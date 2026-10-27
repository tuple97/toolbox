package plugin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"toolbox/app/internal/semver"
)

// 安装来源类型。
const (
	// SourceRegistry 来自官方插件市场索引
	SourceRegistry = "registry"
	// SourceURL 来自任意下载地址
	SourceURL = "url"
	// SourceFile 来自本地安装包
	SourceFile = "file"
	// SourceLocalDir 来自本地目录（开发者模式）
	SourceLocalDir = "local"
	// SourceArchive 来自前端上传的离线包内容
	SourceArchive = "archive"
)

// planTTL 安装计划的有效期。
//
// 预览与安装是两次调用，中间隔着用户确认；计划在这段时间内必须保持不变，
// 否则会出现「预览看到的版本」和「实际装的版本」不一致。
const planTTL = 15 * time.Minute

// PreviewOptions 预览选项。
type PreviewOptions struct {
	// ResolveDependencies 是否求解依赖闭包。
	//
	// false 时只读取清单，用于界面快速渲染插件卡片（不联网、毫秒级完成）。
	ResolveDependencies bool
	// Offline 是否禁止网络访问。
	//
	// 为 true 时依赖只能来自：同批次的包、本地已安装版本、本地包缓存。
	// 这是「离线安装」的硬约束：不会偷偷访问网络。
	Offline bool
}

// planEntry 一次安装请求求解出的不可变计划。
type planEntry struct {
	id        string
	createdAt time.Time
	expiresAt time.Time

	resolution *Resolution
	origins    map[string]Origin
	decisions  map[string]TrustDecision
	addedPerms map[string][]string
	roots      map[string]struct{}

	packages []PackagePreview
	items    []PlanItem
	warnings []string

	needTrust      bool
	trustReason    string
	addedPermsFlat []string
	downloads      int
}

// planCache 安装计划缓存。
//
// 生命周期：Preview 写入，Install 取出即删除，过期项在每次写入时顺带清理。
type planCache struct {
	mu    sync.Mutex
	items map[string]*planEntry
}

func newPlanCache() *planCache {
	return &planCache{items: make(map[string]*planEntry)}
}

func (c *planCache) put(entry *planEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for id, item := range c.items {
		if now.After(item.expiresAt) {
			delete(c.items, id)
		}
	}
	c.items[entry.id] = entry
}

func (c *planCache) take(id string) (*planEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.items[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrPlanExpired, id)
	}
	delete(c.items, id)
	if time.Now().After(entry.expiresAt) {
		return nil, fmt.Errorf("%w: %s", ErrPlanExpired, id)
	}
	return entry, nil
}

// ------------------------------------------------------------------ 预览

// Preview 读取一批包并（可选地）求解完整依赖闭包，生成安装计划。
//
// 在线市场安装、任意 URL 安装、本地 ZIP 安装、本地目录安装、
// 多包批量安装全部走这一条路径：来源解析不同，计划、校验与事务一致。
func (m *Manager) Preview(ctx context.Context, inputs []PackageInput, opts PreviewOptions) (*InstallPreview, error) {
	if len(inputs) == 0 {
		return nil, fmt.Errorf("没有可安装的插件包")
	}

	m.installMu.Lock()
	defer m.installMu.Unlock()

	// 只有显式使用 registry 来源时才联网；离线模式下永不联网。
	needIndex := false
	for _, in := range inputs {
		if strings.EqualFold(strings.TrimSpace(in.Source), SourceRegistry) {
			needIndex = true
			break
		}
	}
	if needIndex && opts.Offline {
		return nil, fmt.Errorf("%w: 离线模式下不能从插件市场安装", ErrSourceUnavailable)
	}

	/*
	 * 一次安装可能横跨多个来源：根插件来自用户点选的来源，依赖则可能在别的
	 * 来源里。因此这里把全部已启用来源的索引（命中缓存就不打网络）都取来，
	 * 交给挑选与求解统一使用 —— 否则「A 源的主包依赖 B 源的依赖」这类组合
	 * 会在求解阶段莫名其妙地报「依赖缺失」。
	 */
	var views []sourceIndexView
	if needIndex {
		explicit := make([]string, 0, len(inputs))
		for _, in := range inputs {
			if !strings.EqualFold(strings.TrimSpace(in.Source), SourceRegistry) {
				continue
			}
			if url := strings.TrimSpace(in.SourceURL); url != "" && !containsString(explicit, url) {
				explicit = append(explicit, url)
			}
		}
		var errs map[string]error
		views, errs = m.ensureSourcesForInstall(ctx, explicit, false)
		if len(views) == 0 {
			// 全部来源都失败：把错误按地址排序后取第一条，保证提示稳定可复现
			urls := make([]string, 0, len(errs))
			for url := range errs {
				urls = append(urls, url)
			}
			sort.Strings(urls)
			for _, url := range urls {
				return nil, errs[url]
			}
			return nil, fmt.Errorf("%w: 插件索引不可用", ErrSourceUnavailable)
		}
	}

	loaded, err := m.loadInputs(inputs, views)
	if err != nil {
		return nil, err
	}

	entry := &planEntry{
		id:         newToken(8),
		createdAt:  time.Now(),
		expiresAt:  time.Now().Add(planTTL),
		origins:    make(map[string]Origin),
		decisions:  make(map[string]TrustDecision),
		addedPerms: make(map[string][]string),
		roots:      make(map[string]struct{}),
	}

	preview := &InstallPreview{
		PlanID:    entry.id,
		ExpiresAt: entry.expiresAt.Format(time.RFC3339),
		Packages:  make([]PackagePreview, 0, len(loaded)),
		Plan:      []PlanItem{},
		Warnings:  []string{},
	}

	// 卡片信息（无论是否求解依赖都返回）
	for _, item := range loaded {
		if _, dup := entry.roots[item.manifest.ID]; dup {
			return nil, fmt.Errorf("同一次安装中重复选择了插件 %s", item.manifest.ID)
		}
		entry.roots[item.manifest.ID] = struct{}{}
		preview.Packages = append(preview.Packages, m.packagePreview(item))
	}

	if !opts.ResolveDependencies {
		preview.PlanID = ""
		preview.ExpiresAt = ""
		preview.Warnings = append(preview.Warnings, m.signatureWarning()...)
		return preview, nil
	}

	catalog, err := m.buildCatalog(loaded, views, opts.Offline)
	if err != nil {
		return nil, err
	}
	resolution, err := Resolve(
		rootRequirements(loaded),
		catalog,
		ResolveOptions{Installed: m.installedVersions()},
	)
	if err != nil {
		return nil, err
	}
	entry.resolution = resolution

	// 生成计划：按拓扑顺序（依赖在前）遍历，便于界面展示与安装执行
	for _, mf := range resolution.Order {
		catalogEntry := catalog.Entry(mf.ID, mf.Version)
		if catalogEntry == nil {
			return nil, fmt.Errorf("内部错误：求解结果 %s@%s 不在候选目录中", mf.ID, mf.Version)
		}
		origin := catalogEntry.Origin
		entry.origins[mf.ID] = origin

		item := PlanItem{
			ID:             mf.ID,
			Version:        mf.Version,
			Source:         string(origin.Kind),
			SourceRef:      origin.Ref,
			Checksum:       NormalizeChecksum(origin.Checksum),
			Official:       origin.Official,
			SourceVerified: origin.Verified,
		}
		if _, ok := entry.roots[mf.ID]; ok {
			item.Root = true
		}

		rec, installed := m.recordOf(mf.ID)
		switch {
		case !installed:
			item.Action = ActionInstall
		case rec.Version == mf.Version && item.Root:
			item.Action = ActionReinstall
		case rec.Version == mf.Version:
			item.Action = ActionKeep
		default:
			item.Action = ActionUpgrade
		}

		// origin.Official 已与来源验签结果取过与；再传一次 Verified 是为了复用
		// DecideTrust 的判定分支（official 为真时必然已验签，不会落到「声明官方但无法验证」）
		decision := DecideTrust(origin.Official, origin.Verified, m.alreadyTrusted(mf.ID, origin.Checksum))
		entry.decisions[mf.ID] = decision
		item.NeedTrust = decision.NeedPrompt
		item.TrustReason = decision.Reason
		if item.NeedTrust {
			entry.needTrust = true
			if entry.trustReason == "" {
				entry.trustReason = decision.Reason
			}
		}

		added := m.addedPermissions(mf)
		entry.addedPerms[mf.ID] = added
		item.AddedPermissions = added
		for _, one := range added {
			if !containsString(entry.addedPermsFlat, one) {
				entry.addedPermsFlat = append(entry.addedPermsFlat, one)
			}
		}

		if item.Action != ActionKeep {
			if origin.Kind == KindRegistry && origin.Payload == nil && origin.CachePath == "" {
				entry.downloads++
			}
			if origin.Payload != nil || origin.CachePath != "" {
				item.Cached = true
			}
		}

		entry.items = append(entry.items, item)
		preview.Plan = append(preview.Plan, item)
	}

	sort.Strings(entry.addedPermsFlat)
	preview.AddedPermissions = append([]string{}, entry.addedPermsFlat...)
	preview.NeedTrust = entry.needTrust
	preview.TrustReason = entry.trustReason

	entry.warnings = append(entry.warnings, m.signatureWarning()...)
	unverified := 0
	for _, mf := range resolution.Order {
		origin := entry.origins[mf.ID]
		if !origin.Official || !origin.Verified {
			unverified++
		}
	}
	if unverified > 0 {
		entry.warnings = append(entry.warnings, fmt.Sprintf(
			"本次将安装 %d 个未经官方索引签名验证的插件，请确认你信任它们的来源。", unverified))
	}
	if entry.downloads > 0 {
		entry.warnings = append(entry.warnings, fmt.Sprintf(
			"本次安装需要下载 %d 个安装包。", entry.downloads))
	}
	entry.warnings = dedupeStrings(entry.warnings)
	preview.Warnings = append([]string{}, entry.warnings...)
	preview.PendingDownloads = entry.downloads

	m.plans.put(entry)
	return preview, nil
}

// InstallPlan 按已确认的计划完成安装。
//
// 计划一旦被取出即失效：绝不会因为计划缓存过期而重新求解、悄悄换包。
func (m *Manager) InstallPlan(ctx context.Context, planID string, trust, acceptPermissions bool) error {
	if strings.TrimSpace(planID) == "" {
		return fmt.Errorf("%w: 缺少安装计划", ErrPlanExpired)
	}

	m.installMu.Lock()
	defer m.installMu.Unlock()

	entry, err := m.plans.take(planID)
	if err != nil {
		return err
	}
	if entry.resolution == nil {
		return fmt.Errorf("%w: 该计划未求解依赖", ErrPlanExpired)
	}

	// 信任关卡：需要用户确认的来源必须显式确认
	if entry.needTrust && !trust {
		return fmt.Errorf("%w: %s", ErrUntrusted, entry.trustReason)
	}
	// 权限扩张关卡：升级引入新权限必须用户确认
	if len(entry.addedPermsFlat) > 0 && !acceptPermissions {
		return fmt.Errorf("本次安装新增了权限，需要确认：%s", strings.Join(entry.addedPermsFlat, "；"))
	}

	// 打开安装包内容（下载 / 缓存 / 本地）
	payloads := make(map[string][]byte, len(entry.resolution.Order))
	dirs := make(map[string]string, len(entry.resolution.Order))
	for _, item := range entry.items {
		if item.Action == ActionKeep {
			continue
		}
		origin := entry.origins[item.ID]
		payload, dir, err := m.obtainPackage(ctx, item, origin, entry.resolution.Selected[item.ID])
		if err != nil {
			return err
		}
		payloads[item.ID] = payload
		dirs[item.ID] = dir
	}

	// 读取旧记录快照，供事务回滚使用
	oldRecords := make(map[string][]byte, len(entry.items))
	m.mu.RLock()
	for _, item := range entry.items {
		if rec, ok := m.records[item.ID]; ok {
			if raw, err := json.MarshalIndent(rec, "", "  "); err == nil {
				oldRecords[item.ID] = raw
			}
		}
	}
	m.mu.RUnlock()

	tx, err := m.store.NewTransaction(newToken(6))
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			tx.Abort()
		}
	}()

	var changed []string
	for _, item := range entry.items {
		if item.Action == ActionKeep {
			continue
		}
		mf := entry.resolution.Selected[item.ID]
		if mf == nil {
			return fmt.Errorf("内部错误：计划项 %s 缺少清单", item.ID)
		}

		staging, err := tx.StagingVersionDir(item.ID, item.Version)
		if err != nil {
			return err
		}
		if dir := dirs[item.ID]; dir != "" {
			if err := copyTree(dir, staging); err != nil {
				return fmt.Errorf("复制插件目录失败(%s): %w", item.ID, err)
			}
		} else {
			payload := payloads[item.ID]
			if len(payload) == 0 {
				return fmt.Errorf("%w: %s@%s 缺少安装包内容", ErrInvalidPackage, item.ID, item.Version)
			}
			if err := ExtractPackage(payload, staging); err != nil {
				return fmt.Errorf("解压插件包失败(%s@%s): %w", item.ID, item.Version, err)
			}
		}

		// 包内清单必须与计划完全一致，杜绝「挂羊头卖狗肉」
		inner, err := LoadManifest(staging)
		if err != nil {
			return fmt.Errorf("%w: 插件包内清单非法(%s@%s): %v", ErrInvalidPackage, item.ID, item.Version, err)
		}
		if inner.ID != item.ID || inner.Version != item.Version {
			return fmt.Errorf("%w: 插件包内容与计划不一致：计划 %s@%s，实际 %s@%s",
				ErrInvalidPackage, item.ID, item.Version, inner.ID, inner.Version)
		}
		if err := validateEntries(staging, inner); err != nil {
			return err
		}

		hadRecord := len(oldRecords[item.ID]) > 0
		rec, err := m.buildRecord(item, inner, oldRecords[item.ID])
		if err != nil {
			return err
		}
		newRecord, err := json.MarshalIndent(rec, "", "  ")
		if err != nil {
			return err
		}

		target := m.store.VersionDir(item.ID, item.Version)
		_, statErr := os.Stat(target)
		hadTarget := statErr == nil

		tx.AddOp(txOp{
			ID:         item.ID,
			Version:    item.Version,
			Action:     item.Action,
			StagingDir: staging,
			TargetDir:  target,
			BackupDir:  target + ".backup-" + tx.ID(),
			HadTarget:  hadTarget,
			RecordPath: m.store.RecordPath(item.ID),
			NewRecord:  newRecord,
			OldRecord:  oldRecords[item.ID],
			HadRecord:  hadRecord,
			NewPlugin:  !hadRecord,
		})
		changed = append(changed, item.ID)
	}

	if len(changed) == 0 {
		return nil
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true

	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.reloadLocked(ctx); err != nil {
		return err
	}

	// 安装成功后清理超出保留数的旧版本（保留当前版本与可回滚版本）
	for _, item := range entry.items {
		if item.Action == ActionKeep {
			continue
		}
		rec := m.records[item.ID]
		protect := []string{item.Version}
		if rec != nil && rec.PreviousVersion != "" {
			protect = append(protect, rec.PreviousVersion)
		}
		if _, err := m.store.CleanupOldVersions(item.ID, 0, protect...); err != nil {
			slog.Warn("清理旧版本失败", "plugin", item.ID, "error", err)
		}
	}
	return nil
}

// obtainPackage 取得某个计划项的安装内容。
func (m *Manager) obtainPackage(ctx context.Context, item PlanItem, origin Origin, mf *Manifest) ([]byte, string, error) {
	switch {
	case origin.Dir != "":
		return nil, origin.Dir, nil
	case origin.Payload != nil:
		if err := VerifyChecksum(origin.Payload, item.Checksum); err != nil {
			return nil, "", err
		}
		return origin.Payload, "", nil
	case origin.CachePath != "":
		raw, err := os.ReadFile(origin.CachePath)
		if err != nil {
			return nil, "", fmt.Errorf("%w: 读取本地缓存失败(%s): %v", ErrSourceUnavailable, item.ID, err)
		}
		if err := VerifyChecksum(raw, item.Checksum); err != nil {
			return nil, "", err
		}
		return raw, "", nil
	}

	if origin.Kind != KindRegistry {
		return nil, "", fmt.Errorf("%w: %s@%s 缺少安装包内容", ErrSourceUnavailable, item.ID, item.Version)
	}
	raw, err := m.client.DownloadPackage(ctx, origin.Ref, origin.Checksum)
	if err != nil {
		return nil, "", fmt.Errorf("下载插件包失败(%s@%s): %w", item.ID, item.Version, err)
	}
	if err := m.store.PutCache(item.Checksum, raw, mf); err != nil {
		slog.Warn("写入插件包缓存失败", "plugin", item.ID, "error", err)
	}
	return raw, "", nil
}

// packagePreview 依据已读取的包构造展示信息。
func (m *Manager) packagePreview(item *loadedInput) PackagePreview {
	mf := item.manifest
	preview := PackagePreview{
		ID:           mf.ID,
		Name:         mf.Name,
		Version:      mf.Version,
		Publisher:    mf.Publisher,
		Description:  mf.Description,
		Icon:         mf.Icon,
		Homepage:     mf.Homepage,
		License:      mf.License,
		Source:       string(item.origin.Kind),
		SourceRef:    item.origin.describeRef(),
		Official:     item.origin.Official,
		Checksum:     NormalizeChecksum(item.origin.Checksum),
		Permissions:  mf.Permissions.PermissionSummary(),
		Dependencies: mf.SortedDependencies(),
	}

	if rec, ok := m.recordOf(mf.ID); ok {
		preview.CurrentVersion = rec.Version
		preview.Upgrade = rec.Version != mf.Version
	}
	preview.AddedPermissions = m.addedPermissions(mf)
	return preview
}

// addedPermissions 计算相对已安装版本新增的权限。
func (m *Manager) addedPermissions(mf *Manifest) []string {
	rec, ok := m.recordOf(mf.ID)
	if !ok {
		return mf.Permissions.PermissionSummary()
	}
	current, err := m.store.LoadManifest(rec.ID, rec.Version)
	if err != nil {
		return mf.Permissions.PermissionSummary()
	}
	return PermissionDiff(current.Permissions, mf.Permissions)
}

// alreadyTrusted 报告同一来源摘要是否已被信任。
func (m *Manager) alreadyTrusted(id, checksum string) bool {
	rec, ok := m.recordOf(id)
	if !ok || !rec.IsTrusted() {
		return false
	}
	if checksum == "" || rec.Checksum == "" {
		return true
	}
	return strings.EqualFold(NormalizeChecksum(rec.Checksum), NormalizeChecksum(checksum))
}

func (m *Manager) recordOf(id string) (*InstallRecord, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	rec, ok := m.records[id]
	return rec, ok
}

// installedVersions 返回已安装版本快照（供求解复用）。
func (m *Manager) installedVersions() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]string, len(m.records))
	for id, rec := range m.records {
		if m.manifests[id] != nil {
			out[id] = rec.Version
		}
	}
	return out
}

// signatureWarning 返回与签名配置相关的通用提示。
func (m *Manager) signatureWarning() []string {
	if SignatureEnabled() {
		return nil
	}
	return []string{"当前应用未配置官方索引签名公钥，插件来源校验强度较低（可在构建时用 -ldflags 注入公钥）。"}
}

// buildRecord 依据计划项构造新的安装记录。
func (m *Manager) buildRecord(item PlanItem, mf *Manifest, oldRaw []byte) (*InstallRecord, error) {
	// 用计划项自带的来源验签状态，而不是全局的 SignatureEnabled()：
	// 多源下不同来源的验签结果并不相同，拿全局开关当代理会误判第三方源为官方。
	decision := DecideTrust(item.Official, item.SourceVerified, m.alreadyTrusted(item.ID, item.Checksum))

	rec := &InstallRecord{
		ID:          item.ID,
		Version:     item.Version,
		Source:      item.Source,
		SourceRef:   item.SourceRef,
		Checksum:    NormalizeChecksum(item.Checksum),
		Trust:       decision.Level,
		Official:    item.Official,
		Enabled:     true,
		Permissions: mf.Permissions,
		InstalledAt: nowRFC3339(),
		UpdatedAt:   nowRFC3339(),
	}
	if rec.Trust == TrustNone {
		rec.Trust = TrustUser
	}
	if rec.IsTrusted() {
		rec.TrustedAt = rec.UpdatedAt
	}

	if len(oldRaw) > 0 {
		var old InstallRecord
		if err := json.Unmarshal(oldRaw, &old); err == nil {
			rec.InstalledAt = old.InstalledAt
			rec.Enabled = old.Enabled
			if old.Trust != TrustNone && old.Trust != "" {
				// 已信任的插件升级时继承信任（同一发布者，用户已做过决定）
				rec.Trust = old.Trust
				rec.TrustedAt = old.TrustedAt
			}
			if old.Version != item.Version {
				rec.PreviousVersion = old.Version
			} else {
				rec.PreviousVersion = old.PreviousVersion
			}
		}
	}
	return rec, nil
}

// ------------------------------------------------------------------ 输入装载

// loadedInput 一个已完成清单校验的待安装包。
type loadedInput struct {
	input    PackageInput
	manifest *Manifest
	origin   Origin
}

// loadInputs 读取并校验全部输入包。
func (m *Manager) loadInputs(inputs []PackageInput, views []sourceIndexView) ([]*loadedInput, error) {
	out := make([]*loadedInput, 0, len(inputs))
	for _, in := range inputs {
		item, err := m.loadInput(in, views)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func (m *Manager) loadInput(in PackageInput, views []sourceIndexView) (*loadedInput, error) {
	source := strings.ToLower(strings.TrimSpace(in.Source))
	switch source {
	case SourceRegistry:
		if len(views) == 0 {
			return nil, fmt.Errorf("%w: 插件索引不可用", ErrSourceUnavailable)
		}
		if strings.TrimSpace(in.ID) == "" {
			return nil, fmt.Errorf("从插件市场安装需要提供插件 id")
		}
		entry, view, err := pickRegistryEntry(views, in.SourceURL, in.ID, strings.TrimSpace(in.Version))
		if err != nil {
			return nil, err
		}
		mf := entry.Manifest()
		origin := Origin{
			Kind:     KindRegistry,
			Ref:      entry.Download,
			Checksum: entry.Checksum,
			Official: entry.Official && view.Verified,
			Verified: view.Verified,
			Priority: originPriorityRoot,
		}
		if payload, ok, err := m.store.ReadCache(entry.Checksum); err == nil && ok {
			origin.Payload = payload
		}
		return &loadedInput{input: in, manifest: mf, origin: origin}, nil

	case SourceURL:
		target := strings.TrimSpace(in.Ref)
		if target == "" {
			return nil, fmt.Errorf("从 URL 安装需要提供下载地址")
		}
		payload, err := m.client.DownloadPackage(context.Background(), target, "")
		if err != nil {
			return nil, err
		}
		return m.loadPayload(in, KindURL, target, payload)

	case SourceFile:
		path := strings.TrimSpace(in.Ref)
		if path == "" {
			return nil, fmt.Errorf("从文件安装需要提供安装包路径")
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("%w: 读取安装包失败: %v", ErrSourceUnavailable, err)
		}
		if info.IsDir() {
			// 目录按本地开发目录处理，便于开发者直接指向源码目录
			return m.loadLocalDir(PackageInput{Source: SourceLocalDir, Ref: path})
		}
		if info.Size() > maxPackageBytes {
			return nil, fmt.Errorf("%w: 安装包过大（> %d 字节）", ErrInvalidPackage, maxPackageBytes)
		}
		payload, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("%w: 读取安装包失败: %v", ErrSourceUnavailable, err)
		}
		return m.loadPayload(in, KindFile, path, payload)

	case SourceLocalDir:
		return m.loadLocalDir(in)

	case SourceArchive:
		if len(in.Content) == 0 {
			return nil, fmt.Errorf("插件包内容为空")
		}
		if len(in.Content) > maxPackageBytes {
			return nil, fmt.Errorf("%w: 插件包过大（> %d 字节）", ErrInvalidPackage, maxPackageBytes)
		}
		name := strings.TrimSpace(in.Ref)
		if name == "" {
			name = "导入的插件包"
		}
		return m.loadPayload(in, KindBatch, name, in.Content)

	default:
		return nil, fmt.Errorf("未知的插件来源: %q", in.Source)
	}
}

// loadPayload 从内存中的安装包读取清单。
func (m *Manager) loadPayload(in PackageInput, kind PackageKind, ref string, payload []byte) (*loadedInput, error) {
	staging, err := os.MkdirTemp("", "toolbox-plugin-preview-*")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()

	if err := ExtractPackage(payload, staging); err != nil {
		return nil, err
	}
	mf, err := LoadManifest(staging)
	if err != nil {
		return nil, err
	}
	if err := validateEntries(staging, mf); err != nil {
		return nil, err
	}

	checksum := HashBytes(payload)
	if err := m.store.PutCache(checksum, payload, mf); err != nil {
		slog.Warn("写入插件包缓存失败", "plugin", mf.ID, "error", err)
	}
	return &loadedInput{
		input:    in,
		manifest: mf,
		origin: Origin{
			Kind:     kind,
			Ref:      ref,
			Checksum: checksum,
			Payload:  payload,
			Priority: originPriorityRoot,
		},
	}, nil
}

// loadLocalDir 从本地目录读取清单（开发者模式）。
func (m *Manager) loadLocalDir(in PackageInput) (*loadedInput, error) {
	dir := strings.TrimSpace(in.Ref)
	if dir == "" {
		return nil, fmt.Errorf("本地目录安装需要提供目录路径")
	}
	mf, err := LoadManifest(dir)
	if err != nil {
		// 最常见的误操作是选中了「包含多个插件的父目录」。
		if candidates := subPluginDirs(dir); len(candidates) > 0 {
			return nil, fmt.Errorf(
				"该目录下是 %d 个插件，请选择具体的插件目录（例如 %s）",
				len(candidates), filepath.Join(dir, candidates[0]))
		}
		return nil, err
	}
	if err := validateEntries(dir, mf); err != nil {
		return nil, err
	}
	return &loadedInput{
		input:    in,
		manifest: mf,
		origin: Origin{
			Kind:     KindLocalDir,
			Ref:      dir,
			Dir:      dir,
			Priority: originPriorityRoot,
		},
	}, nil
}

// buildCatalog 构建依赖求解的候选目录。
//
// 顺序：本地已安装 → 本地包缓存 → 本次提供的包 → 官方索引。
// 后加入的条目在优先级更高或内容更完整时覆盖前面的同名版本（见 Catalog.Add）。
func (m *Manager) buildCatalog(loaded []*loadedInput, views []sourceIndexView, offline bool) (*Catalog, error) {
	catalog := NewCatalog()

	// 1. 本地已安装：允许求解复用它，安装时走 keep 分支
	m.mu.RLock()
	installed := make(map[string]*Manifest, len(m.manifests))
	for id, mf := range m.manifests {
		installed[id] = mf
	}
	m.mu.RUnlock()

	for id, mf := range installed {
		rec := m.recordOf2(id)
		if rec == nil {
			continue
		}
		if err := catalog.Add(mf, Origin{
			Kind:     KindInstalled,
			Ref:      rec.Version,
			Priority: originPriorityInstalled,
		}); err != nil {
			return nil, err
		}
	}

	// 2. 本地包缓存：离线安装唯一的依赖来源（不含任何网络请求）
	for _, cached := range m.store.CachedPackages() {
		if err := catalog.Add(cached.Manifest, Origin{
			Kind:      KindRegistry,
			Ref:       "本地缓存 " + cached.Checksum,
			Checksum:  cached.Checksum,
			CachePath: cached.Path,
			Priority:  originPriorityRegistry,
		}); err != nil {
			return nil, err
		}
	}

	// 3. 本次提供的包
	for _, item := range loaded {
		if err := catalog.Add(item.manifest, item.origin); err != nil {
			return nil, err
		}
	}

	// 4. 各插件源索引（离线模式下不访问网络，也不使用索引）
	if len(views) == 0 || offline {
		return catalog, nil
	}
	for _, view := range views {
		verified := view.Verified
		for i := range view.Index.Plugins {
			entry := &view.Index.Plugins[i]
			origin := Origin{
				Kind:     KindRegistry,
				Ref:      entry.Download,
				Checksum: entry.Checksum,
				Official: entry.Official && verified,
				Verified: verified,
				Priority: originPriorityRegistry,
			}
			if path, ok := m.store.CacheFile(entry.Checksum); ok {
				origin.CachePath = path
			}
			if err := catalog.Add(entry.Manifest(), origin); err != nil {
				/*
				 * 同一个 (id, version) 被两个来源提供但摘要不一致。
				 *
				 * 这是来源之间的分歧，不是本插件的安装错误：先登记的来源胜出，
				 * 冲突项跳过。绝不能因为「用户同时挂了两个源」就让整次安装失败，
				 * 也不该在这里替用户决定谁是对的 —— 实际安装的内容仍按选中来源
				 * 自己的摘要校验。
				 */
				slog.Warn("跳过与其它来源冲突的索引条目",
					"id", entry.ID, "version", entry.Version, "source", view.Source.URL, "error", err)
			}
		}
	}
	return catalog, nil
}

// rootRequirements 构造根要求（每个输入钉死到它自己的精确版本）。
func rootRequirements(loaded []*loadedInput) []Requirement {
	out := make([]Requirement, 0, len(loaded))
	for _, item := range loaded {
		out = append(out, Requirement{
			ID:         item.manifest.ID,
			Constraint: "=" + item.manifest.Version,
			From:       rootRef,
		})
	}
	return out
}

// ------------------------------------------------------------------ 升级 / 回滚 / 卸载 / 启停

// Upgrade 把插件升级到官方索引中的最新版本。
//
// 与其它安装路径共用同一套「预览 → 计划 → 事务」流程，没有独立的升级实现。
func (m *Manager) Upgrade(ctx context.Context, id string, acceptPermissions bool) error {
	preview, err := m.Preview(ctx, []PackageInput{{Source: SourceRegistry, ID: id}}, PreviewOptions{ResolveDependencies: true})
	if err != nil {
		return err
	}
	// 升级已安装插件：信任状态继承自既有记录，信任关卡在计划里已按此判定
	return m.InstallPlan(ctx, preview.PlanID, true, acceptPermissions)
}

// Rollback 把插件回滚到上一个安装过的版本。
//
// 回滚不是「改一个字段」：必须先确认目标版本仍在磁盘上、本身兼容，
// 且回滚后所有依赖它的插件仍然满足版本约束。
func (m *Manager) Rollback(ctx context.Context, id string) error {
	m.installMu.Lock()
	defer m.installMu.Unlock()

	m.mu.RLock()
	rec := m.records[id]
	current := m.manifests[id]
	graph := m.graph
	m.mu.RUnlock()

	if rec == nil {
		return fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	if rec.PreviousVersion == "" {
		return fmt.Errorf("插件 %s 没有可回滚的历史版本", id)
	}
	target := rec.PreviousVersion
	if !m.store.HasVersion(id, target) {
		return fmt.Errorf("插件 %s 的历史版本 %s 已不存在", id, target)
	}
	targetManifest, err := m.store.LoadManifest(id, target)
	if err != nil {
		return fmt.Errorf("历史版本 %s 的清单不可用: %w", target, err)
	}
	if reason := m.incompatibleReason(targetManifest); reason != "" {
		return fmt.Errorf("%w: 历史版本 %s 无法在当前应用上运行：%s", ErrIncompatible, target, reason)
	}

	// 回滚后依赖方是否仍满足
	for _, depID := range graph.DependentsClosure(id) {
		depRec := m.recordOf2(depID)
		if depRec == nil || !depRec.Enabled {
			continue
		}
		depManifest := m.manifestOf(depID)
		if depManifest == nil {
			continue
		}
		constraint, ok := depManifest.Dependencies[id]
		if !ok {
			continue
		}
		parsed, pErr := semver.ParseConstraint(constraint)
		version, vErr := semver.Parse(target)
		if pErr != nil || vErr != nil || !parsed.Check(version) {
			return fmt.Errorf("%w: 回滚后 %s 将不满足 %s 声明的 %s",
				ErrDependencyConflict, id, depID, constraint)
		}
	}
	// 目标版本自身的依赖是否仍然满足
	for depID, constraint := range targetManifest.Dependencies {
		depRec := m.recordOf2(depID)
		if depRec == nil {
			return fmt.Errorf("%w: 历史版本 %s 依赖 %s 未安装", ErrDependencyMissing, target, depID)
		}
		parsed, pErr := semver.ParseConstraint(constraint)
		version, vErr := semver.Parse(depRec.Version)
		if pErr != nil || vErr != nil || !parsed.Check(version) {
			return fmt.Errorf("%w: 历史版本 %s 需要 %s@%s，当前为 %s",
				ErrDependencyConflict, target, depID, constraint, depRec.Version)
		}
	}

	_ = current
	newRec := *rec
	newRec.Version = target
	// 让回滚可逆：把当前版本记为「上一个版本」，再次回滚即回到它。
	newRec.PreviousVersion = rec.Version
	newRec.UpdatedAt = nowRFC3339()

	oldRaw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	newRaw, err := json.MarshalIndent(&newRec, "", "  ")
	if err != nil {
		return err
	}

	tx, err := m.store.NewTransaction(newToken(6))
	if err != nil {
		return err
	}
	tx.AddOp(txOp{
		ID:         id,
		Version:    target,
		Action:     ActionRollback,
		RecordPath: m.store.RecordPath(id),
		NewRecord:  newRaw,
		OldRecord:  oldRaw,
		HadRecord:  true,
	})
	if err := tx.Commit(); err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reloadLocked(ctx)
}

// Uninstall 卸载插件。
//
// force 为 false 时，被其它已安装插件依赖会拒绝卸载，并提示具体依赖方；
// force 为 true 时先停用全部依赖方（含传递依赖），再完成卸载。
//
// 返回值是被自动停用的插件 id，供前端提示用户。
func (m *Manager) Uninstall(ctx context.Context, id string, force bool) ([]string, error) {
	m.installMu.Lock()
	defer m.installMu.Unlock()

	m.mu.RLock()
	_, installed := m.records[id]
	dependents := m.graph.DependentsClosure(id)
	records := make(map[string]*InstallRecord, len(dependents))
	for _, depID := range dependents {
		records[depID] = m.records[depID]
	}
	m.mu.RUnlock()

	if !installed {
		return nil, fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	if len(dependents) > 0 && !force {
		return nil, fmt.Errorf("%w: %s（被 %s 依赖，可强制卸载，依赖它的插件会被自动停用）",
			ErrInUse, id, strings.Join(dependents, "、"))
	}

	/*
	 * 强制卸载：先把依赖方全部停用，再删被卸载的插件。
	 *
	 * 顺序不能反 —— 先删掉被依赖的插件，依赖方立刻处于「依赖缺失」的
	 * 坏状态。停用是一个有记录的显式状态，用户把依赖装回来后自己启用即可。
	 */
	disabled := make([]string, 0, len(dependents))
	var ops []txOp
	for _, depID := range dependents {
		rec := records[depID]
		if rec == nil || !rec.Enabled {
			continue
		}
		newRec := *rec
		newRec.Enabled = false
		oldRaw, _ := json.MarshalIndent(rec, "", "  ")
		newRaw, err := json.MarshalIndent(&newRec, "", "  ")
		if err != nil {
			return nil, err
		}
		ops = append(ops, txOp{
			ID:         depID,
			Version:    rec.Version,
			Action:     ActionRollback,
			RecordPath: m.store.RecordPath(depID),
			NewRecord:  newRaw,
			OldRecord:  oldRaw,
			HadRecord:  true,
		})
		disabled = append(disabled, depID)
	}

	if len(ops) > 0 {
		tx, err := m.store.NewTransaction(newToken(6))
		if err != nil {
			return nil, err
		}
		for _, op := range ops {
			tx.AddOp(op)
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
	}

	if err := m.store.RemovePlugin(id); err != nil {
		// 删除失败：重新加载以反映「依赖方已停用」的一致状态
		m.mu.Lock()
		_ = m.reloadLocked(ctx)
		m.mu.Unlock()
		return nil, err
	}
	slog.Info("插件已卸载", "plugin", id, "force", force, "disabled", disabled)

	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.reloadLocked(ctx); err != nil {
		return disabled, err
	}
	return disabled, nil
}

// SetEnabled 启用或停用插件。
//
// 启用前会校验：已受信任、与宿主版本兼容、全部依赖已安装且已启用。
// 停用被依赖的插件时，默认拒绝；cascade 为 true 时级联停用依赖方。
//
// 返回被级联停用/启用的插件 id。
func (m *Manager) SetEnabled(ctx context.Context, id string, enabled bool, cascade bool) ([]string, error) {
	m.installMu.Lock()
	defer m.installMu.Unlock()

	m.mu.RLock()
	rec := m.records[id]
	mf := m.manifests[id]
	dependents := m.graph.DependentsClosure(id)
	m.mu.RUnlock()

	if rec == nil {
		return nil, fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}

	changed := make([]string, 0, 1+len(dependents))
	ops := make([]txOp, 0, 1+len(dependents))

	if enabled {
		if mf == nil {
			return nil, fmt.Errorf("插件 %s 的清单缺失或损坏", id)
		}
		if !rec.IsTrusted() {
			return nil, fmt.Errorf("%w: 请先信任插件 %s", ErrUntrusted, id)
		}
		if reason := m.incompatibleReason(mf); reason != "" {
			return nil, fmt.Errorf("%w: %s", ErrIncompatible, reason)
		}
		if err := m.checkDependenciesEnabled(mf); err != nil {
			return nil, err
		}
		if !rec.Enabled {
			op, err := recordOp(m.store, rec, func(next *InstallRecord) { next.Enabled = true })
			if err != nil {
				return nil, err
			}
			ops = append(ops, op)
			changed = append(changed, id)
		}
	} else {
		active := make([]string, 0, len(dependents))
		m.mu.RLock()
		for _, depID := range dependents {
			if depRec := m.records[depID]; depRec != nil && depRec.Enabled {
				active = append(active, depID)
			}
		}
		m.mu.RUnlock()
		if len(active) > 0 && !cascade {
			return nil, fmt.Errorf("%w: %s（被 %s 依赖，可选择级联停用）",
				ErrInUse, id, strings.Join(active, "、"))
		}
		// 级联停用：先停用依赖方，再停用自己（依赖方在前，顺序无关但更直观）
		for _, depID := range active {
			depRec := m.recordOf2(depID)
			if depRec == nil {
				continue
			}
			op, err := recordOp(m.store, depRec, func(next *InstallRecord) { next.Enabled = false })
			if err != nil {
				return nil, err
			}
			ops = append(ops, op)
			changed = append(changed, depID)
		}
		if rec.Enabled {
			op, err := recordOp(m.store, rec, func(next *InstallRecord) { next.Enabled = false })
			if err != nil {
				return nil, err
			}
			ops = append(ops, op)
			changed = append(changed, id)
		}
	}

	if len(ops) > 0 {
		tx, err := m.store.NewTransaction(newToken(6))
		if err != nil {
			return nil, err
		}
		for _, op := range ops {
			tx.AddOp(op)
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.reloadLocked(ctx); err != nil {
		return changed, err
	}
	return changed, nil
}

// SetTrusted 设置插件的信任状态。
func (m *Manager) SetTrusted(ctx context.Context, id string, trusted bool) error {
	m.installMu.Lock()
	defer m.installMu.Unlock()

	rec := m.recordOf2(id)
	if rec == nil {
		return fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	op, err := recordOp(m.store, rec, func(next *InstallRecord) {
		if trusted {
			next.Trust = TrustUser
			next.TrustedAt = nowRFC3339()
			return
		}
		next.Trust = TrustNone
		next.TrustedAt = ""
	})
	if err != nil {
		return err
	}
	tx, err := m.store.NewTransaction(newToken(6))
	if err != nil {
		return err
	}
	tx.AddOp(op)
	if err := tx.Commit(); err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reloadLocked(ctx)
}

// checkDependenciesEnabled 校验依赖是否都已安装且已启用。
func (m *Manager) checkDependenciesEnabled(mf *Manifest) error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, dep := range mf.SortedDependencies() {
		depRec, ok := m.records[dep.ID]
		if !ok {
			return fmt.Errorf("%w: %s 需要 %s@%s", ErrDependencyMissing, mf.ID, dep.ID, dep.Constraint)
		}
		if !depRec.Enabled {
			return fmt.Errorf("依赖 %s 已停用，请先启用它", dep.ID)
		}
		if !depRec.IsTrusted() {
			return fmt.Errorf("%w: 依赖 %s 未被信任", ErrUntrusted, dep.ID)
		}
		constraint, err := semver.ParseConstraint(dep.Constraint)
		if err != nil {
			return fmt.Errorf("依赖 %s 的约束非法: %w", dep.ID, err)
		}
		version, vErr := semver.Parse(depRec.Version)
		if vErr != nil {
			return fmt.Errorf("依赖 %s 的已安装版本号非法: %q", dep.ID, depRec.Version)
		}
		if !constraint.Check(version) {
			return fmt.Errorf("%w: 依赖 %s 当前为 %s，不满足 %s",
				ErrDependencyConflict, dep.ID, depRec.Version, dep.Constraint)
		}
	}
	return nil
}

func (m *Manager) recordOf2(id string) *InstallRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.records[id]
}

func (m *Manager) manifestOf(id string) *Manifest {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.manifests[id]
}

// recordOp 构造一个只改安装记录的事务动作。
func recordOp(store *Store, rec *InstallRecord, mutate func(*InstallRecord)) (txOp, error) {
	next := *rec
	mutate(&next)
	oldRaw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return txOp{}, err
	}
	newRaw, err := json.MarshalIndent(&next, "", "  ")
	if err != nil {
		return txOp{}, err
	}
	return txOp{
		ID:         rec.ID,
		Version:    next.Version,
		Action:     ActionRollback,
		RecordPath: store.RecordPath(rec.ID),
		NewRecord:  newRaw,
		OldRecord:  oldRaw,
		HadRecord:  true,
	}, nil
}

// ------------------------------------------------------------------ 工具

// newToken 生成随机短标识。
func newToken(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// describeRef 返回来源引用；为空时退化为来源类型。
func (o Origin) describeRef() string {
	if strings.TrimSpace(o.Ref) != "" {
		return o.Ref
	}
	return string(o.Kind)
}

func manifestName(mf *Manifest) string {
	if mf.Name != "" {
		return mf.Name
	}
	return mf.ID
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

func dedupeStrings(list []string) []string {
	seen := make(map[string]struct{}, len(list))
	out := make([]string, 0, len(list))
	for _, item := range list {
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

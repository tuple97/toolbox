package plugin

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"toolbox/app/internal/semver"
)

// pendingTTL 待安装缓存的存活时间。
//
// Preview 与 Install 是两次前端调用，中间隔着用户的确认操作；
// 这段时间内复用已下载/已解包的内容，避免重复拉取。
const pendingTTL = 5 * time.Minute

// pendingInstall 一次安装的准备工作结果。
type pendingInstall struct {
	createdAt time.Time

	source   string
	ref      string
	manifest *Manifest
	checksum string
	official bool
	signed   bool

	// payload 安装包原始内容（url / file 来源）
	payload []byte
	// sourceDir 本地目录来源时的原始目录
	sourceDir string
	// tempDir 需要清理的临时目录
	tempDir string
	// warnings 准备阶段发现的风险提示
	warnings []string
}

// cacheKey 待安装缓存的键。
func (p *pendingInstall) cacheKey() string {
	return strings.Join([]string{p.source, p.ref, p.manifest.ID, p.manifest.Version}, "|")
}

// cleanup 释放临时资源。
func (p *pendingInstall) cleanup() {
	if p.tempDir != "" {
		_ = os.RemoveAll(p.tempDir)
		p.tempDir = ""
	}
}

// Preview 生成完整安装预览：基本信息 + 依赖安装计划。
//
// 依赖求解可能要去官方索引补齐（联网），因此明显慢于 PreviewBasic。
func (m *Manager) Preview(ctx context.Context, req InstallRequest) (*InstallPreview, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pending, err := m.prepareLocked(ctx, req)
	if err != nil {
		return nil, err
	}
	preview := m.buildPreviewLocked(pending, req)
	m.attachPlanLocked(ctx, pending, preview)
	return preview, nil
}

// PreviewBasic 只读取插件包基本信息，不做依赖求解（不联网，毫秒级返回）。
//
// 界面先拿它渲染插件卡片，再异步补齐依赖计划 —— 依赖求解可能要走
// 官方索引，不该让基本信息陪着一起等。
func (m *Manager) PreviewBasic(ctx context.Context, req InstallRequest) (*InstallPreview, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pending, err := m.prepareLocked(ctx, req)
	if err != nil {
		return nil, err
	}
	return m.buildPreviewLocked(pending, req), nil
}

// attachPlanLocked 补全依赖安装计划与缺失清单（可能联网）。
func (m *Manager) attachPlanLocked(ctx context.Context, pending *pendingInstall, preview *InstallPreview) {
	plan, missing := m.resolvePlanLocked(ctx, pending)
	for _, item := range plan {
		preview.Plan = append(preview.Plan, InstallPlanItem{
			ID:      item.manifest.ID,
			Version: item.manifest.Version,
			Action:  item.action,
			Scanned: item.scanned,
		})
	}

	// 依赖缺失不再阻断安装，但要在预览里说清楚后果
	preview.MissingDependencies = missing
	if len(missing) > 0 {
		preview.Warnings = append(preview.Warnings,
			"部分依赖当前无法解析：仍可安装，但在补齐依赖之前该插件无法启用。")
	}
}

// buildPreviewLocked 依据准备结果构造预览基本信息（不含依赖计划）。
func (m *Manager) buildPreviewLocked(pending *pendingInstall, req InstallRequest) *InstallPreview {
	mf := pending.manifest

	preview := &InstallPreview{
		ID:           mf.ID,
		Name:         mf.Name,
		Version:      mf.Version,
		Publisher:    mf.Publisher,
		Description:  mf.Description,
		Icon:         mf.Icon,
		Homepage:     mf.Homepage,
		License:      mf.License,
		Source:       pending.source,
		SourceRef:    pending.ref,
		Official:     pending.official,
		Checksum:     pending.checksum,
		Signed:       pending.signed,
		Permissions:  mf.Permissions.PermissionSummary(),
		Dependencies: mf.SortedDependencies(),
		Plan:         []InstallPlanItem{},
		Warnings:     append([]string{}, pending.warnings...),
	}

	if existing, ok := m.records[mf.ID]; ok {
		preview.Upgrade = true
		preview.CurrentVersion = existing.Version
	}

	preview.Trusted = m.isTrustedLocked(mf.ID, pending.checksum)
	preview.NeedTrust = NeedTrustPrompt(preview.Official, preview.Trusted)

	// 新增权限（升级场景）
	if existing, ok := m.records[mf.ID]; ok {
		if current, curErr := m.store.LoadManifest(mf.ID, existing.Version); curErr == nil {
			preview.AddedPermissions = PermissionDiff(current.Permissions, mf.Permissions)
		}
	} else {
		// 全新安装：全部权限都算新增
		preview.AddedPermissions = mf.Permissions.PermissionSummary()
	}

	if !preview.Official && !preview.Signed {
		preview.Warnings = append(preview.Warnings,
			"该插件未提供发布者签名，无法验证来源真实性，请确认你信任其发布者。")
	}
	if !SignatureEnabled() {
		preview.Warnings = append(preview.Warnings,
			"当前应用未配置官方索引签名公钥，插件来源校验强度较低。")
	}

	return preview
}

// resolvedPackage 依赖求解后单个待落地插件。
type resolvedPackage struct {
	manifest *Manifest
	action   string // install / upgrade / keep
	// payload 非空表示已有包内容（主包）
	payload []byte
	// dir 非空表示来自本地目录
	dir string
	// entry 非空表示需从官方索引下载
	entry *RegistryEntry
	// primary 是否为主安装目标
	primary bool
	// scanned 依赖是否来自同级目录的临时扫描（非用户显式选中）
	scanned bool
}

// resolvePlanLocked 求解依赖闭包，产出落地计划与缺失清单。
//
// 依赖查找由近及远：本地已装 → 同批次待装包 → 插件所在目录的兄弟目录
// → 官方索引。只有确实缺包时才联网，避免「装个没依赖的插件也要等网络」。
//
// 依赖**不可满足不再报错**：返回只含主包的计划，并把缺失项交给界面标红。
// 用户可以先把插件装上、之后再补依赖（启用时仍会校验，见
// checkDependenciesReadyLocked）。
func (m *Manager) resolvePlanLocked(
	ctx context.Context,
	pending *pendingInstall,
) ([]*resolvedPackage, []MissingDependency) {
	localDirs := make(map[string]string)
	catalog, scanned := m.installCatalogLocked(pending, localDirs)

	rootConstraint := "=" + pending.manifest.Version
	var index *RegistryIndex

	ordered, resolveErr := Resolve(pending.manifest.ID, rootConstraint, catalog)
	if resolveErr != nil {
		// 本地凑不齐，再引入官方索引（这一步才会联网）
		if index, _, _ = m.ensureIndexLocked(ctx, false); index != nil {
			for i := range index.Plugins {
				catalog.Add(index.Plugins[i].Manifest())
			}
			ordered, resolveErr = Resolve(pending.manifest.ID, rootConstraint, catalog)
		}
	}

	if resolveErr != nil || len(ordered) == 0 {
		// 宽松回退：只落地主包，缺失的依赖原样报给界面
		primary := &resolvedPackage{
			manifest: pending.manifest,
			action:   "install",
			payload:  pending.payload,
			dir:      pending.sourceDir,
			primary:  true,
		}
		if existing, ok := m.records[pending.manifest.ID]; ok {
			primary.action = "upgrade"
			_ = existing
		}
		return []*resolvedPackage{primary}, m.missingDependenciesLocked(pending.manifest)
	}

	out := make([]*resolvedPackage, 0, len(ordered))
	// 求解成功但取不到包（payload/dir/索引都拿不到）的依赖会被跳过，
	// 它们仍应出现在缺失清单里，故单独记账。
	skipped := make(map[string]struct{})
	for _, mf := range ordered {
		item := &resolvedPackage{manifest: mf}

		if mf.ID == pending.manifest.ID && mf.Version == pending.manifest.Version {
			item.primary = true
			item.payload = pending.payload
			item.dir = pending.sourceDir
		} else if dir, ok := localDirs[mf.ID]; ok && dir != "" {
			// 依赖来自同批次安装或兄弟目录：直接用那个目录落地
			item.dir = dir
			// 兄弟目录是安装时临时扫描出来的，界面据此提示「自动扫描」
			_, item.scanned = scanned[mf.ID]
		}

		if existing, ok := m.records[mf.ID]; ok {
			// 依赖已安装：仅在版本不同时才升级
			item.action = "keep"
			if existing.Version != mf.Version {
				item.action = "upgrade"
			}
		} else {
			item.action = "install"
		}

		if item.primary && item.action == "keep" {
			// 主包即使是同版本重装，也走落地流程
			item.action = "upgrade"
		}

		// 已安装且版本一致：无需重新落地（materialize 会直接跳过），
		// 但必须留在计划里 —— 否则界面看不到这条依赖，会误报「无依赖」。
		if item.action == "keep" {
			out = append(out, item)
			continue
		}

		if item.payload == nil && item.dir == "" {
			// 本地没有，只能从官方索引补包
			if index == nil {
				index, _, _ = m.ensureIndexLocked(ctx, false)
			}
			var entry *RegistryEntry
			if index != nil {
				entry = index.Find(mf.ID, mf.Version)
			}
			if entry == nil {
				// 找不到包就跳过，并记入缺失清单，而不是让整次安装失败
				skipped[mf.ID] = struct{}{}
				continue
			}
			item.entry = entry
		}
		out = append(out, item)
	}

	// 以求解结果判断依赖是否齐备。
	//
	// 不能只查本地已安装集合：依赖也可能来自同批次安装包或兄弟目录，
	// 那些包在安装前不计入 records，否则同一条依赖会既出现在
	// 「将一并安装」里、又出现在「缺失」里。
	planned := make(map[string]string, len(ordered))
	for _, plannedManifest := range ordered {
		planned[plannedManifest.ID] = plannedManifest.Version
	}
	for id := range skipped {
		delete(planned, id)
	}
	return out, m.missingFromPlanLocked(pending.manifest, planned)
}

// missingFromPlanLocked 依据求解结果判断依赖是否齐备。
func (m *Manager) missingFromPlanLocked(mf *Manifest, planned map[string]string) []MissingDependency {
	out := make([]MissingDependency, 0)
	for _, dep := range mf.SortedDependencies() {
		version, ok := planned[dep.ID]
		if !ok {
			out = append(out, MissingDependency{
				ID:         dep.ID,
				Constraint: dep.Constraint,
				Reason:     "未找到可用来源",
			})
			continue
		}
		constraint, cErr := semver.ParseConstraint(dep.Constraint)
		parsed, vErr := semver.Parse(version)
		if cErr == nil && vErr == nil && constraint.Check(parsed) {
			continue
		}
		out = append(out, MissingDependency{
			ID:         dep.ID,
			Constraint: dep.Constraint,
			Reason:     fmt.Sprintf("可用版本 %s 不满足约束", version),
		})
	}
	return out
}

// installCatalogLocked 构建依赖求解的候选集，并把「能去哪里取包」写进 localDirs。
//
// 返回值 scanned 是「安装时从同级目录扫描出来」的插件 id 集合：
// 这些包用户并没有显式选中，界面需要把它们和「新装」区分开。
func (m *Manager) installCatalogLocked(pending *pendingInstall, localDirs map[string]string) (*Catalog, map[string]struct{}) {
	catalog := m.localCatalogLocked()
	catalog.Add(pending.manifest)
	scanned := make(map[string]struct{})

	// 同批次待安装的其它包（用户一次选了多个目录 / 安装包）
	for _, other := range m.pending {
		if other == nil || other == pending || other.manifest == nil {
			continue
		}
		catalog.Add(other.manifest)
		if other.sourceDir != "" {
			localDirs[other.manifest.ID] = other.sourceDir
		}
	}

	// 本地目录插件的兄弟目录：开发时通常把若干插件放在同一个父目录下。
	//
	// 只按依赖 id 推测目录名逐个探测，不 ReadDir 父目录 ——
	// 父目录可能是 D:\Workspace 这种规模，遍历一次的代价远大于收益。
	if pending.sourceDir != "" {
		parent := filepath.Dir(pending.sourceDir)
		for _, dep := range pending.manifest.SortedDependencies() {
			if _, ok := localDirs[dep.ID]; ok {
				continue
			}
			dir, ok := resolveSiblingDir(parent, dep.ID, pending.sourceDir)
			if !ok {
				continue
			}
			sibling, err := LoadManifest(dir)
			if err != nil {
				continue
			}
			catalog.Add(sibling)
			localDirs[sibling.ID] = dir
			scanned[sibling.ID] = struct{}{}
		}
	}
	return catalog, scanned
}

// missingDependenciesLocked 列出清单里声明、但当前无法满足的依赖。
func (m *Manager) missingDependenciesLocked(mf *Manifest) []MissingDependency {
	out := make([]MissingDependency, 0)
	for _, dep := range mf.SortedDependencies() {
		rec, installed := m.records[dep.ID]
		if !installed {
			out = append(out, MissingDependency{
				ID:         dep.ID,
				Constraint: dep.Constraint,
				Reason:     "未安装",
			})
			continue
		}
		constraint, cErr := semver.ParseConstraint(dep.Constraint)
		version, vErr := semver.Parse(rec.Version)
		if cErr == nil && vErr == nil && constraint.Check(version) {
			continue
		}
		out = append(out, MissingDependency{
			ID:         dep.ID,
			Constraint: dep.Constraint,
			Reason:     fmt.Sprintf("已安装 %s，不满足约束", rec.Version),
		})
	}
	return out
}

// resolveSiblingDir 按依赖 id 推测同级的插件目录，命中即返回。
//
// 目录名只是推测（com.toolbox.connections 对应 connections），
// 所以命中后还要读一次清单核对 id，避免撞名装错插件。
func resolveSiblingDir(parent, pluginID, exclude string) (string, bool) {
	for _, name := range candidateDirNames(pluginID) {
		dir := filepath.Join(parent, name)
		if dir == exclude {
			continue
		}
		if info, err := os.Stat(filepath.Join(dir, ManifestFileName)); err != nil || info.IsDir() {
			continue
		}
		if mf, err := LoadManifest(dir); err == nil && mf.ID == pluginID {
			return dir, true
		}
	}
	return "", false
}

// candidateDirNames 由插件 id 推测可能的目录名。
//
// com.toolbox.connections → com.toolbox.connections / connections / toolbox-connections
func candidateDirNames(pluginID string) []string {
	parts := strings.Split(pluginID, ".")
	names := make([]string, 0, 3)
	names = append(names, pluginID)

	if len(parts) >= 2 {
		names = append(names, parts[len(parts)-1])
		names = append(names, strings.Join(parts[len(parts)-2:], "-"))
	}

	out := names[:0]
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if name == "" {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

// Install 执行安装或升级。
func (m *Manager) Install(ctx context.Context, req InstallRequest) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	pending, err := m.prepareLocked(ctx, req)
	if err != nil {
		return err
	}
	return m.installPendingLocked(ctx, pending, req)
}

// installPendingLocked 完成安装的准备结果落地：关卡校验 → 依赖求解 → 逐个落地。
//
// 调用方必须持有 m.mu。抽出来是为了让「从索引安装」与「从离线包安装」
// 共用完全相同的信任与权限关卡，避免两条路径出现安全策略分叉。
func (m *Manager) installPendingLocked(ctx context.Context, pending *pendingInstall, req InstallRequest) error {
	// 信任关卡：非官方且未被信任的来源必须显式确认
	if NeedTrustPrompt(pending.official, m.isTrustedLocked(pending.manifest.ID, pending.checksum)) && !req.Trust {
		return fmt.Errorf("%w: %s（请先确认信任该来源）", ErrUntrusted, pending.manifest.ID)
	}

	// 权限扩张关卡：升级引入新权限必须用户确认
	if added := m.addedPermissionsLocked(pending); len(added) > 0 && !req.AcceptPermissions {
		return fmt.Errorf("本次安装新增了权限，需要确认：%s", strings.Join(added, "；"))
	}

	// 依赖缺失不阻断安装：先把主包与能补上的依赖落地，
	// 缺失项由界面标红，补齐之前该插件不会被启用。
	plan, _ := m.resolvePlanLocked(ctx, pending)

	for _, item := range plan {
		if err := m.materializeLocked(ctx, item, pending); err != nil {
			return err
		}
	}

	if err := m.reloadLocked(ctx); err != nil {
		return err
	}

	// 安装完成后清理超出保留数的旧版本
	for _, item := range plan {
		if _, err := m.store.CleanupOldVersions(item.manifest.ID, 2); err != nil {
			slog.Warn("清理旧版本失败", "plugin", item.manifest.ID, "error", err)
		}
	}
	return nil
}

// materializeLocked 把单个插件落地到磁盘并写入安装记录。
func (m *Manager) materializeLocked(ctx context.Context, item *resolvedPackage, pending *pendingInstall) error {
	mf := item.manifest
	id, version := mf.ID, mf.Version

	existing, hadExisting := m.records[id]

	// 已经是目标版本且非主包重装：跳过
	if item.action == "keep" {
		return nil
	}

	pluginDir := m.store.PluginDir(id)
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		return fmt.Errorf("创建插件目录失败: %w", err)
	}

	// 本地目录来源（开发者模式）：直接复制到版本目录
	if item.dir != "" {
		staging := filepath.Join(pluginDir, fmt.Sprintf(".staging-%s-%d", version, time.Now().UnixNano()))
		if err := copyTree(item.dir, staging); err != nil {
			_ = os.RemoveAll(staging)
			return fmt.Errorf("复制插件目录失败: %w", err)
		}
		if err := m.commitStaging(id, version, staging, mf); err != nil {
			return err
		}
		return m.writeRecordLocked(id, version, pending, mf, item, existing, hadExisting)
	}

	// 需要内容：命中主包 payload，或从官方索引下载
	payload := item.payload
	if payload == nil && item.entry != nil {
		raw, err := m.market.DownloadPackage(ctx, item.entry.Download, item.entry.Checksum)
		if err != nil {
			return fmt.Errorf("下载插件包失败(%s): %w", id, err)
		}
		payload = raw
	}
	if payload == nil {
		return fmt.Errorf("插件 %s@%s 缺少安装包内容", id, version)
	}

	staging := filepath.Join(pluginDir, fmt.Sprintf(".staging-%s-%d", version, time.Now().UnixNano()))
	if err := ExtractPackage(payload, staging); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("解压插件包失败(%s): %w", id, err)
	}
	// 校验包内清单与计划一致，杜绝「挂羊头卖狗肉」
	inner, err := LoadManifest(staging)
	if err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("插件包内清单非法: %w", err)
	}
	if inner.ID != id || inner.Version != version {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("插件包内容与声明不一致：期望 %s@%s，实际 %s@%s",
			id, version, inner.ID, inner.Version)
	}
	if err := m.commitStaging(id, version, staging, inner); err != nil {
		return err
	}
	return m.writeRecordLocked(id, version, pending, inner, item, existing, hadExisting)
}

// commitStaging 把 staging 目录原子替换为正式的版本目录。
func (m *Manager) commitStaging(id, version, staging string, mf *Manifest) error {
	target := m.store.VersionDir(id, version)

	// 已存在同名版本：先移走再删除，避免半途失败后目录不可用
	if _, err := os.Stat(target); err == nil {
		backup := target + ".old-" + fmt.Sprint(time.Now().UnixNano())
		if err := os.Rename(target, backup); err != nil {
			return fmt.Errorf("替换已存在的插件版本失败: %w", err)
		}
		defer func() { _ = os.RemoveAll(backup) }()
	}

	if err := os.Rename(staging, target); err != nil {
		return fmt.Errorf("提交插件版本失败: %w", err)
	}
	slog.Info("插件已落地", "plugin", id, "version", mf.Version)
	return nil
}

// writeRecordLocked 写入安装记录。
func (m *Manager) writeRecordLocked(
	id, version string,
	pending *pendingInstall,
	mf *Manifest,
	item *resolvedPackage,
	existing *InstallRecord,
	hadExisting bool,
) error {
	rec := &InstallRecord{
		ID:          id,
		Version:     version,
		Publisher:   mf.Publisher,
		Enabled:     true,
		Trusted:     true, // 已通过 Install 的信任关卡
		TrustedAt:   nowRFC3339(),
		Permissions: mf.Permissions,
	}

	if hadExisting && existing != nil {
		rec.InstalledAt = existing.InstalledAt
		rec.Enabled = existing.Enabled
		rec.Trusted = existing.Trusted
		rec.TrustedAt = existing.TrustedAt
		/*
		 * 重装与升级都刷新 UpdatedAt。
		 *
		 * 它不只是展示用的时间戳：前端把它当作插件资源的缓存令牌
		 * （入口 URL 形如 /plugins/<id>/<version>/frontend/index.js?v=<updatedAt>）。
		 * 插件资源由宿主以 immutable 长缓存下发，ESM 模块本身也按 URL 缓存，
		 * 同版本重装若不刷新这个值，URL 不变 —— 浏览器直接复用已求值的旧模块，
		 * 表现就是「插件重装了但界面还是旧的」。
		 */
		rec.UpdatedAt = nowRFC3339()
		if existing.Version != version {
			rec.PreviousVersion = existing.Version
		}
	}

	// 主包使用本次来源信息，依赖包来自官方索引
	if item.primary && pending != nil {
		rec.Source = pending.source
		rec.SourceRef = pending.ref
		rec.Checksum = pending.checksum
		rec.Official = pending.official
		// 官方条目或用户已确认信任：这里统一按「主包需信任」处理
		rec.Trusted = true
		if pending.source == SourceRegistry {
			rec.Trusted = pending.official
			// 非官方条目在 Install 中已要求 req.Trust，因此视为已信任
			if !pending.official {
				rec.Trusted = true
			}
		}
	} else if item.entry != nil {
		rec.Source = SourceRegistry
		rec.SourceRef = item.entry.Repo
		rec.Checksum = NormalizeChecksum(item.entry.Checksum)
		rec.Official = item.entry.Official
		rec.Trusted = item.entry.Official
		if !item.entry.Official {
			// 依赖来自官方索引的第三方条目：继承主包的信任决定
			rec.Trusted = true
		}
	} else {
		rec.Source = SourceRegistry
		rec.Trusted = true
	}

	if err := m.store.WriteRecord(rec); err != nil {
		return err
	}
	m.records[id] = rec
	return nil
}

// addedPermissionsLocked 计算本次安装相对已安装版本新增的权限。
func (m *Manager) addedPermissionsLocked(pending *pendingInstall) []string {
	existing, ok := m.records[pending.manifest.ID]
	if !ok {
		return pending.manifest.Permissions.PermissionSummary()
	}
	current, err := m.store.LoadManifest(existing.ID, existing.Version)
	if err != nil {
		return pending.manifest.Permissions.PermissionSummary()
	}
	return PermissionDiff(current.Permissions, pending.manifest.Permissions)
}

// isTrustedLocked 报告插件是否已被本地信任（校验和一致才算）。
func (m *Manager) isTrustedLocked(id, checksum string) bool {
	rec, ok := m.records[id]
	if !ok || !rec.Trusted {
		return false
	}
	if checksum == "" || rec.Checksum == "" {
		return true
	}
	return strings.EqualFold(NormalizeChecksum(rec.Checksum), NormalizeChecksum(checksum))
}

// prepareLocked 完成一次安装的全部准备工作，并写入待安装缓存。
func (m *Manager) prepareLocked(ctx context.Context, req InstallRequest) (*pendingInstall, error) {
	switch strings.ToLower(strings.TrimSpace(req.Source)) {
	case SourceRegistry:
		return m.prepareFromRegistryLocked(ctx, req)
	case SourceURL:
		return m.prepareFromURLLocked(ctx, req)
	case SourceFile:
		return m.prepareFromFileLocked(req)
	case SourceLocalDir:
		return m.prepareFromLocalDirLocked(req)
	default:
		return nil, fmt.Errorf("未知的插件来源: %q", req.Source)
	}
}

// prepareFromRegistryLocked 从官方索引准备安装。
func (m *Manager) prepareFromRegistryLocked(ctx context.Context, req InstallRequest) (*pendingInstall, error) {
	if strings.TrimSpace(req.ID) == "" {
		return nil, fmt.Errorf("从插件市场安装需要提供插件 id")
	}
	index, verified, err := m.ensureIndexLocked(ctx, false)
	if err != nil {
		return nil, err
	}

	entry := m.pickRegistryEntry(index, req.ID, req.Version)
	if entry == nil {
		if req.Version != "" {
			return nil, fmt.Errorf("插件市场中不存在 %s@%s", req.ID, req.Version)
		}
		return nil, fmt.Errorf("插件市场中不存在 %s", req.ID)
	}
	if !verified && SignatureEnabled() {
		return nil, fmt.Errorf("插件索引签名校验未通过，已拒绝安装")
	}

	payload, err := m.market.DownloadPackage(ctx, entry.Download, entry.Checksum)
	if err != nil {
		return nil, err
	}

	staging, err := os.MkdirTemp("", "toolbox-plugin-*")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	if err := ExtractPackage(payload, staging); err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	mf, err := LoadManifest(staging)
	if err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	if mf.ID != entry.ID || mf.Version != entry.Version {
		_ = os.RemoveAll(staging)
		return nil, fmt.Errorf("插件包与索引记录不一致：索引为 %s@%s，包内为 %s@%s",
			entry.ID, entry.Version, mf.ID, mf.Version)
	}

	pending := &pendingInstall{
		createdAt: time.Now(),
		source:    SourceRegistry,
		ref:       entry.Download,
		manifest:  mf,
		checksum:  NormalizeChecksum(entry.Checksum),
		official:  entry.Official,
		signed:    strings.TrimSpace(entry.Signature) != "",
		payload:   payload,
		tempDir:   staging,
	}
	if entry.Signature == "" {
		pending.warnings = append(pending.warnings, "该条目未提供发布者签名")
	}
	if !entry.Official {
		pending.warnings = append(pending.warnings, "该插件未通过官方审核，请确认来源可信")
	}
	m.rememberPendingLocked(pending)
	return pending, nil
}

// prepareFromURLLocked 从任意 URL 准备安装。
func (m *Manager) prepareFromURLLocked(ctx context.Context, req InstallRequest) (*pendingInstall, error) {
	url := strings.TrimSpace(req.Ref)
	if url == "" {
		return nil, fmt.Errorf("从 URL 安装需要提供下载地址")
	}
	payload, err := m.market.DownloadPackage(ctx, url, "")
	if err != nil {
		return nil, err
	}
	return m.prepareFromPayloadLocked(SourceURL, url, payload, nil)
}

// prepareFromFileLocked 从本地安装包准备安装。
func (m *Manager) prepareFromFileLocked(req InstallRequest) (*pendingInstall, error) {
	path := strings.TrimSpace(req.Ref)
	if path == "" {
		return nil, fmt.Errorf("从文件安装需要提供安装包路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("读取安装包失败: %w", err)
	}
	if info.IsDir() {
		// 目录按本地开发目录处理，便于开发者直接指向源码目录
		return m.prepareFromLocalDirLocked(InstallRequest{Source: SourceLocalDir, Ref: path, Trust: req.Trust})
	}
	if info.Size() > maxPackageBytes {
		return nil, fmt.Errorf("安装包过大（> %d 字节）", maxPackageBytes)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取安装包失败: %w", err)
	}
	return m.prepareFromPayloadLocked(SourceFile, path, payload, nil)
}

// prepareFromLocalDirLocked 从本地目录准备安装（开发者模式）。
func (m *Manager) prepareFromLocalDirLocked(req InstallRequest) (*pendingInstall, error) {
	dir := strings.TrimSpace(req.Ref)
	if dir == "" {
		return nil, fmt.Errorf("本地目录安装需要提供目录路径")
	}

	mf, err := LoadManifest(dir)
	if err != nil {
		// 最常见的误操作是选中了「包含多个插件的父目录」。
		// 这时给出的原始错误是「找不到 manifest.json」，用户难以判断，
		// 因此这里探测一层子目录并直接指出应该选哪个。
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
	pending := &pendingInstall{
		createdAt: time.Now(),
		source:    SourceLocalDir,
		ref:       dir,
		manifest:  mf,
		official:  false,
		sourceDir: dir,
		warnings: []string{
			"这是来自本地目录的插件，未经过任何来源校验，仅供开发与自用。",
		},
	}
	m.rememberPendingLocked(pending)
	return pending, nil
}

// prepareFromPayloadLocked 从已获得的安装包内容准备安装。
func (m *Manager) prepareFromPayloadLocked(source, ref string, payload []byte, entry *RegistryEntry) (*pendingInstall, error) {
	staging, err := os.MkdirTemp("", "toolbox-plugin-*")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	if err := ExtractPackage(payload, staging); err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	mf, err := LoadManifest(staging)
	if err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	if err := validateEntries(staging, mf); err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}

	pending := &pendingInstall{
		createdAt: time.Now(),
		source:    source,
		ref:       ref,
		manifest:  mf,
		checksum:  HashBytes(payload),
		payload:   payload,
		tempDir:   staging,
	}
	if entry != nil {
		pending.official = entry.Official
		pending.signed = strings.TrimSpace(entry.Signature) != ""
	}
	m.rememberPendingLocked(pending)
	return pending, nil
}

// rememberPendingLocked 记录待安装项，并清理过期项。
func (m *Manager) rememberPendingLocked(pending *pendingInstall) {
	if m.pending == nil {
		m.pending = make(map[string]*pendingInstall)
	}
	// 清理过期缓存，顺带释放临时目录
	for key, item := range m.pending {
		if time.Since(item.createdAt) > pendingTTL {
			item.cleanup()
			delete(m.pending, key)
		}
	}
	m.pending[pending.cacheKey()] = pending
}

// pickRegistryEntry 在索引中挑选满足约束的最高版本。
func (m *Manager) pickRegistryEntry(index *RegistryIndex, id, version string) *RegistryEntry {
	if index == nil {
		return nil
	}
	// 指定版本：精确匹配
	if version != "" {
		return index.Find(id, version)
	}
	// 未指定：取最高版本
	var best *RegistryEntry
	var bestVer semver.Version
	for i := range index.Plugins {
		entry := &index.Plugins[i]
		if entry.ID != id {
			continue
		}
		v, err := semver.Parse(entry.Version)
		if err != nil {
			continue
		}
		if best == nil || v.Compare(bestVer) > 0 {
			best = entry
			bestVer = v
		}
	}
	return best
}

// validateEntries 校验清单声明的入口在插件目录内确实存在。
//
// 不做这一步会出现「安装成功但插件不可用」：前端入口缺失时工具不会被注册，
// 用户只看到菜单没出现，却拿不到任何错误提示（最容易发生在
// 直接安装未构建的插件源码目录时）。
func validateEntries(root string, mf *Manifest) error {
	exists := func(rel string) bool {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		return err == nil && !info.IsDir()
	}

	// 前端入口：显式声明就必须存在；声明了工具却没写入口时按默认路径校验
	frontend := mf.Runtime.Frontend
	if frontend == "" && len(mf.Contributes.Tools) > 0 {
		frontend = "frontend/index.js"
	}
	if frontend != "" && !exists(frontend) {
		return fmt.Errorf(
			"插件包内缺少前端入口 %s（若装的是插件源码目录，请先在插件仓库执行 pnpm build）",
			frontend)
	}

	if mf.BackendKind() != BackendNone {
		entry := mf.BackendEntry()
		if entry != "" && !exists(entry) {
			return fmt.Errorf("插件包内缺少后端入口 %s", entry)
		}
	}
	return nil
}

// subPluginDirs 列出目录下「自身含 manifest.json」的一级子目录（已排序）。
//
// 用于把「选中了父目录」这一误操作翻译成人能看懂的错误提示。
func subPluginDirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidate := filepath.Join(dir, entry.Name(), ManifestFileName)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			out = append(out, entry.Name())
		}
	}
	sort.Strings(out)
	return out
}

// localCatalogLocked 用本地已安装插件构建候选目录。
func (m *Manager) localCatalogLocked() *Catalog {
	c := NewCatalog()
	for _, mf := range m.manifests {
		c.Add(mf)
	}
	return c
}

// Uninstall 卸载插件。
//
// force 为 false 时，被其它插件依赖会拒绝卸载，并提示具体依赖方；
// force 为 true 时先停用全部依赖方（含传递依赖），再完成卸载。
//
// 返回值是被自动停用的插件 id，供前端提示用户；未强制卸载时恒为空。
func (m *Manager) Uninstall(ctx context.Context, id string, force bool) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.records[id]; !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}

	dependents := transitiveDependents(id, m.manifests)
	if len(dependents) > 0 && !force {
		return nil, fmt.Errorf("%w: %s（被 %s 依赖，可强制卸载，依赖它的插件会被自动停用）",
			ErrInUse, id, strings.Join(dependents, "、"))
	}

	/*
	 * 强制卸载：先把依赖方全部停用，再删被卸载的插件。
	 *
	 * 顺序不能反 —— 先删掉被依赖的插件，依赖方立刻处于「依赖缺失」的
	 * 坏状态（重新加载时会报依赖不满足）。停用是一个有记录的显式状态，
	 * 用户把依赖装回来后自己启用即可。
	 */
	disabled := make([]string, 0, len(dependents))
	for _, depID := range dependents {
		depRec, ok := m.records[depID]
		if !ok || !depRec.Enabled {
			continue
		}
		depRec.Enabled = false
		if err := m.store.WriteRecord(depRec); err != nil {
			return nil, err
		}
		disabled = append(disabled, depID)
	}

	if err := m.store.RemovePlugin(id); err != nil {
		return nil, err
	}
	slog.Info("插件已卸载", "plugin", id, "force", force, "disabled", disabled)
	return disabled, m.reloadLocked(ctx)
}

// transitiveDependents 求依赖 target 的插件闭包（直接 + 间接）。
//
// 只停用直接依赖方不够：A→B→C 时卸载 C，B 被停用，但 A 仍然指着 B，
// 照样跑不起来。闭包保证一次把整条链上的插件都停干净。
func transitiveDependents(target string, installed map[string]*Manifest) []string {
	seen := map[string]bool{target: true}
	queue := []string{target}
	var out []string
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, depID := range DependentsOf(cur, installed) {
			if seen[depID] {
				continue
			}
			seen[depID] = true
			out = append(out, depID)
			queue = append(queue, depID)
		}
	}
	sort.Strings(out)
	return out
}

// SetEnabled 启用或停用插件。
//
// 启用前会校验：已受信任、与宿主版本兼容、全部依赖已安装且已启用。
func (m *Manager) SetEnabled(ctx context.Context, id string, enabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	rec, ok := m.records[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}

	if enabled {
		if !rec.Trusted {
			return fmt.Errorf("%w: 请先信任插件 %s", ErrUntrusted, id)
		}
		mf := m.manifests[id]
		if mf == nil {
			return fmt.Errorf("插件 %s 的清单缺失或损坏", id)
		}
		if reason := m.incompatibleReason(mf); reason != "" {
			return fmt.Errorf("%w: %s", ErrIncompatible, reason)
		}
		if err := m.checkDependenciesReadyLocked(mf); err != nil {
			return err
		}
	}

	rec.Enabled = enabled
	if err := m.store.WriteRecord(rec); err != nil {
		return err
	}
	return m.reloadLocked(ctx)
}

// checkDependenciesReadyLocked 校验依赖是否都已安装、启用且版本满足约束。
func (m *Manager) checkDependenciesReadyLocked(mf *Manifest) error {
	for _, dep := range mf.SortedDependencies() {
		depRec, ok := m.records[dep.ID]
		if !ok {
			return fmt.Errorf("%w: %s 需要 %s@%s", ErrDependencyMissing, mf.ID, dep.ID, dep.Constraint)
		}
		if !depRec.Enabled {
			return fmt.Errorf("依赖 %s 已停用，请先启用它", dep.ID)
		}
		if !depRec.Trusted {
			return fmt.Errorf("%w: 依赖 %s 未被信任", ErrUntrusted, dep.ID)
		}
		constraint, err := semver.ParseConstraint(dep.Constraint)
		if err != nil {
			return fmt.Errorf("依赖 %s 的约束非法: %w", dep.ID, err)
		}
		version, err := semver.Parse(depRec.Version)
		if err != nil {
			return fmt.Errorf("依赖 %s 的已安装版本号非法: %q", dep.ID, depRec.Version)
		}
		if !constraint.Check(version) {
			return fmt.Errorf("%w: 依赖 %s 当前为 %s，不满足 %s",
				ErrDependencyConflict, dep.ID, depRec.Version, dep.Constraint)
		}
	}
	return nil
}

// SetTrusted 设置插件的信任状态。
func (m *Manager) SetTrusted(ctx context.Context, id string, trusted bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	rec, ok := m.records[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	rec.Trusted = trusted
	if trusted {
		rec.TrustedAt = nowRFC3339()
	} else {
		rec.TrustedAt = ""
	}
	if err := m.store.WriteRecord(rec); err != nil {
		return err
	}
	return m.reloadLocked(ctx)
}

// copyTree 递归复制目录（用于本地目录来源的插件）。
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(src, path)
		if relErr != nil {
			return relErr
		}
		target := filepath.Join(dst, rel)

		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
			return mkErr
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		return os.WriteFile(target, data, 0o644)
	})
}

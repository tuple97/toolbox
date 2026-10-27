package plugin

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"toolbox/app/internal/semver"
)

// 索引缓存策略。
const (
	// indexCacheTTL 索引缓存有效期。
	//
	// 刷新市场时不应每次都打网络：同一份索引在短期内直接复用。
	indexCacheTTL = 10 * time.Minute
	// indexFailureBackoff 索引读取失败后的退避时间。
	//
	// 避免用户反复点击刷新时把失败的请求一直打出去。
	indexFailureBackoff = 20 * time.Second
)

// sourceIndex 单个来源的索引缓存。
type sourceIndex struct {
	index    *RegistryIndex
	verified bool
	err      string
	loadedAt time.Time
}

// sourceIndexView 一次操作中「来源 + 索引 + 验签状态」的组合。
type sourceIndexView struct {
	Source   RegistrySource
	Index    *RegistryIndex
	Verified bool
}

// ---------------------------------------------------------------- 来源列表

// Sources 返回当前配置的插件源（含被禁用的）。
//
// 每一项都会带上「是否官方内置」的判定：官方源是宿主自带的信任基准，
// 界面据此隐藏删除入口。
func (m *Manager) Sources() []RegistrySource {
	m.indexMu.Lock()
	defer m.indexMu.Unlock()
	out := make([]RegistrySource, 0, len(m.sources))
	for _, src := range m.sources {
		src.Official = m.isOfficialURL(src.URL)
		out = append(out, src)
	}
	return out
}

// SetSources 整体替换插件源列表。
//
// 只做校验与缓存维护：保留仍在列表里的来源的索引缓存（单纯切换启用状态
// 不该白拉一次网络），丢弃已被移除的来源。
//
// 内置官方源会由 withOfficialSource 补回：它不可删除。
func (m *Manager) SetSources(sources []RegistrySource) error {
	normalized, err := NormalizeSources(sources)
	if err != nil {
		return err
	}
	normalized = m.withOfficialSource(normalized)

	m.indexMu.Lock()
	defer m.indexMu.Unlock()
	m.sources = normalized

	keep := make(map[string]struct{}, len(normalized))
	for _, src := range normalized {
		keep[src.URL] = struct{}{}
	}
	for url := range m.sourceIndexes {
		if _, ok := keep[url]; !ok {
			delete(m.sourceIndexes, url)
		}
	}
	return nil
}

// NormalizeSources 校验并归一化插件源列表（去空白、查重、限制协议）。
//
// 导出是为了让装配层在写库前就能拦下非法数据，避免坏数据落盘。
func NormalizeSources(sources []RegistrySource) ([]RegistrySource, error) {
	out := make([]RegistrySource, 0, len(sources))
	seen := make(map[string]struct{}, len(sources))
	for _, src := range sources {
		url := strings.TrimSpace(src.URL)
		if url == "" {
			return nil, fmt.Errorf("插件源地址不能为空")
		}
		if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
			return nil, fmt.Errorf("插件源地址必须以 http:// 或 https:// 开头: %s", url)
		}
		if _, dup := seen[url]; dup {
			return nil, fmt.Errorf("插件源地址重复: %s", url)
		}
		seen[url] = struct{}{}
		out = append(out, RegistrySource{
			URL:     url,
			Name:    strings.TrimSpace(src.Name),
			Enabled: src.Enabled,
		})
	}
	return out, nil
}

// isOfficialURL 报告某个地址是否为宿主内置的官方源。
//
// 官方源是验签强度的基准：只有它会在「配了公钥却没有签名」时直接拒绝。
func (m *Manager) isOfficialURL(url string) bool {
	return strings.EqualFold(strings.TrimSpace(url), strings.TrimSpace(m.client.Provider().IndexURL))
}

// withOfficialSource 保证内置官方源始终在列表里，且只出现一次。
//
// 官方源随宿主内置，界面上不提供删除入口；这里再兜一层，
// 历史配置或外部调用传进来的列表同样以它打底。
func (m *Manager) withOfficialSource(sources []RegistrySource) []RegistrySource {
	officialURL := strings.TrimSpace(m.client.Provider().IndexURL)
	out := make([]RegistrySource, 0, len(sources)+1)
	found := false
	for _, src := range sources {
		if !strings.EqualFold(strings.TrimSpace(src.URL), officialURL) {
			out = append(out, src)
			continue
		}
		if found {
			// 重复出现的官方源只保留第一条
			continue
		}
		found = true
		name := strings.TrimSpace(src.Name)
		if name == "" {
			name = OfficialSourceName
		}
		out = append(out, RegistrySource{
			URL:      officialURL,
			Name:     name,
			Enabled:  src.Enabled,
			Official: true,
		})
	}
	if !found {
		// 缺了就补在最前面：官方源是默认那一档，不该排到用户自建源后面
		out = append([]RegistrySource{{
			URL:      officialURL,
			Name:     OfficialSourceName,
			Enabled:  true,
			Official: true,
		}}, out...)
	}
	return out
}

// sourceName 返回来源的展示名，未命名时回落到地址。
func sourceName(src RegistrySource) string {
	if name := strings.TrimSpace(src.Name); name != "" {
		return name
	}
	return src.URL
}

// ---------------------------------------------------------------- 索引拉取

// sourceOf 按地址查找来源（调用方需持有 indexMu）。
func (m *Manager) sourceOf(url string) (RegistrySource, bool) {
	for _, src := range m.sources {
		if src.URL == url {
			return src, true
		}
	}
	return RegistrySource{}, false
}

// ensureSourceIndex 返回某个来源的索引（必要时联网刷新）。
//
// 调用方必须持有 indexMu。网络请求只占用这把锁，不阻塞插件状态读写，
// 也不长时间占用安装互斥锁。
func (m *Manager) ensureSourceIndex(ctx context.Context, src RegistrySource, force bool) (*RegistryIndex, bool, error) {
	now := time.Now()
	cached := m.sourceIndexes[src.URL]
	if cached == nil {
		cached = &sourceIndex{}
		m.sourceIndexes[src.URL] = cached
	}

	if !force && cached.index != nil && now.Sub(cached.loadedAt) < indexCacheTTL {
		return cached.index, cached.verified, nil
	}
	if !force && cached.index == nil && cached.err != "" && now.Sub(cached.loadedAt) < indexFailureBackoff {
		return nil, false, fmt.Errorf("%w: %s", ErrSourceUnavailable, cached.err)
	}

	var (
		index    *RegistryIndex
		verified bool
		err      error
	)
	if m.isOfficialURL(src.URL) {
		// 官方源：配了公钥就必须验签通过
		index, verified, err = m.client.FetchIndexAt(ctx, src.URL, m.client.Provider().SignatureURL, true)
	} else {
		// 用户自设来源：签名可选，但签名存在却验不过照样拒绝
		index, verified, err = m.client.FetchIndexAt(ctx, src.URL, "", false)
	}

	cached.loadedAt = now
	if err != nil {
		cached.err = err.Error()
		if cached.index == nil {
			return nil, false, err
		}
		// 已有可用缓存时保留旧索引，但把错误暴露出去
		return cached.index, cached.verified, err
	}
	cached.index = index
	cached.verified = verified
	cached.err = ""
	return index, verified, nil
}

// ensureSources 拉取指定来源（urls 为空时取全部已启用来源）的索引。
//
// 单个来源失败不会拖垮整体：错误记录在返回的 errs 里，成功的来源照常可用。
// 只有「一个都没成功」时由调用方判定为整体不可用。
func (m *Manager) ensureSources(ctx context.Context, urls []string, force bool) ([]sourceIndexView, map[string]error) {
	m.indexMu.Lock()
	defer m.indexMu.Unlock()

	wanted := urls
	if len(wanted) == 0 {
		wanted = make([]string, 0, len(m.sources))
		for _, src := range m.sources {
			if src.Enabled {
				wanted = append(wanted, src.URL)
			}
		}
	}

	views := make([]sourceIndexView, 0, len(wanted))
	errs := make(map[string]error)
	for _, url := range wanted {
		src, ok := m.sourceOf(url)
		if !ok {
			errs[url] = fmt.Errorf("%w: 未配置的插件源 %s", ErrSourceUnavailable, url)
			continue
		}
		index, verified, err := m.ensureSourceIndex(ctx, src, force)
		if err != nil {
			errs[url] = err
			if index == nil {
				continue
			}
		}
		views = append(views, sourceIndexView{Source: src, Index: index, Verified: verified})
	}
	return views, errs
}

// ensureSourcesForInstall 拉取「全部已启用来源 + 显式点选的来源」。
//
// 为什么显式点选的来源即使未启用也要拉：设置里可以浏览未启用的来源，
// 用户看到想装的插件时不该被「来源没启用」拦住 —— 他点的就是这一条。
func (m *Manager) ensureSourcesForInstall(ctx context.Context, explicit []string, force bool) ([]sourceIndexView, map[string]error) {
	m.indexMu.Lock()
	wanted := make([]string, 0, len(m.sources)+len(explicit))
	for _, src := range m.sources {
		if src.Enabled {
			wanted = append(wanted, src.URL)
		}
	}
	m.indexMu.Unlock()

	for _, url := range explicit {
		if !containsString(wanted, url) {
			wanted = append(wanted, url)
		}
	}
	return m.ensureSources(ctx, wanted, force)
}

// ------------------------------------------------------------ 条目挑选与合并

// bestEntry 跨来源挑选某插件最合适的条目：优先精确版本，否则版本最高。
//
// 版本相同时优先验签通过的来源（可信度更高），再按来源配置顺序。
func bestEntry(views []sourceIndexView, id, version string) (*RegistryEntry, sourceIndexView) {
	var best *RegistryEntry
	var bestView sourceIndexView
	for _, view := range views {
		entry := view.Index.Find(id, version)
		if entry == nil {
			continue
		}
		if best == nil {
			best, bestView = entry, view
			continue
		}
		cmp := compareVersions(entry.Version, best.Version)
		if cmp > 0 || (cmp == 0 && view.Verified && !bestView.Verified) {
			best, bestView = entry, view
		}
	}
	return best, bestView
}

// pickRegistryEntry 定位某个 registry 安装输入该用哪个来源的哪个条目。
//
//   - 指定了 sourceURL：只在该来源里找 —— 合并列表里同名插件会各占一条，
//     必须精确取用户点中的那条；
//   - 未指定（升级、依赖补齐）：跨来源挑版本最高的。
func pickRegistryEntry(views []sourceIndexView, sourceURL, id, version string) (*RegistryEntry, sourceIndexView, error) {
	if target := strings.TrimSpace(sourceURL); target != "" {
		for _, view := range views {
			if view.Source.URL != target {
				continue
			}
			entry := view.Index.Find(id, version)
			if entry == nil {
				return nil, view, fmt.Errorf("插件源 %s 中不存在 %s", sourceName(view.Source), describeVersion(id, version))
			}
			return entry, view, nil
		}
		return nil, sourceIndexView{}, fmt.Errorf("%w: 插件源不可用（%s）", ErrSourceUnavailable, target)
	}

	entry, view := bestEntry(views, id, version)
	if entry == nil {
		return nil, view, fmt.Errorf("插件市场中不存在 %s", describeVersion(id, version))
	}
	return entry, view, nil
}

// describeVersion 拼出「id 或 id@version」的提示文案。
func describeVersion(id, version string) string {
	if strings.TrimSpace(version) == "" {
		return id
	}
	return id + "@" + version
}

// ---------------------------------------------------------------- 市场快照

// Marketplace 返回插件市场快照（合并全部已启用来源）。
//
// refresh 为 true 时强制联网刷新；单个来源读取失败不会让整个插件管理界面
// 不可用，错误随快照返回，界面可提示并重试。
func (m *Manager) Marketplace(ctx context.Context, refresh bool) MarketplaceSnapshot {
	snapshot := MarketplaceSnapshot{
		State:            "idle",
		Sources:          []MarketplaceSource{},
		SignatureEnabled: SignatureEnabled(),
		Items:            []MarketplaceItem{},
	}

	views, errs := m.ensureSources(ctx, nil, refresh)
	snapshot.Sources = m.sourceStatuses(views, errs)

	// 一个已启用来源都没配：明确说明，而不是显示成「加载失败」
	enabledCount := 0
	for _, status := range snapshot.Sources {
		if status.Enabled {
			enabledCount++
		}
	}

	switch {
	case enabledCount == 0:
		snapshot.State = "idle"
		snapshot.Error = "尚未配置任何已启用的插件源"
		return snapshot
	case len(views) == 0:
		snapshot.State = "error"
		snapshot.Error = joinSourceErrors(snapshot.Sources)
		return snapshot
	}

	snapshot.State = "ready"
	if len(errs) > 0 {
		snapshot.Error = joinSourceErrors(snapshot.Sources)
	}

	items := make([]MarketplaceItem, 0, 32)
	for _, view := range views {
		items = append(items, m.itemsOf(view)...)
	}
	// 同名插件在多个来源里都会出现，按「插件 id → 来源」排序保证顺序稳定
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].ID != items[j].ID {
			return items[i].ID < items[j].ID
		}
		return items[i].SourceURL < items[j].SourceURL
	})
	snapshot.Items = items
	return snapshot
}

// SourceMarketplace 返回「单个来源」的插件列表（不看启用状态）。
//
// 用于设置里选中某个源时预览它提供哪些插件 —— 被禁用的来源同样可以查看，
// 否则用户无法在启用之前判断它值不值得信任。
func (m *Manager) SourceMarketplace(ctx context.Context, url string, refresh bool) (MarketplaceSource, []MarketplaceItem, error) {
	target := strings.TrimSpace(url)
	if target == "" {
		return MarketplaceSource{}, nil, fmt.Errorf("插件源地址不能为空")
	}

	views, errs := m.ensureSources(ctx, []string{target}, refresh)
	var (
		status MarketplaceSource
		found  bool
	)
	for _, item := range m.sourceStatuses(views, errs) {
		if item.URL == target {
			status, found = item, true
			break
		}
	}
	if !found {
		return MarketplaceSource{URL: target}, nil, fmt.Errorf("未配置的插件源: %s", target)
	}

	if status.State == "error" {
		return status, nil, fmt.Errorf("%w: %s", ErrSourceUnavailable, status.Error)
	}

	for _, view := range views {
		if view.Source.URL == target {
			return status, m.itemsOf(view), nil
		}
	}
	return status, []MarketplaceItem{}, nil
}

// sourceStatuses 汇总各来源状态（含被禁用的，便于设置里管理）。
//
// State 只描述「本次有没有读到索引」：ready 成功 / error 失败 / idle 未读取
// （通常是未启用的来源）；是否启用由 Enabled 单独表达，两者不要混为一谈。
func (m *Manager) sourceStatuses(views []sourceIndexView, errs map[string]error) []MarketplaceSource {
	byURL := make(map[string]sourceIndexView, len(views))
	for _, view := range views {
		byURL[view.Source.URL] = view
	}

	m.indexMu.Lock()
	defer m.indexMu.Unlock()

	out := make([]MarketplaceSource, 0, len(m.sources))
	for _, src := range m.sources {
		status := MarketplaceSource{
			URL:      src.URL,
			Name:     src.Name,
			Enabled:  src.Enabled,
			Official: m.isOfficialURL(src.URL),
			State:    "idle",
		}
		view, ok := byURL[src.URL]
		switch {
		case ok && view.Index != nil:
			status.State = "ready"
			status.Verified = view.Verified
			status.UpdatedAt = view.Index.UpdatedAt
			status.Count = len(view.Index.Plugins)
		case errs[src.URL] != nil:
			status.State = "error"
			status.Error = errs[src.URL].Error()
		default:
			// 未启用的来源可能留有历史缓存：仍展示上一次读到的规模
			if cached := m.sourceIndexes[src.URL]; cached != nil && cached.index != nil {
				status.Verified = cached.verified
				status.UpdatedAt = cached.index.UpdatedAt
				status.Count = len(cached.index.Plugins)
			}
		}
		out = append(out, status)
	}
	return out
}

// joinSourceErrors 把各来源的失败原因汇总成一句话。
func joinSourceErrors(statuses []MarketplaceSource) string {
	parts := make([]string, 0, len(statuses))
	for _, status := range statuses {
		if status.State != "error" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s：%s", sourceName(RegistrySource{URL: status.URL, Name: status.Name}), status.Error))
	}
	if len(parts) == 0 {
		return ""
	}
	return "部分插件源读取失败 —— " + strings.Join(parts, "；")
}

// itemsOf 把单个来源的索引条目转成市场条目（同 id 只取该来源的最高版本）。
//
// 刻意不跨来源去重：用户需要并排看到「官方源 v1.2.0」与「第三方源 v1.3.0」。
func (m *Manager) itemsOf(view sourceIndexView) []MarketplaceItem {
	latest := make(map[string]*RegistryEntry)
	for i := range view.Index.Plugins {
		entry := &view.Index.Plugins[i]
		current, ok := latest[entry.ID]
		if !ok || compareVersions(entry.Version, current.Version) > 0 {
			latest[entry.ID] = entry
		}
	}

	ids := make([]string, 0, len(latest))
	for id := range latest {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	m.mu.RLock()
	defer m.mu.RUnlock()

	items := make([]MarketplaceItem, 0, len(ids))
	for _, id := range ids {
		entry := latest[id]
		item := MarketplaceItem{
			ID:          entry.ID,
			Name:        entry.Name,
			Version:     entry.Version,
			Publisher:   entry.Publisher,
			Description: entry.Description,
			Icon:        entry.Icon,
			Homepage:    entry.Homepage,
			// official 只是索引自己的声明：来源没验签就不能当真，
			// 否则界面会给未验证来源的插件挂上「官方」标签。
			Official:       entry.Official && view.Verified,
			SourceURL:      view.Source.URL,
			SourceName:     sourceName(view.Source),
			SourceVerified: view.Verified,
			Permissions:    entry.Permissions.PermissionSummary(),
			Dependencies:   dependencyRefs(entry.Dependencies),
		}
		if rec, ok := m.records[id]; ok {
			item.Installed = true
			item.InstalledVersion = rec.Version
			item.Enabled = rec.Enabled
			item.Updatable = compareVersions(entry.Version, rec.Version) > 0
			if loaded, ok := m.loaded[id]; ok {
				item.Active = loaded.loadErr == "" && m.blocked[id] == ""
			}
		}
		items = append(items, item)
	}
	return items
}

// dependencyRefs 把依赖声明拼成「id@约束」并排序。
func dependencyRefs(deps map[string]string) []string {
	refs := make([]string, 0, len(deps))
	for depID, constraint := range deps {
		refs = append(refs, depID+"@"+constraint)
	}
	sort.Strings(refs)
	return refs
}

// ---------------------------------------------------------------- 更新检查

// CheckUpdates 返回可升级的插件列表（跨全部已启用来源取最高版本）。
func (m *Manager) CheckUpdates(ctx context.Context) ([]UpdateInfo, error) {
	views, errs := m.ensureSources(ctx, nil, false)
	if len(views) == 0 {
		if len(errs) > 0 {
			return nil, fmt.Errorf("%w: 全部插件源均不可用", ErrSourceUnavailable)
		}
		return nil, nil
	}

	var out []UpdateInfo
	m.mu.RLock()
	for id, rec := range m.records {
		entry, view := bestEntry(views, id, "")
		if entry == nil || compareVersions(entry.Version, rec.Version) <= 0 {
			continue
		}
		official := entry.Official && view.Verified
		info := UpdateInfo{
			ID:             id,
			CurrentVersion: rec.Version,
			LatestVersion:  entry.Version,
			Official:       official,
			SourceURL:      view.Source.URL,
			SourceName:     sourceName(view.Source),
			SourceVerified: view.Verified,
		}
		if current, ok := m.manifests[id]; ok {
			info.Name = current.Name
			info.AddedPermissions = PermissionDiff(current.Permissions, entry.Manifest().Permissions)
		}
		decision := DecideTrust(official, view.Verified, rec.IsTrusted())
		info.CanAutoUpgrade = !decision.NeedPrompt && rec.IsTrusted() && len(info.AddedPermissions) == 0
		out = append(out, info)
	}
	m.mu.RUnlock()

	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// compareVersions 比较版本号，无法解析时退化为字符串比较。
func compareVersions(left, right string) int {
	l, lErr := semver.Parse(left)
	r, rErr := semver.Parse(right)
	if lErr != nil || rErr != nil {
		return strings.Compare(left, right)
	}
	return l.Compare(r)
}

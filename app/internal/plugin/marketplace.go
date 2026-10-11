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

// ensureIndex 返回索引（必要时联网刷新）。
//
// 只持有 indexMu：网络请求不会阻塞插件状态的读写，
// 也不会长时间占用安装互斥锁。
func (m *Manager) ensureIndex(ctx context.Context, force bool) (*RegistryIndex, bool, error) {
	m.indexMu.Lock()
	defer m.indexMu.Unlock()

	now := time.Now()
	if !force && m.index != nil && now.Sub(m.indexLoadedAt) < indexCacheTTL {
		return m.index, m.indexVerified, nil
	}
	if !force && m.index == nil && m.indexErr != "" && now.Sub(m.indexLoadedAt) < indexFailureBackoff {
		return nil, false, fmt.Errorf("%w: %s", ErrSourceUnavailable, m.indexErr)
	}

	index, verified, err := m.client.FetchIndex(ctx)
	m.indexLoadedAt = now
	if err != nil {
		m.indexErr = err.Error()
		if m.index == nil {
			return nil, false, err
		}
		// 已有可用缓存时保留旧索引，但把错误暴露出去
		return m.index, m.indexVerified, err
	}
	m.index = index
	m.indexVerified = verified
	m.indexErr = ""
	return index, verified, nil
}

// RegistryURL 返回当前索引地址。
func (m *Manager) RegistryURL() string {
	m.indexMu.Lock()
	defer m.indexMu.Unlock()
	return m.client.Provider().IndexURL
}

// SetRegistryURL 更换索引地址（镜像）。
//
// 注意：更换地址不会改变宿主的验签公钥，镜像同样要提供能通过验签的索引。
func (m *Manager) SetRegistryURL(raw string) error {
	target := strings.TrimSpace(raw)
	if target == "" {
		target = DefaultRegistryIndexURL
	}
	if !strings.HasPrefix(target, "https://") && !strings.HasPrefix(target, "http://") {
		return fmt.Errorf("索引地址必须以 http:// 或 https:// 开头")
	}

	m.indexMu.Lock()
	defer m.indexMu.Unlock()
	m.client.SetProvider(RegistryProvider{IndexURL: target})
	// 索引来源变化：丢弃缓存，避免展示上一个来源的数据
	m.index = nil
	m.indexVerified = false
	m.indexErr = ""
	m.indexLoadedAt = time.Time{}
	return nil
}

// Marketplace 返回插件市场快照。
//
// refresh 为 true 时强制联网刷新索引；读取失败不会让整个插件管理界面不可用，
// 而是把错误放进快照里由界面提示并允许重试。
func (m *Manager) Marketplace(ctx context.Context, refresh bool) MarketplaceSnapshot {
	snapshot := MarketplaceSnapshot{
		State:            "idle",
		Source:           m.RegistryURL(),
		SignatureEnabled: SignatureEnabled(),
		Items:            []MarketplaceItem{},
	}

	index, verified, err := m.ensureIndex(ctx, refresh)
	if err != nil && index == nil {
		snapshot.State = "error"
		snapshot.Error = err.Error()
		snapshot.Verified = verified
		return snapshot
	}
	if index == nil {
		snapshot.State = "error"
		snapshot.Error = "插件索引不可用"
		return snapshot
	}

	snapshot.State = "ready"
	snapshot.UpdatedAt = index.UpdatedAt
	snapshot.Verified = verified
	if err != nil {
		snapshot.Error = err.Error()
	}

	// 同 id 只展示最高版本
	latest := make(map[string]*RegistryEntry)
	for i := range index.Plugins {
		entry := &index.Plugins[i]
		current, ok := latest[entry.ID]
		if !ok {
			latest[entry.ID] = entry
			continue
		}
		if compareVersions(entry.Version, current.Version) > 0 {
			latest[entry.ID] = entry
		}
	}

	m.mu.RLock()
	ids := make([]string, 0, len(latest))
	for id := range latest {
		ids = append(ids, id)
	}
	sort.Strings(ids)

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
			Official:    entry.Official,
			Permissions: entry.Permissions.PermissionSummary(),
			Dependencies: func() []string {
				refs := make([]string, 0, len(entry.Dependencies))
				for depID, constraint := range entry.Dependencies {
					refs = append(refs, depID+"@"+constraint)
				}
				sort.Strings(refs)
				return refs
			}(),
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
	m.mu.RUnlock()

	snapshot.Items = items
	return snapshot
}

// CheckUpdates 返回可升级的插件列表。
func (m *Manager) CheckUpdates(ctx context.Context) ([]UpdateInfo, error) {
	index, verified, err := m.ensureIndex(ctx, false)
	if err != nil && index == nil {
		return nil, err
	}
	if index == nil {
		return nil, fmt.Errorf("%w: 插件索引不可用", ErrSourceUnavailable)
	}

	var out []UpdateInfo
	m.mu.RLock()
	for id, rec := range m.records {
		entry := index.Latest(id)
		if entry == nil {
			continue
		}
		if compareVersions(entry.Version, rec.Version) <= 0 {
			continue
		}
		latest := entry.Manifest()
		info := UpdateInfo{
			ID:             id,
			CurrentVersion: rec.Version,
			LatestVersion:  entry.Version,
			Official:       entry.Official,
		}
		if current, ok := m.manifests[id]; ok {
			info.Name = current.Name
			info.AddedPermissions = PermissionDiff(current.Permissions, latest.Permissions)
		}
		decision := DecideTrust(entry.Official && verified, verified, rec.IsTrusted())
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

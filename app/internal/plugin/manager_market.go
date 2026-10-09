package plugin

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"toolbox/app/internal/semver"
)

// indexCacheTTL 官方索引的本地缓存时长。
//
// 插件管理页可能被反复打开，这里避免每次都打网络；
// 用户点击「刷新」会强制绕过缓存。
const indexCacheTTL = 10 * time.Minute

// indexFailureBackoff 索引拉取失败后的冷却时间。
//
// 拉取失败时索引缓存是空的（典型场景：索引托管在 GitHub raw，部分网络环境下
// 请求会一直挂到 12s 超时），若不冷却，每一次「检查更新 / 打开市场」都会重新
// 发起一次这样的请求 —— 而 ensureIndexLocked 的调用方全都持着 m.mu，
// 等于把安装、卸载、启停一起堵在锁上，界面表现就是「干什么都在转」。
//
// 冷却期内直接回放上次的错误；用户显式点「刷新索引 / 重试」会绕过冷却。
const indexFailureBackoff = 30 * time.Second

// ensureIndexLocked 获取官方索引（带缓存与失败冷却）。
//
// 网络失败时仍返回上一次成功拉取的索引（若有），
// 使离线场景下市场列表与升级检查仍可展示旧数据。
//
// force 为 true 时忽略缓存与失败冷却，强制联网拉取 ——
// 用户点「刷新索引 / 重试」时走这条路，否则冷却期内点重试会毫无反应。
func (m *Manager) ensureIndexLocked(ctx context.Context, force bool) (*RegistryIndex, bool, error) {
	if !force && m.index != nil && m.indexLoaded && time.Since(m.indexLoadedAt) < indexCacheTTL {
		return m.index, m.indexVerified, nil
	}

	// 失败冷却：见 indexFailureBackoff 的说明，这里是为了不反复把锁占满
	if !force && m.index == nil && m.indexErr != "" && time.Since(m.indexLoadedAt) < indexFailureBackoff {
		return nil, false, fmt.Errorf("%s", m.indexErr)
	}

	index, verified, err := m.market.FetchIndex(ctx)
	m.indexLoaded = true
	m.indexLoadedAt = time.Now()

	if err != nil {
		m.indexErr = err.Error()
		if m.index != nil {
			return m.index, m.indexVerified, err
		}
		return nil, false, err
	}

	m.index = index
	m.indexVerified = verified
	m.indexErr = ""
	return index, verified, nil
}

// SetRegistryIndexURL 更换官方索引地址（例如使用镜像）。
func (m *Manager) SetRegistryIndexURL(url string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.opts.Registry.IndexURL = strings.TrimSpace(url)
	m.market.SetProvider(m.opts.Registry)
	// 失效缓存，下次访问重新拉取
	m.index = nil
	m.indexLoaded = false
	m.indexVerified = false
	m.indexErr = ""
}

// RegistryIndexURL 返回当前索引地址。
func (m *Manager) RegistryIndexURL() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.opts.Registry.IndexURL
}

// Marketplace 返回插件市场快照（索引条目与本地安装状态的对比结果）。
//
// 网络失败不作为错误返回：快照自身以 state=error 表达失败，
// 前端据此展示「加载失败 + 重试」，而不是整页异常。
func (m *Manager) Marketplace(ctx context.Context, refresh bool) *MarketplaceSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()

	snap := &MarketplaceSnapshot{
		State:  "ready",
		Source: m.opts.Registry.IndexURL,
		Items:  []MarketplaceItem{},
	}

	// refresh 由用户显式触发（刷新索引 / 重试）：绕过缓存与失败冷却
	index, verified, err := m.ensureIndexLocked(ctx, refresh)
	snap.Verified = verified
	if err != nil {
		snap.State = "error"
		snap.Error = err.Error()
	}
	if index == nil {
		return snap
	}
	snap.UpdatedAt = index.UpdatedAt

	// 每个插件只展示最高版本
	latest := make(map[string]*RegistryEntry)
	for i := range index.Plugins {
		entry := &index.Plugins[i]
		current, ok := latest[entry.ID]
		if !ok {
			latest[entry.ID] = entry
			continue
		}
		curVer, curErr := semver.Parse(current.Version)
		newVer, newErr := semver.Parse(entry.Version)
		if curErr == nil && newErr == nil && newVer.Compare(curVer) > 0 {
			latest[entry.ID] = entry
		}
	}

	ids := make([]string, 0, len(latest))
	for id := range latest {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		entry := latest[id]
		item := MarketplaceItem{
			ID:           entry.ID,
			Name:         entry.Name,
			Version:      entry.Version,
			Publisher:    entry.Publisher,
			Description:  entry.Description,
			Icon:         entry.Icon,
			Homepage:     entry.Homepage,
			Official:     entry.Official,
			Permissions:  entry.Permissions.PermissionSummary(),
			Dependencies: dependencyStrings(entry.Dependencies),
		}

		if rec, ok := m.records[id]; ok {
			item.Installed = true
			item.InstalledVersion = rec.Version
			item.Enabled = rec.Enabled
			if cur, curErr := semver.Parse(rec.Version); curErr == nil {
				if next, nextErr := semver.Parse(entry.Version); nextErr == nil {
					item.Updatable = next.Compare(cur) > 0
				}
			}
		}
		snap.Items = append(snap.Items, item)
	}
	return snap
}

// CheckUpdates 检查全部已安装插件的可用更新。
func (m *Manager) CheckUpdates(ctx context.Context) ([]UpdateInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	index, _, err := m.ensureIndexLocked(ctx, false)
	if err != nil {
		return nil, err
	}
	if index == nil {
		return nil, fmt.Errorf("插件索引不可用")
	}

	ids := make([]string, 0, len(m.records))
	for id := range m.records {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]UpdateInfo, 0, len(ids))
	for _, id := range ids {
		rec := m.records[id]
		entry := m.pickRegistryEntry(index, id, "")
		if entry == nil {
			continue
		}
		current, curErr := semver.Parse(rec.Version)
		next, nextErr := semver.Parse(entry.Version)
		if curErr != nil || nextErr != nil || next.Compare(current) <= 0 {
			continue
		}

		info := UpdateInfo{
			ID:             id,
			Name:           entry.Name,
			CurrentVersion: rec.Version,
			LatestVersion:  entry.Version,
			Official:       entry.Official,
		}

		if currentManifest, mfErr := m.store.LoadManifest(id, rec.Version); mfErr == nil {
			info.AddedPermissions = PermissionDiff(currentManifest.Permissions, entry.Permissions)
		} else {
			info.AddedPermissions = entry.Permissions.PermissionSummary()
		}
		info.CanAutoUpgrade = len(info.AddedPermissions) == 0
		out = append(out, info)
	}
	return out, nil
}

// Upgrade 把插件升级到官方索引中的最新版本。
//
// acceptPermissions 表示用户已确认接受升级带来的新增权限。
func (m *Manager) Upgrade(ctx context.Context, id string, acceptPermissions bool) error {
	return m.Install(ctx, InstallRequest{
		Source:            SourceRegistry,
		ID:                id,
		AcceptPermissions: acceptPermissions,
		// 升级已安装插件时信任状态继承自既有记录，这里置 true 以通过信任关卡
		Trust: true,
	})
}

// Rollback 把插件回滚到上一个安装过的版本。
func (m *Manager) Rollback(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	rec, ok := m.records[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	if rec.PreviousVersion == "" {
		return fmt.Errorf("插件 %s 没有可回滚的历史版本", id)
	}
	versions, err := m.store.ListVersions(id)
	if err != nil {
		return err
	}
	found := false
	for _, v := range versions {
		if v == rec.PreviousVersion {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("插件 %s 的历史版本 %s 已不存在", id, rec.PreviousVersion)
	}

	previous := rec.PreviousVersion
	rec.Version = previous
	rec.PreviousVersion = ""
	rec.UpdatedAt = nowRFC3339()
	if err := m.store.WriteRecord(rec); err != nil {
		return err
	}
	return m.reloadLocked(ctx)
}

// dependencyStrings 把依赖表转为 "id@约束" 形式的展示字符串。
func dependencyStrings(deps map[string]string) []string {
	if len(deps) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(deps))
	for id, constraint := range deps {
		out = append(out, fmt.Sprintf("%s@%s", id, constraint))
	}
	sort.Strings(out)
	return out
}

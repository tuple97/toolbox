package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"toolbox/app/internal/semver"
)

// Storage 插件私有配置存储（由宿主持久化层实现）。
type Storage interface {
	Get(pluginID, key string) (string, bool, error)
	Set(pluginID, key, value string) error
	Delete(pluginID, key string) error
	List(pluginID string) (map[string]string, error)
}

// EventSink 应用事件出口（把插件事件送到前端总线）。
type EventSink interface {
	Emit(name string, payload any)
}

// Options 管理器装配参数。
type Options struct {
	// DataDir 应用数据目录
	DataDir string
	// AppVersion 宿主版本，用于 engines 兼容性判断
	AppVersion string
	// Registry 官方索引来源
	Registry RegistryProvider
	// Storage 插件私有配置存储
	Storage Storage
	// Events 事件出口
	Events EventSink
	// RuntimeFactory 运行时工厂；为空时使用内置实现
	RuntimeFactory RuntimeFactory
}

// loaded 单个已加载插件的运行时状态。
type loaded struct {
	manifest *Manifest
	runtime  Runtime
	bridge   *HostBridge
	loadErr  string
}

// Manager 插件体系的统一入口，同时实现 HostEnv。
//
// 锁的划分（避免联网操作把整个插件管理堵死）：
//   - mu：状态读写（records/manifests/loaded/graph），只做内存操作；
//   - installMu：安装、卸载、启停等会改磁盘的操作串行化；
//   - indexMu：索引缓存，网络请求只持有它。
type Manager struct {
	store  *Store
	client *RegistryClient
	opts   Options

	factory RuntimeFactory

	mu        sync.RWMutex
	records   map[string]*InstallRecord
	manifests map[string]*Manifest
	loaded    map[string]*loaded
	graph     *DepGraph
	blocked   map[string]string
	// recoverErr 启动恢复失败的原因（供界面提示）
	recoverErr string

	installMu sync.Mutex

	plans *planCache

	indexMu       sync.Mutex
	index         *RegistryIndex
	indexVerified bool
	indexErr      string
	indexLoadedAt time.Time
}

// NewManager 创建插件管理器。
func NewManager(opts Options) *Manager {
	if opts.RuntimeFactory == nil {
		opts.RuntimeFactory = defaultRuntimeFactory
	}
	if opts.Registry.IndexURL == "" {
		opts.Registry = DefaultRegistryProvider()
	}
	return &Manager{
		store:     NewStore(opts.DataDir),
		client:    NewRegistryClient(opts.Registry),
		opts:      opts,
		factory:   opts.RuntimeFactory,
		records:   make(map[string]*InstallRecord),
		manifests: make(map[string]*Manifest),
		loaded:    make(map[string]*loaded),
		blocked:   make(map[string]string),
		graph:     NewDepGraph(nil),
		plans:     newPlanCache(),
	}
}

// Store 返回底层插件仓库。
func (m *Manager) Store() *Store { return m.store }

// Startup 执行启动流程：恢复遗留事务 → 扫描磁盘 → 计算有效状态并加载。
//
// 插件体系是可选能力，恢复失败不应让应用起不来，因此错误只记录并暴露，
// 由插件管理页提示用户。
func (m *Manager) Startup(ctx context.Context) error {
	m.installMu.Lock()
	defer m.installMu.Unlock()

	if err := m.store.EnsureLayout(); err != nil {
		return err
	}

	recovered, err := m.store.RecoverTransactions()
	if err != nil {
		m.mu.Lock()
		m.recoverErr = err.Error()
		m.mu.Unlock()
		slog.Error("插件安装事务恢复失败", "error", err)
	}
	for _, item := range recovered {
		slog.Info("已恢复插件安装事务", "tx", item.ID, "state", item.State, "rolledBack", item.Rolled)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reloadLocked(ctx)
}

// RecoverError 返回启动恢复过程中遇到的问题（无则空串）。
func (m *Manager) RecoverError() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.recoverErr
}

// Reload 重新扫描磁盘并加载插件。
func (m *Manager) Reload(ctx context.Context) error {
	m.installMu.Lock()
	defer m.installMu.Unlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reloadLocked(ctx)
}

// reloadLocked 重新扫描磁盘、计算有效状态并按拓扑顺序加载。
//
// 调用方必须持有 m.mu（写锁）与 m.installMu。
func (m *Manager) reloadLocked(ctx context.Context) error {
	m.closeAllLocked()

	if err := m.store.EnsureLayout(); err != nil {
		return err
	}

	records, manifests := m.scan()
	m.records = records
	m.manifests = manifests
	m.graph = NewDepGraph(manifests)

	active, blocked := m.computeEffectiveLocked()
	m.blocked = blocked

	order, err := m.graph.OrderSubset(sortedKeys(active))
	if err != nil {
		// 循环依赖：整条链上都无法确定加载顺序，全部阻塞并给出原因
		for id := range active {
			blocked[id] = err.Error()
			delete(active, id)
		}
		slog.Error("插件依赖存在循环，相关插件不予加载", "error", err)
		return nil
	}

	loaded := make(map[string]struct{}, len(order))
	for _, mf := range order {
		if dep := firstUnloadedDep(mf, loaded); dep != "" {
			blocked[mf.ID] = fmt.Sprintf("依赖 %s 未能加载", dep)
			delete(active, mf.ID)
			continue
		}
		item := m.loadPlugin(ctx, mf)
		m.loaded[mf.ID] = item
		if item.loadErr != "" {
			blocked[mf.ID] = item.loadErr
			delete(active, mf.ID)
			slog.Error("插件加载失败", "plugin", mf.ID, "error", item.loadErr)
			continue
		}
		loaded[mf.ID] = struct{}{}
		if item.runtime == nil {
			slog.Info("插件已加载（纯前端）", "plugin", mf.ID, "version", mf.Version)
		} else {
			slog.Info("插件已加载", "plugin", mf.ID, "version", mf.Version,
				"handlers", item.runtime.Handlers())
		}
	}
	return nil
}

// scan 读取磁盘上的安装记录与清单。
//
// 任何一条记录或清单损坏都只影响该插件：它会被保留在状态列表里，
// 但标记为不可用（界面据此提示用户重新安装）。
func (m *Manager) scan() (map[string]*InstallRecord, map[string]*Manifest) {
	ids, err := m.store.ListIDs()
	if err != nil {
		slog.Error("读取插件目录失败", "error", err)
		return map[string]*InstallRecord{}, map[string]*Manifest{}
	}

	records := make(map[string]*InstallRecord, len(ids))
	manifests := make(map[string]*Manifest, len(ids))

	for _, id := range ids {
		rec, recErr := m.store.ReadRecord(id)
		if recErr != nil {
			slog.Warn("读取插件安装记录失败，已跳过", "plugin", id, "error", recErr)
			continue
		}
		if rec.Version == "" || !m.store.HasVersion(id, rec.Version) {
			slog.Warn("插件记录指向的版本目录不存在", "plugin", id, "version", rec.Version)
			rec.Enabled = false
			records[id] = rec
			continue
		}
		mf, mfErr := m.store.LoadManifest(id, rec.Version)
		if mfErr != nil {
			slog.Warn("读取插件清单失败，已标记不可用", "plugin", id, "error", mfErr)
			rec.Enabled = false
			records[id] = rec
			continue
		}
		if mf.ID != id {
			slog.Warn("插件清单中的 id 与目录不一致，已标记不可用", "plugin", id, "manifestID", mf.ID)
			rec.Enabled = false
			records[id] = rec
			continue
		}
		records[id] = rec
		manifests[id] = mf
	}
	return records, manifests
}

// computeEffectiveLocked 计算「实际可运行」的插件集合与阻塞原因。
//
// 规则：用户启用只是必要条件；还必须通过信任、兼容性与完整依赖闭包检查，
// 否则记录会被阻塞并给出原因。enabled 不等于实际运行状态。
func (m *Manager) computeEffectiveLocked() (map[string]struct{}, map[string]string) {
	active := make(map[string]struct{})
	blocked := make(map[string]string)

	for id, rec := range m.records {
		if !rec.Enabled {
			continue
		}
		mf := m.manifests[id]
		switch {
		case mf == nil:
			blocked[id] = "插件清单缺失或损坏"
			continue
		case !rec.IsTrusted():
			blocked[id] = "插件未被信任"
			continue
		}
		if reason := m.incompatibleReason(mf); reason != "" {
			blocked[id] = reason
			continue
		}
		active[id] = struct{}{}
	}

	// 依赖闭包检查：依赖必须同样处于「启用 + 可信 + 兼容」状态
	for changed := true; changed; {
		changed = false
		for id := range active {
			mf := m.manifests[id]
			if mf == nil {
				delete(active, id)
				blocked[id] = "插件清单缺失或损坏"
				changed = true
				continue
			}
			if reason := m.dependencyBlockReasonLocked(mf, active); reason != "" {
				delete(active, id)
				blocked[id] = reason
				changed = true
			}
		}
	}
	return active, blocked
}

// dependencyBlockReasonLocked 返回依赖闭包不满足的原因；满足时返回空串。
func (m *Manager) dependencyBlockReasonLocked(mf *Manifest, active map[string]struct{}) string {
	for _, dep := range mf.SortedDependencies() {
		rec, installed := m.records[dep.ID]
		if !installed {
			return fmt.Sprintf("依赖 %s 未安装", dep.ID)
		}
		if !rec.Enabled {
			return fmt.Sprintf("依赖 %s 已被停用", dep.ID)
		}
		if _, ok := active[dep.ID]; !ok {
			return fmt.Sprintf("依赖 %s 当前不可用", dep.ID)
		}
		constraint, err := semver.ParseConstraint(dep.Constraint)
		if err != nil {
			return fmt.Sprintf("依赖 %s 的约束非法", dep.ID)
		}
		version, vErr := semver.Parse(rec.Version)
		if vErr != nil {
			return fmt.Sprintf("依赖 %s 的已安装版本号非法", dep.ID)
		}
		if !constraint.Check(version) {
			return fmt.Sprintf("依赖 %s 当前为 %s，不满足 %s", dep.ID, rec.Version, dep.Constraint)
		}
	}
	return ""
}

// loadPlugin 创建并启动单个插件的运行时。
func (m *Manager) loadPlugin(ctx context.Context, mf *Manifest) *loaded {
	item := &loaded{manifest: mf}

	kind := mf.BackendKind()
	if kind == BackendNone {
		return item // 纯前端插件，无需后端运行时
	}
	if kind != BackendJS {
		item.loadErr = fmt.Sprintf("不支持的后端运行时: %q", kind)
		return item
	}

	runtime, err := m.factory(mf.Runtime)
	if err != nil {
		item.loadErr = err.Error()
		return item
	}

	entry := mf.BackendEntry()
	source, err := m.store.ReadAsset(mf.ID, mf.Version, entry)
	if err != nil {
		item.loadErr = fmt.Sprintf("读取后端入口失败: %v", err)
		_ = runtime.Close()
		return item
	}

	bridge := NewHostBridge(m, mf.ID, mf.Version, mf.Permissions)
	if err := runtime.Start(ctx, bridge, source); err != nil {
		item.loadErr = err.Error()
		_ = runtime.Close()
		return item
	}

	item.runtime = runtime
	item.bridge = bridge
	return item
}

// closeAllLocked 关闭全部运行时。
func (m *Manager) closeAllLocked() {
	for id, item := range m.loaded {
		if item.runtime != nil {
			if err := item.runtime.Close(); err != nil {
				slog.Warn("关闭插件运行时失败", "plugin", id, "error", err)
			}
		}
	}
	m.loaded = make(map[string]*loaded)
}

// Close 释放全部运行时。
func (m *Manager) Close() error {
	m.installMu.Lock()
	defer m.installMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeAllLocked()
	return nil
}

// Invoke 调用插件自己注册的后端 handler（前端绑定走这里）。
func (m *Manager) Invoke(ctx context.Context, id, handler string, args json.RawMessage) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	// 外部调用是新的调用栈起点
	if CallTraceFrom(ctx) == nil {
		ctx = WithCallTrace(ctx, NewCallTrace())
	}

	m.mu.RLock()
	rec, ok := m.records[id]
	item, loadedOK := m.loaded[id]
	blocked := m.blocked[id]
	m.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	if !rec.Enabled {
		return nil, fmt.Errorf("%w: %s", ErrDisabled, id)
	}
	if !loadedOK || item.runtime == nil {
		reason := blocked
		if reason == "" {
			reason = "插件未加载"
		}
		if item != nil && item.loadErr != "" {
			reason = item.loadErr
		}
		return nil, fmt.Errorf("%w: %s：%s", ErrBlocked, id, reason)
	}
	return item.runtime.Call(ctx, handler, args)
}

// ListInstalled 返回全部已安装插件的完整信息。
func (m *Manager) ListInstalled() []InstalledInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.listInstalledLocked()
}

func (m *Manager) listInstalledLocked() []InstalledInfo {
	ids := sortedKeys(m.records)
	out := make([]InstalledInfo, 0, len(ids))

	for _, id := range ids {
		rec := m.records[id]
		mf := m.manifests[id]

		info := InstalledInfo{
			ID:                  id,
			Enabled:             rec.Enabled,
			Trusted:             rec.IsTrusted(),
			TrustLevel:          string(rec.Trust),
			Official:            rec.Official,
			Source:              rec.Source,
			SourceRef:           rec.SourceRef,
			Installed:           rec.InstalledAt,
			Updated:             rec.UpdatedAt,
			PreviousVersion:     rec.PreviousVersion,
			Permissions:         []string{},
			Dependencies:        []DependencyRef{},
			MissingDependencies: []MissingDependency{},
			SidebarGroups:       []SidebarGroup{},
			Tools:               []ToolContribution{},
			Commands:            []CommandContribution{},
			Settings:            []SettingContribution{},
			SettingsPanels:      []SettingsPanelContribution{},
			MCPTools:            []MCPToolContribution{},
			Handlers:            []string{},
			Exports:             []string{},
			InUseBy:             []string{},
			Compatible:          true,
		}

		if rec.Trust == TrustOfficial {
			info.TrustReason = "官方索引条目，索引签名校验通过"
		} else if rec.Trust == TrustUser {
			info.TrustReason = "由你确认信任的来源"
		} else {
			info.TrustReason = "尚未信任"
		}

		if mf != nil {
			info.Name = mf.Name
			info.Version = mf.Version
			info.Publisher = mf.Publisher
			info.Description = mf.Description
			info.Author = mf.Author
			info.Homepage = mf.Homepage
			info.License = mf.License
			info.Icon = mf.Icon
			info.Engines = mf.Engines
			info.Runtime = mf.Runtime
			info.Exports = append([]string{}, mf.Runtime.Exports...)
			info.Permissions = mf.Permissions.PermissionSummary()
			info.Dependencies = mf.SortedDependencies()
			info.MissingDependencies = m.missingDependenciesLocked(mf)
			info.ManifestOutdated = mf.Legacy()
			if mf.Contributes.Sidebar != nil {
				info.SidebarGroups = mf.Contributes.Sidebar.Groups
			}
			info.Tools = mf.Contributes.Tools
			info.Commands = mf.Contributes.Commands
			info.Settings = mf.Contributes.Settings
			info.SettingsPanels = mf.Contributes.SettingsPanels
			if mf.Contributes.MCP != nil {
				info.MCPTools = mf.Contributes.MCP.Tools
			}
			if reason := m.incompatibleReason(mf); reason != "" {
				info.Compatible = false
				info.IncompatReason = reason
			}
			info.InUseBy = m.graph.Dependents(id)
		} else {
			info.Version = rec.Version
			info.LoadError = "插件清单缺失或损坏"
		}

		if item, ok := m.loaded[id]; ok {
			info.Loaded = item.runtime != nil && item.loadErr == ""
			if item.loadErr != "" {
				info.LoadError = item.loadErr
			}
			if item.runtime != nil {
				info.Handlers = item.runtime.Handlers()
			}
		}

		// 有效状态：用户启用只是必要条件，还要满足信任、兼容与完整依赖闭包，
		// 并且（有后端时）运行时确实加载成功。
		blockReason := m.blocked[id]
		active := rec.Enabled && rec.IsTrusted() && info.Compatible &&
			blockReason == "" && mf != nil
		if active && mf.BackendKind() != BackendNone {
			active = info.Loaded
		}
		info.Active = active
		info.BlockedReason = blockReason
		if !rec.Enabled {
			info.BlockedReason = ""
		}

		out = append(out, info)
	}
	return out
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

// incompatibleReason 返回与宿主 / 插件 API 不兼容的原因；兼容时返回空串。
func (m *Manager) incompatibleReason(mf *Manifest) string {
	if mf == nil {
		return ""
	}
	if reason := m.checkVersionConstraint(mf.Engines.Toolbox, m.opts.AppVersion, "应用"); reason != "" {
		return reason
	}
	return m.checkVersionConstraint(mf.Engines.PluginAPI, PluginAPIVersion, "插件 API")
}

// checkVersionConstraint 校验单个版本约束。
func (m *Manager) checkVersionConstraint(constraint, current, label string) string {
	if strings.TrimSpace(constraint) == "" {
		return ""
	}
	cur, err := semver.Parse(current)
	if err != nil {
		// 宿主版本号非法（开发构建常见）时不做拦截
		return ""
	}
	parsed, err := semver.ParseConstraint(constraint)
	if err != nil {
		return fmt.Sprintf("清单中的 %s 版本约束非法", label)
	}
	if !parsed.Check(cur) {
		return fmt.Sprintf("需要%s版本 %s，当前为 %s", label, constraint, current)
	}
	return ""
}

// PluginManifest 返回已安装插件的当前清单（未安装返回 nil）。
func (m *Manager) PluginManifest(id string) *Manifest {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.manifests[id]
}

// RuntimeHandlers 返回指定插件已注册的 handler 名（供诊断）。
func (m *Manager) RuntimeHandlers(id string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if item, ok := m.loaded[id]; ok && item.runtime != nil {
		return item.runtime.Handlers()
	}
	return nil
}

// ---------------------------------------------------------------- HostEnv 实现

// AppVersion 实现 HostEnv。
func (m *Manager) AppVersion() string { return m.opts.AppVersion }

// StorageGet 实现 HostEnv。
func (m *Manager) StorageGet(pluginID, key string) (string, bool, error) {
	if m.opts.Storage == nil {
		return "", false, fmt.Errorf("插件存储不可用")
	}
	return m.opts.Storage.Get(pluginID, key)
}

// StorageSet 实现 HostEnv。
func (m *Manager) StorageSet(pluginID, key, value string) error {
	if m.opts.Storage == nil {
		return fmt.Errorf("插件存储不可用")
	}
	return m.opts.Storage.Set(pluginID, key, value)
}

// StorageDelete 实现 HostEnv。
func (m *Manager) StorageDelete(pluginID, key string) error {
	if m.opts.Storage == nil {
		return fmt.Errorf("插件存储不可用")
	}
	return m.opts.Storage.Delete(pluginID, key)
}

// StorageList 实现 HostEnv。
func (m *Manager) StorageList(pluginID string) (map[string]string, error) {
	if m.opts.Storage == nil {
		return nil, fmt.Errorf("插件存储不可用")
	}
	return m.opts.Storage.List(pluginID)
}

// ClearPluginData 清除某个插件的全部私有配置（卸载默认不清理，需显式调用）。
func (m *Manager) ClearPluginData(id string) error {
	if m.opts.Storage == nil {
		return fmt.Errorf("插件存储不可用")
	}
	all, err := m.opts.Storage.List(id)
	if err != nil {
		return err
	}
	keys := make([]string, 0, len(all))
	for key := range all {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := m.opts.Storage.Delete(id, key); err != nil {
			return err
		}
	}
	return nil
}

// EmitEvent 实现 HostEnv，事件名加 "plugin:" 前缀避免与内置事件冲突。
func (m *Manager) EmitEvent(pluginID, name string, payload any) error {
	if m.opts.Events == nil {
		return nil
	}
	m.opts.Events.Emit("plugin:"+pluginID+":"+name, payload)
	return nil
}

// CallPlugin 实现 HostEnv：在依赖关系与公开接口约束下调用另一个插件。
func (m *Manager) CallPlugin(ctx context.Context, callerID, targetID, handler string, args json.RawMessage) (json.RawMessage, error) {
	if callerID == "" || targetID == "" || handler == "" {
		return nil, fmt.Errorf("调用插件需要提供调用方、目标插件与 handler 名")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if CallTraceFrom(ctx) == nil {
		ctx = WithCallTrace(ctx, NewCallTrace())
	}

	m.mu.RLock()
	caller := m.manifests[callerID]
	target := m.manifests[targetID]
	targetRec := m.records[targetID]
	targetItem := m.loaded[targetID]
	targetBlocked := m.blocked[targetID]
	m.mu.RUnlock()

	if caller == nil {
		return nil, fmt.Errorf("%w: 调用方 %s 未安装", ErrNotInstalled, callerID)
	}
	if callerID != targetID {
		// 跨插件调用必须先声明依赖：知道 id 不等于可以随意调用
		constraint, declared := caller.Dependencies[targetID]
		if !declared {
			return nil, fmt.Errorf("%w: 插件 %s 未声明对 %s 的依赖",
				ErrPermissionDenied, callerID, targetID)
		}
		if targetRec == nil {
			return nil, fmt.Errorf("%w: %s", ErrNotInstalled, targetID)
		}
		parsed, err := semver.ParseConstraint(constraint)
		version, vErr := semver.Parse(targetRec.Version)
		if err != nil || vErr != nil || !parsed.Check(version) {
			return nil, fmt.Errorf("%w: %s 当前为 %s，不满足 %s 声明的 %s",
				ErrDependencyConflict, targetID, targetRec.Version, callerID, constraint)
		}
		// 只有目标插件显式公开的 handler 才能被跨插件调用
		if !target.ExportsHandler(handler) {
			return nil, fmt.Errorf("%w: %s 未公开 handler %q（需在清单 runtime.exports 中声明）",
				ErrNotExported, targetID, handler)
		}
	}

	if targetItem == nil || targetItem.runtime == nil {
		reason := targetBlocked
		if reason == "" {
			reason = "目标插件未加载"
		}
		return nil, fmt.Errorf("%w: %s：%s", ErrBlocked, targetID, reason)
	}

	// 递归深度限制由调用方（HostBridge）按插件自身计数，见 HostBridge.CallPlugin
	return targetItem.runtime.Call(ctx, handler, args)
}

// EnabledPlugins 实现 HostEnv。
func (m *Manager) EnabledPlugins() []PluginSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]PluginSummary, 0, len(m.loaded))
	for id, item := range m.loaded {
		if item.manifest == nil || m.blocked[id] != "" {
			continue
		}
		if item.runtime == nil && item.loadErr != "" {
			continue
		}
		out = append(out, PluginSummary{
			ID:      id,
			Name:    item.manifest.Name,
			Version: item.manifest.Version,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ---------------------------------------------------------------- 工具

// firstUnloadedDep 返回清单里第一个尚未成功加载的依赖。
func firstUnloadedDep(mf *Manifest, loaded map[string]struct{}) string {
	for _, dep := range mf.SortedDependencies() {
		if _, ok := loaded[dep.ID]; !ok {
			return dep.ID
		}
	}
	return ""
}

// sortedKeys 泛化的 map 键排序。
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
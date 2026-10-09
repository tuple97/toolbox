package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
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
	// DataDir 应用数据目录（插件装在 <DataDir>/plugins 下）
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
type Manager struct {
	mu sync.RWMutex

	store *Store
	opts  Options

	factory RuntimeFactory

	// 已安装插件的安装记录与清单（以磁盘状态为准）
	records   map[string]*InstallRecord
	manifests map[string]*Manifest
	// 已加载的运行时（仅启用且受信任的插件）
	loaded map[string]*loaded

	// 官方索引缓存
	market        *Market
	index         *RegistryIndex
	indexVerified bool
	indexErr      string
	indexLoaded   bool
	indexLoadedAt time.Time

	// pending 待安装缓存：Preview 与 Install 之间复用已下载/已解包的内容
	pending map[string]*pendingInstall
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
		opts:      opts,
		factory:   opts.RuntimeFactory,
		records:   make(map[string]*InstallRecord),
		manifests: make(map[string]*Manifest),
		loaded:    make(map[string]*loaded),
		market:    NewMarket(opts.Registry),
	}
}

// Store 返回底层插件仓库。
func (m *Manager) Store() *Store { return m.store }

// Reload 重新扫描磁盘并加载所有已启用且受信任的插件。
func (m *Manager) Reload(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reloadLocked(ctx)
}

func (m *Manager) reloadLocked(ctx context.Context) error {
	m.closeAllLocked()

	if err := m.store.EnsureRoot(); err != nil {
		return err
	}

	records, manifests, err := m.scanLocked()
	if err != nil {
		return err
	}
	m.records = records
	m.manifests = manifests

	// 只加载「启用 + 受信任 + 兼容」的插件
	candidates := make(map[string]*Manifest)
	for id, rec := range records {
		mf := manifests[id]
		if mf == nil || !rec.Enabled || !rec.Trusted {
			continue
		}
		if reason := m.incompatibleReason(mf); reason != "" {
			slog.Warn("插件与当前版本不兼容，已跳过加载", "plugin", id, "reason", reason)
			continue
		}
		candidates[id] = mf
	}

	// 拓扑排序：依赖先加载。存在环时退化为按 id 顺序加载，避免整体不可用。
	ordered, topoErr := TopoSort(candidates)
	if topoErr != nil {
		slog.Error("插件依赖存在循环，按 id 顺序加载", "error", topoErr)
		ordered = sortManifestsByID(candidates)
	}

	for _, mf := range ordered {
		item := m.loadPluginLocked(ctx, mf, records[mf.ID])
		m.loaded[mf.ID] = item

		switch {
		case item.loadErr != "":
			slog.Error("插件加载失败", "plugin", mf.ID, "error", item.loadErr)
		case item.runtime == nil:
			// 纯前端插件没有后端运行时，属正常状态
			slog.Info("插件已加载（纯前端）", "plugin", mf.ID, "version", mf.Version)
		default:
			slog.Info("插件已加载", "plugin", mf.ID, "version", mf.Version,
				"handlers", item.runtime.Handlers())
		}
	}
	return nil
}

// scanLocked 读取磁盘上的安装记录与清单。
func (m *Manager) scanLocked() (map[string]*InstallRecord, map[string]*Manifest, error) {
	ids, err := m.store.ListIDs()
	if err != nil {
		return nil, nil, err
	}

	records := make(map[string]*InstallRecord, len(ids))
	manifests := make(map[string]*Manifest, len(ids))

	for _, id := range ids {
		rec, recErr := m.store.ReadRecord(id)
		if recErr != nil {
			slog.Warn("读取插件安装记录失败，已跳过", "plugin", id, "error", recErr)
			continue
		}
		mf, mfErr := m.store.LoadManifest(id, rec.Version)
		if mfErr != nil {
			slog.Warn("读取插件清单失败，已标记不可用", "plugin", id, "error", mfErr)
			rec.Enabled = false
			records[id] = rec
			continue
		}
		records[id] = rec
		manifests[id] = mf
	}
	return records, manifests, nil
}

// loadPluginLocked 创建并启动单个插件的运行时。
func (m *Manager) loadPluginLocked(ctx context.Context, mf *Manifest, rec *InstallRecord) *loaded {
	item := &loaded{manifest: mf}

	kind := mf.BackendKind()
	if kind == BackendNone {
		return item // 纯前端插件，无需后端运行时
	}

	runtime, err := m.factory(kind)
	if err != nil {
		item.loadErr = err.Error()
		return item
	}

	entry := mf.BackendEntry()
	source, err := m.store.ReadAsset(mf.ID, mf.Version, entry)
	if err != nil {
		item.loadErr = fmt.Sprintf("读取后端入口失败: %v", err)
		return item
	}

	perms := mf.Permissions
	bridge := NewHostBridge(m, mf.ID, mf.Version, perms)
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
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeAllLocked()
	return nil
}

// Invoke 调用插件注册的后端 handler。
func (m *Manager) Invoke(_ context.Context, id, handler string, args json.RawMessage) (json.RawMessage, error) {
	m.mu.RLock()
	rec, ok := m.records[id]
	item, loadedOK := m.loaded[id]
	m.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}
	if !rec.Enabled {
		return nil, fmt.Errorf("%w: %s", ErrDisabled, id)
	}
	if !loadedOK || item.runtime == nil {
		reason := "插件未加载"
		if loadedOK && item.loadErr != "" {
			reason = item.loadErr
		}
		return nil, fmt.Errorf("插件 %s 不可用: %s", id, reason)
	}
	return item.runtime.Call(context.Background(), handler, args)
}

// ListInstalled 返回全部已安装插件的完整信息。
func (m *Manager) ListInstalled() []InstalledInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.listInstalledLocked()
}

func (m *Manager) listInstalledLocked() []InstalledInfo {
	ids := make([]string, 0, len(m.records))
	for id := range m.records {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]InstalledInfo, 0, len(ids))
	for _, id := range ids {
		rec := m.records[id]
		mf := m.manifests[id]

		info := InstalledInfo{
			ID:                  id,
			Enabled:             rec.Enabled,
			Trusted:             rec.Trusted,
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
			InUseBy:             []string{},
			Compatible:          true,
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
			info.Permissions = mf.Permissions.PermissionSummary()
			info.Dependencies = mf.SortedDependencies()
			info.MissingDependencies = m.missingDependenciesLocked(mf)
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
			info.InUseBy = DependentsOf(id, m.manifests)
		} else {
			info.Version = rec.Version
			info.LoadError = "插件清单缺失或损坏"
		}

		if item, ok := m.loaded[id]; ok {
			info.Loaded = item.runtime != nil
			info.LoadError = item.loadErr
			if item.runtime != nil {
				info.Handlers = item.runtime.Handlers()
			}
		}

		out = append(out, info)
	}
	return out
}

// incompatibleReason 返回与宿主版本不兼容的原因；兼容时返回空串。
func (m *Manager) incompatibleReason(mf *Manifest) string {
	if mf == nil || mf.Engines.Toolbox == "" {
		return ""
	}
	current, err := semver.Parse(m.opts.AppVersion)
	if err != nil {
		// 宿主版本号非法（开发构建常见）时不做拦截
		return ""
	}
	constraint, err := semver.ParseConstraint(mf.Engines.Toolbox)
	if err != nil {
		return "清单中的 engines.toolbox 约束非法"
	}
	if !constraint.Check(current) {
		return fmt.Sprintf("需要应用版本 %s，当前为 %s", mf.Engines.Toolbox, m.opts.AppVersion)
	}
	return ""
}

// sortManifestsByID 按插件 id 排序，作为拓扑排序失败时的兜底顺序。
func sortManifestsByID(items map[string]*Manifest) []*Manifest {
	ids := make([]string, 0, len(items))
	for id := range items {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*Manifest, 0, len(ids))
	for _, id := range ids {
		out = append(out, items[id])
	}
	return out
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

// EmitEvent 实现 HostEnv，事件名加 "plugin:" 前缀避免与内置事件冲突。
func (m *Manager) EmitEvent(pluginID, name string, payload any) error {
	if m.opts.Events == nil {
		return nil
	}
	m.opts.Events.Emit("plugin:"+pluginID+":"+name, payload)
	return nil
}

// CallPlugin 实现 HostEnv：调用另一个插件的 handler。
func (m *Manager) CallPlugin(pluginID, handler string, args json.RawMessage) (json.RawMessage, error) {
	return m.Invoke(context.Background(), pluginID, handler, args)
}

// EnabledPlugins 实现 HostEnv。
func (m *Manager) EnabledPlugins() []PluginSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]PluginSummary, 0, len(m.loaded))
	for id, item := range m.loaded {
		if item.manifest == nil {
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

// RuntimeHandlers 返回指定插件已注册的 handler 名（供诊断）。
func (m *Manager) RuntimeHandlers(id string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if item, ok := m.loaded[id]; ok && item.runtime != nil {
		return item.runtime.Handlers()
	}
	return nil
}

// PluginManifest 返回已安装插件的当前清单（未安装返回 nil）。
func (m *Manager) PluginManifest(id string) *Manifest {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.manifests[id]
}

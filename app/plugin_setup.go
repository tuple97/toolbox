package app

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"toolbox/app/internal/database"
	"toolbox/app/internal/plugin"
)

// settingKeyPluginSources 插件源列表在 app_settings 里的键（JSON 数组）。
const settingKeyPluginSources = "plugin_sources"

// 插件体系的装配层：把宿主的存储与事件总线接到管理器上。
// 依赖注入走 plugin.Storage / plugin.EventSink 两个窄接口，
// 因此插件内核不感知 SQLite 与 Wails，可独立测试。

// pluginStorage 把本地仓储适配为插件私有配置存储。
type pluginStorage struct {
	repo *database.Repository
}

// Get 实现 plugin.Storage。
func (s pluginStorage) Get(pluginID, key string) (string, bool, error) {
	return s.repo.PluginSettingGet(pluginID, key)
}

// Set 实现 plugin.Storage。
func (s pluginStorage) Set(pluginID, key, value string) error {
	return s.repo.PluginSettingSet(pluginID, key, value)
}

// Delete 实现 plugin.Storage。
func (s pluginStorage) Delete(pluginID, key string) error {
	return s.repo.PluginSettingDelete(pluginID, key)
}

// List 实现 plugin.Storage。
func (s pluginStorage) List(pluginID string) (map[string]string, error) {
	return s.repo.PluginSettingList(pluginID)
}

// pluginEvents 把 Wails 事件总线适配为插件事件出口。
type pluginEvents struct {
	app *App
}

// Emit 实现 plugin.EventSink。
func (e pluginEvents) Emit(name string, payload any) {
	if e.app == nil || e.app.wailsApp == nil {
		return
	}
	e.app.wailsApp.Event.Emit(name, payload)
}

// setupPlugins 创建插件管理器。插件是可选能力，失败不影响应用启动。
func (a *App) setupPlugins(repo *database.Repository, dataDir string) {
	if repo == nil || dataDir == "" {
		return
	}

	a.plugins = plugin.NewManager(plugin.Options{
		DataDir:    dataDir,
		AppVersion: NormalizedVersion(),
		Registry:   plugin.DefaultRegistryProvider(),
		Sources:    loadPluginSources(repo),
		Storage:    pluginStorage{repo: repo},
		Events:     pluginEvents{app: a},
	})
}

// loadPluginSources 读取用户配置的插件源列表。
//
// 返回 nil 表示「没有（可用的）配置」：管理器会退化成只有内置官方源。
// 存量数据被改坏时同样返回 nil，只记日志 —— 插件源坏了不该让应用起不来。
func loadPluginSources(repo *database.Repository) []plugin.RegistrySource {
	setting, err := repo.GetSetting(settingKeyPluginSources)
	if err != nil || setting == nil {
		return nil
	}
	raw := strings.TrimSpace(setting.Value)
	if raw == "" || raw == "[]" {
		return nil
	}

	var sources []plugin.RegistrySource
	if err := json.Unmarshal([]byte(raw), &sources); err != nil {
		slog.Warn("插件源配置不是合法 JSON，回落到内置官方源", "error", err)
		return nil
	}
	normalized, err := plugin.NormalizeSources(sources)
	if err != nil {
		slog.Warn("插件源配置非法，回落到内置官方源", "error", err)
		return nil
	}
	if len(normalized) == 0 {
		return nil
	}
	return normalized
}

// savePluginSources 把插件源列表写入本地配置（SQLite）。
func (a *App) savePluginSources(sources []plugin.RegistrySource) error {
	if a.settings == nil {
		return nil
	}
	raw, err := json.Marshal(sources)
	if err != nil {
		return fmt.Errorf("序列化插件源失败: %w", err)
	}
	if err := a.settings.Save(settingKeyPluginSources, string(raw)); err != nil {
		return fmt.Errorf("插件源已更新，但保存到本地配置失败: %w", err)
	}
	return nil
}

package app

import (
	"toolbox/app/internal/database"
	"toolbox/app/internal/plugin"
)

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
		Storage:    pluginStorage{repo: repo},
		Events:     pluginEvents{app: a},
	})
}

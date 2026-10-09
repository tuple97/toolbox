package app

import (
	"toolbox/app/internal/database"
)

// ---------------------------------------------------------------- Tab 工作台

// ListTabs 返回全部工作台 Tab。
func (a *App) ListTabs() ([]database.Tab, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.tabs.List()
}

// SaveTabs 全量保存 Tab 列表，返回带真实 ID 的列表
func (a *App) SaveTabs(tabs []database.Tab) ([]database.Tab, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.tabs.SaveAll(tabs)
}

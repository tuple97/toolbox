package app

import (
	"toolbox/app/internal/database"
)

// ---------------------------------------------------------------- 全局配置

// GetAllSettings 返回全部应用配置
func (a *App) GetAllSettings() ([]database.Setting, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.settings.ListAll()
}

// SaveSetting 写入单个配置项。
func (a *App) SaveSetting(key string, value string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.settings.Save(key, value)
}

package database

import (
	"database/sql"
	"fmt"
)

// 插件私有配置的持久化。
//
// 插件安装记录（版本、来源、信任状态）随插件目录一起放在磁盘上的
// .install.json 里，目的是让「卸载＝删目录」这一步足够直观、
// 且插件目录可以整体拷贝迁移。因此这里只持久化插件运行期的私有配置。

// PluginSettingGet 读取插件的某项私有配置。
func (r *Repository) PluginSettingGet(pluginID, key string) (string, bool, error) {
	row := r.db.conn.QueryRow(`
		SELECT config_value FROM plugin_settings
		WHERE plugin_id = ? AND config_key = ?`, pluginID, key)

	var value string
	if err := row.Scan(&value); err != nil {
		if err == sql.ErrNoRows {
			return "", false, nil
		}
		return "", false, fmt.Errorf("读取插件配置失败(%s/%s): %w", pluginID, key, err)
	}
	return value, true, nil
}

// PluginSettingSet 写入或更新插件的私有配置。
func (r *Repository) PluginSettingSet(pluginID, key, value string) error {
	_, err := r.db.conn.Exec(`
		INSERT INTO plugin_settings (plugin_id, config_key, config_value)
		VALUES (?, ?, ?)
		ON CONFLICT(plugin_id, config_key) DO UPDATE SET
			config_value = excluded.config_value`,
		pluginID, key, value)
	if err != nil {
		return fmt.Errorf("保存插件配置失败(%s/%s): %w", pluginID, key, err)
	}
	return nil
}

// PluginSettingDelete 删除插件的某项私有配置。
func (r *Repository) PluginSettingDelete(pluginID, key string) error {
	if _, err := r.db.conn.Exec(`
		DELETE FROM plugin_settings WHERE plugin_id = ? AND config_key = ?`,
		pluginID, key); err != nil {
		return fmt.Errorf("删除插件配置失败(%s/%s): %w", pluginID, key, err)
	}
	return nil
}

// PluginSettingList 返回插件的全部私有配置。
func (r *Repository) PluginSettingList(pluginID string) (map[string]string, error) {
	rows, err := r.db.conn.Query(`
		SELECT config_key, config_value FROM plugin_settings
		WHERE plugin_id = ? ORDER BY config_key ASC`, pluginID)
	if err != nil {
		return nil, fmt.Errorf("查询插件配置失败(%s): %w", pluginID, err)
	}
	defer rows.Close()

	out := make(map[string]string)
	for rows.Next() {
		var key, value string
		if scanErr := rows.Scan(&key, &value); scanErr != nil {
			return nil, fmt.Errorf("解析插件配置行失败: %w", scanErr)
		}
		out[key] = value
	}
	return out, rows.Err()
}

// PluginSettingDeleteAll 删除插件的全部配置（卸载插件时清理）。
func (r *Repository) PluginSettingDeleteAll(pluginID string) error {
	if _, err := r.db.conn.Exec(`
		DELETE FROM plugin_settings WHERE plugin_id = ?`, pluginID); err != nil {
		return fmt.Errorf("清理插件配置失败(%s): %w", pluginID, err)
	}
	return nil
}

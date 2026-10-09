package database

import (
	"database/sql"
	"fmt"
)

// ListSettings 返回全部配置项
func (r *Repository) ListSettings() ([]Setting, error) {
	rows, err := r.db.conn.Query(`
		SELECT config_key, config_type, config_value
		FROM app_settings ORDER BY config_key ASC`)
	if err != nil {
		return nil, fmt.Errorf("查询 app_settings 失败: %w", err)
	}
	defer rows.Close()

	list := make([]Setting, 0)
	for rows.Next() {
		var s Setting
		if scanErr := rows.Scan(&s.Key, &s.Type, &s.Value); scanErr != nil {
			return nil, fmt.Errorf("解析配置行失败: %w", scanErr)
		}
		list = append(list, s)
	}
	return list, rows.Err()
}

// GetSetting 按 key 返回配置项，不存在时返回 sql.ErrNoRows
func (r *Repository) GetSetting(key string) (*Setting, error) {
	row := r.db.conn.QueryRow(`
		SELECT config_key, config_type, config_value
		FROM app_settings WHERE config_key = ?`, key)

	var s Setting
	if err := row.Scan(&s.Key, &s.Type, &s.Value); err != nil {
		if err == sql.ErrNoRows {
			return nil, err
		}
		return nil, fmt.Errorf("查询配置 %s 失败: %w", key, err)
	}
	return &s, nil
}

// UpsertSetting 写入或更新配置项
func (r *Repository) UpsertSetting(s Setting) error {
	_, err := r.db.conn.Exec(`
		INSERT INTO app_settings (config_key, config_type, config_value)
		VALUES (?, ?, ?)
		ON CONFLICT(config_key) DO UPDATE SET
			config_type = excluded.config_type,
			config_value = excluded.config_value`,
		s.Key, s.Type, s.Value)
	if err != nil {
		return fmt.Errorf("保存配置 %s 失败: %w", s.Key, err)
	}
	return nil
}

// CountSettings 返回配置项数量
func (r *Repository) CountSettings() (int, error) {
	var count int
	if err := r.db.conn.QueryRow(`SELECT COUNT(*) FROM app_settings`).Scan(&count); err != nil {
		return 0, fmt.Errorf("统计配置项失败: %w", err)
	}
	return count, nil
}

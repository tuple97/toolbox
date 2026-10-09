package database

import (
	"fmt"
)

// 工作台标签（tabs 表）的读写

// ListTabs 按排序返回全部 Tab
func (r *Repository) ListTabs() ([]Tab, error) {
	rows, err := r.db.conn.Query(`
		SELECT id, name, sort_order, is_active, is_locked, tool_type, payload, schema_version
		FROM tabs ORDER BY sort_order ASC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("查询 tabs 失败: %w", err)
	}
	defer rows.Close()

	tabs := make([]Tab, 0)
	for rows.Next() {
		var t Tab
		if scanErr := rows.Scan(
			&t.ID, &t.Name, &t.SortOrder, &t.IsActive, &t.IsLocked,
			&t.ToolType, &t.Payload, &t.SchemaVersion,
		); scanErr != nil {
			return nil, fmt.Errorf("解析 tab 行失败: %w", scanErr)
		}
		tabs = append(tabs, t)
	}
	return tabs, rows.Err()
}

// SaveTabs 整体覆盖保存 Tab 列表，返回写库后的实际数据（ID>0 保留原 ID，ID<=0 由库分配并回填）
func (r *Repository) SaveTabs(tabs []Tab) ([]Tab, error) {
	tx, err := r.db.conn.Begin()
	if err != nil {
		return nil, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM tabs`); err != nil {
		return nil, fmt.Errorf("清空 tabs 失败: %w", err)
	}

	existingStmt, err := tx.Prepare(`
		INSERT INTO tabs (id, name, sort_order, is_active, is_locked, tool_type, payload, schema_version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return nil, fmt.Errorf("准备插入语句失败: %w", err)
	}
	defer existingStmt.Close()

	newStmt, err := tx.Prepare(`
		INSERT INTO tabs (name, sort_order, is_active, is_locked, tool_type, payload, schema_version)
		VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return nil, fmt.Errorf("准备插入语句失败: %w", err)
	}
	defer newStmt.Close()

	result := make([]Tab, 0, len(tabs))
	for i, t := range tabs {
		version := t.SchemaVersion
		if version <= 0 {
			version = 1
		}

		updated := t
		updated.SortOrder = i

		if t.ID > 0 {
			if _, execErr := existingStmt.Exec(
				t.ID, t.Name, i, boolToInt(t.IsActive), boolToInt(t.IsLocked),
				t.ToolType, t.Payload, version,
			); execErr != nil {
				return nil, fmt.Errorf("写入 tab(%s) 失败: %w", t.Name, execErr)
			}
		} else {
			res, execErr := newStmt.Exec(
				t.Name, i, boolToInt(t.IsActive), boolToInt(t.IsLocked),
				t.ToolType, t.Payload, version,
			)
			if execErr != nil {
				return nil, fmt.Errorf("写入 tab(%s) 失败: %w", t.Name, execErr)
			}

			newID, idErr := res.LastInsertId()
			if idErr != nil {
				return nil, fmt.Errorf("获取 tab(%s) 新 ID 失败: %w", t.Name, idErr)
			}
			updated.ID = newID
		}

		result = append(result, updated)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("提交事务失败: %w", err)
	}
	return result, nil
}

const (
	defaultPageSize = 50
	maxPageSize     = 1000
)

// normalizePageSize 把页大小约束到合法区间
func normalizePageSize(size int) int {
	if size <= 0 {
		return defaultPageSize
	}
	if size > maxPageSize {
		return maxPageSize
	}
	return size
}

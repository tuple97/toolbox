package database

import (
	"fmt"
)

// 词典（dictionaries / dictionary_items 表）的读写。

// ListDictionaries 返回全部词典
func (r *Repository) ListDictionaries() ([]Dictionary, error) {
	rows, err := r.db.conn.Query(`
		SELECT id, name, COALESCE(description, '') FROM dictionaries ORDER BY id ASC`)
	if err != nil {
		return nil, fmt.Errorf("查询 dictionaries 失败: %w", err)
	}
	defer rows.Close()

	list := make([]Dictionary, 0)
	for rows.Next() {
		var d Dictionary
		if scanErr := rows.Scan(&d.ID, &d.Name, &d.Description); scanErr != nil {
			return nil, fmt.Errorf("解析词典行失败: %w", scanErr)
		}
		list = append(list, d)
	}
	return list, rows.Err()
}

// SaveDictionary 新增或更新词典，返回记录 ID
func (r *Repository) SaveDictionary(d Dictionary) (int64, error) {
	if d.ID > 0 {
		_, err := r.db.conn.Exec(
			`UPDATE dictionaries SET name = ?, description = ? WHERE id = ?`,
			d.Name, d.Description, d.ID)
		if err != nil {
			return 0, fmt.Errorf("更新词典失败: %w", err)
		}
		return d.ID, nil
	}

	res, err := r.db.conn.Exec(
		`INSERT INTO dictionaries (name, description) VALUES (?, ?)`,
		d.Name, d.Description)
	if err != nil {
		return 0, fmt.Errorf("新增词典失败: %w", err)
	}
	return res.LastInsertId()
}

// DeleteDictionary 删除词典，其下词典项级联删除
func (r *Repository) DeleteDictionary(id int64) error {
	if _, err := r.db.conn.Exec(`DELETE FROM dictionaries WHERE id = ?`, id); err != nil {
		return fmt.Errorf("删除词典失败: %w", err)
	}
	return nil
}

// ListDictionaryItems 返回指定词典的全部项
func (r *Repository) ListDictionaryItems(dictionaryID int64) ([]DictionaryItem, error) {
	rows, err := r.db.conn.Query(`
		SELECT id, dictionary_id, value, meaning, COALESCE(description, ''), sort_order
		FROM dictionary_items WHERE dictionary_id = ? ORDER BY sort_order ASC, id ASC`, dictionaryID)
	if err != nil {
		return nil, fmt.Errorf("查询 dictionary_items 失败: %w", err)
	}
	defer rows.Close()

	list := make([]DictionaryItem, 0)
	for rows.Next() {
		var item DictionaryItem
		if scanErr := rows.Scan(
			&item.ID, &item.DictionaryID, &item.Value, &item.Meaning,
			&item.Description, &item.SortOrder,
		); scanErr != nil {
			return nil, fmt.Errorf("解析词典项失败: %w", scanErr)
		}
		list = append(list, item)
	}
	return list, rows.Err()
}

// SaveDictionaryItems 整体覆盖保存某词典下的全部项
func (r *Repository) SaveDictionaryItems(dictionaryID int64, items []DictionaryItem) error {
	tx, err := r.db.conn.Begin()
	if err != nil {
		return fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM dictionary_items WHERE dictionary_id = ?`, dictionaryID); err != nil {
		return fmt.Errorf("清空词典项失败: %w", err)
	}

	stmt, err := tx.Prepare(`
		INSERT INTO dictionary_items (dictionary_id, value, meaning, description, sort_order)
		VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("准备插入语句失败: %w", err)
	}
	defer stmt.Close()

	for i, item := range items {
		if _, err := stmt.Exec(dictionaryID, item.Value, item.Meaning, item.Description, i); err != nil {
			return fmt.Errorf("写入词典项(%s) 失败: %w", item.Value, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交事务失败: %w", err)
	}
	return nil
}

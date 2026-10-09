package database

import (
	"database/sql"
	"fmt"
)

// db_connections 表读写与行扫描（密码字段为密文，加解密在 services 层）

// ListConnections 返回全部数据库连接
func (r *Repository) ListConnections() ([]DBConnection, error) {
	rows, err := r.db.conn.Query(`
		SELECT ` + connectionColumns + `
		FROM db_connections ORDER BY id ASC`)
	if err != nil {
		return nil, fmt.Errorf("查询 db_connections 失败: %w", err)
	}
	defer rows.Close()

	list := make([]DBConnection, 0)
	for rows.Next() {
		item, scanErr := scanConnection(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		list = append(list, item)
	}
	return list, rows.Err()
}

// GetConnection 按 ID 返回单个连接。
func (r *Repository) GetConnection(id int64) (*DBConnection, error) {
	row := r.db.conn.QueryRow(`
		SELECT `+connectionColumns+`
		FROM db_connections WHERE id = ?`, id)

	item, err := scanConnection(row)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("连接不存在: %d", id)
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// SaveConnection 新增或更新连接，返回记录 ID。
func (r *Repository) SaveConnection(c DBConnection) (int64, error) {
	// 入库前归一环境标识，保证三者互斥
	c.normalizeEnvMark()

	if c.ID > 0 {
		_, err := r.db.conn.Exec(`
			UPDATE db_connections
			SET name = ?, db_type = ?, host = ?, port = ?, database = ?, username = ?, password = ?, extra = ?,
			    note = ?, color = ?, charset = ?, default_schema = ?,
			    connect_timeout_secs = ?, query_timeout_secs = ?, keepalive_secs = ?,
			    ssl_mode = ?, ssl_ca_path = ?, ssl_cert_path = ?, ssl_key_path = ?, url_params = ?,
			    read_only = ?, is_local = ?, is_test = ?, is_production = ?
			WHERE id = ?`,
			c.Name, c.DBType, c.Host, c.Port, c.Database, c.Username, c.Password, c.Extra,
			c.Note, c.Color, c.Charset, c.DefaultSchema,
			c.ConnectTimeoutSecs, c.QueryTimeoutSecs, c.KeepaliveSecs,
			c.SSLMode, c.SSLCaPath, c.SSLCertPath, c.SSLKeyPath, c.URLParams,
			boolToInt(c.ReadOnly), boolToInt(c.IsLocal), boolToInt(c.IsTest), boolToInt(c.IsProduction), c.ID)
		if err != nil {
			return 0, fmt.Errorf("更新连接失败: %w", err)
		}
		return c.ID, nil
	}

	res, err := r.db.conn.Exec(`
		INSERT INTO db_connections (
			name, db_type, host, port, database, username, password, extra,
			note, color, charset, default_schema,
			connect_timeout_secs, query_timeout_secs, keepalive_secs,
			ssl_mode, ssl_ca_path, ssl_cert_path, ssl_key_path, url_params,
			read_only, is_local, is_test, is_production
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.Name, c.DBType, c.Host, c.Port, c.Database, c.Username, c.Password, c.Extra,
		c.Note, c.Color, c.Charset, c.DefaultSchema,
		c.ConnectTimeoutSecs, c.QueryTimeoutSecs, c.KeepaliveSecs,
		c.SSLMode, c.SSLCaPath, c.SSLCertPath, c.SSLKeyPath, c.URLParams,
		boolToInt(c.ReadOnly), boolToInt(c.IsLocal), boolToInt(c.IsTest), boolToInt(c.IsProduction))
	if err != nil {
		return 0, fmt.Errorf("新增连接失败: %w", err)
	}
	return res.LastInsertId()
}

// normalizeEnvMark 保证环境标识互斥（优先级 生产 > 测试 > 本地）
func (c *DBConnection) normalizeEnvMark() {
	if c.IsProduction {
		c.IsLocal = false
		c.IsTest = false
		return
	}
	if c.IsTest {
		c.IsLocal = false
	}
}

// DeleteConnection 删除连接
func (r *Repository) DeleteConnection(id int64) error {
	if _, err := r.db.conn.Exec(`DELETE FROM db_connections WHERE id = ?`, id); err != nil {
		return fmt.Errorf("删除连接失败: %w", err)
	}
	return nil
}

// rowScanner 抽象 *sql.Row 与 *sql.Rows 的 Scan
type rowScanner interface {
	Scan(dest ...any) error
}

// scanConnection 从一行结果解析连接信息
func scanConnection(s rowScanner) (DBConnection, error) {
	var c DBConnection
	// 可为 NULL 的列用 Null* 承接
	var host, database, username, password, extra sql.NullString
	var note, color, charset, defaultSchema sql.NullString
	var sslMode, sslCa, sslCert, sslKey, urlParams sql.NullString
	var port, connectTimeout, queryTimeout, keepalive sql.NullInt64
	var readOnly, isLocal, isTest, isProduction sql.NullInt64

	if err := s.Scan(
		&c.ID, &c.Name, &c.DBType, &host, &port,
		&database, &username, &password, &extra,
		&note, &color, &charset, &defaultSchema,
		&connectTimeout, &queryTimeout, &keepalive,
		&sslMode, &sslCa, &sslCert, &sslKey, &urlParams,
		&readOnly, &isLocal, &isTest, &isProduction,
	); err != nil {
		if err == sql.ErrNoRows {
			return c, err
		}
		return c, fmt.Errorf("解析连接行失败: %w", err)
	}

	c.Host = host.String
	c.Port = int(port.Int64)
	c.Database = database.String
	c.Username = username.String
	c.Password = password.String
	c.Extra = extra.String
	c.Note = note.String
	c.Color = color.String
	c.Charset = charset.String
	c.DefaultSchema = defaultSchema.String
	c.ConnectTimeoutSecs = int(connectTimeout.Int64)
	c.QueryTimeoutSecs = int(queryTimeout.Int64)
	c.KeepaliveSecs = int(keepalive.Int64)
	c.SSLMode = sslMode.String
	c.SSLCaPath = sslCa.String
	c.SSLCertPath = sslCert.String
	c.SSLKeyPath = sslKey.String
	c.URLParams = urlParams.String
	c.ReadOnly = readOnly.Int64 != 0
	c.IsLocal = isLocal.Int64 != 0
	c.IsTest = isTest.Int64 != 0
	c.IsProduction = isProduction.Int64 != 0
	return c, nil
}

// connectionColumns 连接表统一使用的列清单（顺序与 scanConnection 一致）
const connectionColumns = `id, name, db_type, host, port, database, username, password, extra,
	note, color, charset, default_schema,
	connect_timeout_secs, query_timeout_secs, keepalive_secs,
	ssl_mode, ssl_ca_path, ssl_cert_path, ssl_key_path, url_params,
	read_only, is_local, is_test, is_production`

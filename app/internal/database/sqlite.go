// Package database 负责本地 SQLite 的初始化、建表与连接管理。
//
// 使用 modernc.org/sqlite（纯 Go 实现，无 CGO 依赖），
// 便于交叉编译与免安装分发。
package database

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

// DB 包装本地 SQLite 连接，供各仓储复用。
type DB struct {
	conn *sql.DB
	path string
}

var (
	// 保证同一进程内只初始化一次
	once   sync.Once
	shared *DB
	err    error
)

// schema 为全部建表语句。
// 使用 IF NOT EXISTS，保证多次启动幂等。
const schema = `
-- 1. Tab 记录表
CREATE TABLE IF NOT EXISTS tabs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 0,
  is_locked      INTEGER NOT NULL DEFAULT 0,
  tool_type      TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- 2. 数据库连接配置表（密码加密存储）
CREATE TABLE IF NOT EXISTS db_connections (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  db_type  TEXT NOT NULL,
  host     TEXT,
  port     INTEGER,
  database TEXT,
  username TEXT,
  password TEXT,
  extra    TEXT,
  note                 TEXT,
  color                TEXT,
  charset              TEXT,
  default_schema       TEXT,
  connect_timeout_secs INTEGER NOT NULL DEFAULT 10,
  query_timeout_secs   INTEGER NOT NULL DEFAULT 60,
  keepalive_secs       INTEGER NOT NULL DEFAULT 30,
  ssl_mode             TEXT,
  ssl_ca_path          TEXT,
  ssl_cert_path        TEXT,
  ssl_key_path         TEXT,
  url_params           TEXT,
  read_only            INTEGER NOT NULL DEFAULT 0,
  is_local             INTEGER NOT NULL DEFAULT 0,
  is_test              INTEGER NOT NULL DEFAULT 0,
  is_production        INTEGER NOT NULL DEFAULT 0
);

-- 3. SQL 模板配置表
CREATE TABLE IF NOT EXISTS sql_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id        INTEGER NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  sql_text       TEXT    NOT NULL,
  database       TEXT    NOT NULL DEFAULT '',
  variables      TEXT    NOT NULL,
  field_mappings TEXT    NOT NULL,
  export_templates TEXT  NOT NULL DEFAULT '[]',
  pre_script     TEXT,
  post_script    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  page_size      INTEGER NOT NULL DEFAULT 50
);

-- 4. 词典表
CREATE TABLE IF NOT EXISTS dictionaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT
);

-- 5. 词典项表
CREATE TABLE IF NOT EXISTS dictionary_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE,
  value         TEXT    NOT NULL,
  meaning       TEXT    NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- 6. 应用全局配置表
CREATE TABLE IF NOT EXISTS app_settings (
  config_key   TEXT PRIMARY KEY,
  config_type  TEXT NOT NULL,
  config_value TEXT NOT NULL
);

-- 7. 插件私有配置表
-- 每个插件的独立键值空间；插件只能读写自己 plugin_id 下的记录（由宿主 API 保证）
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id    TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, config_key)
);

-- 索引：按 sort_order 读取 Tab、按连接取模板、按词典取项
CREATE INDEX IF NOT EXISTS idx_tabs_sort_order ON tabs(sort_order);
CREATE INDEX IF NOT EXISTS idx_sql_templates_conn ON sql_templates(conn_id);
CREATE INDEX IF NOT EXISTS idx_dict_items_dict ON dictionary_items(dictionary_id, sort_order);
`

// Open 初始化并返回本地 SQLite 单例。
// dataDir 为数据目录；为空时退回当前工作目录。
//
// 应用运行期应始终使用该函数，保证全局只有一个连接。
// 需要独立实例的场景（如测试）请使用 OpenAt。
func Open(dataDir string) (*DB, error) {
	once.Do(func() {
		shared, err = open(dataDir)
	})
	return shared, err
}

// OpenAt 在指定目录创建独立的数据库实例（不复用单例）。
// 主要供测试使用，避免多个测试相互影响。
func OpenAt(dataDir string) (*DB, error) {
	return open(dataDir)
}

func open(dataDir string) (*DB, error) {
	if dataDir == "" {
		dataDir = "."
	}
	if mkErr := os.MkdirAll(dataDir, 0o755); mkErr != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", mkErr)
	}

	dbPath := filepath.Join(dataDir, "toolbox.db")
	// _pragma 参数在连接建立时即生效：开启外键约束，保证 CASCADE 删除可用
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", filepath.ToSlash(dbPath))

	conn, openErr := sql.Open("sqlite", dsn)
	if openErr != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", openErr)
	}

	// SQLite 写入串行化，限制连接数可避免 database is locked
	conn.SetMaxOpenConns(1)

	// WAL 模式提升读写并发；synchronous=NORMAL 在 WAL 下兼顾性能与安全
	pragmas := []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA synchronous=NORMAL;",
	}
	for _, stmt := range pragmas {
		if _, pErr := conn.Exec(stmt); pErr != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("设置 PRAGMA 失败(%s): %w", stmt, pErr)
		}
	}

	if _, sErr := conn.Exec(schema); sErr != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("初始化表结构失败: %w", sErr)
	}

	// 旧库升级：CREATE TABLE IF NOT EXISTS 不会补充新增列，这里按需补建
	for _, m := range columnMigrations {
		if mErr := ensureColumn(conn, m.table, m.column, m.ddl); mErr != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("补充表结构失败(%s.%s): %w", m.table, m.column, mErr)
		}
	}

	return &DB{conn: conn, path: dbPath}, nil
}

// columnMigration 描述一条「缺列则补建」的迁移。
type columnMigration struct {
	table  string
	column string
	ddl    string
}

// columnMigrations 为历史库补充新增列的清单。
// 新增字段时在此登记即可，无需用户手动删库。
var columnMigrations = []columnMigration{
	{table: "sql_templates", column: "page_size", ddl: "page_size INTEGER NOT NULL DEFAULT 50"},
	// 导出模板（2026-09-20）：结果行「复制为…」里的自定义导出模板列表
	{table: "sql_templates", column: "export_templates", ddl: "export_templates TEXT NOT NULL DEFAULT '[]'"},
	// 启用状态（2026-09-20）：默认启用，停用的模板不允许执行
	{table: "sql_templates", column: "enabled", ddl: "enabled INTEGER NOT NULL DEFAULT 1"},
	// 模板自带库（2026-09-21）：空表示用连接配置里的默认库
	{table: "sql_templates", column: "database", ddl: "database TEXT NOT NULL DEFAULT ''"},
	// 连接参数扩展（2026-09-14）：备注/颜色/方言/超时/SSL/自定义参数/只读与生产标记
	{table: "db_connections", column: "note", ddl: "note TEXT"},
	{table: "db_connections", column: "color", ddl: "color TEXT"},
	{table: "db_connections", column: "charset", ddl: "charset TEXT"},
	{table: "db_connections", column: "default_schema", ddl: "default_schema TEXT"},
	{table: "db_connections", column: "connect_timeout_secs", ddl: "connect_timeout_secs INTEGER NOT NULL DEFAULT 10"},
	{table: "db_connections", column: "query_timeout_secs", ddl: "query_timeout_secs INTEGER NOT NULL DEFAULT 60"},
	{table: "db_connections", column: "keepalive_secs", ddl: "keepalive_secs INTEGER NOT NULL DEFAULT 30"},
	{table: "db_connections", column: "ssl_mode", ddl: "ssl_mode TEXT"},
	{table: "db_connections", column: "ssl_ca_path", ddl: "ssl_ca_path TEXT"},
	{table: "db_connections", column: "ssl_cert_path", ddl: "ssl_cert_path TEXT"},
	{table: "db_connections", column: "ssl_key_path", ddl: "ssl_key_path TEXT"},
	{table: "db_connections", column: "url_params", ddl: "url_params TEXT"},
	{table: "db_connections", column: "read_only", ddl: "read_only INTEGER NOT NULL DEFAULT 0"},
	{table: "db_connections", column: "is_production", ddl: "is_production INTEGER NOT NULL DEFAULT 0"},
	// 环境标识扩展（2026-09-15）：本地 / 测试 / 生产三选一
	{table: "db_connections", column: "is_local", ddl: "is_local INTEGER NOT NULL DEFAULT 0"},
	{table: "db_connections", column: "is_test", ddl: "is_test INTEGER NOT NULL DEFAULT 0"},
}

// ensureColumn 在表缺少指定列时执行 ALTER TABLE ADD COLUMN。
// 通过 PRAGMA table_info 判断列是否存在，保证重复执行幂等。
func ensureColumn(conn *sql.DB, table, column, ddl string) error {
	rows, err := conn.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			cid       int
			name      string
			ctype     string
			notNull   int
			dfltValue sql.NullString
			pk        int
		)
		if scanErr := rows.Scan(&cid, &name, &ctype, &notNull, &dfltValue, &pk); scanErr != nil {
			return scanErr
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	_, err = conn.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s", table, ddl))
	return err
}

// Conn 返回底层连接，供仓储直接使用。
func (d *DB) Conn() *sql.DB {
	return d.conn
}

// Path 返回数据库文件路径。
func (d *DB) Path() string {
	return d.path
}

// Close 关闭连接。
func (d *DB) Close() error {
	if d == nil || d.conn == nil {
		return nil
	}
	return d.conn.Close()
}

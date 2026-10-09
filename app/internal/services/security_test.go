package services

import (
	"testing"

	"github.com/go-sql-driver/mysql"

	"toolbox/app/internal/database"
)

// TestBuildDSN_MysqlPasswordWithSpecialChars 校验含特殊字符的密码不会破坏 DSN。
//
// 用字符串拼接 DSN 时，`P@ss:w0rd/?` 里的 @ : / ? 会被驱动解析成别的 host 或参数，
// 现在统一交给 mysql.Config.FormatDSN 做转义。
func TestBuildDSN_MysqlPasswordWithSpecialChars(t *testing.T) {
	conn := database.DBConnection{
		DBType:   "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "testdb",
		Username: "root",
		Charset:  "utf8mb4",
	}

	driver, dsn, err := buildDSN(conn, "P@ss:w0rd/?")
	if err != nil {
		t.Fatalf("构造 DSN 失败: %v", err)
	}
	if driver != "mysql" {
		t.Fatalf("驱动名应为 mysql，实际 %s", driver)
	}

	// 交给驱动自己解析回来，确认账号 / 密码 / 地址 / 库名都没被特殊字符带偏
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("驱动无法解析 DSN: %v（%s）", err, dsn)
	}
	if cfg.User != "root" {
		t.Errorf("用户名解析错误: %s", cfg.User)
	}
	if cfg.Passwd != "P@ss:w0rd/?" {
		t.Errorf("密码解析错误: %q", cfg.Passwd)
	}
	if cfg.Addr != "127.0.0.1:3306" {
		t.Errorf("地址解析错误: %s", cfg.Addr)
	}
	if cfg.DBName != "testdb" {
		t.Errorf("库名解析错误: %s", cfg.DBName)
	}
}

// TestReadOnlyForbiddenReason 只读连接要拦住「首关键字是 SELECT 的写操作」。
func TestReadOnlyForbiddenReason(t *testing.T) {
	cases := map[string]bool{
		"select * from users":                        false,
		"select * from users where id = 1":           false,
		"select * from users into outfile '/tmp/x'":  true,
		"select * from users into dumpfile '/tmp/x'": true,
		"select * from users for update":             true,
		"select * from users lock in share mode":     true,
	}

	for sql, want := range cases {
		got := readOnlyForbiddenReason(sql) != ""
		if got != want {
			t.Errorf("%q: 命中=%v，期望=%v", sql, got, want)
		}
	}
}

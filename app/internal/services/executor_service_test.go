package services

import "testing"

// TestIsSystemDatabase 校验系统库判定。
//
// 这条规则决定「库下拉框与补全候选里是否列出系统库」（前端按设置项过滤），
// 所以两条边界都要盯住：**该藏的别漏**，**不该藏的绝不能误伤** ——
// sys_logs / mysql_backup 这类业务库被藏掉，用户会以为库不见了。
func TestIsSystemDatabase(t *testing.T) {
	cases := []struct {
		dbType string
		name   string
		want   bool
	}{
		{"mysql", "information_schema", true},
		{"mysql", "mysql", true},
		{"mysql", "performance_schema", true},
		{"mysql", "sys", true},
		{"mysql", "sys_logs", false},
		{"mysql", "mysql_backup", false},
		{"mysql", "business_db", false},
		{"postgres", "pg_catalog", true},
		{"postgres", "information_schema", true},
		{"postgres", "pg_toast", true},
		{"postgres", "pg_toast_16385", true},
		{"postgres", "pg_temp_3", true},
		{"postgres", "public", false},
		// 方言不同、判定不同：`mysql` 库在 PostgreSQL 下不是系统对象
		{"postgres", "mysql", false},
		// 大小写与空白不敏感
		{"MySQL", "SYS", true},
		{"mysql", "  ", false},
	}
	for _, c := range cases {
		if got := isSystemDatabase(c.dbType, c.name); got != c.want {
			t.Errorf("isSystemDatabase(%q, %q) = %v, want %v", c.dbType, c.name, got, c.want)
		}
	}
}

// TestQuoteMySQLIdent 校验标识符转义。
//
// `SHOW CREATE TABLE` 的表名来自 SQL 里的限定名与元数据，直接拼进语句时
// 反引号必须双写 —— 否则名字里带反引号就能越出标识符边界，拼出别的语句。
// 中文表名不加引号在本项目里也合法，但这里统一加引号更稳（与前端生成器一致）。
func TestQuoteMySQLIdent(t *testing.T) {
	cases := map[string]string{
		"users":      "`users`",
		"中文表":        "`中文表`",
		"weird`name": "`weird``name`",
		"back``tick": "`back````tick`",
	}
	for in, want := range cases {
		if got := quoteMySQLIdent(in); got != want {
			t.Errorf("quoteMySQLIdent(%q) = %q, want %q", in, got, want)
		}
	}
}

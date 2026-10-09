package services

import "testing"

// TestBuildCountSQL 覆盖统计总数 SQL 的生成规则：
// 简单查询应改写为 COUNT(*) 并去掉排序，复杂查询回退为子查询。
func TestBuildCountSQL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "简单查询改写并去掉排序",
			in:   "SELECT id, name FROM users WHERE status = 1 ORDER BY id DESC",
			want: "SELECT COUNT(*) FROM users WHERE status = 1",
		},
		{
			name: "最外层 FROM 之后的内容整体保留",
			in:   "SELECT a FROM (SELECT * FROM t) AS s ORDER BY a",
			want: "SELECT COUNT(*) FROM (SELECT * FROM t) AS s",
		},
		{
			name: "分号被清理",
			in:   "SELECT a FROM t;",
			want: "SELECT COUNT(*) FROM t",
		},
		{
			name: "字符串中的 order by 不被误截断",
			in:   "SELECT a FROM t WHERE name = 'order by x' ORDER BY a",
			want: "SELECT COUNT(*) FROM t WHERE name = 'order by x'",
		},
		{
			name: "窗口函数内的 order by 不影响最外层",
			in:   "SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM t",
			want: "SELECT COUNT(*) FROM t",
		},
		{
			name: "group by 回退子查询",
			in:   "SELECT a, COUNT(*) FROM t GROUP BY a",
			want: "SELECT COUNT(*) FROM (SELECT a, COUNT(*) FROM t GROUP BY a) AS __toolbox_total",
		},
		{
			name: "distinct 回退子查询",
			in:   "SELECT DISTINCT a FROM t",
			want: "SELECT COUNT(*) FROM (SELECT DISTINCT a FROM t) AS __toolbox_total",
		},
		{
			name: "union 回退子查询并去掉排序",
			in:   "SELECT a FROM t1 UNION SELECT a FROM t2 ORDER BY a",
			want: "SELECT COUNT(*) FROM (SELECT a FROM t1 UNION SELECT a FROM t2) AS __toolbox_total",
		},
		{
			name: "CTE 回退子查询",
			in:   "WITH c AS (SELECT 1) SELECT * FROM c ORDER BY 1",
			want: "SELECT COUNT(*) FROM (WITH c AS (SELECT 1) SELECT * FROM c) AS __toolbox_total",
		},
		{
			name: "只有 order by 时被整体去掉",
			in:   "SELECT a FROM t ORDER BY a",
			want: "SELECT COUNT(*) FROM t",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildCountSQL(tc.in)
			if got != tc.want {
				t.Fatalf("buildCountSQL()\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}

// TestApplyPagination 校验分页 SQL 的生成：
// 无自带 limit 时直接追加，已有 limit/offset 时包一层派生表。
func TestApplyPagination(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		pageSize int
		offset   int
		want     string
	}{
		{
			name:     "第一页只追加 LIMIT",
			in:       "SELECT * FROM users WHERE 1=1",
			pageSize: 20,
			offset:   0,
			want:     "SELECT * FROM users WHERE 1=1\nLIMIT 20",
		},
		{
			name:     "后续页追加 LIMIT OFFSET",
			in:       "SELECT * FROM users ORDER BY id",
			pageSize: 20,
			offset:   40,
			want:     "SELECT * FROM users ORDER BY id\nLIMIT 20 OFFSET 40",
		},
		{
			name:     "末尾行注释不影响追加",
			in:       "SELECT * FROM users -- 全部用户",
			pageSize: 20,
			offset:   0,
			want:     "SELECT * FROM users -- 全部用户\nLIMIT 20",
		},
		{
			name:     "原 SQL 自带 limit 时包一层",
			in:       "SELECT * FROM users LIMIT 10",
			pageSize: 20,
			offset:   0,
			want:     "SELECT * FROM (SELECT * FROM users LIMIT 10) AS __toolbox_page LIMIT 20 OFFSET 0",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := applyPagination(tc.in, tc.pageSize, tc.offset)
			if got != tc.want {
				t.Fatalf("applyPagination()\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}

// TestMainStatementKeyword 校验主关键字识别：
// WITH 开头要穿透 CTE 看主语句，且不能被注释/引号里的关键字带偏。
func TestMainStatementKeyword(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "普通查询", in: "SELECT * FROM t", want: "select"},
		{name: "写操作", in: "update t set a = 1", want: "update"},
		{name: "元数据语句", in: "SHOW TABLES", want: "show"},
		{name: "EXPLAIN 分析", in: "EXPLAIN SELECT * FROM t", want: "explain"},
		{name: "行首块注释被跳过", in: "/* 说明 */ SELECT 1", want: "select"},
		{name: "行首行注释被跳过", in: "-- 说明\nSELECT 1", want: "select"},
		{name: "CTE 内层 select 不算主语句", in: "WITH c AS (SELECT 1) UPDATE t SET a = 1", want: "update"},
		{name: "CTE 查询", in: "WITH c AS (SELECT 1) SELECT * FROM c", want: "select"},
		{name: "递归 CTE 查询", in: "WITH RECURSIVE c AS (SELECT 1) SELECT * FROM c", want: "select"},
		{name: "标识符不会误判", in: "select_type FROM t", want: "select_type"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mainStatementKeyword(tc.in)
			if got != tc.want {
				t.Fatalf("mainStatementKeyword() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestCanPaginateStatement 校验「哪些语句允许追加分页」的判定：
// 只有返回结果集且语法接受 LIMIT/OFFSET 的语句才能分页。
func TestCanPaginateStatement(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "SELECT 可分页", in: "SELECT * FROM users", want: true},
		{name: "TABLE 简写可分页", in: "TABLE users", want: true},
		{name: "VALUES 可分页", in: "VALUES (1), (2)", want: true},
		{name: "CTE 查询可分页", in: "WITH c AS (SELECT 1) SELECT * FROM c", want: true},
		{name: "自带 LIMIT 也可分页（会包一层）", in: "SELECT * FROM users LIMIT 10", want: true},
		{name: "SHOW 不分页（没有 OFFSET 语法）", in: "SHOW TABLES", want: false},
		{name: "DESCRIBE 不分页", in: "DESCRIBE users", want: false},
		{name: "EXPLAIN 不分页（会改变被解释的语句）", in: "EXPLAIN SELECT * FROM users", want: false},
		{name: "INSERT 不分页", in: "INSERT INTO users VALUES (1)", want: false},
		{name: "UPDATE 不分页", in: "UPDATE users SET a = 1", want: false},
		{name: "DELETE 不分页", in: "DELETE FROM users", want: false},
		{name: "DDL 不分页", in: "CREATE TABLE t (a int)", want: false},
		{name: "CTE 写操作不分页", in: "WITH c AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT * FROM c)", want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := canPaginateStatement(tc.in); got != tc.want {
				t.Fatalf("canPaginateStatement(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestPreparePagination 校验分页入口的整体行为：
// 不改写不支持分页的语句，页大小缺省/上限也在这一层收敛。
func TestPreparePagination(t *testing.T) {
	t.Run("未请求分页时原样返回", func(t *testing.T) {
		sql := "SELECT * FROM users"
		got, size := preparePagination(sql, 0, 50)
		if got != sql || size != 0 {
			t.Fatalf("got %q size %d, want 原样且 size 0", got, size)
		}
	})

	t.Run("SHOW 不分页也不改写", func(t *testing.T) {
		sql := "SHOW TABLES"
		got, size := preparePagination(sql, 2, 50)
		if got != sql || size != 0 {
			t.Fatalf("got %q size %d, want 原样且 size 0", got, size)
		}
	})

	t.Run("页大小缺省取默认值", func(t *testing.T) {
		got, size := preparePagination("SELECT * FROM users", 1, 0)
		if size != defaultPageSize {
			t.Fatalf("size = %d, want %d", size, defaultPageSize)
		}
		if want := "SELECT * FROM users\nLIMIT 50"; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("页大小超上限被收敛", func(t *testing.T) {
		_, size := preparePagination("SELECT * FROM users", 1, maxPageSize+500)
		if size != maxPageSize {
			t.Fatalf("size = %d, want %d", size, maxPageSize)
		}
	})

	t.Run("第二页拼上 OFFSET", func(t *testing.T) {
		got, _ := preparePagination("SELECT * FROM users", 3, 20)
		if want := "SELECT * FROM users\nLIMIT 20 OFFSET 40"; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
}

// TestIndexOfTopLevelKeyword 校验关键字定位不会被括号、引号与注释干扰。
func TestIndexOfTopLevelKeyword(t *testing.T) {
	cases := []struct {
		name    string
		query   string
		keyword string
		want    int
	}{
		{name: "最外层命中", query: "select a from t order by a", keyword: "from", want: 9},
		{name: "括号内不算", query: "select (select a from t) from u", keyword: "from", want: 25},
		{name: "单引号内不算", query: "select 'from' from t", keyword: "from", want: 14},
		{name: "行注释内不算", query: "select a -- from t\nfrom u", keyword: "from", want: 19},
		{name: "标识符中的关键字不算", query: "select order_type from t", keyword: "order", want: -1},
		{name: "未命中", query: "select a from t", keyword: "group by", want: -1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := indexOfTopLevelKeyword(tc.query, tc.keyword)
			if got != tc.want {
				t.Fatalf("indexOfTopLevelKeyword() = %d, want %d", got, tc.want)
			}
		})
	}
}

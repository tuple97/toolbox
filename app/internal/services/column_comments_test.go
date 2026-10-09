package services

import (
	"reflect"
	"testing"
)

func TestFromTables(t *testing.T) {
	cases := []struct {
		name  string
		query string
		want  []tableRef
	}{
		{
			name:  "单表（未限定：schema 留空，由调用方回退默认库）",
			query: "SELECT * FROM users",
			want:  []tableRef{{table: "users"}},
		},
		{
			name:  "限定名带上库（连接没配默认库时，这是唯一的 schema 线索）",
			query: "SELECT u.id FROM `db`.`users` u",
			want:  []tableRef{{schema: "db", table: "users"}},
		},
		{
			name:  "JOIN 两张表并去重",
			query: "SELECT * FROM users u JOIN orders o ON o.user_id = u.id JOIN users u2 ON 1 = 1",
			want:  []tableRef{{table: "users"}, {table: "orders"}},
		},
		{
			name:  "同名表在不同库：按 库.表 区分，都保留",
			query: "SELECT * FROM a.users JOIN b.users ON 1 = 1",
			want:  []tableRef{{schema: "a", table: "users"}, {schema: "b", table: "users"}},
		},
		{
			name:  "子查询：跳过括号本身，仍能取到内部的表",
			query: "SELECT * FROM (SELECT * FROM orders) t",
			want:  []tableRef{{table: "orders"}},
		},
		{
			name:  "注释里的 from 不算",
			query: "SELECT * FROM /* from fake */ users",
			want:  []tableRef{{table: "users"}},
		},
		{
			name:  "没有表来源",
			query: "SELECT 1",
			want:  []tableRef{},
		},
		{
			name:  "字符串里的 from 不算",
			query: "SELECT * FROM users WHERE name = 'from orders'",
			want:  []tableRef{{table: "users"}},
		},
		{
			name:  "CTE：按出现顺序收集（CTE 名查不到注释，无副作用）",
			query: "WITH c AS (SELECT * FROM users) SELECT * FROM c",
			want:  []tableRef{{table: "users"}, {table: "c"}},
		},
	}

	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := fromTables(item.query)
			if len(got) == 0 && len(item.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, item.want) {
				t.Fatalf("fromTables(%q) = %v, 期望 %v", item.query, got, item.want)
			}
		})
	}
}

func TestQualifiedTableRef(t *testing.T) {
	cases := []struct {
		text   string
		schema string
		table  string
	}{
		{"users", "", "users"},
		{"`db`.`users` u", "db", "users"},
		{`"public"."log"`, "public", "log"},
		{"db.users WHERE 1 = 1", "db", "users"},
		{"(SELECT 1) t", "", ""},
		{"", "", ""},
	}

	for _, item := range cases {
		got := qualifiedTableRef(item.text)
		if got.schema != item.schema || got.table != item.table {
			t.Fatalf("qualifiedTableRef(%q) = %+v, 期望 {%s %s}", item.text, got, item.schema, item.table)
		}
	}
}

// TestDisplayTypeOf 覆盖「字典里的类型 → 结果表头展示用类型」的整理规则。
func TestDisplayTypeOf(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"varchar(255)", "VARCHAR(255)"},
		{"decimal(10,2)", "DECIMAL(10,2)"},
		{"int unsigned", "INT UNSIGNED"},
		{"bigint", "BIGINT"},
		// enum / set 的取值大小写有意义，只大写类型名本身
		{"enum('a','B')", "ENUM('a','B')"},
		{"  datetime(3)  ", "DATETIME(3)"},
		{"", ""},
		{"   ", ""},
	}

	for _, item := range cases {
		if got := displayTypeOf(item.raw); got != item.want {
			t.Fatalf("displayTypeOf(%q) = %q, 期望 %q", item.raw, got, item.want)
		}
	}
}

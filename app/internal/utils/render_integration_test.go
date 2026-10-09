package utils

import (
	"strings"
	"testing"
)

// 本文件覆盖 PRD 5.6 的验收场景：
// 用户书写的 SQL 模板无需修改点号即可渲染。

// 场景一：现有 where ... like '%{{device_no}}%' 语法无需修改即可工作
func TestAcceptance_ExistingSyntaxUnchanged(t *testing.T) {
	tpl := `select * from gcp_aftersale_uat.device where device_no like '%{{ device_no }}%'`

	got, err := RenderSQL(tpl, map[string]any{"device_no": "A001"})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	want := `select * from gcp_aftersale_uat.device where device_no like '%A001%'`
	if got != want {
		t.Errorf("得到 %q\n期望 %q", got, want)
	}
}

// 场景二：device_no 为空时不拼接条件（核心用法）
func TestAcceptance_EmptyVariableSkipsCondition(t *testing.T) {
	tpl := `select * from device where 1=1{{if device_no}} and device_no like '%{{ device_no }}%'{{end}}`

	// 有值
	got, err := RenderSQL(tpl, map[string]any{"device_no": "A001"})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "and device_no like '%A001%'") {
		t.Errorf("应拼接条件，实际: %s", got)
	}

	// 空串（对应前端补全后的缺失变量）
	got, err = RenderSQL(tpl, map[string]any{"device_no": ""})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if strings.Contains(got, "and device_no") {
		t.Errorf("空值不应拼接条件，实际: %s", got)
	}
	if !strings.HasSuffix(got, "where 1=1") {
		t.Errorf("应保留 where 占位，实际: %s", got)
	}
}

// 场景三：multi-select 变量配合 range + join 实现 IN 查询
func TestAcceptance_MultiSelectInQuery(t *testing.T) {
	tpl := `select * from device where 1=1{{if device_no_list}} and device_no in ({{ range $i, $v := device_no_list }}{{ if $i }},{{ end }}{{ quote $v }}{{ end }}){{end}}`

	got, err := RenderSQL(tpl, map[string]any{
		"device_no_list": []any{"A001", "A002", "A003"},
	})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "and device_no in ('A001','A002','A003')") {
		t.Errorf("IN 条件不符，实际: %s", got)
	}

	// 空列表不拼接
	got, err = RenderSQL(tpl, map[string]any{"device_no_list": []any{}})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if strings.Contains(got, "and device_no") {
		t.Errorf("空列表不应拼接条件，实际: %s", got)
	}
}

// 场景四：join 函数实现 IN 查询
func TestAcceptance_JoinFuncInQuery(t *testing.T) {
	tpl := `select * from device where name in ('{{ join "','" names }}')`

	got, err := RenderSQL(tpl, map[string]any{"names": []any{"a", "b"}})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "'a','b'") {
		t.Errorf("join 结果不符: %s", got)
	}
}

// 场景五：引用未补全的变量时报错，而非静默输出空串
func TestAcceptance_MissingVariableErrors(t *testing.T) {
	// 模拟后端未补全变量而直接渲染的情况
	_, err := RenderSQL(
		`select * from t where a = '{{ device_no }}'`,
		map[string]any{},
	)
	if err == nil {
		t.Fatal("缺失变量应报错")
	}
	if !strings.Contains(err.Error(), "device_no") {
		t.Errorf("错误信息应包含变量名，实际: %v", err)
	}
}

// 场景六：复杂条件拼接
func TestAcceptance_ComplexConditions(t *testing.T) {
	tpl := `select * from device where 1=1` +
		`{{if device_no}} and device_no like '%{{ device_no }}%'{{end}}` +
		`{{if env}} and env = {{ quote env }}{{end}}` +
		`{{if status_list}} and status in ({{ range $i, $v := status_list }}{{ if $i }},{{ end }}{{ quote $v }}{{ end }}){{end}}`

	got, err := RenderSQL(tpl, map[string]any{
		"device_no":   "A001",
		"env":         "prod",
		"status_list": []any{"1", "2"},
	})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}

	for _, expect := range []string{
		"and device_no like '%A001%'",
		"and env = 'prod'",
		"and status in ('1','2')",
	} {
		if !strings.Contains(got, expect) {
			t.Errorf("缺少条件 %q\n实际: %s", expect, got)
		}
	}
}

// 场景七：注入尝试应被 quote 阻止
func TestAcceptance_QuotePreventsInjection(t *testing.T) {
	got, err := RenderSQL(
		`select * from device where device_no = {{ quote device_no }}`,
		map[string]any{"device_no": "A001' OR '1'='1"},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	// 单引号被转义后，注入串成为普通字面量
	want := `select * from device where device_no = 'A001'' OR ''1''=''1'`
	if got != want {
		t.Errorf("得到 %q\n期望 %q", got, want)
	}
}

// 场景八：数字类型的 quote 不加引号
func TestAcceptance_QuoteKeepsNumber(t *testing.T) {
	got, err := RenderSQL(
		`select * from device where id = {{ quote id }} and enabled = {{ quote enabled }}`,
		map[string]any{"id": 42, "enabled": true},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "id = 42") {
		t.Errorf("数字不应加引号，实际: %s", got)
	}
	if !strings.Contains(got, "enabled = true") {
		t.Errorf("布尔不应加引号，实际: %s", got)
	}
}

package script

import (
	"strings"
	"testing"
)

// 说明：模板渲染已迁移至 text/template（见 internal/utils/parser_test.go），
// 本文件只覆盖 goja 承担的脚本执行职责。

func TestRunPreScript_ReturnStatement(t *testing.T) {
	engine := NewEngine()

	source := `
		// 用户可写完整 JS 逻辑
		console.log("pre script running");
		return {
			variables: { env: variables.env.toUpperCase() },
			sqlFragment: " AND level > 3"
		};
	`
	result, err := engine.RunPreScript(source, map[string]any{"env": "prod"}, "SELECT 1")
	if err != nil {
		t.Fatalf("前置脚本执行失败: %v", err)
	}

	if result.Variables["env"] != "PROD" {
		t.Errorf("变量应被处理为 PROD，实际: %v", result.Variables["env"])
	}
	if result.SQLFragment != " AND level > 3" {
		t.Errorf("SQL 片段不符: %s", result.SQLFragment)
	}
	if len(result.Console) == 0 {
		t.Error("console.log 输出应被收集")
	}
}

func TestRunPreScript_EmptySource(t *testing.T) {
	engine := NewEngine()

	// 未配置脚本时，变量应原样透传
	result, err := engine.RunPreScript("", map[string]any{"a": 1}, "SELECT 1")
	if err != nil {
		t.Fatalf("空脚本不应报错: %v", err)
	}
	if result.Variables["a"] != 1 {
		t.Errorf("变量应原样透传，实际: %v", result.Variables)
	}
}

func TestRunPreScript_ExpressionForm(t *testing.T) {
	engine := NewEngine()

	// 不写 return 的对象字面量形式也应可用
	result, err := engine.RunPreScript(
		`{ variables: { n: variables.n + 1 } }`,
		map[string]any{"n": 1},
		"SELECT 1",
	)
	if err != nil {
		t.Fatalf("表达式形式执行失败: %v", err)
	}
	if result.Variables["n"] != int64(2) {
		t.Errorf("变量应被加一，实际: %v (%T)", result.Variables["n"], result.Variables["n"])
	}
}

func TestRunPostScript_FilterRows(t *testing.T) {
	engine := NewEngine()

	rows := []map[string]any{
		{"id": 1, "status": "active"},
		{"id": 2, "status": "disabled"},
		{"id": 3, "status": "active"},
	}

	source := `
		// 过滤 + 脱敏
		const mapped = rows
			.filter(r => r.status === "active")
			.map(r => ({ ...r, status: "启用" }));
		return { rows: mapped };
	`
	result, err := engine.RunPostScript(source, rows)
	if err != nil {
		t.Fatalf("后置脚本执行失败: %v", err)
	}

	if len(result.Rows) != 2 {
		t.Fatalf("应过滤出 2 行，实际 %d", len(result.Rows))
	}
	if result.Rows[0]["status"] != "启用" {
		t.Errorf("状态应被翻译为启用，实际: %v", result.Rows[0]["status"])
	}
}

func TestRunPostScript_EmptySource(t *testing.T) {
	engine := NewEngine()

	rows := []map[string]any{{"a": 1}}
	result, err := engine.RunPostScript("", rows)
	if err != nil {
		t.Fatalf("空脚本不应报错: %v", err)
	}
	if len(result.Rows) != 1 {
		t.Errorf("结果集应原样返回，实际 %d 行", len(result.Rows))
	}
}

func TestRunPreScript_InvalidReturn(t *testing.T) {
	engine := NewEngine()

	// 返回非对象应报错，便于用户定位
	_, err := engine.RunPreScript(`return "not an object";`, map[string]any{}, "")
	if err == nil {
		t.Fatal("返回非对象应报错")
	}
}

func TestValidateScript(t *testing.T) {
	engine := NewEngine()

	if err := engine.ValidateScript("return { a: 1 };"); err != nil {
		t.Errorf("合法脚本不应报错: %v", err)
	}
	if err := engine.ValidateScript("return { a: ; };"); err == nil {
		t.Error("非法脚本应报错")
	}
	if err := engine.ValidateScript(""); err != nil {
		t.Errorf("空脚本不应报错: %v", err)
	}
}

func TestRunPostScript_ConsoleCollected(t *testing.T) {
	engine := NewEngine()

	source := `
		console.log("rows count:", rows.length);
		return { rows };
	`
	result, err := engine.RunPostScript(source, []map[string]any{{"a": 1}})
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if len(result.Console) == 0 || !strings.Contains(result.Console[0], "rows count") {
		t.Errorf("console 输出应被收集，实际: %v", result.Console)
	}
}

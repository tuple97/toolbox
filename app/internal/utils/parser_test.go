package utils

import (
	"regexp"
	"strings"
	"testing"
)

// normalizeSpace 压缩模板标记内的多余空格，便于断言比较。
// text/template 对空格不敏感，因此断言应关注语义而非精确排版。
func normalizeSpace(s string) string {
	s = regexp.MustCompile(`\{\{\s*`).ReplaceAllString(s, "{{ ")
	s = regexp.MustCompile(`\s*\}\}`).ReplaceAllString(s, " }}")
	return s
}

// assertPreprocess 断言预处理结果（忽略标记内空白差异）
func assertPreprocess(t *testing.T, input, want string) {
	t.Helper()
	got := PreprocessPlaceholders(input)
	if normalizeSpace(got) != normalizeSpace(want) {
		t.Errorf("输入 %q\n得到 %q\n期望 %q", input, got, want)
	}
}

func TestPreprocessPlaceholders_PlainVariable(t *testing.T) {
	assertPreprocess(t, `{{ device_no }}`, `{{ .device_no }}`)
	assertPreprocess(t, `{{device_no}}`, `{{ .device_no }}`)
	assertPreprocess(t, `{{   device_no   }}`, `{{ .device_no }}`)
	assertPreprocess(t, `{{ user_name }}`, `{{ .user_name }}`)
}

func TestPreprocessPlaceholders_KeepsKeywords(t *testing.T) {
	// 关键字绝不能被破坏，这是 5.6 验收项
	assertPreprocess(t, `{{if device_no}}`, `{{if .device_no}}`)
	assertPreprocess(t, `{{ end }}`, `{{end}}`)
	assertPreprocess(t, `{{end}}`, `{{end}}`)
	assertPreprocess(t, `{{else}}`, `{{else}}`)
	assertPreprocess(t, `{{range device_list}}`, `{{range .device_list}}`)
}

func TestPreprocessPlaceholders_Negation(t *testing.T) {
	assertPreprocess(t, `{{if not device_no}}`, `{{if not .device_no}}`)
	// 已带点号应保持原样，不重复补点
	assertPreprocess(t, `{{if .device_no}}`, `{{if .device_no}}`)
}

func TestPreprocessPlaceholders_Comparison(t *testing.T) {
	// 字符串字面量内容不能被改，变量要补点
	got := PreprocessPlaceholders(`{{if eq env "prod"}}`)
	if !strings.Contains(got, `.env`) {
		t.Errorf("env 应补点号，实际: %s", got)
	}
	if !strings.Contains(got, `"prod"`) {
		t.Errorf("字符串字面量应保持原样，实际: %s", got)
	}
}

func TestPreprocessPlaceholders_Idempotent(t *testing.T) {
	// 重复调用不应产生 ..xxx
	input := `select * from t where a = {{ device_no }} {{if env}}{{end}}`
	once := PreprocessPlaceholders(input)
	twice := PreprocessPlaceholders(once)

	if normalizeSpace(once) != normalizeSpace(twice) {
		t.Errorf("预处理非幂等\n一次: %s\n二次: %s", once, twice)
	}
	if strings.Contains(twice, "..") {
		t.Errorf("出现多余的点号: %s", twice)
	}
}

func TestRenderSQL_BasicVariable(t *testing.T) {
	got, err := RenderSQL(
		`select * from device where device_no like '%{{ device_no }}%'`,
		map[string]any{"device_no": "A001"},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	want := `select * from device where device_no like '%A001%'`
	if got != want {
		t.Errorf("得到 %q\n期望 %q", got, want)
	}
}

func TestRenderSQL_IfCondition(t *testing.T) {
	tpl := `select * from device where 1=1{{if device_no}} and device_no = '{{ device_no }}'{{end}}`

	// 有值时拼接
	got, err := RenderSQL(tpl, map[string]any{"device_no": "A001"})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "and device_no = 'A001'") {
		t.Errorf("应拼接条件，实际: %s", got)
	}

	// 空值时不拼接
	got, err = RenderSQL(tpl, map[string]any{"device_no": ""})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if strings.Contains(got, "and device_no") {
		t.Errorf("空值不应拼接条件，实际: %s", got)
	}
}

func TestRenderSQL_QuoteEscape(t *testing.T) {
	got, err := RenderSQL(
		`select * from t where name = {{ quote name }}`,
		map[string]any{"name": "O'Brien"},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, `'O''Brien'`) {
		t.Errorf("单引号应被转义，实际: %s", got)
	}
}

func TestRenderSQL_QuoteNumberNoQuotes(t *testing.T) {
	got, err := RenderSQL(
		`select * from t where id = {{ quote id }}`,
		map[string]any{"id": 42},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "id = 42") {
		t.Errorf("数字不应加引号，实际: %s", got)
	}
}

func TestRenderSQL_RangeJoin(t *testing.T) {
	tpl := `select * from t where id in ({{ range $i, $v := .ids }}{{ if $i }},{{ end }}{{ quote $v }}{{ end }})`
	got, err := RenderSQL(tpl, map[string]any{"ids": []any{"1", "2", "3"}})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	want := `select * from t where id in ('1','2','3')`
	if got != want {
		t.Errorf("得到 %q\n期望 %q", got, want)
	}
}

func TestRenderSQL_JoinFunc(t *testing.T) {
	got, err := RenderSQL(
		`select * from t where name in ('{{ join "','" .names }}')`,
		map[string]any{"names": []any{"a", "b"}},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, `'a','b'`) {
		t.Errorf("join 结果不符: %s", got)
	}
}

func TestRenderSQL_DefaultFunc(t *testing.T) {
	got, err := RenderSQL(
		`select * from t where status = {{ quote (default "active" status) }}`,
		map[string]any{"status": ""},
	)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if !strings.Contains(got, "'active'") {
		t.Errorf("default 应生效，实际: %s", got)
	}
}

func TestRenderSQL_MissingKeyError(t *testing.T) {
	// 缺少变量应报错，而非静默渲染为空
	_, err := RenderSQL(`select * from t where a = {{ .not_exist }}`, map[string]any{})
	if err == nil {
		t.Fatal("缺失变量应报错")
	}
}

func TestRenderSQL_SyntaxError(t *testing.T) {
	_, err := RenderSQL(`select * from t {{ if }}`, map[string]any{})
	if err == nil {
		t.Fatal("语法错误应报错")
	}
}

func TestCheckTemplate_OK(t *testing.T) {
	check := CheckTemplate(`select * from users where id = {{ id }} {{if env}} and a = 1{{end}}`)
	if !check.Valid {
		t.Fatalf("应当校验通过，实际: %+v", check)
	}
	if check.Line != 0 || check.Message != "" {
		t.Errorf("通过时不应带位置与消息: %+v", check)
	}
}

func TestCheckTemplate_ReportsLine(t *testing.T) {
	// 第 3 行的 {{ 没闭合：行号应指向它，消息里不该再带 `template: sql:…:` 前缀
	check := CheckTemplate("SELECT 1\nSELECT 2\nSELECT {{ id ")
	if check.Valid {
		t.Fatal("未闭合的标记应当校验失败")
	}
	if check.Line != 3 {
		t.Errorf("行号应为 3，实际 %d（消息：%s）", check.Line, check.Message)
	}
	if strings.Contains(check.Message, "template:") {
		t.Errorf("消息应剥掉模板前缀，实际: %s", check.Message)
	}
}

func TestCheckTemplate_SyntaxError(t *testing.T) {
	check := CheckTemplate(`select * from t {{ if }}`)
	if check.Valid {
		t.Fatal("语法错误应当校验失败")
	}
	if check.Line <= 0 {
		t.Errorf("应当解析出行号，实际: %+v", check)
	}
	if check.Message == "" {
		t.Error("应当给出可读的错误消息")
	}
}

func TestExtractTemplateVariables(t *testing.T) {
	names := ExtractTemplateVariables(
		`select * from t where a = {{ device_no }} {{if env}} and b = {{ quote user_name }}{{end}}`,
	)

	found := map[string]bool{}
	for _, n := range names {
		found[n] = true
	}

	for _, expect := range []string{"device_no", "env", "user_name"} {
		if !found[expect] {
			t.Errorf("应提取出 %s，实际: %v", expect, names)
		}
	}
	// 函数名不应被当作变量
	if found["quote"] || found["if"] || found["end"] {
		t.Errorf("函数名/关键字不应被提取为变量: %v", names)
	}
}

func TestExtractTemplateVariables_Dedupe(t *testing.T) {
	names := ExtractTemplateVariables(`{{ a }} {{ a }} {{if a}}{{end}}`)
	count := 0
	for _, n := range names {
		if n == "a" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("重复变量应去重，实际出现 %d 次: %v", count, names)
	}
}

func TestValidateTemplate(t *testing.T) {
	if err := ValidateTemplate(`select * from t where a = {{ a }}`); err != nil {
		t.Errorf("合法模板不应报错: %v", err)
	}
	if err := ValidateTemplate(`select * from t {{ if }}`); err == nil {
		t.Error("非法模板应报错")
	}
}

// Package script 基于 goja 提供前置/后置脚本执行能力。
//
// 职责划分（重要）：
//   - SQL 模板渲染 = text/template（见 internal/utils/parser.go）
//   - 前置/后置脚本 = goja（本包）
//
// 两者彻底分离，模板不再借道 JS 引擎，避免双轨实现带来的行为不一致。
package script

import (
	"fmt"
	"strings"
	"time"

	"github.com/dop251/goja"
)

// Engine 封装 goja 运行时。
// goja.Runtime 非并发安全，每次执行创建独立实例，避免跨请求污染。
type Engine struct{}

// NewEngine 创建脚本引擎。
func NewEngine() *Engine {
	return &Engine{}
}

// EvalResult 描述前置脚本执行结果。
type EvalResult struct {
	// Variables 处理后的变量表
	Variables map[string]any `json:"variables"`
	// SQLFragment 脚本动态生成的 SQL 片段
	SQLFragment string `json:"sqlFragment"`
	// Console 脚本内 console.log 收集的输出，用于前端展示调试信息
	Console []string `json:"console"`
}

// ScriptResult 描述后置脚本执行结果。
type ScriptResult struct {
	// Rows 处理后的结果集
	Rows []map[string]any `json:"rows"`
	// Console 调试输出
	Console []string `json:"console"`
}

// 单次脚本执行的超时保护，避免死循环阻塞 UI
const scriptTimeout = 5 * time.Second

// newRuntime 创建带超时看门狗与 console 收集的运行时。
func (e *Engine) newRuntime(console *[]string) *goja.Runtime {
	vm := goja.New()

	// 注入 console，收集用户脚本的调试输出
	consoleObj := vm.NewObject()
	logFn := func(call goja.FunctionCall) goja.Value {
		parts := make([]string, 0, len(call.Arguments))
		for _, arg := range call.Arguments {
			parts = append(parts, exportToString(arg))
		}
		*console = append(*console, strings.Join(parts, " "))
		return goja.Undefined()
	}
	for _, name := range []string{"log", "info", "warn", "error", "debug"} {
		_ = consoleObj.Set(name, logFn)
	}
	_ = vm.Set("console", consoleObj)

	// 看门狗：超时后中断执行，防止用户脚本死循环卡住应用
	time.AfterFunc(scriptTimeout, func() {
		vm.Interrupt("脚本执行超时（超过 5s），请检查是否存在死循环")
	})

	return vm
}

// RunPreScript 执行前置脚本。
//
// 脚本可访问 variables 与 sqlTemplate，并需返回结果：
//
//	return { variables: {...}, sqlFragment: "..." }
//
// 未返回时，视为仅依赖默认行为（变量原样传递）。
func (e *Engine) RunPreScript(source string, variables map[string]any, sqlTemplate string) (*EvalResult, error) {
	result := &EvalResult{
		Variables: variables,
		Console:   make([]string, 0),
	}
	if strings.TrimSpace(source) == "" {
		return result, nil
	}

	vm := e.newRuntime(&result.Console)
	if err := injectVariables(vm, variables); err != nil {
		return nil, err
	}
	if err := vm.Set("sqlTemplate", sqlTemplate); err != nil {
		return nil, fmt.Errorf("注入 sqlTemplate 失败: %w", err)
	}

	value, err := runUserScript(vm, source)
	if err != nil {
		return nil, fmt.Errorf("前置脚本执行失败: %w", err)
	}
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return result, nil
	}

	// 解析脚本返回值
	exported := value.Export()
	obj, ok := exported.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("前置脚本应返回对象 { variables, sqlFragment }，实际为 %T", exported)
	}

	if raw, exists := obj["variables"]; exists {
		converted, convErr := toAnyMap(raw)
		if convErr != nil {
			return nil, fmt.Errorf("前置脚本返回的 variables 非法: %w", convErr)
		}
		result.Variables = converted
	}
	if raw, exists := obj["sqlFragment"]; exists {
		result.SQLFragment = exportToString(vm.ToValue(raw))
	}
	return result, nil
}

// RunPostScript 执行后置脚本。
//
// 脚本可访问 rows，并需返回 { rows: [...] }。
func (e *Engine) RunPostScript(source string, rows []map[string]any) (*ScriptResult, error) {
	result := &ScriptResult{
		Rows:    rows,
		Console: make([]string, 0),
	}
	if strings.TrimSpace(source) == "" {
		return result, nil
	}

	vm := e.newRuntime(&result.Console)
	if err := vm.Set("rows", rows); err != nil {
		return nil, fmt.Errorf("注入 rows 失败: %w", err)
	}

	value, err := runUserScript(vm, source)
	if err != nil {
		return nil, fmt.Errorf("后置脚本执行失败: %w", err)
	}
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return result, nil
	}

	exported := value.Export()
	obj, ok := exported.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("后置脚本应返回对象 { rows }，实际为 %T", exported)
	}

	raw, exists := obj["rows"]
	if !exists {
		return result, nil
	}

	// 结果集统一转为 []map[string]any
	list, convErr := toAnySlice(raw)
	if convErr != nil {
		return nil, fmt.Errorf("后置脚本返回的 rows 非法: %w", convErr)
	}
	converted := make([]map[string]any, 0, len(list))
	for _, item := range list {
		rowMap, mapErr := toAnyMap(item)
		if mapErr != nil {
			return nil, fmt.Errorf("后置脚本返回的 rows 含非法行: %w", mapErr)
		}
		converted = append(converted, rowMap)
	}
	result.Rows = converted
	return result, nil
}

// ValidateScript 校验脚本语法，用于前端保存前预检。
//
// 注意：必须按执行时的形式（包进函数体）编译。
// 直接编译裸脚本会把合法的 "return {...}" 误判为 Illegal return statement。
func (e *Engine) ValidateScript(source string) error {
	trimmed := strings.TrimSpace(source)
	if trimmed == "" {
		return nil
	}

	// 与 runUserScript 保持一致：表达式式写法也需通过包裹后才能编译
	candidates := []string{"(function(){\n" + source + "\n})()"}
	if strings.HasPrefix(trimmed, "{") && !strings.Contains(trimmed, "return") {
		candidates = append(candidates, "("+source+")")
	}

	var lastErr error
	for _, candidate := range candidates {
		if _, err := goja.Compile("user-script", candidate, false); err == nil {
			return nil
		} else {
			lastErr = err
		}
	}
	return fmt.Errorf("脚本语法错误: %w", lastErr)
}

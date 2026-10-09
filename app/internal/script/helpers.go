package script

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/dop251/goja"
)

// builtinIdentifiers 为脚本引擎注入的内置对象与上下文，
// 注入用户变量时需跳过，避免用户变量覆盖内置对象导致脚本异常。
var builtinIdentifiers = map[string]struct{}{
	// JS 内置对象与全局函数
	"console": {}, "Math": {}, "Date": {}, "JSON": {}, "String": {},
	"Number": {}, "Boolean": {}, "Array": {}, "Object": {}, "parseInt": {},
	"parseFloat": {}, "isNaN": {}, "encodeURIComponent": {}, "decodeURIComponent": {},
	// 字面量
	"true": {}, "false": {}, "null": {}, "undefined": {},
	// 引擎注入的上下文
	"sqlTemplate": {}, "variables": {}, "rows": {},
}

// injectVariables 把变量表注入运行时作用域。
func injectVariables(vm *goja.Runtime, variables map[string]any) error {
	if variables == nil {
		return nil
	}
	for name, value := range variables {
		if _, exists := builtinIdentifiers[name]; exists {
			// 避免用户变量覆盖内置对象，例如把 Math 设成字符串导致脚本异常
			continue
		}
		if err := vm.Set(name, value); err != nil {
			return fmt.Errorf("注入变量 %s 失败: %w", name, err)
		}
	}
	// 同时以 variables 对象暴露，便于脚本整体读取
	if err := vm.Set("variables", variables); err != nil {
		return fmt.Errorf("注入 variables 失败: %w", err)
	}
	return nil
}

// runUserScript 执行用户脚本。
//
// 兼容两种写法：
//   - 直接写表达式：{ variables: { a: 1 } }
//   - 写 return 语句：return { variables: { a: 1 } }
//
// 这样用户无需关心「脚本 vs 表达式」的区别，降低使用门槛。
func runUserScript(vm *goja.Runtime, source string) (goja.Value, error) {
	trimmed := strings.TrimSpace(source)

	// 已包含 return 的，按函数体包装后立即调用
	if strings.Contains(trimmed, "return") {
		wrapped := "(function(){\n" + source + "\n})()"
		value, err := vm.RunString(wrapped)
		if err != nil {
			return nil, err
		}
		return value, nil
	}

	// 否则先尝试作为表达式求值（兼容对象字面量）
	if strings.HasPrefix(trimmed, "{") {
		wrapped := "(" + source + ")"
		if value, err := vm.RunString(wrapped); err == nil {
			return value, nil
		}
	}

	// 兜底按函数体执行，取最后一条表达式的结果
	wrapped := "(function(){\n" + source + "\n})()"
	value, err := vm.RunString(wrapped)
	if err != nil {
		return nil, err
	}
	return value, nil
}

// exportToString 把 goja 值转为字符串。
func exportToString(value goja.Value) string {
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return ""
	}

	switch v := value.Export().(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case int:
		return strconv.Itoa(v)
	case float64:
		// 整数浮点去掉多余小数位
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(encoded)
	}
}

// toAnyMap 把任意值规整为 map[string]any。
func toAnyMap(value any) (map[string]any, error) {
	switch typed := value.(type) {
	case map[string]any:
		return typed, nil
	case nil:
		return map[string]any{}, nil
	default:
		// 兼容 goja 导出的 map[any]any
		encoded, err := json.Marshal(typed)
		if err != nil {
			return nil, fmt.Errorf("无法转换为对象: %w", err)
		}
		var result map[string]any
		if err := json.Unmarshal(encoded, &result); err != nil {
			return nil, fmt.Errorf("无法转换为对象: %w", err)
		}
		return result, nil
	}
}

// toAnySlice 把任意值规整为 []any。
func toAnySlice(value any) ([]any, error) {
	if value == nil {
		return []any{}, nil
	}
	if list, ok := value.([]any); ok {
		return list, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("无法转换为数组: %w", err)
	}
	var result []any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, fmt.Errorf("无法转换为数组: %w", err)
	}
	return result, nil
}

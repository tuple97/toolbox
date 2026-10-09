package utils

import (
	"fmt"
	"strconv"
	"strings"
	"text/template"
	"time"
)

// TplFuncMap 为 SQL 模板提供的自定义函数。
//
// 说明：仅使用 text/template（不用 html/template），
// 因为后者会做 HTML 转义，会把 SQL 中的引号、尖括号转义成语义错误的字符。
var TplFuncMap = template.FuncMap{
	"quote":   tplQuote,
	"upper":   strings.ToUpper,
	"lower":   strings.ToLower,
	"default": tplDefault,
	"join":    tplJoin,
	"now":     tplNow,
	"in":      tplIn,
}

// tplQuote 按类型为值加上 SQL 引号，防止注入。
//
// 规则：
//   - nil / 无效值 → NULL
//   - 字符串 → 单引号包裹，内部单引号转义为两个单引号
//   - 数字 / 布尔 → 原样输出（不加引号，保证 id = 1 这类比较正确）
//   - 其他 → 转成字符串后按字符串处理
func tplQuote(value any) string {
	switch typed := value.(type) {
	case nil:
		return "NULL"
	case string:
		return quoteString(typed)
	case int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64:
		return fmt.Sprintf("%v", typed)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return quoteString(fmt.Sprintf("%v", typed))
	}
}

// quoteString 把字符串安全地包成 SQL 单引号字面量。
func quoteString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// tplDefault 当 v 为空值或零值时返回 def。
// 参数顺序为 (默认值, 实际值)，便于在管道中使用：{{ .name | default "默认" }}
func tplDefault(def any, value any) any {
	if isEmptyValue(value) {
		return def
	}
	return value
}

// isEmptyValue 判断值是否应被视为「空」。
func isEmptyValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case bool:
		return !typed
	case int:
		return typed == 0
	case int64:
		return typed == 0
	case float64:
		return typed == 0
	case []any:
		return len(typed) == 0
	case []string:
		return len(typed) == 0
	default:
		return false
	}
}

// tplJoin 把数组拼接为字符串，用于 IN 查询。
//
// 用法：{{ join "','" .device_no_list }} 配合外层引号生成 'a','b'
// 若元素需逐个加引号，建议外层使用 quote：
//
//	device_no in ({{ range $i, $v := .list }}{{ if $i }},{{ end }}{{ quote $v }}{{ end }})
func tplJoin(sep string, value any) string {
	switch typed := value.(type) {
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, fmt.Sprintf("%v", item))
		}
		return strings.Join(parts, sep)
	case []string:
		return strings.Join(typed, sep)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// tplNow 按 Go 时间格式返回当前时间字符串。
// 例：{{ now "2006-01-02 15:04:05" }}
func tplNow(layout string) string {
	if layout == "" {
		layout = "2006-01-02 15:04:05"
	}
	return time.Now().Format(layout)
}

// tplIn 判断集合是否包含某值，用于条件拼接。
// 例：{{ if in "prod,uat" .env }}
func tplIn(haystack any, needle any) bool {
	target := fmt.Sprintf("%v", needle)

	switch typed := haystack.(type) {
	case []any:
		for _, item := range typed {
			if fmt.Sprintf("%v", item) == target {
				return true
			}
		}
		return false
	case []string:
		for _, item := range typed {
			if item == target {
				return true
			}
		}
		return false
	case string:
		// 逗号分隔的字符串集合
		for _, item := range strings.Split(typed, ",") {
			if strings.TrimSpace(item) == target {
				return true
			}
		}
		return false
	default:
		return false
	}
}

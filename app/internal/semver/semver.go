// Package semver 提供精简的语义化版本解析与比较。
//
// 刻意不引入第三方依赖：插件版本与依赖解析是信任边界的一部分，
// 实现保持可见、可控、可测试。范围（约束）语法见 constraint.go。
package semver

import (
	"fmt"
	"strconv"
	"strings"
)

// Version 语义化版本（MAJOR.MINOR.PATCH[-PRERELEASE]，忽略构建元数据）。
type Version struct {
	Major int
	Minor int
	Patch int
	// Pre 预发布标识段，例如 1.2.3-beta.1 中的 ["beta","1"]
	Pre []string
}

// Parse 解析版本号，允许可选的 v 前缀（发布标签习惯写 v1.2.3）。
func Parse(raw string) (Version, error) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "v")
	if s == "" {
		return Version{}, fmt.Errorf("版本号为空")
	}

	// 构建元数据（+ 之后）不参与比较，直接丢弃
	if idx := strings.IndexByte(s, '+'); idx >= 0 {
		s = s[:idx]
	}

	var pre []string
	if idx := strings.IndexByte(s, '-'); idx >= 0 {
		preRaw := s[idx+1:]
		s = s[:idx]
		if preRaw == "" {
			return Version{}, fmt.Errorf("非法的预发布标识: %q", raw)
		}
		for _, part := range strings.Split(preRaw, ".") {
			if part == "" {
				return Version{}, fmt.Errorf("非法的预发布标识: %q", raw)
			}
			pre = append(pre, part)
		}
	}

	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("版本号必须形如 x.y.z: %q", raw)
	}
	nums := make([]int, 3)
	for i, p := range parts {
		n, err := parseNum(p)
		if err != nil {
			return Version{}, fmt.Errorf("版本号段 %q 非法: %w", p, err)
		}
		nums[i] = n
	}
	return Version{Major: nums[0], Minor: nums[1], Patch: nums[2], Pre: pre}, nil
}

// MustParse 解析失败时 panic，仅用于测试与包内常量。
func MustParse(raw string) Version {
	v, err := Parse(raw)
	if err != nil {
		panic(err)
	}
	return v
}

// IsValid 报告字符串是否为合法版本号。
func IsValid(raw string) bool {
	_, err := Parse(raw)
	return err == nil
}

func parseNum(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("空数字段")
	}
	if len(s) > 1 && s[0] == '0' {
		return 0, fmt.Errorf("数字段不允许前导零")
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, err
	}
	if n < 0 {
		return 0, fmt.Errorf("数字段不允许为负")
	}
	return n, nil
}

// String 返回规范化的版本号字符串。
func (v Version) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if len(v.Pre) > 0 {
		s += "-" + strings.Join(v.Pre, ".")
	}
	return s
}

// Compare 按语义化版本规则比较：v < o 返回 -1，相等返回 0，v > o 返回 1。
func (v Version) Compare(o Version) int {
	if c := compareInt(v.Major, o.Major); c != 0 {
		return c
	}
	if c := compareInt(v.Minor, o.Minor); c != 0 {
		return c
	}
	if c := compareInt(v.Patch, o.Patch); c != 0 {
		return c
	}
	return comparePre(v.Pre, o.Pre)
}

// LessThan 报告 v 是否低于 o。
func (v Version) LessThan(o Version) bool { return v.Compare(o) < 0 }

// Equal 报告 v 是否等于 o。
func (v Version) Equal(o Version) bool { return v.Compare(o) == 0 }

// comparePre 预发布版本优先级：有预发布标识的低于同版本正式版。
func comparePre(a, b []string) int {
	switch {
	case len(a) == 0 && len(b) == 0:
		return 0
	case len(a) == 0:
		return 1 // 正式版 > 预发布
	case len(b) == 0:
		return -1
	}
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if c := comparePreIdent(a[i], b[i]); c != 0 {
			return c
		}
	}
	return compareInt(len(a), len(b))
}

func comparePreIdent(a, b string) int {
	an, aErr := strconv.Atoi(a)
	bn, bErr := strconv.Atoi(b)
	switch {
	case aErr == nil && bErr == nil:
		return compareInt(an, bn)
	case aErr == nil:
		return -1 // 数字标识 < 字母标识
	case bErr == nil:
		return 1
	default:
		return strings.Compare(a, b)
	}
}

func compareInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

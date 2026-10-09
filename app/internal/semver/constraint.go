package semver

import (
	"fmt"
	"strconv"
	"strings"
)

/*
范围（约束）语法：

	* 或空             任意版本
	1.2.3              精确匹配
	1.2.x / 1.x        前缀通配
	^1.2.3             兼容升级（>=1.2.3 <2.0.0；0.x 按最左非零段收窄）
	~1.2.3             补丁升级（>=1.2.3 <1.3.0）
	>=1.2.3 <2.0.0     空格连接为「与」
	^1.0.0 || ^2.0.0   用 || 连接为「或」
*/

// Comparator 单个比较项，统一规约为 = > >= < <= 五种。
type Comparator struct {
	Op  string
	Ver Version
}

func (c Comparator) String() string { return c.Op + c.Ver.String() }

// Constraint 由若干「与」组构成的「或」表达式；空表示任意版本。
type Constraint struct {
	// Groups 外层为「或」，内层为「与」
	Groups [][]Comparator
	// raw 原始文本，便于报错与展示
	raw string
}

// String 返回原始约束文本。
func (c Constraint) String() string { return c.raw }

// ParseConstraint 解析约束表达式。
func ParseConstraint(raw string) (Constraint, error) {
	text := strings.TrimSpace(raw)
	// 空或 * 视为任意版本
	if text == "" || text == "*" || text == "x" || text == "X" {
		return Constraint{raw: "*"}, nil
	}

	result := Constraint{raw: text}
	for _, orPart := range strings.Split(text, "||") {
		group, err := parseAndGroup(strings.TrimSpace(orPart))
		if err != nil {
			return Constraint{}, err
		}
		result.Groups = append(result.Groups, group)
	}
	if len(result.Groups) == 0 {
		return Constraint{}, fmt.Errorf("约束表达式为空: %q", raw)
	}
	return result, nil
}

// parseAndGroup 解析由空格分隔的比较项；若只有一个整体（无空格）则按单个 token 处理。
func parseAndGroup(text string) ([]Comparator, error) {
	if text == "" {
		return nil, fmt.Errorf("约束表达式存在空的或分支")
	}
	// 规范写法是空格分隔；但 ^1.2.3 这类整体也可能被写成连写形式
	fields := strings.Fields(text)
	if len(fields) == 1 {
		return expandToken(fields[0])
	}
	var group []Comparator
	for _, f := range fields {
		items, err := expandToken(f)
		if err != nil {
			return nil, err
		}
		group = append(group, items...)
	}
	return group, nil
}

// expandToken 把单个约束 token 展开为若干基础比较项。
func expandToken(token string) ([]Comparator, error) {
	if token == "" {
		return nil, fmt.Errorf("出现了空的比较项")
	}

	// 提取运算符前缀
	op, rest := splitOp(token)

	switch op {
	case "^":
		v, err := parseLoose(rest)
		if err != nil {
			return nil, err
		}
		upper := caretUpper(v)
		return []Comparator{{Op: ">=", Ver: v}, {Op: "<", Ver: upper}}, nil
	case "~", "~>":
		v, err := parseLoose(rest)
		if err != nil {
			return nil, err
		}
		upper := tildeUpper(v)
		return []Comparator{{Op: ">=", Ver: v}, {Op: "<", Ver: upper}}, nil
	case ">", ">=", "<", "<=", "=":
		v, err := parseLoose(rest)
		if err != nil {
			return nil, err
		}
		return []Comparator{{Op: op, Ver: v}}, nil
	default:
		// 无运算符：可能是精确版本、通配或部分版本（1.2 / 1）
		return expandPlain(token)
	}
}

// splitOp 分离前导运算符与剩余部分。
func splitOp(token string) (string, string) {
	for _, op := range []string{">=", "<=", "~>", ">", "<", "=", "^", "~"} {
		if strings.HasPrefix(token, op) {
			return op, strings.TrimSpace(token[len(op):])
		}
	}
	return "", token
}

// expandPlain 处理无运算符的写法。
func expandPlain(token string) ([]Comparator, error) {
	// 通配：1.2.x / 1.x / 1.* 等
	if strings.ContainsAny(token, "xX*") {
		// 补齐到三段，使 1.x 等价于 1.x.x
		parts := strings.Split(token, ".")
		for len(parts) < 3 {
			parts = append(parts, "x")
		}
		return expandWildcard(strings.Join(parts, "."))
	}
	parts := strings.Split(token, ".")
	if len(parts) == 3 {
		v, err := Parse(token)
		if err != nil {
			return nil, err
		}
		return []Comparator{{Op: "=", Ver: v}}, nil
	}
	if len(parts) == 2 {
		// 1.2 视为 1.2.x
		return expandWildcard(token + ".x")
	}
	if len(parts) == 1 {
		// 1 视为 1.x.x
		return expandWildcard(token + ".x.x")
	}
	return nil, fmt.Errorf("非法的版本约束: %q", token)
}

// expandWildcard 把 1.2.x / 1.x.x 等通配写法展开为区间。
func expandWildcard(token string) ([]Comparator, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("通配版本必须形如 x.y.z: %q", token)
	}

	isWild := func(s string) bool { return s == "x" || s == "X" || s == "*" }

	// 定位第一个通配段，其前一段必须为数字
	switch {
	case isWild(parts[0]):
		// 任意版本
		return nil, nil
	case isWild(parts[1]):
		major, err := parseWildNum(parts[0])
		if err != nil {
			return nil, err
		}
		return []Comparator{
			{Op: ">=", Ver: Version{Major: major}},
			{Op: "<", Ver: Version{Major: major + 1}},
		}, nil
	case isWild(parts[2]):
		major, err := parseWildNum(parts[0])
		if err != nil {
			return nil, err
		}
		minor, err := parseWildNum(parts[1])
		if err != nil {
			return nil, err
		}
		return []Comparator{
			{Op: ">=", Ver: Version{Major: major, Minor: minor}},
			{Op: "<", Ver: Version{Major: major, Minor: minor + 1}},
		}, nil
	default:
		v, err := Parse(token)
		if err != nil {
			return nil, err
		}
		return []Comparator{{Op: "=", Ver: v}}, nil
	}
}

func parseWildNum(s string) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("通配版本段 %q 非法", s)
	}
	return n, nil
}

// parseLoose 解析 ^ ~ >= 等运算符后的版本，允许两段或一段写法（1.2 → 1.2.0）。
func parseLoose(s string) (Version, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Version{}, fmt.Errorf("比较项缺少版本号")
	}
	parts := strings.Split(s, ".")
	switch len(parts) {
	case 1:
		s += ".0.0"
	case 2:
		s += ".0"
	}
	return Parse(s)
}

// caretUpper 计算 ^ 约束的上界。
//
// 语义：>=v，且不允许改变最左侧非零段。
//
//	^1.2.3 -> <2.0.0
//	^0.2.3 -> <0.3.0
//	^0.0.3 -> <0.0.4
func caretUpper(v Version) Version {
	switch {
	case v.Major > 0:
		return Version{Major: v.Major + 1}
	case v.Minor > 0:
		return Version{Minor: v.Minor + 1}
	default:
		return Version{Patch: v.Patch + 1}
	}
}

// tildeUpper 计算 ~ 约束的上界：允许补丁升级。
//
//	~1.2.3 -> <1.3.0
//	~1.2   -> <1.3.0
//	~1     -> <2.0.0
func tildeUpper(v Version) Version {
	if v.Minor == 0 && v.Patch == 0 && len(v.Pre) == 0 {
		// ~1 形式：只有 major 有值
		return Version{Major: v.Major + 1}
	}
	return Version{Major: v.Major, Minor: v.Minor + 1}
}

// Check 报告版本是否满足约束。
func (c Constraint) Check(v Version) bool {
	if len(c.Groups) == 0 {
		return true // 任意版本
	}
	for _, group := range c.Groups {
		if len(group) == 0 {
			return true // 该或分支为「任意」
		}
		if groupMatches(group, v) {
			return true
		}
	}
	return false
}

func groupMatches(group []Comparator, v Version) bool {
	for _, cmp := range group {
		if !comparatorMatches(cmp, v) {
			return false
		}
	}
	return true
}

func comparatorMatches(c Comparator, v Version) bool {
	// 预发布版本只在区间显式引用同版本预发布时才匹配（与 npm 语义一致）
	if len(v.Pre) > 0 && !referencesPrerelease(c.Ver, v) {
		return false
	}
	n := v.Compare(c.Ver)
	switch c.Op {
	case "=":
		return n == 0
	case ">":
		return n > 0
	case ">=":
		return n >= 0
	case "<":
		return n < 0
	case "<=":
		return n <= 0
	default:
		return false
	}
}

// referencesPrerelease 报告比较项是否引用了与 v 相同的 [major.minor.patch] 预发布。
func referencesPrerelease(cv, v Version) bool {
	return len(cv.Pre) > 0 &&
		cv.Major == v.Major && cv.Minor == v.Minor && cv.Patch == v.Patch
}

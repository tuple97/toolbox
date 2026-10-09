package semver

import "testing"

func TestParseAndCompare(t *testing.T) {
	cases := []struct {
		a    string
		b    string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.0.0", "1.0.1", -1},
		{"2.0.0", "1.9.9", 1},
		{"1.10.0", "1.9.0", 1},
		// 预发布版本低于同版本正式版
		{"1.0.0-beta.1", "1.0.0", -1},
		{"1.0.0", "1.0.0-beta.1", 1},
		{"1.0.0-beta.2", "1.0.0-beta.1", 1},
		{"1.0.0-alpha", "1.0.0-beta", -1},
		// 数字标识低于字母标识
		{"1.0.0-1", "1.0.0-alpha", -1},
		// 允许 v 前缀与构建元数据
		{"v1.2.3", "1.2.3", 0},
		{"1.2.3+build.7", "1.2.3", 0},
	}

	for _, c := range cases {
		va, err := Parse(c.a)
		if err != nil {
			t.Fatalf("Parse(%q) 失败: %v", c.a, err)
		}
		vb, err := Parse(c.b)
		if err != nil {
			t.Fatalf("Parse(%q) 失败: %v", c.b, err)
		}
		if got := va.Compare(vb); got != c.want {
			t.Errorf("Compare(%q, %q) = %d，期望 %d", c.a, c.b, got, c.want)
		}
	}
}

func TestParseRejectsInvalid(t *testing.T) {
	for _, raw := range []string{"", "1", "1.2", "1.2.3.4", "1.02.3", "a.b.c", "1.2.-1"} {
		if _, err := Parse(raw); err == nil {
			t.Errorf("Parse(%q) 应当失败，却通过了", raw)
		}
	}
}

func TestConstraintCheck(t *testing.T) {
	cases := []struct {
		constraint string
		version    string
		want       bool
	}{
		// 精确
		{"=1.2.3", "1.2.3", true},
		{"=1.2.3", "1.2.4", false},
		// 兼容升级
		{"^1.2.3", "1.2.3", true},
		{"^1.2.3", "1.9.0", true},
		{"^1.2.3", "2.0.0", false},
		// 0.x 的 ^ 按最左非零段收窄
		{"^0.2.3", "0.2.9", true},
		{"^0.2.3", "0.3.0", false},
		{"^0.0.3", "0.0.3", true},
		{"^0.0.3", "0.0.4", false},
		// 补丁升级
		{"~1.2.3", "1.2.9", true},
		{"~1.2.3", "1.3.0", false},
		// 区间（空格为「与」）
		{">=1.0.0 <2.0.0", "1.5.0", true},
		{">=1.0.0 <2.0.0", "2.0.0", false},
		// 通配
		{"1.2.x", "1.2.7", true},
		{"1.2.x", "1.3.0", false},
		{"1.x", "1.9.9", true},
		{"1.x", "2.0.0", false},
		{"*", "9.9.9", true},
		{"", "9.9.9", true},
		// 或
		{"^1.0.0 || ^2.0.0", "1.4.2", true},
		{"^1.0.0 || ^2.0.0", "2.3.4", true},
		{"^1.0.0 || ^2.0.0", "3.0.0", false},
	}

	for _, c := range cases {
		constraint, err := ParseConstraint(c.constraint)
		if err != nil {
			t.Fatalf("ParseConstraint(%q) 失败: %v", c.constraint, err)
		}
		v, err := Parse(c.version)
		if err != nil {
			t.Fatalf("Parse(%q) 失败: %v", c.version, err)
		}
		if got := constraint.Check(v); got != c.want {
			t.Errorf("Check(%q, %q) = %v，期望 %v", c.constraint, c.version, got, c.want)
		}
	}
}

func TestConstraintRejectsPrereleaseOutsideRange(t *testing.T) {
	// 预发布版本只有在区间显式引用该版本时才匹配
	constraint, err := ParseConstraint("^1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	v, err := Parse("1.5.0-beta.1")
	if err != nil {
		t.Fatal(err)
	}
	if constraint.Check(v) {
		t.Error("1.5.0-beta.1 不应满足 ^1.2.3")
	}
}

func TestParseConstraintRejectsInvalid(t *testing.T) {
	for _, raw := range []string{"1.2.3.4", ">=a.b.c"} {
		if _, err := ParseConstraint(raw); err == nil {
			t.Errorf("ParseConstraint(%q) 应当失败，却通过了", raw)
		}
	}
}

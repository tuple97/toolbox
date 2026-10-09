package plugin

import "testing"

func TestPermissionAllowsURL(t *testing.T) {
	perms := Permissions{Network: []string{"api.example.com", "*.internal.test"}}

	cases := []struct {
		url  string
		want bool
	}{
		{"https://api.example.com/v1/x", true},
		{"http://api.example.com", true},
		{"https://evil.example.com", false},
		// 非 http(s) 协议一律拒绝
		{"file:///etc/passwd", false},
		{"ftp://api.example.com", false},
		// 通配必须匹配至少一级子域
		{"https://a.internal.test", true},
		{"https://deep.sub.internal.test", true},
		{"https://internal.test", false},
		// 未声明的域名
		{"https://other.com", false},
		{"not a url", false},
	}

	for _, c := range cases {
		if got := perms.AllowsURL(c.url); got != c.want {
			t.Errorf("AllowsURL(%q) = %v，期望 %v", c.url, got, c.want)
		}
	}
}

func TestPermissionEmptyNetworkDeniesEverything(t *testing.T) {
	var perms Permissions
	if perms.AllowsURL("https://api.example.com") {
		t.Error("未声明 network 权限时不应允许任何请求")
	}
}

func TestPermissionValidate(t *testing.T) {
	valid := Permissions{Network: []string{"api.example.com", "*.internal.test"}, DB: []string{"read"}}
	if err := valid.Validate(); err != nil {
		t.Errorf("合法权限被判为非法: %v", err)
	}

	invalid := []Permissions{
		{Network: []string{"https://api.example.com"}},
		{Network: []string{"api.example.com/path"}},
		{Network: []string{"api.example.com:8080"}},
		{Network: []string{"api*.example.com"}},
		{DB: []string{"drop"}},
	}
	for i, p := range invalid {
		if err := p.Validate(); err == nil {
			t.Errorf("第 %d 组非法权限未被拦截: %+v", i, p)
		}
	}
}

func TestPermissionDBImpliesRead(t *testing.T) {
	perms := Permissions{DB: []string{"write"}}
	if !perms.AllowsDB("write") {
		t.Error("应允许 write")
	}
	if !perms.AllowsDB("read") {
		t.Error("write 应隐含 read")
	}

	readOnly := Permissions{DB: []string{"read"}}
	if readOnly.AllowsDB("write") {
		t.Error("只读权限不应允许 write")
	}
}

func TestPermissionDiff(t *testing.T) {
	before := Permissions{Network: []string{"api.example.com"}, Storage: true}
	after := Permissions{
		Network: []string{"api.example.com", "new.example.com"},
		Storage: true,
		Notify:  true,
		DB:      []string{"read"},
	}

	added := PermissionDiff(before, after)
	if len(added) != 3 {
		t.Fatalf("期望 3 项新增权限，实际 %d: %v", len(added), added)
	}
	joined := ""
	for _, item := range added {
		joined += item + "\n"
	}
	for _, expect := range []string{"new.example.com", "通知", "数据库"} {
		if !contains(joined, expect) {
			t.Errorf("新增权限描述缺少 %q: %s", expect, joined)
		}
	}

	// 权限未扩张时不应产生任何条目（升级可静默进行）
	if diff := PermissionDiff(before, before); len(diff) != 0 {
		t.Errorf("权限未变化时不应有差异: %v", diff)
	}
}

func TestNeedTrustPrompt(t *testing.T) {
	cases := []struct {
		official bool
		trusted  bool
		want     bool
	}{
		{true, false, false},  // 官方审核：直接安装
		{false, true, false},  // 已被用户信任
		{false, false, true},  // 非官方且未信任：必须确认
		{true, true, false},   // 官方且已信任
	}
	for _, c := range cases {
		if got := NeedTrustPrompt(c.official, c.trusted); got != c.want {
			t.Errorf("NeedTrustPrompt(%v, %v) = %v，期望 %v",
				c.official, c.trusted, got, c.want)
		}
	}
}

func TestManifestValidation(t *testing.T) {
	base := func() *Manifest {
		return &Manifest{
			ID:        "com.example.demo",
			Name:      "示例",
			Version:   "1.0.0",
			Publisher: "example",
			Runtime:   RuntimeSpec{Backend: "js"},
		}
	}

	if err := base().Validate(); err != nil {
		t.Fatalf("合法清单被判为非法: %v", err)
	}

	badID := base()
	badID.ID = "not-a-reverse-domain"
	if err := badID.Validate(); err == nil {
		t.Error("非法 id 未被拦截")
	}

	badVersion := base()
	badVersion.Version = "1.0"
	if err := badVersion.Validate(); err == nil {
		t.Error("非法版本号未被拦截")
	}

	selfDep := base()
	selfDep.Dependencies = map[string]string{"com.example.demo": "^1.0.0"}
	if err := selfDep.Validate(); err == nil {
		t.Error("自依赖未被拦截")
	}

	escape := base()
	escape.Runtime.Entry = "../../evil.js"
	if err := escape.Validate(); err == nil {
		t.Error("路径穿越未被拦截")
	}

	dupTool := base()
	dupTool.Contributes.Tools = []ToolContribution{
		{Type: "panel", Label: "A"},
		{Type: "panel", Label: "B"},
	}
	if err := dupTool.Validate(); err == nil {
		t.Error("重复工具类型未被拦截")
	}
}

func TestChecksumHelpers(t *testing.T) {
	got := HashBytes([]byte("hello"))
	if got != "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Errorf("摘要计算有误: %s", got)
	}
	if NormalizeChecksum("SHA256:ABC") != "sha256:abc" {
		t.Error("摘要归一化失败")
	}
	if err := VerifyChecksum([]byte("hello"), "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"); err != nil {
		t.Errorf("正确摘要应通过校验: %v", err)
	}
	if err := VerifyChecksum([]byte("hello"), "sha256:deadbeef"); err == nil {
		t.Error("错误摘要应被拒绝")
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

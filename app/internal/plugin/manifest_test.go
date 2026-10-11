package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestParseManifestValid 合法清单应当通过完整校验。
func TestParseManifestValid(t *testing.T) {
	mf := baseManifest("com.toolbox.demo", "1.2.3")
	mf.Contributes = Contributions{
		Sidebar: &SidebarContribution{Groups: []SidebarGroup{{ID: "demo", Label: "示例"}}},
		Tools: []ToolContribution{{
			Type:  "com.toolbox.demo.tool",
			Label: "示例工具",
			Group: "demo",
		}},
		Commands: []CommandContribution{{ID: "com.toolbox.demo.run", Title: "运行"}},
		Settings: []SettingContribution{{
			Key: "endpoint", Type: "string", Title: "地址", Default: "http://localhost",
		}},
		SettingsPanels: []SettingsPanelContribution{{ID: "main", Title: "主面板"}},
		MCP:            &MCPContribution{Tools: []MCPToolContribution{{Name: "demo_query"}}},
	}
	raw, err := json.Marshal(mf)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}

	got, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("合法清单被拒绝: %v", err)
	}
	if got.ID != mf.ID || got.Version != mf.Version {
		t.Fatalf("解析结果不一致: %+v", got)
	}
	if got.Legacy() {
		t.Fatal("新协议清单不应标记为 legacy")
	}
	if got.FrontendEntry() != "frontend/index.js" {
		t.Fatalf("期望默认前端入口，实得 %q", got.FrontendEntry())
	}
}

// TestParseManifestRejects 非法清单必须在安装前被拒绝。
func TestParseManifestRejects(t *testing.T) {
	valid := baseManifest("com.toolbox.demo", "1.0.0")
	baseRaw, err := json.Marshal(valid)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}

	cases := []struct {
		name    string
		mutate  func(*Manifest)
		raw     string
		wantSub string
	}{
		{
			name:    "缺少 manifestVersion",
			raw:     `{"id":"com.toolbox.demo","name":"x","version":"1.0.0","publisher":"toolbox","engines":{"toolbox":">=0.1.0","pluginApi":"^1.0.0"}}`,
			wantSub: "manifestVersion",
		},
		{
			name:    "不支持的清单格式版本",
			mutate:  func(m *Manifest) { m.ManifestVersion = 99 },
			wantSub: "不支持的清单格式版本",
		},
		{
			name:    "非法插件 id",
			mutate:  func(m *Manifest) { m.ID = "Bad_ID" },
			wantSub: "id 非法",
		},
		{
			name:    "非法 semver",
			mutate:  func(m *Manifest) { m.Version = "1.0" },
			wantSub: "版本号非法",
		},
		{
			name:    "缺少发布者",
			mutate:  func(m *Manifest) { m.Publisher = "" },
			wantSub: "publisher",
		},
		{
			name:    "缺少宿主版本范围",
			mutate:  func(m *Manifest) { m.Engines.Toolbox = "" },
			wantSub: "engines.toolbox",
		},
		{
			name:    "缺少插件 API 版本范围",
			mutate:  func(m *Manifest) { m.Engines.PluginAPI = "" },
			wantSub: "engines.pluginApi",
		},
		{
			name:    "宿主版本约束非法",
			mutate:  func(m *Manifest) { m.Engines.Toolbox = ">>1.0" },
			wantSub: "engines.toolbox 约束非法",
		},
		{
			name:    "自依赖",
			mutate:  func(m *Manifest) { m.Dependencies = map[string]string{"com.toolbox.demo": "^1.0.0"} },
			wantSub: "不能依赖自身",
		},
		{
			name:    "依赖约束非法",
			mutate:  func(m *Manifest) { m.Dependencies = map[string]string{"com.toolbox.other": "not-a-range"} },
			wantSub: "约束非法",
		},
		{
			name:    "依赖 id 非法",
			mutate:  func(m *Manifest) { m.Dependencies = map[string]string{"Other": "^1.0.0"} },
			wantSub: "依赖 id 非法",
		},
		{
			name: "工具类型重复",
			mutate: func(m *Manifest) {
				m.Contributes.Tools = []ToolContribution{
					{Type: "dup", Label: "a"}, {Type: "dup", Label: "b"},
				}
			},
			wantSub: "工具类型重复",
		},
		{
			name: "工具类型非法",
			mutate: func(m *Manifest) {
				m.Contributes.Tools = []ToolContribution{{Type: "Bad Type", Label: "a"}}
			},
			wantSub: "工具类型非法",
		},
		{
			name: "命令缺少插件前缀",
			mutate: func(m *Manifest) {
				m.Contributes.Commands = []CommandContribution{{ID: "run", Title: "运行"}}
			},
			wantSub: "必须以插件 id 为前缀",
		},
		{
			name: "命令 id 重复",
			mutate: func(m *Manifest) {
				m.Contributes.Commands = []CommandContribution{
					{ID: "com.toolbox.demo.a", Title: "a"},
					{ID: "com.toolbox.demo.a", Title: "b"},
				}
			},
			wantSub: "命令 id 重复",
		},
		{
			name: "配置项类型非法",
			mutate: func(m *Manifest) {
				m.Contributes.Settings = []SettingContribution{{Key: "k", Type: "color", Title: "t"}}
			},
			wantSub: "类型非法",
		},
		{
			name: "select 缺少选项",
			mutate: func(m *Manifest) {
				m.Contributes.Settings = []SettingContribution{{Key: "k", Type: "select", Title: "t"}}
			},
			wantSub: "必须提供 options",
		},
		{
			name: "设置面板 id 重复",
			mutate: func(m *Manifest) {
				m.Contributes.SettingsPanels = []SettingsPanelContribution{{ID: "p"}, {ID: "p"}}
			},
			wantSub: "设置面板 id 重复",
		},
		{
			name: "MCP 工具名重复",
			mutate: func(m *Manifest) {
				m.Contributes.MCP = &MCPContribution{Tools: []MCPToolContribution{{Name: "x"}, {Name: "x"}}}
			},
			wantSub: "MCP 工具名重复",
		},
		{
			name: "后端入口路径穿越",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "js", Entry: "../evil.js"}
			},
			wantSub: "越出插件目录",
		},
		{
			name: "后端入口为绝对路径",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "js", Entry: "/etc/passwd"}
			},
			wantSub: "绝对路径",
		},
		{
			name: "不支持的后端运行时",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "wasm"}
			},
			wantSub: "runtime.backend 非法",
		},
		{
			name: "纯前端插件声明后端入口",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "none", Entry: "backend/index.js"}
			},
			wantSub: "不允许声明 runtime.entry",
		},
		{
			name: "非 js 后端声明 exports",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "none", Exports: []string{"hello"}}
			},
			wantSub: "只有 runtime.backend = js",
		},
		{
			name: "exports 重复",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "js", Exports: []string{"a", "a"}}
			},
			wantSub: "handler 名重复",
		},
		{
			name: "exports 名称非法",
			mutate: func(m *Manifest) {
				m.Runtime = RuntimeSpec{Backend: "js", Exports: []string{"1bad name"}}
			},
			wantSub: "handler 名非法",
		},
		{
			name: "非法网络白名单",
			mutate: func(m *Manifest) {
				m.Permissions = Permissions{Network: []string{"https://example.com/api"}}
			},
			wantSub: "不能包含路径",
		},
		{
			name: "网络白名单通配非法",
			mutate: func(m *Manifest) {
				m.Permissions = Permissions{Network: []string{"api.*.com"}}
			},
			wantSub: "只支持 *. 前缀通配",
		},
		{
			name: "数据库权限非法",
			mutate: func(m *Manifest) {
				m.Permissions = Permissions{DB: []string{"admin"}}
			},
			wantSub: "数据库权限取值非法",
		},
		{
			name: "数据库权限重复",
			mutate: func(m *Manifest) {
				m.Permissions = Permissions{DB: []string{"read", "READ"}}
			},
			wantSub: "重复声明",
		},
		{
			name:    "未知字段",
			raw:     strings.Replace(string(baseRaw), `"publisher"`, `"publisherX"`, 1),
			wantSub: "解析插件清单失败",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := tc.raw
			if raw == "" {
				mf := baseManifest("com.toolbox.demo", "1.0.0")
				tc.mutate(mf)
				encoded, err := json.Marshal(mf)
				if err != nil {
					t.Fatalf("序列化失败: %v", err)
				}
				raw = string(encoded)
			}
			_, err := ParseManifest([]byte(raw))
			if err == nil {
				t.Fatal("期望解析失败，实际通过")
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("错误信息应包含 %q，实际: %v", tc.wantSub, err)
			}
		})
	}
}

// TestLegacyManifestFallback 旧协议清单只在「缺少 manifestVersion」时被容忍。
func TestLegacyManifestFallback(t *testing.T) {
	legacy := `{
	  "id": "com.toolbox.legacy",
	  "name": "旧插件",
	  "version": "1.0.0",
	  "publisher": "toolbox",
	  "engines": {"toolbox": ">=0.1.0"},
	  "permissions": {"storage": true}
	}`
	mf, err := ParseLegacyManifest([]byte(legacy))
	if err != nil {
		t.Fatalf("旧协议清单应可解析: %v", err)
	}
	if !mf.Legacy() {
		t.Fatal("应标记为 legacy")
	}

	if _, err := ParseManifest([]byte(legacy)); err == nil {
		t.Fatal("严格解析必须拒绝旧协议清单")
	}

	// 旧协议清单里出现未知字段仍然要报错，不能为了兼容放宽一切
	bad := strings.Replace(legacy, `"name"`, `"nameX"`, 1)
	if _, err := ParseLegacyManifest([]byte(bad)); err == nil {
		t.Fatal("旧协议清单中的未知字段必须报错")
	}

	// 已带 manifestVersion 的内容不应被按旧协议解析
	if _, err := ParseLegacyManifest([]byte(`{"manifestVersion":1}`)); err == nil {
		t.Fatal("带 manifestVersion 的清单不应按旧协议解析")
	}
}

// TestValidateRelativePath 路径校验要挡住各类穿越写法。
func TestValidateRelativePath(t *testing.T) {
	bad := []string{"../a.js", "a/../../b.js", "/abs.js", "./a.js"}
	for _, p := range bad {
		if err := validateRelPath(p); err == nil {
			t.Fatalf("路径 %q 应被拒绝", p)
		}
	}
	good := []string{"frontend/index.js", "backend/index.js", "assets/logo.svg"}
	for _, p := range good {
		if err := validateRelPath(p); err != nil {
			t.Fatalf("路径 %q 应被接受: %v", p, err)
		}
	}
}

// TestPermissionSummaryAndDiff 权限描述与差异计算。
func TestPermissionSummaryAndDiff(t *testing.T) {
	old := Permissions{Storage: true}
	next := Permissions{
		Storage: true,
		Network: []string{"api.example.com"},
		DB:      []string{"read"},
		Events:  true,
	}

	diff := PermissionDiff(old, next)
	if len(diff) != 3 {
		t.Fatalf("期望 3 项新增权限，实际 %d: %v", len(diff), diff)
	}
	if len(PermissionDiff(next, next)) != 0 {
		t.Fatal("权限未变化时差异应为空")
	}
	if !PermissionsEqual(old, Permissions{Storage: true}) {
		t.Fatal("相同权限应判定为相等")
	}

	summary := next.PermissionSummary()
	if len(summary) != 4 {
		t.Fatalf("期望 4 项权限描述，实际 %v", summary)
	}
}

// TestPermissionsAllowsURL 网络白名单匹配规则。
func TestPermissionsAllowsURL(t *testing.T) {
	perms := Permissions{Network: []string{"api.example.com", "*.trusted.io"}}
	cases := map[string]bool{
		"https://api.example.com/v1":      true,
		"http://api.example.com":          true,
		"https://sub.api.example.com":     false,
		"https://a.trusted.io":            true,
		"https://a.b.trusted.io":          true,
		"https://trusted.io":              false,
		"ftp://api.example.com":           false,
		"https://evil.com":                false,
		"https://api.example.com.evil.io": false,
	}
	for raw, want := range cases {
		if got := perms.AllowsURL(raw); got != want {
			t.Fatalf("AllowsURL(%q) = %v，期望 %v", raw, got, want)
		}
	}
	empty := Permissions{}
	if empty.AllowsURL("https://api.example.com") {
		t.Fatal("未声明网络权限时不应允许任何地址")
	}
}

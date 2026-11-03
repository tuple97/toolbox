package plugin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

/* 用户看到的错误应该只有「插件想说的那句话」 */

// runBackendHandler 装一个只有后端脚本的插件，调用指定 handler 并返回错误文案。
func runBackendHandler(t *testing.T, id, script, handler string, args any) error {
	t.Helper()

	mgr := newTestManager(t)
	mgr.SetDeveloperMode(true)

	manifest := &Manifest{
		ManifestVersion: 1,
		ID:              id,
		Name:            "错误文案测试",
		Version:         "1.0.0",
		Publisher:       "test",
		Engines:         Engines{Toolbox: ">=0.1.0", PluginAPI: "^1.0.0"},
		Runtime:         RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js"},
		Contributes: Contributions{
			Tools: []ToolContribution{{Type: id + "-tool", Label: "错误文案测试"}},
		},
	}
	dir := writePluginDir(t, manifest, map[string]string{
		"backend/index.js": script,
	})

	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览插件失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装插件失败: %v", err)
	}

	var raw json.RawMessage
	if args != nil {
		encoded, marshalErr := json.Marshal(args)
		if marshalErr != nil {
			t.Fatalf("序列化参数失败: %v", marshalErr)
		}
		raw = encoded
	}
	_, err = mgr.Invoke(context.Background(), id, handler, raw)
	return err
}

func assertCleanMessage(t *testing.T, message string, mustContain []string) {
	t.Helper()
	for _, want := range mustContain {
		if !strings.Contains(message, want) {
			t.Fatalf("提示文案丢失了「%s」，实际: %q", want, message)
		}
	}
	for _, unwanted := range []string{" at ", "Error:", "GoError:", "执行失败", "handler"} {
		if strings.Contains(message, unwanted) {
			t.Fatalf("错误信息里不该出现 %q，实际: %q", unwanted, message)
		}
	}
}

// 插件里 throw new Error('...') 的典型场景（PMS token 失效就是这样报的）
func TestHandlerErrorKeepsOnlyMessage(t *testing.T) {
	err := runBackendHandler(t, "com.test.error-message", `
		toolbox.handler('verify', function () {
			throw new Error('token 已失效或不正确，请重新登录')
		})
	`, "verify", nil)
	if err == nil {
		t.Fatal("应该返回错误")
	}
	assertCleanMessage(t, err.Error(), []string{"token 已失效或不正确，请重新登录"})
}

// Go 侧抛出的错误（NewGoError）同样不应带前缀
func TestGoErrorKeepsOnlyMessage(t *testing.T) {
	err := runBackendHandler(t, "com.test.go-error", `
		toolbox.handler('boom', function () {
			toolbox.http.request({})
		})
	`, "boom", nil)
	if err == nil {
		t.Fatal("应该返回错误")
	}
	assertCleanMessage(t, err.Error(), []string{"请求缺少 url"})
}

// 单元层面直接验证前缀剥离
func TestJSMessageStripping(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"Error 前缀", "Error: token 已失效或不正确，请重新登录", "token 已失效或不正确，请重新登录"},
		{"GoError 前缀", "GoError: 请求缺少 url", "请求缺少 url"},
		{"TypeError 前缀", "TypeError: 请求缺少 url", "请求缺少 url"},
		{"RangeError 前缀", "RangeError: 参数越界", "参数越界"},
		{"无前缀保持原样", "签到失败：今天已签到", "签到失败：今天已签到"},
		{"只有构造器名视为空", "Error", ""},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := stripJSErrorPrefix(item.in)
			if got != item.want {
				t.Fatalf("stripJSErrorPrefix(%q) = %q，期望 %q", item.in, got, item.want)
			}
		})
	}
}

/* 复现用户反馈的 PMS 场景： verify handler 检测到 token 失效 → throw new Erro */
func TestPMSVerifyStyleMessage(t *testing.T) {
	err := runBackendHandler(t, "com.test.pms-style", `
		toolbox.handler('verify', function () {
			throw new Error('token 已失效或不正确，请重新登录')
		})
	`, "verify", map[string]any{"token": ""})
	if err == nil {
		t.Fatal("应该返回错误")
	}
	got := err.Error()
	if got != "token 已失效或不正确，请重新登录" {
		t.Fatalf("用户应只看到一句话，实际: %q", got)
	}
	if strings.Contains(got, "handler") || strings.Contains(got, " at ") {
		t.Fatalf("不该包含实现细节，实际: %q", got)
	}
}

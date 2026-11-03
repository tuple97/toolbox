package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 迁移验收：把「公共库 / 私有库」构建出来的产物当作真实安装包，
// 走一遍宿主的「源码目录安装 → 加载 → 调用 → 权限校验」全链路。
//
// 这样做的意义：插件仓的构建成功只说明产物**打得出来**，
// 是否**装得进去、跑得起来**要由宿主判定 —— 清单协议、权限字段、
// 前端入口、后端 handler 注册全在宿主的代码里。
//
// 目录不存在时跳过（CI 与独立检出宿主仓库时不会有这两个仓）。
func TestMigratedPluginsInstallAndRun(t *testing.T) {
	type expectation struct {
		root        string
		id          string
		handler     string
		args        string
		wantExports []string
	}

	cases := []expectation{
		{
			// 公共库的纯前端插件：验证「没有后端运行时」的插件也能装进去
			root:    `..\..\..\..\toolbox-plugins\plugins\connections`,
			id:      "com.toolbox.connections",
			handler: "",
		},
		{
			// 带后端运行时的官方插件：签到/余量等动作都在这层注册
			root:    `..\..\..\..\toolbox-plugins\plugins\agent-accounts`,
			id:      "com.toolbox.agent-accounts",
			handler: "state",
		},
		{
			root:    `..\..\..\..\toolbox-plugins-private\plugins\elk-logs`,
			id:      "com.sany.elk-logs",
			handler: "state",
		},
		{
			root:    `..\..\..\..\toolbox-plugins-private\plugins\pms-worklog`,
			id:      "com.sany.pms-worklog",
			handler: "state",
		},
	}

	for _, item := range cases {
		t.Run(item.id, func(t *testing.T) {
			dir, err := filepath.Abs(item.root)
			if err != nil {
				t.Fatalf("解析插件目录失败: %v", err)
			}
			manifestPath := filepath.Join(dir, "manifest.json")
			if _, statErr := os.Stat(manifestPath); statErr != nil {
				t.Skipf("插件源码目录不存在，跳过: %s", dir)
			}

			mgr := newTestManager(t)
			mgr.SetDeveloperMode(true)

			preview, err := mgr.Preview(context.Background(),
				[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
				PreviewOptions{ResolveDependencies: true})
			if err != nil {
				t.Fatalf("预览安装 %s 失败: %v", item.id, err)
			}
			if preview == nil || preview.PlanID == "" {
				t.Fatalf("%s 没有生成安装计划", item.id)
			}
			if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
				t.Fatalf("安装 %s 失败: %v", item.id, err)
			}

			installed := false
			for _, info := range mgr.ListInstalled() {
				if info.ID != item.id {
					continue
				}
				installed = true
				if info.LoadError != "" {
					t.Fatalf("%s 安装后加载失败: %s", item.id, info.LoadError)
				}
			}
			if !installed {
				t.Fatalf("%s 安装后没有出现在已安装列表", item.id)
			}

			if item.handler == "" {
				return
			}

			// 前端插件自带后端时，handler 必须真的注册上了
			if _, err := mgr.Invoke(context.Background(), item.id, item.handler, nil); err != nil {
				t.Fatalf("%s 调用 handler %q 失败: %v", item.id, item.handler, err)
			}
		})
	}
}

// 迁移验收：写入文件的权限边界。
//
// 这是新加的宿主能力，必须证明「没声明 permissions.fileWrite 就写不了」，
// 否则任何插件都能往用户机器上落文件。
func TestSaveTextFileRequiresFileWritePermission(t *testing.T) {
	dir := t.TempDir()
	env := &stubHostEnv{savePath: filepath.Join(dir, "out.csv")}

	withoutPermission := NewHostBridge(env, "com.test.readonly", "1.0.0", Permissions{Storage: true})
	saveErr := error(nil)
	_, saveErr = withoutPermission.SaveTextFile("导出", "out.csv", "a,b", nil)
	if saveErr == nil {
		t.Fatal("未声明 permissions.fileWrite 时导出文件应被拒绝")
	}
	if !strings.Contains(saveErr.Error(), "permissions.fileWrite") {
		t.Fatalf("错误应说明缺少哪项权限，实际: %v", saveErr)
	}
	if env.prompted {
		t.Fatal("权限不足时不应该弹出保存对话框")
	}

	withPermission := NewHostBridge(env, "com.test.writer", "1.0.0", Permissions{FileWrite: true})
	written, err := withPermission.SaveTextFile("导出", "out.csv", "a,b\n1,2\n", []FileFilter{
		{DisplayName: "CSV 文件", Pattern: "*.csv"},
	})
	if err != nil {
		t.Fatalf("声明权限后导出应成功: %v", err)
	}
	if written != env.savePath {
		t.Fatalf("写入路径应为对话框返回的路径，实际 %q", written)
	}
	content, readErr := os.ReadFile(env.savePath)
	if readErr != nil {
		t.Fatalf("文件没有写出来: %v", readErr)
	}
	if string(content) != "a,b\n1,2\n" {
		t.Fatalf("文件内容不符: %q", string(content))
	}
}

// 用户取消保存对话框不是错误：插件要能静默收场。
func TestSaveTextFileCancelIsNotError(t *testing.T) {
	env := &stubHostEnv{savePath: ""}
	bridge := NewHostBridge(env, "com.test.writer", "1.0.0", Permissions{FileWrite: true})

	written, err := bridge.SaveTextFile("导出", "out.csv", "data", nil)
	if err != nil {
		t.Fatalf("用户取消不该报错: %v", err)
	}
	if written != "" {
		t.Fatalf("取消时应返回空路径，实际 %q", written)
	}
}

// 权限扩张必须能被识别：升级弹窗靠它决定要不要重新征求同意。
func TestPermissionDiffDetectsFileWrite(t *testing.T) {
	before := Permissions{Storage: true}
	after := Permissions{Storage: true, FileWrite: true}

	added := PermissionDiff(before, after)
	found := false
	for _, item := range added {
		if strings.Contains(item, "本地文件") {
			found = true
		}
	}
	if !found {
		t.Fatalf("新增 fileWrite 权限应出现在权限差异里，实际: %v", added)
	}
	if PermissionsEqual(before, after) {
		t.Fatal("权限扩张后不应再判定为相等")
	}
}

// stubHostEnv 只实现 SaveTextFile 需要的那部分，其余方法维持最小行为。
type stubHostEnv struct {
	savePath string
	prompted bool
	settings map[string]string
}

func (s *stubHostEnv) AppVersion() string { return "test" }

func (s *stubHostEnv) StorageGet(_, key string) (string, bool, error) {
	value, ok := s.settings[key]
	return value, ok, nil
}

func (s *stubHostEnv) StorageSet(_, key, value string) error {
	if s.settings == nil {
		s.settings = map[string]string{}
	}
	s.settings[key] = value
	return nil
}

func (s *stubHostEnv) StorageDelete(_, key string) error {
	delete(s.settings, key)
	return nil
}

func (s *stubHostEnv) StorageList(string) (map[string]string, error) {
	return s.settings, nil
}

func (s *stubHostEnv) EmitEvent(string, string, any) error { return nil }

func (s *stubHostEnv) CallPlugin(
	context.Context, string, string, string, json.RawMessage,
) (json.RawMessage, error) {
	return nil, nil
}

func (s *stubHostEnv) EnabledPlugins() []PluginSummary { return nil }

func (s *stubHostEnv) PromptSaveFile(string, string, []FileFilter) (string, error) {
	s.prompted = true
	return s.savePath, nil
}

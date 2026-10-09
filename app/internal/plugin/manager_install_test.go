package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 回归测试：纯前端插件（runtime.backend = "none"）没有后端运行时，
// 加载路径必须在 runtime 为 nil 时也能走通 —— 早期版本在这里对
// nil 的 runtime 调用了 Handlers()，导致安装过程中 panic。
func TestInstallFrontendOnlyPlugin(t *testing.T) {
	dataDir := t.TempDir()

	manifest := &Manifest{
		ID:        "com.test.frontend-only",
		Name:      "纯前端插件",
		Version:   "1.0.0",
		Publisher: "test",
		Runtime:   RuntimeSpec{Backend: "none", Frontend: "frontend/index.js"},
		Contributes: Contributions{
			Tools: []ToolContribution{{Type: "front-only", Label: "纯前端工具"}},
		},
	}

	archive := buildArchive(t, manifest, map[string]string{
		"frontend/index.js": "export function activate() {}",
	})

	mgr := NewManager(Options{DataDir: dataDir, AppVersion: "0.1.0"})

	if err := mgr.InstallArchive(context.Background(), "front-only.zip", archive, true, true); err != nil {
		t.Fatalf("安装纯前端插件失败: %v", err)
	}

	installed := mgr.ListInstalled()
	if len(installed) != 1 {
		t.Fatalf("期望安装 1 个插件，实际 %d", len(installed))
	}
	info := installed[0]
	if info.ID != manifest.ID {
		t.Errorf("插件 id 不符: %s", info.ID)
	}
	if !info.Enabled || !info.Trusted {
		t.Error("安装后应为启用且已信任")
	}
	if info.Loaded {
		t.Error("纯前端插件不应报告已加载后端运行时")
	}
	if info.LoadError != "" {
		t.Errorf("纯前端插件不应有加载错误: %s", info.LoadError)
	}
	if len(info.Tools) != 1 || info.Tools[0].Type != "front-only" {
		t.Errorf("扩展点未正确读取: %+v", info.Tools)
	}
}

// 安装到本地目录（开发者模式）后重新扫描，同样不应 panic。
func TestInstallFrontendOnlyPluginFromLocalDir(t *testing.T) {
	dataDir := t.TempDir()
	pluginDir := filepath.Join(t.TempDir(), "front-only")

	manifest := &Manifest{
		ID:        "com.test.local-front",
		Name:      "本地纯前端插件",
		Version:   "1.0.0",
		Publisher: "test",
		Runtime:   RuntimeSpec{Backend: "none"},
	}
	writeFile(t, filepath.Join(pluginDir, ManifestFileName), mustJSON(t, manifest))
	writeFile(t, filepath.Join(pluginDir, "frontend/index.js"), []byte("export function activate() {}"))

	mgr := NewManager(Options{DataDir: dataDir, AppVersion: "0.1.0"})
	if err := mgr.Install(context.Background(), InstallRequest{
		Source: SourceLocalDir,
		Ref:    pluginDir,
		Trust:  true,
	}); err != nil {
		t.Fatalf("从本地目录安装失败: %v", err)
	}

	if installed := mgr.ListInstalled(); len(installed) != 1 {
		t.Fatalf("期望安装 1 个插件，实际 %d", len(installed))
	}
}

// 选中「包含多个插件的父目录」时应给出可操作的提示，而不是原始的
// 「找不到 manifest.json」。
func TestInstallFromParentDirectoryGivesActionableError(t *testing.T) {
	dataDir := t.TempDir()
	parent := t.TempDir()

	for _, name := range []string{"alpha", "beta"} {
		dir := filepath.Join(parent, name)
		manifest := &Manifest{
			ID:        "com.test." + name,
			Name:      name,
			Version:   "1.0.0",
			Publisher: "test",
			Runtime:   RuntimeSpec{Backend: "none"},
		}
		writeFile(t, filepath.Join(dir, ManifestFileName), mustJSON(t, manifest))
	}

	mgr := NewManager(Options{DataDir: dataDir, AppVersion: "0.1.0"})
	err := mgr.Install(context.Background(), InstallRequest{
		Source: SourceLocalDir,
		Ref:    parent,
		Trust:  true,
	})
	if err == nil {
		t.Fatal("选中父目录应当报错")
	}
	message := err.Error()
	if !bytes.Contains([]byte(message), []byte("请选择具体的插件目录")) {
		t.Errorf("错误提示不够明确: %s", message)
	}
	if !bytes.Contains([]byte(message), []byte("alpha")) {
		t.Errorf("错误提示应指出一个可用的子目录: %s", message)
	}
}

// 无依赖的插件安装不应触发索引网络请求（离线也应立即完成）。
func TestInstallWithoutDependenciesDoesNotFetchIndex(t *testing.T) {
	dataDir := t.TempDir()

	manifest := &Manifest{
		ID:        "com.test.offline",
		Name:      "离线插件",
		Version:   "1.0.0",
		Publisher: "test",
		Runtime:   RuntimeSpec{Backend: "none"},
	}
	archive := buildArchive(t, manifest, nil)

	mgr := NewManager(Options{
		DataDir:    dataDir,
		AppVersion: "0.1.0",
		// 指向一个必然失败的地址：一旦走了网络分支，测试就会明显变慢/失败
		Registry: RegistryProvider{IndexURL: "http://127.0.0.1:1/registry.json"},
	})

	if err := mgr.InstallArchive(context.Background(), "offline.zip", archive, true, true); err != nil {
		t.Fatalf("离线安装失败: %v", err)
	}
	if mgr.indexLoaded {
		t.Error("无依赖的插件安装不应去拉取官方索引")
	}
}

// 回归测试：依赖已经装好时，安装预览仍要把它列在计划里（动作 keep），
// 不能因为它无需重新落地就从计划里消失 —— 否则界面会误报「无依赖，可独立运行」。
func TestPreviewKeepsInstalledDependencyInPlan(t *testing.T) {
	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: "0.1.0",
		// 指向必然失败的地址：依赖已装齐，不该再去联网
		Registry: RegistryProvider{IndexURL: "http://127.0.0.1:1/registry.json"},
	})

	depDir := filepath.Join(t.TempDir(), "dep")
	dep := &Manifest{
		ID:        "com.test.dep",
		Name:      "已被依赖的插件",
		Version:   "1.0.0",
		Publisher: "test",
		Runtime:   RuntimeSpec{Backend: "none"},
	}
	writeFile(t, filepath.Join(depDir, ManifestFileName), mustJSON(t, dep))
	if err := mgr.Install(context.Background(), InstallRequest{
		Source: SourceLocalDir,
		Ref:    depDir,
		Trust:  true,
	}); err != nil {
		t.Fatalf("安装依赖插件失败: %v", err)
	}

	// 主插件放在另一个父目录下，确保只有「已安装集合」能提供这条依赖
	mainDir := filepath.Join(t.TempDir(), "main")
	main := &Manifest{
		ID:           "com.test.main",
		Name:         "主插件",
		Version:      "1.0.0",
		Publisher:    "test",
		Runtime:      RuntimeSpec{Backend: "none"},
		Dependencies: map[string]string{"com.test.dep": "^1.0.0"},
	}
	writeFile(t, filepath.Join(mainDir, ManifestFileName), mustJSON(t, main))

	preview, err := mgr.Preview(context.Background(), InstallRequest{
		Source: SourceLocalDir,
		Ref:    mainDir,
	})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}

	if len(preview.MissingDependencies) != 0 {
		t.Fatalf("依赖已装好，不应报缺失: %+v", preview.MissingDependencies)
	}
	item := planItemOf(preview, "com.test.dep")
	if item == nil {
		t.Fatalf("预览计划应包含已安装的依赖，实际: %+v", preview.Plan)
	}
	if item.Action != "keep" {
		t.Errorf("已安装依赖的动作应为 keep，实际 %q", item.Action)
	}
	if item.Scanned {
		t.Error("已安装依赖不是扫描得来的，不应标记 Scanned")
	}
}

// 依赖既没安装、也不在索引里，但在同级目录被扫到：计划里要能区分出来
// （Scanned = true），界面据此显示「自动扫描」而不是普通「新装」。
func TestPreviewMarksScannedDependency(t *testing.T) {
	parent := t.TempDir()

	dep := &Manifest{
		ID:        "com.test.scanned",
		Name:      "同级目录里的依赖",
		Version:   "1.0.0",
		Publisher: "test",
		Runtime:   RuntimeSpec{Backend: "none"},
	}
	writeFile(t, filepath.Join(parent, "scanned", ManifestFileName), mustJSON(t, dep))

	mainDir := filepath.Join(parent, "main")
	main := &Manifest{
		ID:           "com.test.main",
		Name:         "主插件",
		Version:      "1.0.0",
		Publisher:    "test",
		Runtime:      RuntimeSpec{Backend: "none"},
		Dependencies: map[string]string{"com.test.scanned": "^1.0.0"},
	}
	writeFile(t, filepath.Join(mainDir, ManifestFileName), mustJSON(t, main))

	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: "0.1.0",
		Registry:   RegistryProvider{IndexURL: "http://127.0.0.1:1/registry.json"},
	})

	preview, err := mgr.Preview(context.Background(), InstallRequest{
		Source: SourceLocalDir,
		Ref:    mainDir,
	})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}

	if len(preview.MissingDependencies) != 0 {
		t.Fatalf("同级目录里能扫到依赖，不应报缺失: %+v", preview.MissingDependencies)
	}
	item := planItemOf(preview, "com.test.scanned")
	if item == nil {
		t.Fatalf("应扫描到同级目录里的依赖，实际: %+v", preview.Plan)
	}
	if !item.Scanned {
		t.Error("同级目录扫描到的依赖应标记 Scanned")
	}
	if item.Action != "install" {
		t.Errorf("未安装依赖的动作应为 install，实际 %q", item.Action)
	}
}

// 回归测试：被依赖的插件默认拒绝卸载；强制卸载要先停用依赖方再删。
//
// 依赖链 leaf ← mid ← top：卸载 leaf 时 mid、top 的依赖都断了，
// 只停用直接依赖方（mid）会留下 top 指着已停用的 mid，所以必须停用传递闭包。
func TestForceUninstallDisablesDependents(t *testing.T) {
	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: "0.1.0",
		// 指向必然失败的地址：依赖都在本地已装集合里，不该联网
		Registry: RegistryProvider{IndexURL: "http://127.0.0.1:1/registry.json"},
	})

	installLocal := func(id, name string, deps map[string]string) {
		t.Helper()
		dir := filepath.Join(t.TempDir(), id)
		mf := &Manifest{
			ID:           id,
			Name:         name,
			Version:      "1.0.0",
			Publisher:    "test",
			Runtime:      RuntimeSpec{Backend: "none"},
			Dependencies: deps,
		}
		writeFile(t, filepath.Join(dir, ManifestFileName), mustJSON(t, mf))
		if err := mgr.Install(context.Background(), InstallRequest{
			Source: SourceLocalDir,
			Ref:    dir,
			Trust:  true,
		}); err != nil {
			t.Fatalf("安装 %s 失败: %v", id, err)
		}
	}

	installLocal("com.test.leaf", "被依赖的插件", nil)
	installLocal("com.test.mid", "直接依赖方", map[string]string{"com.test.leaf": "^1.0.0"})
	installLocal("com.test.top", "传递依赖方", map[string]string{"com.test.mid": "^1.0.0"})

	// 非强制：拒绝卸载，错误里要指明依赖方，且不能真的删掉
	_, err := mgr.Uninstall(context.Background(), "com.test.leaf", false)
	if !errors.Is(err, ErrInUse) {
		t.Fatalf("被依赖时卸载应返回 ErrInUse，实际: %v", err)
	}
	if err != nil && !strings.Contains(err.Error(), "com.test.mid") {
		t.Errorf("错误信息里应指明直接依赖方，实际: %v", err)
	}
	if installedInfoOf(mgr, "com.test.leaf") == nil {
		t.Fatal("非强制卸载被拒后，插件不应被删除")
	}

	// 强制：返回被停用的插件（含传递依赖），插件本体删除，依赖方保留但停用
	disabled, err := mgr.Uninstall(context.Background(), "com.test.leaf", true)
	if err != nil {
		t.Fatalf("强制卸载失败: %v", err)
	}
	if len(disabled) != 2 || disabled[0] != "com.test.mid" || disabled[1] != "com.test.top" {
		t.Errorf("应停用 mid 与 top，实际: %v", disabled)
	}
	if installedInfoOf(mgr, "com.test.leaf") != nil {
		t.Error("强制卸载后插件应已删除")
	}
	for _, id := range []string{"com.test.mid", "com.test.top"} {
		info := installedInfoOf(mgr, id)
		if info == nil {
			t.Fatalf("%s 不应被删除", id)
		}
		if info.Enabled {
			t.Errorf("%s 应被自动停用", id)
		}
	}
}

// ---------------------------------------------------------------- 测试辅助

// installedInfoOf 按 id 取已安装信息，不存在时返回 nil。
func installedInfoOf(mgr *Manager, id string) *InstalledInfo {
	list := mgr.ListInstalled()
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

// planItemOf 在预览计划里按插件 id 取一项，取不到返回 nil。
func planItemOf(preview *InstallPreview, id string) *InstallPlanItem {
	for i := range preview.Plan {
		if preview.Plan[i].ID == id {
			return &preview.Plan[i]
		}
	}
	return nil
}

// buildArchive 构造一个符合宿主解包要求的插件包。
func buildArchive(t *testing.T, manifest *Manifest, files map[string]string) []byte {
	t.Helper()

	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)

	writeZipEntry(t, writer, ManifestFileName, mustJSON(t, manifest))
	for name, content := range files {
		writeZipEntry(t, writer, name, []byte(content))
	}

	if err := writer.Close(); err != nil {
		t.Fatalf("构造插件包失败: %v", err)
	}
	return buf.Bytes()
}

func writeZipEntry(t *testing.T, writer *zip.Writer, name string, data []byte) {
	t.Helper()
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatalf("写入 zip 条目失败(%s): %v", name, err)
	}
	if _, err := entry.Write(data); err != nil {
		t.Fatalf("写入 zip 内容失败(%s): %v", name, err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	return raw
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写入文件失败(%s): %v", path, err)
	}
}

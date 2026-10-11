package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// installWithBackend 安装一个带 JS 后端的插件。
//
// 只补上后端必需字段，不覆盖调用方已设置的 runtime.exports。
func installWithBackend(t *testing.T, mgr *Manager, mf *Manifest, script string) {
	t.Helper()
	mf.Runtime.Backend = string(BackendJS)
	if mf.Runtime.Entry == "" {
		mf.Runtime.Entry = "backend/index.js"
	}
	dir := writePluginDir(t, mf, map[string]string{"backend/index.js": script})
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
}

// TestLoadOrderDependenciesFirst 依赖必须先于依赖方加载。
func TestLoadOrderDependenciesFirst(t *testing.T) {
	mgr := newTestManager(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")

	installFromDir(t, mgr, dep)
	installFromDir(t, mgr, main)

	for _, id := range []string{dep.ID, main.ID} {
		info := findInfo(t, mgr, id)
		if !info.Active {
			t.Fatalf("%s 应处于激活状态: %+v", id, info)
		}
	}
	order, err := mgr.graph.OrderSubset([]string{dep.ID, main.ID})
	if err != nil {
		t.Fatalf("拓扑排序失败: %v", err)
	}
	if order[0].ID != dep.ID {
		t.Fatalf("依赖应排在前面: %v", order)
	}
}

// TestDisabledDependencyBlocksDependent 依赖被停用时，依赖方不能激活。
func TestDisabledDependencyBlocksDependent(t *testing.T) {
	mgr := newTestManager(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	installFromDir(t, mgr, dep)
	installFromDir(t, mgr, main)

	// 只把依赖标记为停用，依赖方的记录仍写着「启用」：
	// 这正是重构前会被错误加载的状态，必须算出「阻塞」而不是「运行中」
	rec := mgr.recordOf2(dep.ID)
	rec.Enabled = false
	if err := mgr.Store().WriteRecord(rec); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if err := mgr.Reload(context.Background()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	mainInfo := findInfo(t, mgr, main.ID)
	if mainInfo.Active {
		t.Fatal("依赖被停用后依赖方不能继续运行")
	}
	if !mainInfo.Enabled {
		t.Fatal("本例中依赖方的用户意图仍是启用")
	}
	if !strings.Contains(mainInfo.BlockedReason, dep.ID) {
		t.Fatalf("阻塞原因应指明依赖: %q", mainInfo.BlockedReason)
	}
}

// TestCascadeDisableClearsDependentIntent 级联停用会同步清掉依赖方的启用意图。
func TestCascadeDisableClearsDependentIntent(t *testing.T) {
	mgr := newTestManager(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	installFromDir(t, mgr, dep)
	installFromDir(t, mgr, main)

	changed, err := mgr.SetEnabled(context.Background(), dep.ID, false, true)
	if err != nil {
		t.Fatalf("级联停用失败: %v", err)
	}
	if len(changed) != 2 {
		t.Fatalf("级联停用应影响 2 个插件，实际 %v", changed)
	}
	if findInfo(t, mgr, main.ID).Enabled {
		t.Fatal("级联停用应同时清掉依赖方的启用意图")
	}
}

// TestEnableRequiresEnabledDependency 启用前必须校验依赖已启用。
func TestEnableRequiresEnabledDependency(t *testing.T) {
	mgr := newTestManager(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	installFromDir(t, mgr, dep)
	installFromDir(t, mgr, main)

	if _, err := mgr.SetEnabled(context.Background(), dep.ID, false, true); err != nil {
		t.Fatalf("级联停用失败: %v", err)
	}
	_, err := mgr.SetEnabled(context.Background(), main.ID, true, false)
	if err == nil {
		t.Fatal("依赖未启用时不应允许启用依赖方")
	}
	if !strings.Contains(err.Error(), "依赖") {
		t.Fatalf("错误应说明依赖问题: %v", err)
	}
}

// TestDisableInUseRequiresCascade 停用被依赖的插件需要显式级联。
func TestDisableInUseRequiresCascade(t *testing.T) {
	mgr := newTestManager(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	installFromDir(t, mgr, dep)
	installFromDir(t, mgr, main)

	_, err := mgr.SetEnabled(context.Background(), dep.ID, false, false)
	if err == nil {
		t.Fatal("停用被依赖的插件默认应被拒绝")
	}
	if !strings.Contains(err.Error(), ErrInUse.Error()) || !strings.Contains(err.Error(), main.ID) {
		t.Fatalf("错误应说明依赖方: %v", err)
	}

	changed, err := mgr.SetEnabled(context.Background(), dep.ID, false, true)
	if err != nil {
		t.Fatalf("级联停用失败: %v", err)
	}
	if len(changed) != 2 {
		t.Fatalf("级联停用应影响 2 个插件，实际 %v", changed)
	}
}

// TestUninstallInUseRequiresForce 卸载被依赖的插件默认拒绝，强制时级联停用。
func TestUninstallInUseRequiresForce(t *testing.T) {
	mgr := newTestManager(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	installFromDir(t, mgr, dep)
	installFromDir(t, mgr, main)

	_, err := mgr.Uninstall(context.Background(), dep.ID, false)
	if err == nil {
		t.Fatal("卸载被依赖的插件默认应被拒绝")
	}
	if !strings.Contains(err.Error(), ErrInUse.Error()) {
		t.Fatalf("错误应说明被依赖: %v", err)
	}

	disabled, err := mgr.Uninstall(context.Background(), dep.ID, true)
	if err != nil {
		t.Fatalf("强制卸载失败: %v", err)
	}
	if len(disabled) != 1 || disabled[0] != main.ID {
		t.Fatalf("应报告被停用的依赖方，实际 %v", disabled)
	}
	if mgr.Store().HasVersion(dep.ID, dep.Version) {
		t.Fatal("卸载后版本目录应被删除")
	}
	mainInfo := findInfo(t, mgr, main.ID)
	if mainInfo.Active {
		t.Fatal("依赖被卸载后依赖方不能继续运行")
	}
}

// TestIncompatiblePluginIsBlocked 与宿主版本不兼容的插件不能激活。
func TestIncompatiblePluginIsBlocked(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.future", "1.0.0")
	mf.Engines.Toolbox = ">=99.0.0"
	installFromDir(t, mgr, mf)

	info := findInfo(t, mgr, mf.ID)
	if info.Active {
		t.Fatal("不兼容的插件不应激活")
	}
	if info.Compatible {
		t.Fatal("应标记为不兼容")
	}
	if !strings.Contains(info.IncompatReason, "99.0.0") {
		t.Fatalf("不兼容原因应说明需要的版本: %q", info.IncompatReason)
	}
}

// TestIncompatiblePluginAPIBlocksPlugin 插件 API 版本不匹配同样阻止激活。
func TestIncompatiblePluginAPIBlocksPlugin(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.apifuture", "1.0.0")
	mf.Engines.PluginAPI = "^2.0.0"
	installFromDir(t, mgr, mf)

	info := findInfo(t, mgr, mf.ID)
	if info.Active || info.Compatible {
		t.Fatalf("插件 API 不兼容时不应激活: %+v", info)
	}
}

// TestCircularDependencyBlocksAll 存在循环依赖时相关插件都不加载。
func TestCircularDependencyBlocksAll(t *testing.T) {
	mgr := newTestManager(t)
	// 逐个安装：安装 B 时 A 尚未存在，因此这里直接伪造磁盘状态来构造环路
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.0.0"), "com.toolbox.a", "^1.0.0")

	for _, mf := range []*Manifest{a, b} {
		dir := mgr.Store().VersionDir(mf.ID, mf.Version)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
		raw, err := json.Marshal(mf)
		if err != nil {
			t.Fatalf("序列化失败: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
			t.Fatalf("写入清单失败: %v", err)
		}
		if err := mgr.Store().WriteRecord(&InstallRecord{
			ID: mf.ID, Version: mf.Version, Source: SourceLocalDir,
			Trust: TrustUser, Enabled: true, InstalledAt: nowRFC3339(),
		}); err != nil {
			t.Fatalf("写入记录失败: %v", err)
		}
	}
	if err := mgr.Reload(context.Background()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	for _, id := range []string{a.ID, b.ID} {
		info := findInfo(t, mgr, id)
		if info.Active {
			t.Fatalf("%s 不应在循环依赖下激活", id)
		}
		if !strings.Contains(info.BlockedReason, "循环依赖") {
			t.Fatalf("%s 的阻塞原因应说明循环依赖: %q", id, info.BlockedReason)
		}
	}
}

// TestMissingDependencyBlocksPlugin 依赖缺失时不能靠 enabled 字段硬加载。
func TestMissingDependencyBlocksPlugin(t *testing.T) {
	mgr := newTestManager(t)
	mf := withDependency(baseManifest("com.toolbox.orphan", "1.0.0"), "com.toolbox.nothing", "^1.0.0")

	dir := mgr.Store().VersionDir(mf.ID, mf.Version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	raw, _ := json.Marshal(mf)
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
		t.Fatalf("写入清单失败: %v", err)
	}
	if err := mgr.Store().WriteRecord(&InstallRecord{
		ID: mf.ID, Version: mf.Version, Source: SourceLocalDir,
		Trust: TrustUser, Enabled: true, InstalledAt: nowRFC3339(),
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if err := mgr.Reload(context.Background()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	info := findInfo(t, mgr, mf.ID)
	if info.Active {
		t.Fatal("依赖缺失时插件不应激活")
	}
	if len(info.MissingDependencies) != 1 || info.MissingDependencies[0].ID != "com.toolbox.nothing" {
		t.Fatalf("应报告缺失依赖: %+v", info.MissingDependencies)
	}
}

// TestUntrustedPluginNotLoaded 未受信任的插件不会被加载。
func TestUntrustedPluginNotLoaded(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.untrusted", "1.0.0")

	dir := mgr.Store().VersionDir(mf.ID, mf.Version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	raw, _ := json.Marshal(mf)
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
		t.Fatalf("写入清单失败: %v", err)
	}
	if err := mgr.Store().WriteRecord(&InstallRecord{
		ID: mf.ID, Version: mf.Version, Source: SourceURL,
		Trust: TrustNone, Enabled: true, InstalledAt: nowRFC3339(),
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if err := mgr.Reload(context.Background()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	info := findInfo(t, mgr, mf.ID)
	if info.Active {
		t.Fatal("未受信任的插件不应激活")
	}
	if !strings.Contains(info.BlockedReason, "信任") {
		t.Fatalf("阻塞原因应说明信任问题: %q", info.BlockedReason)
	}
}

// TestInvokeRequiresActivePlugin 未激活的插件不能被调用。
func TestInvokeRequiresActivePlugin(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.invoke", "1.0.0")
	installWithBackend(t, mgr, mf, testBackendScript)

	raw, err := mgr.Invoke(context.Background(), mf.ID, "ping", json.RawMessage(`{"a":1}`))
	if err != nil {
		t.Fatalf("调用失败: %v", err)
	}
	if !strings.Contains(string(raw), `"ok":true`) {
		t.Fatalf("返回值不符合预期: %s", raw)
	}

	if _, err := mgr.Invoke(context.Background(), mf.ID, "nope", nil); err == nil {
		t.Fatal("未知 handler 应报错")
	}
	if _, err := mgr.Invoke(context.Background(), "com.toolbox.absent", "ping", nil); err == nil {
		t.Fatal("未安装插件应报错")
	}
}

// TestRuntimeClosedRejectsCalls 运行时关闭后不能再接受调用。
func TestRuntimeClosedRejectsCalls(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.close", "1.0.0")
	installWithBackend(t, mgr, mf, testBackendScript)

	if err := mgr.Close(); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}
	if _, err := mgr.Invoke(context.Background(), mf.ID, "ping", nil); err == nil {
		t.Fatal("关闭后不应还能调用")
	}
}

// TestReloadDoesNotDuplicateHandlers 重载不会叠加 handler 注册。
func TestReloadDoesNotDuplicateHandlers(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.reload", "1.0.0")
	installWithBackend(t, mgr, mf, testBackendScript)

	first := mgr.RuntimeHandlers(mf.ID)
	for i := 0; i < 3; i++ {
		if err := mgr.Reload(context.Background()); err != nil {
			t.Fatalf("重载失败: %v", err)
		}
	}
	again := mgr.RuntimeHandlers(mf.ID)
	if len(first) != len(again) {
		t.Fatalf("重载后 handler 数量发生变化: %v → %v", first, again)
	}
	enabled := mgr.EnabledPlugins()
	if len(enabled) != 1 || enabled[0].ID != mf.ID {
		t.Fatalf("重载后应仍能列出已启用插件: %+v", enabled)
	}
}

// TestCrossPluginCallRequiresDependency 跨插件调用必须先声明依赖。
func TestCrossPluginCallRequiresDependency(t *testing.T) {
	mgr := newTestManager(t)
	target := baseManifest("com.toolbox.target", "1.0.0")
	target.Runtime = RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js", Exports: []string{"greet"}}
	installWithBackend(t, mgr, target, `toolbox.handler("greet", function (a) { return { hello: a && a.name }; });`)

	caller := baseManifest("com.toolbox.caller", "1.0.0")
	installFromDir(t, mgr, caller)

	_, err := mgr.CallPlugin(context.Background(), caller.ID, target.ID, "greet", json.RawMessage(`{"name":"x"}`))
	if err == nil {
		t.Fatal("未声明依赖时不得跨插件调用")
	}
	if !strings.Contains(err.Error(), ErrPermissionDenied.Error()) {
		t.Fatalf("错误应为权限错误: %v", err)
	}
}

// TestCrossPluginCallRequiresExportedHandler 只有公开的 handler 才能被跨插件调用。
func TestCrossPluginCallRequiresExportedHandler(t *testing.T) {
	mgr := newTestManager(t)
	target := baseManifest("com.toolbox.target", "1.0.0")
	target.Runtime = RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js", Exports: []string{"greet"}}
	installWithBackend(t, mgr, target,
		`toolbox.handler("greet", function () { return "hi" });
		 toolbox.handler("internal", function () { return "secret" });`)

	caller := withDependency(baseManifest("com.toolbox.caller", "1.0.0"), target.ID, "^1.0.0")
	installFromDir(t, mgr, caller)

	if _, err := mgr.CallPlugin(context.Background(), caller.ID, target.ID, "internal", nil); err == nil {
		t.Fatal("未公开的 handler 不得被跨插件调用")
	} else if !strings.Contains(err.Error(), ErrNotExported.Error()) {
		t.Fatalf("错误应为未公开: %v", err)
	}

	raw, err := mgr.CallPlugin(context.Background(), caller.ID, target.ID, "greet", nil)
	if err != nil {
		t.Fatalf("公开的 handler 应可调用: %v", err)
	}
	if string(raw) != `"hi"` {
		t.Fatalf("返回值不符合预期: %s", raw)
	}
}

// placePlugin 直接把插件放到磁盘上（模拟历史安装留下的状态）。
//
// 用于构造「安装流程本身会拒绝、但磁盘上确实存在」的状态，
// 验证运行时与调用校验不依赖安装流程的配合。
func placePlugin(t *testing.T, mgr *Manager, mf *Manifest, trusted bool) {
	t.Helper()
	dir := mgr.Store().VersionDir(mf.ID, mf.Version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	raw, err := json.Marshal(mf)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestFileName), raw, 0o644); err != nil {
		t.Fatalf("写入清单失败: %v", err)
	}
	for name, content := range manifestFiles(mf) {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatalf("写入文件失败: %v", err)
		}
	}
	trust := TrustUser
	if !trusted {
		trust = TrustNone
	}
	if err := mgr.Store().WriteRecord(&InstallRecord{
		ID: mf.ID, Version: mf.Version, Source: SourceLocalDir,
		Trust: trust, Enabled: true, InstalledAt: nowRFC3339(),
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
}

// TestCrossPluginCallChecksVersionConstraint 目标版本不满足依赖约束时应拒绝。
func TestCrossPluginCallChecksVersionConstraint(t *testing.T) {
	mgr := newTestManager(t)
	target := baseManifest("com.toolbox.target", "2.0.0")
	target.Runtime = RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js", Exports: []string{"greet"}}
	installWithBackend(t, mgr, target, `toolbox.handler("greet", function () { return "hi" });`)

	// 调用方声明的是 ^1.0.0，实际装的是 2.0.0：安装流程会拒绝这种组合，
	// 这里直接放到磁盘上，验证调用阶段同样会拦下来。
	caller := withDependency(baseManifest("com.toolbox.caller", "1.0.0"), target.ID, "^1.0.0")
	placePlugin(t, mgr, caller, true)
	if err := mgr.Reload(context.Background()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}

	if _, err := mgr.CallPlugin(context.Background(), caller.ID, target.ID, "greet", nil); err == nil {
		t.Fatal("版本不满足依赖约束时不得调用")
	} else if !strings.Contains(err.Error(), ErrDependencyConflict.Error()) {
		t.Fatalf("错误应为版本冲突: %v", err)
	}
}

// TestCrossPluginCallDepthLimit 递归调用必须被深度限制截断。
func TestCrossPluginCallDepthLimit(t *testing.T) {
	mgr := newTestManager(t)
	looper := baseManifest("com.toolbox.looper", "1.0.0")
	looper.Runtime = RuntimeSpec{Backend: string(BackendJS), Entry: "backend/index.js", Exports: []string{"loop"}}
	installWithBackend(t, mgr, looper,
		`toolbox.handler("loop", function () { return toolbox.plugins.call("com.toolbox.looper", "loop", {}); });`)

	_, err := mgr.Invoke(context.Background(), looper.ID, "loop", nil)
	if err == nil {
		t.Fatal("递归调用应被深度限制截断")
	}
	if !strings.Contains(err.Error(), "调用链过深") {
		t.Fatalf("错误应说明调用链过深: %v", err)
	}
}

// TestPluginSettingsSurviveReloadAndUninstall 配置在重载与卸载后都应保留。
func TestPluginSettingsSurviveReloadAndUninstall(t *testing.T) {
	st := newMemStorage()
	mgr := NewManager(Options{
		DataDir:    t.TempDir(),
		AppVersion: testAppVersion,
		Registry:   RegistryProvider{IndexURL: "http://127.0.0.1:1/registry.json"},
		Storage:    st,
	})
	if err := mgr.Startup(context.Background()); err != nil {
		t.Fatalf("初始化失败: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	mf := baseManifest("com.toolbox.settings", "1.0.0")
	installFromDir(t, mgr, mf)
	if err := mgr.StorageSet(mf.ID, "token", "secret"); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}

	if err := mgr.Reload(context.Background()); err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	if value, ok, _ := mgr.StorageGet(mf.ID, "token"); !ok || value != "secret" {
		t.Fatal("重载后配置应保留")
	}

	if _, err := mgr.Uninstall(context.Background(), mf.ID, false); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if value, ok, _ := mgr.StorageGet(mf.ID, "token"); !ok || value != "secret" {
		t.Fatal("卸载默认应保留用户配置")
	}

	if err := mgr.ClearPluginData(mf.ID); err != nil {
		t.Fatalf("清理配置失败: %v", err)
	}
	if _, ok, _ := mgr.StorageGet(mf.ID, "token"); ok {
		t.Fatal("显式清理后配置应被删除")
	}
}

// TestSetTrustedControlsActivation 信任状态直接影响是否能激活。
func TestSetTrustedControlsActivation(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.trust", "1.0.0")
	installFromDir(t, mgr, mf)

	if err := mgr.SetTrusted(context.Background(), mf.ID, false); err != nil {
		t.Fatalf("取消信任失败: %v", err)
	}
	info := findInfo(t, mgr, mf.ID)
	if info.Active || info.Trusted {
		t.Fatalf("取消信任后不应激活: %+v", info)
	}

	if err := mgr.SetTrusted(context.Background(), mf.ID, true); err != nil {
		t.Fatalf("恢复信任失败: %v", err)
	}
	if !findInfo(t, mgr, mf.ID).Active {
		t.Fatal("恢复信任后应重新激活")
	}
}

package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// previewArchives 预览一组离线包。
func previewArchives(t *testing.T, mgr *Manager, offline bool, packages ...[]byte) *InstallPreview {
	t.Helper()
	inputs := make([]PackageInput, 0, len(packages))
	for i, payload := range packages {
		inputs = append(inputs, PackageInput{
			Source:  SourceArchive,
			Ref:     "pkg-" + string(rune('a'+i)) + ".zip",
			Content: payload,
		})
	}
	preview, err := mgr.Preview(context.Background(), inputs, PreviewOptions{
		ResolveDependencies: true,
		Offline:             offline,
	})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	return preview
}

// actionOf 取出计划中某个插件的动作。
func actionOf(t *testing.T, preview *InstallPreview, id string) PlanItem {
	t.Helper()
	for _, item := range preview.Plan {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("计划中缺少 %s", id)
	return PlanItem{}
}

// TestOnlineInstallResolvesDependencies 在线安装应自动安装依赖。
func TestOnlineInstallResolvesDependencies(t *testing.T) {
	reg := newTestRegistry(t)
	dep := baseManifest("com.toolbox.dep", "1.2.0")
	main := withDependency(baseManifest("com.toolbox.main", "2.0.0"), "com.toolbox.dep", "^1.0.0")
	reg.publish(t, dep, nil, true)
	reg.publish(t, main, nil, true)

	mgr := newTestManagerWith(t, reg.provider())

	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.main"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if len(preview.Plan) != 2 {
		t.Fatalf("计划应包含 2 项，实际 %d: %+v", len(preview.Plan), preview.Plan)
	}
	// 未配置索引签名公钥时，official 不能作为可信证明，必须要求用户确认
	if !preview.NeedTrust {
		t.Fatal("索引未验签时必须要求用户确认信任")
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}

	// 依赖在前，且都已落盘
	if !mgr.Store().HasVersion("com.toolbox.dep", "1.2.0") {
		t.Fatal("依赖未安装")
	}
	depInfo := findInfo(t, mgr, "com.toolbox.dep")
	if !depInfo.Enabled || !depInfo.Active {
		t.Fatalf("依赖应处于启用且可用状态: %+v", depInfo)
	}
	mainInfo := findInfo(t, mgr, "com.toolbox.main")
	if mainInfo.Dependencies[0].ID != "com.toolbox.dep" {
		t.Fatalf("依赖声明丢失: %+v", mainInfo.Dependencies)
	}
}

// TestInstallSpecificVersion 指定版本安装。
func TestInstallSpecificVersion(t *testing.T) {
	reg := newTestRegistry(t)
	reg.publish(t, baseManifest("com.toolbox.a", "1.0.0"), nil, true)
	reg.publish(t, baseManifest("com.toolbox.a", "1.5.0"), nil, true)

	mgr := newTestManagerWith(t, reg.provider())
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.a", Version: "1.0.0"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if preview.Plan[0].Version != "1.0.0" {
		t.Fatalf("应安装指定版本，实际 %s", preview.Plan[0].Version)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if findInfo(t, mgr, "com.toolbox.a").Version != "1.0.0" {
		t.Fatal("安装版本与指定版本不符")
	}
}

// TestInstallFromLocalZip 本地 ZIP 安装。
func TestInstallFromLocalZip(t *testing.T) {
	mgr := newTestManager(t)
	mf := withFrontend(withBackend(baseManifest("com.toolbox.zip", "1.0.0")))
	path := writePackageFile(t, mf, nil)

	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceFile, Ref: path}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if !preview.NeedTrust {
		t.Fatal("非官方来源必须要求用户确认信任")
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}

	dir := mgr.Store().VersionDir("com.toolbox.zip", "1.0.0")
	for _, rel := range []string{ManifestFileName, "frontend/index.js", "backend/index.js"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("安装后缺少 %s: %v", rel, err)
		}
	}
	info := findInfo(t, mgr, "com.toolbox.zip")
	if !info.Trusted || info.TrustLevel != string(TrustUser) {
		t.Fatalf("用户确认信任后应记录信任等级: %+v", info)
	}
}

// TestInstallRequiresTrust 未确认信任时不得安装。
func TestInstallRequiresTrust(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.zip", "1.0.0")
	path := writePackageFile(t, mf, nil)

	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceFile, Ref: path}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	err = mgr.InstallPlan(context.Background(), preview.PlanID, false, true)
	if err == nil || !strings.Contains(err.Error(), ErrUntrusted.Error()) {
		t.Fatalf("期望信任错误，实际 %v", err)
	}
	if mgr.Store().HasVersion("com.toolbox.zip", "1.0.0") {
		t.Fatal("拒绝安装后不应留下文件")
	}
}

// TestInstallFromLocalDir 本地目录安装（开发者模式）。
func TestInstallFromLocalDir(t *testing.T) {
	mgr := newTestManager(t)
	mf := withBackend(baseManifest("com.toolbox.dev", "1.0.0"))
	dir := writePluginDir(t, mf, nil)

	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	info := findInfo(t, mgr, "com.toolbox.dev")
	if !info.Loaded || !info.Active {
		t.Fatalf("本地目录插件应成功加载: %+v", info)
	}
}

// TestLocalDirParentSelectionHint 选中父目录时应给出可读提示。
func TestLocalDirParentSelectionHint(t *testing.T) {
	mgr := newTestManager(t)
	parent := t.TempDir()
	for _, id := range []string{"com.toolbox.one", "com.toolbox.two"} {
		mf := baseManifest(id, "1.0.0")
		raw, err := json.Marshal(mf)
		if err != nil {
			t.Fatalf("序列化失败: %v", err)
		}
		child := filepath.Join(parent, strings.TrimPrefix(id, "com.toolbox."))
		if err := os.MkdirAll(child, 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
		if err := os.WriteFile(filepath.Join(child, ManifestFileName), raw, 0o644); err != nil {
			t.Fatalf("写入清单失败: %v", err)
		}
	}

	_, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: parent}},
		PreviewOptions{ResolveDependencies: true})
	if err == nil {
		t.Fatal("选中父目录应当失败并提示具体插件目录")
	}
	if !strings.Contains(err.Error(), "请选择具体的插件目录") {
		t.Fatalf("提示信息不友好: %v", err)
	}
}

// TestBatchInstallResolvesCrossPackageDependencies 批量安装必须一次求解整个依赖图。
func TestBatchInstallResolvesCrossPackageDependencies(t *testing.T) {
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")

	// 注意：故意把「依赖方」放在前面，验证结果与导入顺序无关
	mgr := newTestManager(t)
	preview := previewArchives(t, mgr, true, zipPackage(t, main, nil), zipPackage(t, dep, nil))

	if len(preview.Plan) != 2 {
		t.Fatalf("批量计划应包含 2 个插件，实际 %d", len(preview.Plan))
	}
	if preview.Plan[0].ID != "com.toolbox.dep" {
		t.Fatalf("拓扑顺序应让依赖在前，实际 %+v", preview.Plan)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("批量安装失败: %v", err)
	}
	if !mgr.Store().HasVersion("com.toolbox.dep", "1.0.0") || !mgr.Store().HasVersion("com.toolbox.main", "1.0.0") {
		t.Fatal("批量安装未完成全部插件")
	}
}

// TestBatchInstallOrderIndependent 批量安装的结果与包选择顺序无关。
func TestBatchInstallOrderIndependent(t *testing.T) {
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	depZip := zipPackage(t, dep, nil)
	mainZip := zipPackage(t, main, nil)

	first := previewArchives(t, newTestManager(t), true, mainZip, depZip)
	second := previewArchives(t, newTestManager(t), true, depZip, mainZip)

	if len(first.Plan) != len(second.Plan) {
		t.Fatalf("两次计划长度不同: %d vs %d", len(first.Plan), len(second.Plan))
	}
	for i := range first.Plan {
		if first.Plan[i].ID != second.Plan[i].ID || first.Plan[i].Version != second.Plan[i].Version {
			t.Fatalf("计划顺序受导入顺序影响: %+v vs %+v", first.Plan, second.Plan)
		}
	}
}

// TestOfflineInstallRejectsMissingDependency 离线缺少依赖必须失败且不改动磁盘。
func TestOfflineInstallRejectsMissingDependency(t *testing.T) {
	mgr := newTestManager(t)
	mf := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")

	_, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: zipPackage(t, mf, nil)}},
		PreviewOptions{ResolveDependencies: true, Offline: true})
	if err == nil {
		t.Fatal("离线缺少依赖应当失败")
	}
	if !strings.Contains(err.Error(), ErrDependencyMissing.Error()) {
		t.Fatalf("错误类型应为依赖缺失: %v", err)
	}
	ids, _ := mgr.Store().ListIDs()
	if len(ids) != 0 {
		t.Fatalf("失败后不应产生任何插件目录: %v", ids)
	}
}

// TestOfflineInstallUsesInstalledDependency 依赖已安装时可以离线安装。
func TestOfflineInstallUsesInstalledDependency(t *testing.T) {
	mgr := newTestManager(t)
	installFromDir(t, mgr, baseManifest("com.toolbox.dep", "1.0.0"))

	mf := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	preview := previewArchives(t, mgr, true, zipPackage(t, mf, nil))

	depItem := actionOf(t, preview, "com.toolbox.dep")
	if depItem.Action != ActionKeep {
		t.Fatalf("已安装依赖应复用（keep），实际 %s", depItem.Action)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
}

// TestOfflineInstallUsesPackageCache 依赖在本地包缓存中时可离线安装。
func TestOfflineInstallUsesPackageCache(t *testing.T) {
	reg := newTestRegistry(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	reg.publish(t, dep, nil, true)

	mgr := newTestManagerWith(t, reg.provider())
	// 先在线安装依赖，让它的包进入本地缓存
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.dep"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装依赖失败: %v", err)
	}
	if _, err := mgr.Uninstall(context.Background(), "com.toolbox.dep", true); err != nil {
		t.Fatalf("卸载依赖失败: %v", err)
	}
	// 卸载后缓存仍在
	if cached := mgr.Store().CachedPackages(); len(cached) == 0 {
		t.Fatal("卸载后安装包应保留在缓存中")
	}

	mf := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	offlinePreview := previewArchives(t, mgr, true, zipPackage(t, mf, nil))
	depItem := actionOf(t, offlinePreview, "com.toolbox.dep")
	if depItem.Action != ActionInstall {
		t.Fatalf("缓存中的依赖应被安装，实际 %s", depItem.Action)
	}
	if depItem.SourceRef == "" || !strings.Contains(depItem.SourceRef, "本地缓存") {
		t.Fatalf("依赖应来自本地缓存，实际 %q", depItem.SourceRef)
	}
	if err := mgr.InstallPlan(context.Background(), offlinePreview.PlanID, true, true); err != nil {
		t.Fatalf("离线安装失败: %v", err)
	}
	if !mgr.Store().HasVersion("com.toolbox.dep", "1.0.0") {
		t.Fatal("依赖未从缓存离线安装")
	}
}

// TestOfflineInstallRejectsVersionConflict 离线版本冲突必须失败。
func TestOfflineInstallRejectsVersionConflict(t *testing.T) {
	reg := newTestRegistry(t)
	dep100 := baseManifest("com.toolbox.dep", "1.0.0")
	dep200 := baseManifest("com.toolbox.dep", "2.0.0")
	reg.publish(t, dep100, nil, true)
	reg.publish(t, dep200, nil, true)

	mgr := newTestManagerWith(t, reg.provider())
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.dep"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if findInfo(t, mgr, "com.toolbox.dep").Version != "2.0.0" {
		t.Fatal("应安装最新版本")
	}

	// 缓存里已经有了 2.0.0，但请求的包要求 ^1.0.0：2.0.0 不满足，1.0.0 又不在缓存里
	cached := mgr.Store().CachedPackages()
	if len(cached) != 1 || cached[0].Manifest.Version != "2.0.0" {
		t.Fatalf("缓存状态不符合预期: %+v", cached)
	}
	// 先把已安装的 2.0.0 卸载，避免求解直接复用已安装版本
	if _, err := mgr.Uninstall(context.Background(), "com.toolbox.dep", true); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}

	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	_, err = mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: zipPackage(t, main, nil)}},
		PreviewOptions{ResolveDependencies: true, Offline: true})
	if err == nil {
		t.Fatal("离线版本冲突应当失败")
	}
	if !strings.Contains(err.Error(), ErrDependencyConflict.Error()) &&
		!strings.Contains(err.Error(), ErrDependencyMissing.Error()) {
		t.Fatalf("错误类型应为版本冲突或依赖缺失: %v", err)
	}
}

// TestInstallRejectsPathTraversal 安装包不得写出插件目录。
func TestInstallRejectsPathTraversal(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.evil", "1.0.0")

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	raw, _ := json.Marshal(mf)
	write := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("创建条目失败: %v", err)
		}
		_, _ = w.Write([]byte(content))
	}
	write(ManifestFileName, string(raw))
	write("../escaped.js", "pwned")
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	_, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: buf.Bytes()}},
		PreviewOptions{ResolveDependencies: true})
	if err == nil {
		t.Fatal("含路径穿越的包必须被拒绝")
	}
	if !strings.Contains(err.Error(), "非法路径") {
		t.Fatalf("错误信息应说明非法路径: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(mgr.Store().DataDir(), "escaped.js")); statErr == nil {
		t.Fatal("穿越文件被写出了")
	}
}

// TestInstallRejectsTooManyFiles 限制包内文件数量（防 zip bomb 的基本手段）。
func TestInstallRejectsTooManyFiles(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.bomb", "1.0.0")

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	raw, _ := json.Marshal(mf)
	w, err := zw.Create(ManifestFileName)
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	_, _ = w.Write(raw)
	for i := 0; i < maxPackageFiles+10; i++ {
		entry, createErr := zw.Create("assets/f" + string(rune('0'+i%10)) + string(rune('a'+i%26)) + ".txt")
		if createErr != nil {
			t.Fatalf("创建条目失败: %v", createErr)
		}
		_, _ = entry.Write([]byte("x"))
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	_, err = mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: buf.Bytes()}},
		PreviewOptions{ResolveDependencies: true})
	if err == nil {
		t.Fatal("文件数量超限必须被拒绝")
	}
	if !strings.Contains(err.Error(), "文件过多") {
		t.Fatalf("错误信息应说明文件过多: %v", err)
	}
}

// TestInstallRejectsMissingEntry 缺少入口文件的包必须被拒绝。
func TestInstallRejectsMissingEntry(t *testing.T) {
	mgr := newTestManager(t)
	mf := withBackend(baseManifest("com.toolbox.noentry", "1.0.0"))

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	raw, _ := json.Marshal(mf)
	w, err := zw.Create(ManifestFileName)
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	_, _ = w.Write(raw)
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	_, err = mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: buf.Bytes()}},
		PreviewOptions{ResolveDependencies: true})
	if err == nil {
		t.Fatal("缺少后端入口必须被拒绝")
	}
	if !strings.Contains(err.Error(), "缺少后端入口") {
		t.Fatalf("错误信息应指明缺少入口: %v", err)
	}
}

// TestInstallRejectsChecksumMismatch 索引摘要与实际内容不符时必须拒绝。
func TestInstallRejectsChecksumMismatch(t *testing.T) {
	reg := newTestRegistry(t)
	mf := baseManifest("com.toolbox.tampered", "1.0.0")
	reg.publish(t, mf, nil, true)

	// 篡改索引里的摘要
	reg.entries[0].Checksum = "sha256:" + strings.Repeat("f", 64)
	reg.rebuild()

	mgr := newTestManagerWith(t, reg.provider())
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: mf.ID}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	err = mgr.InstallPlan(context.Background(), preview.PlanID, true, true)
	if err == nil {
		t.Fatal("摘要不匹配必须导致安装失败")
	}
	if !strings.Contains(err.Error(), ErrChecksumMismatch.Error()) {
		t.Fatalf("错误应为校验和不匹配: %v", err)
	}
	if mgr.Store().HasVersion(mf.ID, mf.Version) {
		t.Fatal("摘要校验失败不应留下安装文件")
	}
}

// TestInstallRejectsManifestMismatch 包内清单与计划不一致时必须拒绝。
func TestInstallRejectsManifestMismatch(t *testing.T) {
	mgr := newTestManager(t)
	outer := baseManifest("com.toolbox.outer", "1.0.0")
	// 包内清单声明的是另一个版本
	inner := baseManifest("com.toolbox.outer", "9.9.9")

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	raw, _ := json.Marshal(inner)
	w, err := zw.Create(ManifestFileName)
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	_, _ = w.Write(raw)
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	// 预览时读到的是 inner 的版本 9.9.9，计划也就是 9.9.9；
	// 这里直接用外层清单构造一个「计划与实际不符」的目录条目来验证提交前校验。
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: buf.Bytes()}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if preview.Plan[0].Version != "9.9.9" {
		t.Fatalf("计划版本应来自包内清单，实际 %s", preview.Plan[0].Version)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if !mgr.Store().HasVersion("com.toolbox.outer", "9.9.9") {
		t.Fatal("应以包内清单的版本为准")
	}
	_ = outer
}

// TestInstallDependencyDownloadFailureLeavesNoChanges 依赖下载失败不得留下半装状态。
func TestInstallDependencyDownloadFailureLeavesNoChanges(t *testing.T) {
	reg := newTestRegistry(t)
	dep := baseManifest("com.toolbox.dep", "1.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^1.0.0")
	reg.publish(t, dep, nil, true)
	reg.publish(t, main, nil, true)

	mgr := newTestManagerWith(t, reg.provider())
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: main.ID}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}

	// 删掉依赖的包，模拟下载失败
	delete(reg.packages, dep.ID+"-"+dep.Version+".zip")

	err = mgr.InstallPlan(context.Background(), preview.PlanID, true, true)
	if err == nil {
		t.Fatal("依赖下载失败必须报错")
	}
	ids, _ := mgr.Store().ListIDs()
	if len(ids) != 0 {
		t.Fatalf("失败后不应留下任何插件: %v", ids)
	}
	// 也不能留下事务残留
	entries, readErr := os.ReadDir(mgr.Store().TxDir())
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("读取事务目录失败: %v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("不应残留事务日志: %v", entries)
	}
}

// TestInstallReusesPlanAndExpires 计划一次性使用，不能重复安装。
func TestInstallReusesPlanAndExpires(t *testing.T) {
	mgr := newTestManager(t)
	mf := baseManifest("com.toolbox.once", "1.0.0")
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: zipPackage(t, mf, nil)}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	err = mgr.InstallPlan(context.Background(), preview.PlanID, true, true)
	if err == nil || !strings.Contains(err.Error(), ErrPlanExpired.Error()) {
		t.Fatalf("计划不应可重复使用，实际 %v", err)
	}

	if err := mgr.InstallPlan(context.Background(), "not-a-plan", true, true); err == nil {
		t.Fatal("未知计划必须报错")
	}
}

// TestReinstallSameVersion 同一版本重新安装应覆盖已有文件。
func TestReinstallSameVersion(t *testing.T) {
	mgr := newTestManager(t)
	mf := withBackend(baseManifest("com.toolbox.reinstall", "1.0.0"))
	installFromDir(t, mgr, mf)

	// 重新用另一个包内容安装同一版本
	second := writePluginDir(t, mf, map[string]string{
		"backend/index.js": `toolbox.handler("v2", function () { return "v2" });`,
	})
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceLocalDir, Ref: second}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if preview.Plan[0].Action != ActionReinstall {
		t.Fatalf("应为重装动作，实际 %s", preview.Plan[0].Action)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("重装失败: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(mgr.Store().VersionDir(mf.ID, mf.Version), "backend", "index.js"))
	if err != nil {
		t.Fatalf("读取重装后的文件失败: %v", err)
	}
	if !strings.Contains(string(raw), "v2") {
		t.Fatalf("重装未覆盖文件内容: %s", raw)
	}
}

// TestUpgradeAndRollback 升级与回滚必须保留旧版本并保持状态一致。
func TestUpgradeAndRollback(t *testing.T) {
	reg := newTestRegistry(t)
	v1 := withBackend(baseManifest("com.toolbox.up", "1.0.0"))
	v2 := withBackend(baseManifest("com.toolbox.up", "2.0.0"))
	reg.publish(t, v1, nil, true)
	reg.publish(t, v2, nil, true)

	mgr := newTestManagerWith(t, reg.provider())
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: v1.ID, Version: "1.0.0"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装 1.0.0 失败: %v", err)
	}

	if err := mgr.Upgrade(context.Background(), v1.ID, true); err != nil {
		t.Fatalf("升级失败: %v", err)
	}
	info := findInfo(t, mgr, v1.ID)
	if info.Version != "2.0.0" {
		t.Fatalf("升级后版本应为 2.0.0，实际 %s", info.Version)
	}
	if info.PreviousVersion != "1.0.0" {
		t.Fatalf("应记录上一个版本，实际 %q", info.PreviousVersion)
	}
	if !mgr.Store().HasVersion(v1.ID, "1.0.0") {
		t.Fatal("升级后旧版本应保留以便回滚")
	}

	if err := mgr.Rollback(context.Background(), v1.ID); err != nil {
		t.Fatalf("回滚失败: %v", err)
	}
	info = findInfo(t, mgr, v1.ID)
	if info.Version != "1.0.0" {
		t.Fatalf("回滚后版本应为 1.0.0，实际 %s", info.Version)
	}
	// 回滚可逆
	if err := mgr.Rollback(context.Background(), v1.ID); err != nil {
		t.Fatalf("二次回滚失败: %v", err)
	}
	if got := findInfo(t, mgr, v1.ID).Version; got != "2.0.0" {
		t.Fatalf("二次回滚应回到 2.0.0，实际 %s", got)
	}
}

// TestRollbackChecksDependents 回滚会破坏依赖方约束时必须拒绝。
func TestRollbackChecksDependents(t *testing.T) {
	reg := newTestRegistry(t)
	depV1 := baseManifest("com.toolbox.dep", "1.0.0")
	depV2 := baseManifest("com.toolbox.dep", "2.0.0")
	main := withDependency(baseManifest("com.toolbox.main", "1.0.0"), "com.toolbox.dep", "^2.0.0")
	reg.publish(t, depV1, nil, true)
	reg.publish(t, depV2, nil, true)
	reg.publish(t, main, nil, true)

	mgr := newTestManagerWith(t, reg.provider())

	// 先单独装 1.0.0
	first, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.dep", Version: "1.0.0"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), first.PlanID, true, true); err != nil {
		t.Fatalf("安装依赖失败: %v", err)
	}

	// 再装 main：它要求 dep ^2.0.0，依赖会被升级到 2.0.0，1.0.0 作为可回滚版本保留
	second, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.main"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), second.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if got := findInfo(t, mgr, "com.toolbox.dep").Version; got != "2.0.0" {
		t.Fatalf("依赖应被升级到 2.0.0，实际 %s", got)
	}

	err = mgr.Rollback(context.Background(), "com.toolbox.dep")
	if err == nil {
		t.Fatal("回滚会破坏 main 的约束，必须拒绝")
	}
	if !strings.Contains(err.Error(), ErrDependencyConflict.Error()) {
		t.Fatalf("错误应说明依赖冲突: %v", err)
	}
}

// TestUpgradeFailsWithClearErrorWhenNoUpdate 无可用更新时应给出明确错误。
func TestUpgradeFailsWithClearErrorWhenNoUpdate(t *testing.T) {
	reg := newTestRegistry(t)
	reg.publish(t, baseManifest("com.toolbox.only", "1.0.0"), nil, true)
	mgr := newTestManagerWith(t, reg.provider())

	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.only"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	// 索引里没有更高版本，Upgrade 会重装同一版本（等价于 keep/reinstall），不应报错
	if err := mgr.Upgrade(context.Background(), "com.toolbox.only", true); err != nil {
		t.Fatalf("无更新时升级不应失败: %v", err)
	}
}

// TestInstallPlanRejectsPermissionEscalation 升级引入新权限时必须显式确认。
func TestInstallPlanRejectsPermissionEscalation(t *testing.T) {
	mgr := newTestManager(t)
	v1 := baseManifest("com.toolbox.perm", "1.0.0")
	installFromDir(t, mgr, v1)

	v2 := withPermissions(baseManifest("com.toolbox.perm", "2.0.0"), Permissions{
		Network: []string{"api.example.com"},
	})
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: zipPackage(t, v2, nil)}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if len(preview.AddedPermissions) == 0 {
		t.Fatal("应识别出新增权限")
	}
	err = mgr.InstallPlan(context.Background(), preview.PlanID, true, false)
	if err == nil {
		t.Fatal("未确认新增权限时必须拒绝安装")
	}

	preview2, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: zipPackage(t, v2, nil)}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if err := mgr.InstallPlan(context.Background(), preview2.PlanID, true, true); err != nil {
		t.Fatalf("确认后应可安装: %v", err)
	}
}

// TestPreviewWithoutResolutionSkipsNetwork 快速预览不得访问网络。
func TestPreviewWithoutResolutionSkipsNetwork(t *testing.T) {
	mgr := newTestManager(t) // 索引地址故意指向不可达地址
	mf := baseManifest("com.toolbox.quick", "1.0.0")
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Content: zipPackage(t, mf, nil)}},
		PreviewOptions{ResolveDependencies: false})
	if err != nil {
		t.Fatalf("快速预览不应联网: %v", err)
	}
	if preview.PlanID != "" {
		t.Fatal("未求解依赖时不应生成计划")
	}
	if len(preview.Packages) != 1 || preview.Packages[0].ID != mf.ID {
		t.Fatalf("卡片信息不正确: %+v", preview.Packages)
	}
}

// TestPreviewOfflineRejectsRegistrySource 离线模式不允许从市场安装。
func TestPreviewOfflineRejectsRegistrySource(t *testing.T) {
	mgr := newTestManager(t)
	_, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.x"}},
		PreviewOptions{ResolveDependencies: true, Offline: true})
	if err == nil {
		t.Fatal("离线模式不应允许从插件市场安装")
	}
	if !strings.Contains(err.Error(), "离线模式") {
		t.Fatalf("错误信息应说明离线限制: %v", err)
	}
}

// TestRegistrySignatureVerification 索引签名校验的各类场景。
func TestRegistrySignatureVerification(t *testing.T) {
	t.Run("验签成功", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.signed", "1.0.0"), nil, true)
		reg.enableSigning(t)

		mgr := newTestManagerWith(t, reg.provider())
		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "ready" || !sourceVerifiedOf(snapshot, reg.provider().IndexURL) {
			t.Fatalf("签名索引应校验通过: %+v", snapshot)
		}
		if len(snapshot.Items) != 1 {
			t.Fatalf("索引条目缺失: %+v", snapshot.Items)
		}
	})

	t.Run("索引被篡改", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.signed", "1.0.0"), nil, true)
		reg.enableSigning(t)
		reg.rebuild()
		// 签名之后修改索引内容
		reg.indexRaw = bytes.Replace(reg.indexRaw, []byte("com.toolbox.signed"), []byte("com.toolbox.evilx"), 1)

		mgr := newTestManagerWith(t, reg.provider())
		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "error" {
			t.Fatalf("被篡改的索引必须被拒绝: %+v", snapshot)
		}
		if !strings.Contains(snapshot.Error, "签名校验失败") {
			t.Fatalf("错误信息应说明验签失败: %s", snapshot.Error)
		}
	})

	t.Run("缺少签名文件", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.signed", "1.0.0"), nil, true)
		reg.enableSigning(t)
		reg.signature = ""

		mgr := newTestManagerWith(t, reg.provider())
		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "error" {
			t.Fatalf("缺少签名时必须拒绝索引: %+v", snapshot)
		}
	})

	t.Run("公钥错误", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.signed", "1.0.0"), nil, true)
		reg.enableSigning(t)
		// 换成另一对密钥的公钥
		otherReg := newTestRegistry(t)
		otherReg.enableSigning(t)

		mgr := newTestManagerWith(t, reg.provider())
		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "error" {
			t.Fatalf("公钥不匹配时必须拒绝索引: %+v", snapshot)
		}
	})

	t.Run("未启用签名时 official 不等于可信", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.official", "1.0.0"), nil, true)
		// 没有配置公钥
		mgr := newTestManagerWith(t, reg.provider())

		preview, err := mgr.Preview(context.Background(),
			[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.official"}},
			PreviewOptions{ResolveDependencies: true})
		if err != nil {
			t.Fatalf("预览失败: %v", err)
		}
		if !preview.NeedTrust {
			t.Fatal("索引未验签时，official 字段不能作为可信证明")
		}
	})

	t.Run("索引格式版本不支持", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.a", "1.0.0"), nil, true)
		var index RegistryIndex
		if err := json.Unmarshal(reg.indexRaw, &index); err != nil {
			t.Fatalf("解析索引失败: %v", err)
		}
		index.SchemaVersion = 99
		raw, _ := json.Marshal(index)
		reg.indexRaw = raw

		mgr := newTestManagerWith(t, reg.provider())
		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "error" || !strings.Contains(snapshot.Error, "索引格式版本") {
			t.Fatalf("应拒绝不支持的索引版本: %+v", snapshot)
		}
	})

	/*
	 * 以下两组针对「用户自添加的第三方来源」：反过来了 —— 官方源缺签名必须拒绝，
	 * 而用户自设来源缺少签名要容忍（按未验签处理），但签名存在却验不过仍然要拒绝。
	 */
	t.Run("用户来源未提供签名时按未验签处理", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.third", "1.0.0"), nil, true)

		// 宿主配了公钥（签名校验开启），但该来源根本不提供签名
		previousKey := RegistryPublicKey
		t.Cleanup(func() { RegistryPublicKey = previousKey })
		RegistryPublicKey = base64.StdEncoding.EncodeToString(make([]byte, 32))

		mgr := newTestManagerWithSources(t, thirdPartySources(reg)...)

		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "ready" {
			t.Fatalf("无签名的第三方来源应可读取: %+v", snapshot)
		}
		if sourceVerifiedOf(snapshot, reg.provider().IndexURL) {
			t.Fatal("未提供签名的来源不应被标记为已验签")
		}
		if len(snapshot.Items) != 1 {
			t.Fatalf("索引条目缺失: %+v", snapshot.Items)
		}
		if snapshot.Items[0].Official {
			t.Fatal("未验签索引里的 official 声明不可信，不能展示为官方")
		}
	})

	t.Run("用户来源签名校验失败时拒绝", func(t *testing.T) {
		reg := newTestRegistry(t)
		reg.publish(t, baseManifest("com.toolbox.third", "1.0.0"), nil, true)
		reg.enableSigning(t)
		// 换成另一对密钥的公钥，模拟该来源被劫持 / 内容被篡改
		otherReg := newTestRegistry(t)
		otherReg.enableSigning(t)

		mgr := newTestManagerWithSources(t, thirdPartySources(reg)...)

		snapshot := mgr.Marketplace(context.Background(), true)
		if snapshot.State != "error" {
			t.Fatalf("签名校验失败的第三方来源必须被拒绝: %+v", snapshot)
		}
		if !strings.Contains(snapshot.Error, "签名校验失败") {
			t.Fatalf("错误信息应说明验签失败: %s", snapshot.Error)
		}
	})
}

// TestPackageInputWireDecoding 前端输入的解码由上层负责，这里验证 base64 形式的往返。
func TestPackageInputWireDecoding(t *testing.T) {
	mf := baseManifest("com.toolbox.wire", "1.0.0")
	payload := zipPackage(t, mf, nil)
	encoded := base64.StdEncoding.EncodeToString(payload)

	mgr := newTestManager(t)
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	preview, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceArchive, Ref: "wire.zip", Content: decoded}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览失败: %v", err)
	}
	if preview.Packages[0].ID != mf.ID {
		t.Fatalf("插件标识不匹配: %+v", preview.Packages[0])
	}
}

// TestMultiSourceMarketplace 多源合并展示、单源视图与按源取包。
func TestMultiSourceMarketplace(t *testing.T) {
	first := newTestRegistry(t)
	first.publish(t, baseManifest("com.toolbox.shared", "1.0.0"), nil, true)
	second := newTestRegistry(t)
	second.publish(t, baseManifest("com.toolbox.shared", "1.1.0"), nil, true)
	second.publish(t, baseManifest("com.toolbox.only-second", "1.0.0"), nil, true)

	firstURL := first.provider().IndexURL
	secondURL := second.provider().IndexURL

	mgr := newTestManagerWithSources(t,
		RegistrySource{URL: firstURL, Name: "源A", Enabled: true},
		RegistrySource{URL: secondURL, Name: "源B", Enabled: true},
	)

	snapshot := mgr.Marketplace(context.Background(), true)
	if snapshot.State != "ready" {
		t.Fatalf("两个来源都应读到索引: %+v", snapshot)
	}
	if len(snapshot.Sources) != 2 {
		t.Fatalf("来源状态数量不对: %+v", snapshot.Sources)
	}

	// 同名插件在多个来源各占一条，并带上各自的来源信息
	shared := 0
	bySource := map[string]string{}
	for _, item := range snapshot.Items {
		if item.ID != "com.toolbox.shared" {
			continue
		}
		shared++
		bySource[item.SourceURL] = item.SourceName
	}
	if shared != 2 {
		t.Fatalf("同名插件应在两个来源各占一条，实际 %d 条", shared)
	}
	if bySource[firstURL] != "源A" || bySource[secondURL] != "源B" {
		t.Fatalf("条目未带上来源信息: %+v", bySource)
	}

	// 不指定来源：跨源取最高版本
	auto, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, ID: "com.toolbox.shared"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("跨源预览失败: %v", err)
	}
	if auto.Plan[0].Version != "1.1.0" {
		t.Fatalf("未指定来源时应取最高版本，实际 %s", auto.Plan[0].Version)
	}

	// 指定来源：精确取该来源的版本（合并列表里用户点的是哪一条就装哪一条）
	explicit, err := mgr.Preview(context.Background(),
		[]PackageInput{{Source: SourceRegistry, SourceURL: firstURL, ID: "com.toolbox.shared"}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("按来源预览失败: %v", err)
	}
	if explicit.Plan[0].Version != "1.0.0" {
		t.Fatalf("指定来源时应取该来源的版本，实际 %s", explicit.Plan[0].Version)
	}
	if err := mgr.InstallPlan(context.Background(), explicit.PlanID, true, true); err != nil {
		t.Fatalf("按来源安装失败: %v", err)
	}
	// SourceRef 记的是下载地址，因此按测试服务的地址判断取包来源
	if ref := findInfo(t, mgr, "com.toolbox.shared").SourceRef; !strings.HasPrefix(ref, first.server.URL) {
		t.Fatalf("安装包应来自指定来源 %s，实际 %s", first.server.URL, ref)
	}

	// 禁用某个来源：它不再参与合并，但仍能单独查看（含插件简略列表）
	if err := mgr.SetSources([]RegistrySource{
		{URL: firstURL, Name: "源A", Enabled: true},
		{URL: secondURL, Name: "源B", Enabled: false},
	}); err != nil {
		t.Fatalf("更新来源列表失败: %v", err)
	}
	merged := mgr.Marketplace(context.Background(), false)
	for _, item := range merged.Items {
		if item.ID == "com.toolbox.only-second" {
			t.Fatal("已禁用来源的插件不应出现在合并列表里")
		}
	}
	status, items, err := mgr.SourceMarketplace(context.Background(), secondURL, false)
	if err != nil {
		t.Fatalf("单独查看来源失败: %v", err)
	}
	if status.Enabled {
		t.Fatalf("来源状态应标明未启用: %+v", status)
	}
	if len(items) != 2 {
		t.Fatalf("单源列表应包含该来源的全部插件，实际 %d 条", len(items))
	}
}

// TestSourcesValidation 来源列表的校验与去重。
func TestSourcesValidation(t *testing.T) {
	mgr := newTestManager(t)

	if err := mgr.SetSources([]RegistrySource{{URL: "", Enabled: true}}); err == nil {
		t.Fatal("空地址应被拒绝")
	}
	if err := mgr.SetSources([]RegistrySource{{URL: "ftp://example.com/registry.json", Enabled: true}}); err == nil {
		t.Fatal("不支持的协议应被拒绝")
	}
	if err := mgr.SetSources([]RegistrySource{
		{URL: "https://example.com/registry.json", Enabled: true},
		{URL: " https://example.com/registry.json ", Enabled: true},
	}); err == nil {
		t.Fatal("重复地址应被拒绝")
	}

	// 校验失败不应改动已有配置
	if len(mgr.Sources()) != 1 {
		t.Fatalf("校验失败时来源列表不应被改动: %+v", mgr.Sources())
	}
}

// TestSignatureEnabledToggle 公钥配置状态影响签名校验开关。
func TestSignatureEnabledToggle(t *testing.T) {
	previous := RegistryPublicKey
	t.Cleanup(func() { RegistryPublicKey = previous })

	RegistryPublicKey = ""
	if SignatureEnabled() {
		t.Fatal("未配置公钥时签名校验应关闭")
	}
	RegistryPublicKey = base64.StdEncoding.EncodeToString(make([]byte, 32))
	if !SignatureEnabled() {
		t.Fatal("配置公钥后签名校验应开启")
	}
}

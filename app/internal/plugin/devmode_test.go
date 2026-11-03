package plugin

import (
	"context"
	"strings"
	"testing"
)

// TestLocalDirRequiresDeveloperMode 关闭开发者模式时，源码目录安装被拒绝。
func TestLocalDirRequiresDeveloperMode(t *testing.T) {
	mgr := newTestManager(t)
	mgr.SetDeveloperMode(false)

	dir := writePluginDir(t, withBackend(baseManifest("com.toolbox.devmode", "1.0.0")), nil)
	ctx := context.Background()

	_, err := mgr.Preview(ctx, []PackageInput{{Source: SourceLocalDir, Ref: dir}}, PreviewOptions{})
	if err == nil {
		t.Fatal("未开启开发者模式时，源码目录安装应被拒绝")
	}
	if !strings.Contains(err.Error(), "开发者模式") {
		t.Fatalf("错误信息应说明需要开发者模式: %v", err)
	}

	// file 来源指向目录时必须同样拒绝：否则等于给了一条绕过通道
	_, err = mgr.Preview(ctx, []PackageInput{{Source: SourceFile, Ref: dir}}, PreviewOptions{})
	if err == nil || !strings.Contains(err.Error(), "开发者模式") {
		t.Fatalf("file 来源选中目录应同样被拒绝: %v", err)
	}

	// 开启后放行，并且能正常装完
	mgr.SetDeveloperMode(true)
	preview, err := mgr.Preview(ctx,
		[]PackageInput{{Source: SourceLocalDir, Ref: dir}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("开启开发者模式后应允许源码目录安装: %v", err)
	}
	if err := mgr.InstallPlan(ctx, preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if info := findInfo(t, mgr, "com.toolbox.devmode"); !info.Loaded {
		t.Fatalf("源码目录插件应成功加载: %+v", info)
	}
}

// TestReleaseArtifactInstallWithoutDevMode 关闭开发者模式时，已编译产物照常可装。
func TestReleaseArtifactInstallWithoutDevMode(t *testing.T) {
	mgr := newTestManager(t)
	mgr.SetDeveloperMode(false)

	path := writePackageFile(t, baseManifest("com.toolbox.release", "1.0.0"), nil)
	ctx := context.Background()

	preview, err := mgr.Preview(ctx,
		[]PackageInput{{Source: SourceFile, Ref: path}},
		PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("离线包安装不应受开发者模式限制: %v", err)
	}
	if err := mgr.InstallPlan(ctx, preview.PlanID, true, true); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
}

// TestDeveloperModeSkipsTrustPrompt 开发者模式下不再要求确认来源信任。
func TestDeveloperModeSkipsTrustPrompt(t *testing.T) {
	reg := newTestRegistry(t)
	mf := baseManifest("com.toolbox.thirdparty", "1.0.0")
	reg.publish(t, mf, nil, false)

	mgr := newTestManagerWithSources(t, thirdPartySources(reg)...)
	ctx := context.Background()
	input := []PackageInput{{
		Source:    SourceRegistry,
		SourceURL: reg.provider().IndexURL,
		ID:        mf.ID,
	}}

	normal, err := mgr.Preview(ctx, input, PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("预览第三方来源失败: %v", err)
	}
	if !normal.NeedTrust {
		t.Fatal("默认应要求确认第三方来源的信任")
	}

	mgr.SetDeveloperMode(true)
	relaxed, err := mgr.Preview(ctx, input, PreviewOptions{ResolveDependencies: true})
	if err != nil {
		t.Fatalf("开发者模式下预览失败: %v", err)
	}
	if relaxed.NeedTrust {
		t.Fatalf("开发者模式下不应再要求确认信任: %+v", relaxed)
	}
}

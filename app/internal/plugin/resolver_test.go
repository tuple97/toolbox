package plugin

import (
	"errors"
	"strings"
	"testing"
)

// mkManifest 构造一个仅用于依赖求解的清单（不做过完整的清单校验）。
func mkManifest(id, version string, deps map[string]string) *Manifest {
	return &Manifest{
		ID:           id,
		Name:         id,
		Version:      version,
		Publisher:    "test",
		Dependencies: deps,
	}
}

func TestResolveIncludesDependenciesInTopologicalOrder(t *testing.T) {
	catalog := NewCatalog()
	catalog.Add(mkManifest("com.app", "1.0.0", map[string]string{"com.core": "^1.0.0"}))
	catalog.Add(mkManifest("com.core", "1.0.0", nil))
	catalog.Add(mkManifest("com.core", "1.5.0", nil))

	order, err := Resolve("com.app", "*", catalog)
	if err != nil {
		t.Fatalf("Resolve 失败: %v", err)
	}
	if len(order) != 2 {
		t.Fatalf("期望解析出 2 个插件，实际 %d", len(order))
	}
	// 依赖必须排在被依赖者之前（加载顺序即此顺序）
	if order[0].ID != "com.core" || order[1].ID != "com.app" {
		t.Fatalf("拓扑顺序错误: %s → %s", order[0].ID, order[1].ID)
	}
	// 约束内取最高版本
	if order[0].Version != "1.5.0" {
		t.Errorf("依赖应选最高兼容版本 1.5.0，实际 %s", order[0].Version)
	}
}

func TestResolvePinsExactRootVersion(t *testing.T) {
	catalog := NewCatalog()
	catalog.Add(mkManifest("com.app", "1.0.0", nil))
	catalog.Add(mkManifest("com.app", "2.0.0", nil))

	order, err := Resolve("com.app", "=1.0.0", catalog)
	if err != nil {
		t.Fatalf("Resolve 失败: %v", err)
	}
	if len(order) != 1 || order[0].Version != "1.0.0" {
		t.Fatalf("指定版本时不应升到更高版本，实际 %+v", order)
	}
}

func TestResolveDetectsCircularDependency(t *testing.T) {
	catalog := NewCatalog()
	catalog.Add(mkManifest("com.a", "1.0.0", map[string]string{"com.b": "^1.0.0"}))
	catalog.Add(mkManifest("com.b", "1.0.0", map[string]string{"com.c": "^1.0.0"}))
	catalog.Add(mkManifest("com.c", "1.0.0", map[string]string{"com.a": "^1.0.0"}))

	_, err := Resolve("com.a", "*", catalog)
	if err == nil {
		t.Fatal("期望检测到循环依赖，却解析成功了")
	}
	if !errors.Is(err, ErrCircularDependency) {
		t.Fatalf("错误类型不符: %v", err)
	}
	// 报错必须给出完整环路，便于用户定位
	if !strings.Contains(err.Error(), "→") {
		t.Errorf("错误信息应包含环路路径，实际: %v", err)
	}
}

func TestResolveDetectsSelfDependency(t *testing.T) {
	catalog := NewCatalog()
	catalog.Add(mkManifest("com.a", "1.0.0", map[string]string{"com.a": "^1.0.0"}))

	_, err := Resolve("com.a", "*", catalog)
	if err == nil {
		t.Fatal("自依赖应被判定为循环依赖")
	}
	if !errors.Is(err, ErrCircularDependency) {
		t.Fatalf("错误类型不符: %v", err)
	}
}

func TestResolveReportsMissingDependency(t *testing.T) {
	catalog := NewCatalog()
	catalog.Add(mkManifest("com.app", "1.0.0", map[string]string{"com.missing": "^1.0.0"}))

	_, err := Resolve("com.app", "*", catalog)
	if !errors.Is(err, ErrDependencyMissing) {
		t.Fatalf("期望依赖缺失错误，实际: %v", err)
	}
}

func TestResolveReportsVersionConflict(t *testing.T) {
	catalog := NewCatalog()
	catalog.Add(mkManifest("com.app", "1.0.0", map[string]string{
		"com.left":  "^1.0.0",
		"com.right": "^1.0.0",
	}))
	catalog.Add(mkManifest("com.left", "1.0.0", map[string]string{"com.shared": "^1.0.0"}))
	catalog.Add(mkManifest("com.right", "1.0.0", map[string]string{"com.shared": "^2.0.0"}))
	catalog.Add(mkManifest("com.shared", "1.0.0", nil))
	catalog.Add(mkManifest("com.shared", "2.0.0", nil))

	_, err := Resolve("com.app", "*", catalog)
	if !errors.Is(err, ErrDependencyConflict) {
		t.Fatalf("期望版本冲突错误，实际: %v", err)
	}
}

func TestDetectCycleReportsPath(t *testing.T) {
	selected := map[string]*Manifest{
		"com.a": mkManifest("com.a", "1.0.0", map[string]string{"com.b": "*"}),
		"com.b": mkManifest("com.b", "1.0.0", map[string]string{"com.a": "*"}),
	}
	path, found := DetectCycle(selected)
	if !found {
		t.Fatal("应当检测到循环依赖")
	}
	if len(path) < 3 {
		t.Fatalf("环路路径过短: %v", path)
	}
	if path[0] != path[len(path)-1] {
		t.Errorf("环路路径应首尾闭合: %v", path)
	}
}

func TestDependentsOf(t *testing.T) {
	installed := map[string]*Manifest{
		"com.core": mkManifest("com.core", "1.0.0", nil),
		"com.a":    mkManifest("com.a", "1.0.0", map[string]string{"com.core": "^1.0.0"}),
		"com.b":    mkManifest("com.b", "1.0.0", map[string]string{"com.core": "^1.0.0"}),
		"com.c":    mkManifest("com.c", "1.0.0", nil),
	}
	dependents := DependentsOf("com.core", installed)
	if len(dependents) != 2 || dependents[0] != "com.a" || dependents[1] != "com.b" {
		t.Fatalf("依赖方计算错误: %v", dependents)
	}
	if len(DependentsOf("com.c", installed)) != 0 {
		t.Error("com.c 不应有依赖方")
	}
}

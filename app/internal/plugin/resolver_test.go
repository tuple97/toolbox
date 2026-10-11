package plugin

import (
	"fmt"
	"strings"
	"testing"
)

// buildCatalog 由若干清单构建目录（同一插件可给出多个版本）。
func buildCatalog(t *testing.T, manifests ...*Manifest) *Catalog {
	t.Helper()
	catalog := NewCatalog()
	for _, mf := range manifests {
		if err := catalog.Add(mf, Origin{Kind: KindRegistry, Ref: "test://" + mf.ID}); err != nil {
			t.Fatalf("登记 %s@%s 失败: %v", mf.ID, mf.Version, err)
		}
	}
	return catalog
}

// resolvedVersions 把求解结果转成 id→version 便于断言。
func resolvedVersions(r *Resolution) map[string]string {
	out := make(map[string]string, len(r.Selected))
	for id, mf := range r.Selected {
		out[id] = mf.Version
	}
	return out
}

// TestResolveDiamondDependency 菱形依赖必须找到同时满足全部约束的一组版本。
func TestResolveDiamondDependency(t *testing.T) {
	a := withDependency(withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0"), "com.toolbox.c", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.2.0"), "com.toolbox.d", "^2.0.0")
	c := withDependency(baseManifest("com.toolbox.c", "1.1.0"), "com.toolbox.d", "^2.3.0")
	d1 := baseManifest("com.toolbox.d", "2.3.0")
	d2 := baseManifest("com.toolbox.d", "2.5.1")

	res, err := ResolveOne("com.toolbox.a", "=1.0.0", buildCatalog(t, a, b, c, d1, d2), nil)
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}
	got := resolvedVersions(res)
	if got["com.toolbox.d"] != "2.5.1" {
		t.Fatalf("期望选中 D 的 2.5.1，实际 %v", got)
	}
	if len(got) != 4 {
		t.Fatalf("依赖闭包应为 4 个插件，实际 %v", got)
	}
}

// TestResolveDiamondConflict 无法满足的菱形依赖必须报冲突，不能随便挑一个版本。
func TestResolveDiamondConflict(t *testing.T) {
	a := withDependency(withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0"), "com.toolbox.c", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.2.0"), "com.toolbox.d", "^1.0.0")
	c := withDependency(baseManifest("com.toolbox.c", "1.1.0"), "com.toolbox.d", "^2.0.0")

	_, err := ResolveOne("com.toolbox.a", "=1.0.0",
		buildCatalog(t, a, b, c, baseManifest("com.toolbox.d", "1.5.0"), baseManifest("com.toolbox.d", "2.0.1")), nil)
	if err == nil {
		t.Fatal("期望版本冲突错误，实际求解成功")
	}
	if !strings.Contains(err.Error(), ErrDependencyConflict.Error()) {
		t.Fatalf("错误应说明版本冲突: %v", err)
	}
	if !strings.Contains(err.Error(), "com.toolbox.d") {
		t.Fatalf("错误应指明冲突的插件: %v", err)
	}
}

// TestResolveResultIsDeterministic 求解结果与目录登记顺序无关。
func TestResolveResultIsDeterministic(t *testing.T) {
	manifests := []*Manifest{
		withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0"),
		baseManifest("com.toolbox.b", "1.0.0"),
		baseManifest("com.toolbox.b", "1.1.0"),
		baseManifest("com.toolbox.b", "1.2.0"),
	}

	first, err := ResolveOne("com.toolbox.a", "=1.0.0", buildCatalog(t, manifests...), nil)
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}

	reversed := make([]*Manifest, len(manifests))
	for i, mf := range manifests {
		reversed[len(manifests)-1-i] = mf
	}
	second, err := ResolveOne("com.toolbox.a", "=1.0.0", buildCatalog(t, reversed...), nil)
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}

	if len(first.Order) != len(second.Order) {
		t.Fatalf("两次结果长度不一致: %d vs %d", len(first.Order), len(second.Order))
	}
	for i := range first.Order {
		if first.Order[i].ID != second.Order[i].ID || first.Order[i].Version != second.Order[i].Version {
			t.Fatalf("第 %d 项顺序不一致: %s@%s vs %s@%s", i,
				first.Order[i].ID, first.Order[i].Version,
				second.Order[i].ID, second.Order[i].Version)
		}
	}
}

// TestResolveReusesInstalledVersion 已安装且满足约束的版本应被复用。
func TestResolveReusesInstalledVersion(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0")
	catalog := buildCatalog(t, a,
		baseManifest("com.toolbox.b", "1.0.0"),
		baseManifest("com.toolbox.b", "1.1.0"),
		baseManifest("com.toolbox.b", "1.9.9"),
	)

	res, err := ResolveOne("com.toolbox.a", "=1.0.0", catalog, map[string]string{"com.toolbox.b": "1.1.0"})
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}
	if got := res.Selected["com.toolbox.b"].Version; got != "1.1.0" {
		t.Fatalf("期望复用已安装的 1.1.0，实际 %s", got)
	}
}

// TestResolveUpgradesInstalledVersionOutsideRange 已安装版本不满足约束时选一个满足约束的更高版本。
func TestResolveUpgradesInstalledVersionOutsideRange(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.4.0")
	catalog := buildCatalog(t, a,
		baseManifest("com.toolbox.b", "1.4.0"),
		baseManifest("com.toolbox.b", "1.6.0"),
	)

	res, err := ResolveOne("com.toolbox.a", "=1.0.0", catalog, map[string]string{"com.toolbox.b": "1.0.0"})
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}
	if got := res.Selected["com.toolbox.b"].Version; got != "1.6.0" {
		t.Fatalf("期望升级到 1.6.0，实际 %s", got)
	}
}

// TestResolveRejectsSilentDowngrade 依赖导致已安装插件降级时必须报错。
func TestResolveRejectsSilentDowngrade(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0")
	catalog := buildCatalog(t, a,
		baseManifest("com.toolbox.b", "1.0.0"),
		baseManifest("com.toolbox.b", "1.4.0"),
	)

	_, err := ResolveOne("com.toolbox.a", "=1.0.0", catalog, map[string]string{"com.toolbox.b": "2.0.0"})
	if err == nil {
		t.Fatal("期望降级错误")
	}
	if !strings.Contains(err.Error(), ErrDowngrade.Error()) {
		t.Fatalf("错误应为降级错误: %v", err)
	}
}

// TestResolveAllowsExplicitDowngrade 用户显式指定精确版本时应允许降级。
func TestResolveAllowsExplicitDowngrade(t *testing.T) {
	catalog := buildCatalog(t,
		baseManifest("com.toolbox.b", "1.0.0"),
		baseManifest("com.toolbox.b", "2.0.0"),
	)
	res, err := ResolveOne("com.toolbox.b", "=1.0.0", catalog, map[string]string{"com.toolbox.b": "2.0.0"})
	if err != nil {
		t.Fatalf("显式降级应被允许: %v", err)
	}
	if res.Selected["com.toolbox.b"].Version != "1.0.0" {
		t.Fatal("应选中显式指定的版本")
	}
}

// TestResolveMissingDependency 依赖缺失必须明确失败。
func TestResolveMissingDependency(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.missing", "^1.0.0")
	_, err := ResolveOne("com.toolbox.a", "=1.0.0", buildCatalog(t, a), nil)
	if err == nil {
		t.Fatal("期望依赖缺失错误")
	}
	if !strings.Contains(err.Error(), ErrDependencyMissing.Error()) {
		t.Fatalf("错误应为依赖缺失: %v", err)
	}
}

// TestResolveCircularDependency 循环依赖必须报错并给出环路。
func TestResolveCircularDependency(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.0.0"), "com.toolbox.c", "^1.0.0")
	c := withDependency(baseManifest("com.toolbox.c", "1.0.0"), "com.toolbox.a", "^1.0.0")

	_, err := ResolveOne("com.toolbox.a", "=1.0.0", buildCatalog(t, a, b, c), nil)
	if err == nil {
		t.Fatal("期望循环依赖错误")
	}
	if !strings.Contains(err.Error(), ErrCircularDependency.Error()) {
		t.Fatalf("错误应为循环依赖: %v", err)
	}
	for _, id := range []string{"com.toolbox.a", "com.toolbox.b", "com.toolbox.c"} {
		if !strings.Contains(err.Error(), id) {
			t.Fatalf("错误应包含环路成员 %s: %v", id, err)
		}
	}
}

// TestResolveSharedDependency 多个插件共享同一依赖时只选一个版本。
func TestResolveSharedDependency(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.shared", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.0.0"), "com.toolbox.shared", ">=1.1.0")
	catalog := buildCatalog(t, a, b,
		baseManifest("com.toolbox.shared", "1.0.0"),
		baseManifest("com.toolbox.shared", "1.1.0"),
		baseManifest("com.toolbox.shared", "1.2.0"),
	)

	res, err := Resolve([]Requirement{
		{ID: "com.toolbox.a", Constraint: "=1.0.0"},
		{ID: "com.toolbox.b", Constraint: "=1.0.0"},
	}, catalog, ResolveOptions{})
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}
	if got := res.Selected["com.toolbox.shared"].Version; got != "1.2.0" {
		t.Fatalf("期望 1.2.0，实际 %s", got)
	}
	if len(res.Selected) != 3 {
		t.Fatalf("期望 3 个插件，实际 %d", len(res.Selected))
	}
}

// TestResolvePrefersStableVersion 同条件下稳定版优先于预发布版。
func TestResolvePrefersStableVersion(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", ">=1.0.0")
	catalog := buildCatalog(t, a,
		baseManifest("com.toolbox.b", "1.0.0"),
		baseManifest("com.toolbox.b", "2.0.0-beta.1"),
	)

	res, err := ResolveOne("com.toolbox.a", "=1.0.0", catalog, nil)
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}
	if got := res.Selected["com.toolbox.b"].Version; got != "1.0.0" {
		t.Fatalf("期望稳定版 1.0.0，实际 %s", got)
	}
}

// TestResolveOrderPutsDependenciesFirst 拓扑顺序必须依赖在前。
func TestResolveOrderPutsDependenciesFirst(t *testing.T) {
	a := withDependency(withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0"), "com.toolbox.c", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.0.0"), "com.toolbox.d", "^1.0.0")
	c := baseManifest("com.toolbox.c", "1.0.0")
	d := baseManifest("com.toolbox.d", "1.0.0")

	res, err := ResolveOne("com.toolbox.a", "=1.0.0", buildCatalog(t, a, b, c, d), nil)
	if err != nil {
		t.Fatalf("求解失败: %v", err)
	}

	position := make(map[string]int, len(res.Order))
	for i, mf := range res.Order {
		position[mf.ID] = i
	}
	for id, mf := range res.Selected {
		for dep := range mf.Dependencies {
			if position[dep] >= position[id] {
				t.Fatalf("依赖 %s 应排在 %s 之前，实际顺序 %v", dep, id, position)
			}
		}
	}
}

// TestCatalogRejectsConflictingChecksum 同一版本出现不同内容必须被拒绝。
func TestCatalogRejectsConflictingChecksum(t *testing.T) {
	catalog := NewCatalog()
	mf := baseManifest("com.toolbox.a", "1.0.0")
	if err := catalog.Add(mf, Origin{Kind: KindRegistry, Checksum: "sha256:" + strings.Repeat("a", 64)}); err != nil {
		t.Fatalf("首次登记失败: %v", err)
	}
	err := catalog.Add(mf, Origin{Kind: KindRegistry, Checksum: "sha256:" + strings.Repeat("b", 64)})
	if err == nil {
		t.Fatal("摘要冲突应被拒绝")
	}
}

// TestCatalogPrefersRootOrigin 同一版本有多个来源时按优先级决策。
func TestCatalogPrefersRootOrigin(t *testing.T) {
	catalog := NewCatalog()
	mf := baseManifest("com.toolbox.a", "1.0.0")
	if err := catalog.Add(mf, Origin{Kind: KindInstalled, Priority: originPriorityInstalled}); err != nil {
		t.Fatalf("登记失败: %v", err)
	}
	if err := catalog.Add(mf, Origin{Kind: KindBatch, Ref: "user.zip", Payload: []byte("zip"), Priority: originPriorityRoot}); err != nil {
		t.Fatalf("登记失败: %v", err)
	}
	entry := catalog.Entry("com.toolbox.a", "1.0.0")
	if entry == nil {
		t.Fatal("应能查回条目")
	}
	if entry.Origin.Kind != KindBatch {
		t.Fatalf("根来源应胜出，实际 %s", entry.Origin.Kind)
	}
}

// TestDepGraphQueries 依赖图的查询能力。
func TestDepGraphQueries(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.0.0"), "com.toolbox.c", "^1.0.0")
	c := baseManifest("com.toolbox.c", "1.0.0")

	graph := NewDepGraph(map[string]*Manifest{
		a.ID: a, b.ID: b, c.ID: c,
	})

	if got := graph.Dependencies(a.ID); len(got) != 1 || got[0] != b.ID {
		t.Fatalf("依赖查询错误: %v", got)
	}
	if got := graph.Dependents(b.ID); len(got) != 1 || got[0] != a.ID {
		t.Fatalf("依赖方查询错误: %v", got)
	}
	closure := graph.DependentsClosure(c.ID)
	if len(closure) != 2 {
		t.Fatalf("传递依赖方应为 2 个，实际 %v", closure)
	}
	deps := graph.DependencyClosure([]string{a.ID})
	if len(deps) != 3 {
		t.Fatalf("依赖闭包应为 3 个，实际 %v", deps)
	}

	order, err := graph.Order()
	if err != nil {
		t.Fatalf("无环图不应报错: %v", err)
	}
	if order[0].ID != c.ID || order[2].ID != a.ID {
		t.Fatalf("拓扑顺序错误: %v", order)
	}

	if _, hasCycle := graph.Cycle(); hasCycle {
		t.Fatal("无环图不应报告环路")
	}
}

// TestDepGraphCycleDetection 环路检测要给出完整路径。
func TestDepGraphCycleDetection(t *testing.T) {
	a := withDependency(baseManifest("com.toolbox.a", "1.0.0"), "com.toolbox.b", "^1.0.0")
	b := withDependency(baseManifest("com.toolbox.b", "1.0.0"), "com.toolbox.a", "^1.0.0")

	graph := NewDepGraph(map[string]*Manifest{a.ID: a, b.ID: b})
	if _, err := graph.Order(); err == nil {
		t.Fatal("有环图排序必须失败，不能退化为按 id 排序")
	}
	cycle, ok := graph.Cycle()
	if !ok || len(cycle) < 3 {
		t.Fatalf("应报告完整环路，实际 %v", cycle)
	}
}

// TestResolveBudgetGuard 极端依赖下应明确失败而不是无限搜索。
func TestResolveBudgetGuard(t *testing.T) {
	manifests := make([]*Manifest, 0, 40)
	for i := 0; i < 20; i++ {
		manifests = append(manifests, baseManifest("com.toolbox.a", fmt.Sprintf("1.%d.0", i)))
	}
	catalog := buildCatalog(t, manifests...)

	res, err := ResolveOne("com.toolbox.a", "^1.0.0", catalog, nil)
	if err != nil {
		t.Fatalf("正常求解不应失败: %v", err)
	}
	if res.Selected["com.toolbox.a"].Version != "1.19.0" {
		t.Fatalf("应选中最高版本，实际 %s", res.Selected["com.toolbox.a"].Version)
	}
}

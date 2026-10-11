package plugin

import (
	"fmt"
	"sort"
	"strings"

	"toolbox/app/internal/semver"
)

// maxSolveSteps 依赖求解的搜索步数上限。
//
// 求解是带回溯的搜索，理论上最坏情况是指数级。插件规模很小，
// 这里给一个远高于实际需要的上限，命中时明确失败而不是无限递归。
const maxSolveSteps = 20000

// rootRef 根依赖的来源标记（用户显式请求安装的插件）。
const rootRef = "(root)"

// Requirement 一条依赖要求。
type Requirement struct {
	// ID 被要求的插件标识
	ID string
	// Constraint semver 约束原文
	Constraint string
	// From 提出要求的来源：rootRef 或某个插件 id
	From string
}

// ResolveOptions 求解选项。
type ResolveOptions struct {
	// Installed 本地已安装版本（id → 版本）。
	//
	// 求解时优先复用满足全部约束的已安装版本，避免无必要的升级。
	Installed map[string]string
}

// Resolution 依赖求解结果。
type Resolution struct {
	// Selected 选定的插件（id → 精确版本清单）
	Selected map[string]*Manifest
	// Order 拓扑顺序（依赖在前），可直接按序加载
	Order []*Manifest
	// Graph 依赖图，供安装计划、启用检查、卸载与级联操作复用
	Graph *DepGraph
	// Catalog 求解所用的目录，安装器据此取包
	Catalog *Catalog
	// Roots 用户显式请求的插件 id
	Roots []string
}

// Resolve 求解一组根要求的完整依赖闭包。
//
// 语义保证：
//   - 返回的每个插件都满足其全部必需依赖的版本约束；
//   - 缺失依赖、版本冲突、循环依赖都会返回明确的错误，绝不静默挑选；
//   - 结果只取决于入参（目录 + 根要求 + 已安装集合），与遍历顺序无关。
func Resolve(roots []Requirement, catalog *Catalog, opts ResolveOptions) (*Resolution, error) {
	if len(roots) == 0 {
		return nil, fmt.Errorf("依赖求解缺少根要求")
	}
	if catalog == nil {
		catalog = NewCatalog()
	}

	state := &solveState{
		constraints: make(map[string][]Requirement),
		selected:    make(map[string]*Manifest),
	}
	rootIDs := make([]string, 0, len(roots))
	rootExact := make(map[string]string, len(roots))

	for _, r := range roots {
		if r.ID == "" {
			return nil, fmt.Errorf("依赖求解的根要求缺少插件 id")
		}
		constraint := r.Constraint
		if strings.TrimSpace(constraint) == "" {
			constraint = "*"
		}
		from := r.From
		if from == "" {
			from = rootRef
		}
		state.constraints[r.ID] = append(state.constraints[r.ID], Requirement{
			ID: r.ID, Constraint: constraint, From: from,
		})
		rootIDs = append(rootIDs, r.ID)
		if v, ok := exactVersionOf(constraint); ok {
			rootExact[r.ID] = v
		}
	}
	sort.Strings(rootIDs)

	sol := &solver{catalog: catalog, installed: opts.Installed, steps: maxSolveSteps}
	result, err := sol.solve(state)
	if err != nil {
		return nil, err
	}

	graph := NewDepGraph(result.selected)
	order, err := graph.Order()
	if err != nil {
		return nil, err
	}

	if err := checkDowngrades(result.selected, opts.Installed, rootExact); err != nil {
		return nil, err
	}

	return &Resolution{
		Selected: result.selected,
		Order:    order,
		Graph:    graph,
		Catalog:  catalog,
		Roots:    rootIDs,
	}, nil
}

// ResolveOne 求解单个根插件（安装单个插件时的常用入口）。
func ResolveOne(id, constraint string, catalog *Catalog, installed map[string]string) (*Resolution, error) {
	return Resolve([]Requirement{{ID: id, Constraint: constraint, From: rootRef}}, catalog, ResolveOptions{Installed: installed})
}

// solveState 求解过程中的中间状态。
type solveState struct {
	// constraints 每个插件当前收到的全部版本约束
	constraints map[string][]Requirement
	// selected 已经选定的版本
	selected map[string]*Manifest
}

func (s *solveState) clone() *solveState {
	next := &solveState{
		constraints: make(map[string][]Requirement, len(s.constraints)),
		selected:    make(map[string]*Manifest, len(s.selected)),
	}
	for k, v := range s.constraints {
		next.constraints[k] = append([]Requirement{}, v...)
	}
	for k, v := range s.selected {
		next.selected[k] = v
	}
	return next
}

// solver 依赖求解器。
type solver struct {
	catalog   *Catalog
	installed map[string]string
	steps     int
}

// solve 递归求解：每次固定一个尚未确定版本、且 id 最小的插件。
func (s *solver) solve(state *solveState) (*solveState, error) {
	s.steps--
	if s.steps <= 0 {
		return nil, fmt.Errorf("依赖求解超出计算上限：请检查插件依赖是否过于复杂")
	}

	pending := ""
	for _, id := range sortedConstraintKeys(state.constraints) {
		if _, ok := state.selected[id]; !ok {
			pending = id
			break
		}
	}
	if pending == "" {
		return state, nil
	}

	reqs := state.constraints[pending]
	parsed, err := parseConstraints(reqs)
	if err != nil {
		return nil, err
	}

	candidates, err := s.candidates(pending, reqs, parsed)
	if err != nil {
		return nil, err
	}

	var lastErr error
	for _, cand := range candidates {
		next := state.clone()
		next.selected[pending] = cand
		for _, dep := range cand.SortedDependencies() {
			next.constraints[dep.ID] = append(next.constraints[dep.ID], Requirement{
				ID: dep.ID, Constraint: dep.Constraint, From: cand.ID,
			})
		}
		if violation := firstViolation(next); violation != nil {
			lastErr = violation
			continue
		}
		out, err := s.solve(next)
		if err == nil {
			return out, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("%w: %s", ErrDependencyConflict, pending)
	}
	return nil, lastErr
}

// candidates 返回满足全部约束的候选版本（按选择优先级排列）。
//
// 目录里没有该插件时报「依赖缺失」，有版本但都不满足约束时报「版本冲突」
// 并给出完整的约束链路与可用版本 —— 两者都是明确的解析失败。
func (s *solver) candidates(
	id string,
	reqs []Requirement,
	constraints []semver.Constraint,
) ([]*Manifest, error) {
	entries := s.catalog.Versions(id)
	if len(entries) == 0 {
		return nil, fmt.Errorf("%w: %s（被 %s 依赖）", ErrDependencyMissing, id, describeFromList(reqs))
	}

	satisfied := make([]*Manifest, 0, len(entries))
	for _, e := range entries {
		v, err := semver.Parse(e.Manifest.Version)
		if err != nil {
			continue
		}
		if matchesAll(constraints, v) {
			satisfied = append(satisfied, e.Manifest)
		}
	}
	if len(satisfied) == 0 {
		return nil, fmt.Errorf("%w: %s 没有同时满足以下约束的版本：%s；可用版本：%s",
			ErrDependencyConflict, id, describeRequirements(reqs), availableVersions(entries))
	}
	return orderCandidates(satisfied, s.installed[id]), nil
}

// orderCandidates 按选择策略排序候选版本：
//
//  1. 已安装且满足全部约束的版本优先（避免无必要的升级）；
//  2. 其余按稳定版优先、版本从高到低；
//  3. 预发布版本排在稳定版之后（同条件不主动引入预发布）。
func orderCandidates(candidates []*Manifest, installed string) []*Manifest {
	out := make([]*Manifest, 0, len(candidates))
	if installed != "" {
		for _, m := range candidates {
			if m.Version == installed {
				out = append(out, m)
				break
			}
		}
	}

	rest := make([]*Manifest, 0, len(candidates))
	for _, m := range candidates {
		if installed != "" && m.Version == installed {
			continue
		}
		rest = append(rest, m)
	}
	sort.SliceStable(rest, func(i, j int) bool {
		left, leftErr := semver.Parse(rest[i].Version)
		right, rightErr := semver.Parse(rest[j].Version)
		if leftErr != nil || rightErr != nil {
			return rest[i].Version > rest[j].Version
		}
		leftPre := len(left.Pre) > 0
		rightPre := len(right.Pre) > 0
		if leftPre != rightPre {
			return !leftPre // 稳定版优先
		}
		return left.Compare(right) > 0
	})
	return append(out, rest...)
}

// firstViolation 检查已选版本里是否存在不满足当前全部约束的条目。
func firstViolation(state *solveState) error {
	for _, id := range sortedManifestKeys(state.selected) {
		reqs := state.constraints[id]
		if len(reqs) == 0 {
			continue
		}
		parsed, err := parseConstraints(reqs)
		if err != nil {
			return err
		}
		version, err := semver.Parse(state.selected[id].Version)
		if err != nil {
			return fmt.Errorf("插件 %s 的候选版本号非法: %q", id, state.selected[id].Version)
		}
		if !matchesAll(parsed, version) {
			return fmt.Errorf("%w: %s@%s 不满足 %s",
				ErrDependencyConflict, id, state.selected[id].Version, describeRequirements(reqs))
		}
	}
	return nil
}

// checkDowngrades 拒绝静默降级已安装插件。
//
// 只有用户显式指定了精确版本（根要求写成 "=x.y.z"）时才允许降级；
// 依赖关系导致的降级必须报错，让用户自己决定怎么处理。
func checkDowngrades(selected map[string]*Manifest, installed map[string]string, rootExact map[string]string) error {
	for _, id := range sortedManifestKeys(selected) {
		current, ok := installed[id]
		if !ok || current == "" {
			continue
		}
		if pinned, ok := rootExact[id]; ok && pinned == selected[id].Version {
			continue // 用户显式要求安装这个版本
		}
		from, fErr := semver.Parse(current)
		to, tErr := semver.Parse(selected[id].Version)
		if fErr != nil || tErr != nil {
			continue
		}
		if to.LessThan(from) {
			return fmt.Errorf("%w: %s 会被降级 %s → %s（如确需降级请显式指定版本）",
				ErrDowngrade, id, current, selected[id].Version)
		}
	}
	return nil
}

// parseConstraints 解析一组约束原文。
func parseConstraints(reqs []Requirement) ([]semver.Constraint, error) {
	out := make([]semver.Constraint, 0, len(reqs))
	for _, r := range reqs {
		c, err := semver.ParseConstraint(r.Constraint)
		if err != nil {
			return nil, fmt.Errorf("依赖 %s 的约束非法（来自 %s）: %w", r.ID, describeFrom(r.From), err)
		}
		out = append(out, c)
	}
	return out, nil
}

func matchesAll(constraints []semver.Constraint, v semver.Version) bool {
	for _, c := range constraints {
		if !c.Check(v) {
			return false
		}
	}
	return true
}

// exactVersionOf 识别 "=x.y.z" 形式的精确约束。
func exactVersionOf(constraint string) (string, bool) {
	text := strings.TrimSpace(constraint)
	if !strings.HasPrefix(text, "=") {
		return "", false
	}
	value := strings.TrimSpace(strings.TrimPrefix(text, "="))
	if !semver.IsValid(value) {
		return "", false
	}
	return value, true
}

func sortedConstraintKeys(m map[string][]Requirement) []string {
	keys := make([]string, 0, len(m))
	for id := range m {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	return keys
}

func sortedManifestKeys(m map[string]*Manifest) []string {
	keys := make([]string, 0, len(m))
	for id := range m {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	return keys
}

func describeFrom(from string) string {
	if from == rootRef || from == "" {
		return "安装目标"
	}
	return from
}

// describeRequirements 生成「谁要求什么版本」的可读说明。
func describeRequirements(reqs []Requirement) string {
	parts := make([]string, 0, len(reqs))
	for _, r := range reqs {
		parts = append(parts, fmt.Sprintf("%s 要求 %s", describeFrom(r.From), r.Constraint))
	}
	sort.Strings(parts)
	return strings.Join(parts, "；")
}

// describeFromList 汇总某插件被谁要求（去重排序）。
func describeFromList(reqs []Requirement) string {
	seen := make(map[string]struct{}, len(reqs))
	names := make([]string, 0, len(reqs))
	for _, r := range reqs {
		from := describeFrom(r.From)
		if _, ok := seen[from]; ok {
			continue
		}
		seen[from] = struct{}{}
		names = append(names, from)
	}
	sort.Strings(names)
	return strings.Join(names, "、")
}

// availableVersions 列出目录中该插件的全部版本，用于冲突提示。
func availableVersions(entries []*CatalogEntry) string {
	parts := make([]string, 0, len(entries))
	for _, e := range entries {
		parts = append(parts, e.Manifest.Version)
	}
	if len(parts) == 0 {
		return "（无）"
	}
	return strings.Join(parts, "、")
}

// ---------------------------------------------------------------- 依赖图

// DepGraph 只读依赖图。
//
// 安装计划、启用前检查、加载顺序、调用授权、停用与卸载检查全部复用它，
// 避免每个方法各写一套依赖遍历。
type DepGraph struct {
	nodes map[string]*Manifest
}

// NewDepGraph 由插件清单集合构建依赖图。
func NewDepGraph(manifests map[string]*Manifest) *DepGraph {
	nodes := make(map[string]*Manifest, len(manifests))
	for id, m := range manifests {
		if m == nil {
			continue
		}
		nodes[id] = m
	}
	return &DepGraph{nodes: nodes}
}

// Node 返回某个插件的清单。
func (g *DepGraph) Node(id string) *Manifest { return g.nodes[id] }

// Has 报告图中是否包含该插件。
func (g *DepGraph) Has(id string) bool {
	_, ok := g.nodes[id]
	return ok
}

// Len 返回图中节点数量。
func (g *DepGraph) Len() int { return len(g.nodes) }

// IDs 返回全部节点标识（已排序）。
func (g *DepGraph) IDs() []string { return sortedManifestKeys(g.nodes) }

// Dependencies 返回某个插件声明的全部依赖（已排序）。
func (g *DepGraph) Dependencies(id string) []string {
	m := g.nodes[id]
	if m == nil {
		return nil
	}
	out := make([]string, 0, len(m.Dependencies))
	for dep := range m.Dependencies {
		out = append(out, dep)
	}
	sort.Strings(out)
	return out
}

// Dependents 返回直接依赖 target 的节点（已排序）。
func (g *DepGraph) Dependents(target string) []string {
	out := make([]string, 0, 4)
	for _, id := range g.IDs() {
		if id == target {
			continue
		}
		if _, ok := g.nodes[id].Dependencies[target]; ok {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// DependentsClosure 返回传递依赖 target 的全部节点（已排序，不含 target）。
func (g *DepGraph) DependentsClosure(target string) []string {
	seen := map[string]bool{target: true}
	queue := []string{target}
	out := make([]string, 0, 4)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, id := range g.Dependents(cur) {
			if seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
			queue = append(queue, id)
		}
	}
	sort.Strings(out)
	return out
}

// DependencyClosure 返回给定节点的全部依赖闭包（含自身，已排序）。
func (g *DepGraph) DependencyClosure(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	queue := append([]string{}, ids...)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if _, ok := seen[cur]; ok {
			continue
		}
		if !g.Has(cur) {
			continue
		}
		seen[cur] = struct{}{}
		queue = append(queue, g.Dependencies(cur)...)
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Order 返回拓扑顺序（依赖在前）。
//
// 存在循环依赖时返回 ErrCircularDependency 并带上完整环路。
// 不做任何「按 id 排序继续加载」的兜底 —— 那只会把错误藏起来。
func (g *DepGraph) Order() ([]*Manifest, error) {
	return g.OrderSubset(g.IDs())
}

// OrderSubset 对给定 id 子集做拓扑排序；子集外的依赖被忽略。
func (g *DepGraph) OrderSubset(ids []string) ([]*Manifest, error) {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	allowed := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if g.Has(id) {
			allowed[id] = struct{}{}
		}
	}

	color := make(map[string]int, len(allowed))
	order := make([]*Manifest, 0, len(allowed))
	var stack []string

	var visit func(id string) error
	visit = func(id string) error {
		switch color[id] {
		case black:
			return nil
		case gray:
			return circularError(stack, id)
		}
		color[id] = gray
		stack = append(stack, id)
		for _, dep := range g.Dependencies(id) {
			if _, ok := allowed[dep]; !ok {
				continue
			}
			if err := visit(dep); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		color[id] = black
		order = append(order, g.nodes[id])
		return nil
	}

	sorted := append([]string{}, ids...)
	sort.Strings(sorted)
	for _, id := range sorted {
		if _, ok := allowed[id]; !ok {
			continue
		}
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// Cycle 返回图中存在的一条环路（无环时返回 nil, false）。
func (g *DepGraph) Cycle() ([]string, bool) {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(g.nodes))
	var stack []string
	var found []string

	var visit func(id string) bool
	visit = func(id string) bool {
		switch color[id] {
		case black:
			return false
		case gray:
			start := 0
			for i, v := range stack {
				if v == id {
					start = i
					break
				}
			}
			found = append(append([]string{}, stack[start:]...), id)
			return true
		}
		color[id] = gray
		stack = append(stack, id)
		for _, dep := range g.Dependencies(id) {
			if _, ok := g.nodes[dep]; !ok {
				continue
			}
			if visit(dep) {
				return true
			}
		}
		stack = stack[:len(stack)-1]
		color[id] = black
		return false
	}

	for _, id := range g.IDs() {
		if visit(id) {
			return found, true
		}
	}
	return nil, false
}

// circularError 构造带完整环路路径的错误，便于用户定位问题。
func circularError(stack []string, repeated string) error {
	start := 0
	for i, id := range stack {
		if id == repeated {
			start = i
			break
		}
	}
	cycle := append(append([]string{}, stack[start:]...), repeated)
	return fmt.Errorf("%w: %s", ErrCircularDependency, strings.Join(cycle, " → "))
}

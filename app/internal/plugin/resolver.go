package plugin

import (
	"fmt"
	"sort"
	"strings"

	"toolbox/app/internal/semver"
)

// maxResolveIterations 依赖求解的最大迭代轮数，防止病态输入下死循环。
const maxResolveIterations = 64

// Catalog 可用插件目录：插件标识 → 各版本清单（按版本降序）。
//
// 它是依赖求解的唯一输入，既可来自本地已安装插件，
// 也可来自官方索引（安装新插件时把索引构建成 Catalog）。
type Catalog struct {
	entries map[string][]*Manifest
}

// NewCatalog 创建空目录。
func NewCatalog() *Catalog {
	return &Catalog{entries: make(map[string][]*Manifest)}
}

// Add 登记一个可用版本；重复 (id, version) 会被忽略。
func (c *Catalog) Add(m *Manifest) {
	if m == nil || m.ID == "" {
		return
	}
	for _, exist := range c.entries[m.ID] {
		if exist.Version == m.Version {
			return
		}
	}
	c.entries[m.ID] = append(c.entries[m.ID], m)
	sort.Slice(c.entries[m.ID], func(i, j int) bool {
		left, leftErr := semver.Parse(c.entries[m.ID][i].Version)
		right, rightErr := semver.Parse(c.entries[m.ID][j].Version)
		if leftErr != nil || rightErr != nil {
			return c.entries[m.ID][i].Version > c.entries[m.ID][j].Version
		}
		return left.Compare(right) > 0 // 降序：优先选高版本
	})
}

// Versions 返回某插件的全部候选版本（降序）。
func (c *Catalog) Versions(id string) []*Manifest {
	return c.entries[id]
}

// Has 报告目录中是否存在该插件。
func (c *Catalog) Has(id string) bool {
	return len(c.entries[id]) > 0
}

// IDs 返回目录中的全部插件标识（已排序）。
func (c *Catalog) IDs() []string {
	ids := make([]string, 0, len(c.entries))
	for id := range c.entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Find 在目录中查找指定插件的指定版本。
func (c *Catalog) Find(id, version string) *Manifest {
	for _, m := range c.entries[id] {
		if m.Version == version {
			return m
		}
	}
	return nil
}

// requirement 一条依赖要求。
type requirement struct {
	// from 提出要求的插件 id（根为 rootRef）
	from string
	// constraint semver 约束原文
	constraint string
}

// rootRef 根依赖的来源标记。
const rootRef = "(root)"

// Resolve 求解插件的依赖闭包。
//
// 返回的清单列表已按拓扑排序：任一插件都出现在它的依赖之后，
// 可以直接按顺序加载。若存在循环依赖或版本冲突则返回相应错误。
func Resolve(rootID, rootConstraint string, catalog *Catalog) ([]*Manifest, error) {
	if rootConstraint == "" {
		rootConstraint = "*"
	}

	selected := make(map[string]*Manifest)

	for iter := 0; iter < maxResolveIterations; iter++ {
		reqs := buildRequirements(rootID, rootConstraint, selected)

		changed := false
		for _, id := range sortedReqKeys(reqs) {
			picked, err := pickVersion(id, reqs[id], catalog)
			if err != nil {
				return nil, err
			}
			if current, ok := selected[id]; !ok || current.Version != picked.Version {
				selected[id] = picked
				changed = true
			}
		}

		// 丢弃不再被任何插件要求的条目
		for id := range selected {
			if _, ok := reqs[id]; !ok {
				delete(selected, id)
				changed = true
			}
		}

		if !changed {
			break
		}
	}

	return TopoSort(selected)
}

// buildRequirements 依据当前选择重建完整需求表。
func buildRequirements(rootID, rootConstraint string, selected map[string]*Manifest) map[string][]requirement {
	reqs := make(map[string][]requirement)
	reqs[rootID] = append(reqs[rootID], requirement{from: rootRef, constraint: rootConstraint})
	for id, m := range selected {
		for _, dep := range m.SortedDependencies() {
			reqs[dep.ID] = append(reqs[dep.ID], requirement{from: id, constraint: dep.Constraint})
		}
	}
	return reqs
}

// pickVersion 在所有要求的约束下挑选最高可用版本。
func pickVersion(id string, reqs []requirement, catalog *Catalog) (*Manifest, error) {
	candidates := catalog.Versions(id)
	if len(candidates) == 0 {
		return nil, fmt.Errorf("%w: %s（被 %s 依赖）", ErrDependencyMissing, id, describeFrom(reqs))
	}

	constraints := make([]semver.Constraint, 0, len(reqs))
	for _, r := range reqs {
		c, err := semver.ParseConstraint(r.constraint)
		if err != nil {
			return nil, fmt.Errorf("依赖 %s 的约束非法: %w", id, err)
		}
		constraints = append(constraints, c)
	}

	for _, cand := range candidates {
		v, err := semver.Parse(cand.Version)
		if err != nil {
			continue
		}
		if matchesAll(constraints, v) {
			return cand, nil
		}
	}

	return nil, fmt.Errorf("%w: %s 没有满足以下要求的版本：%s",
		ErrDependencyConflict, id, describeRequirements(reqs))
}

func matchesAll(constraints []semver.Constraint, v semver.Version) bool {
	for _, c := range constraints {
		if !c.Check(v) {
			return false
		}
	}
	return true
}

// TopoSort 对已选插件做拓扑排序（依赖在前），并检测循环依赖。
func TopoSort(selected map[string]*Manifest) ([]*Manifest, error) {
	const (
		white = 0
		gray  = 1
		black = 2
	)

	color := make(map[string]int, len(selected))
	order := make([]*Manifest, 0, len(selected))
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

		m := selected[id]
		for _, dep := range m.SortedDependencies() {
			if _, ok := selected[dep.ID]; !ok {
				continue
			}
			if err := visit(dep.ID); err != nil {
				return err
			}
		}

		stack = stack[:len(stack)-1]
		color[id] = black
		order = append(order, m)
		return nil
	}

	ids := make([]string, 0, len(selected))
	for id := range selected {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		if color[id] == black {
			continue
		}
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return order, nil
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

// DetectCycle 报告给定插件集合中是否存在循环依赖，并返回环路。
func DetectCycle(selected map[string]*Manifest) ([]string, bool) {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(selected))
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
		m := selected[id]
		for _, dep := range m.SortedDependencies() {
			if _, ok := selected[dep.ID]; !ok {
				continue
			}
			if visit(dep.ID) {
				return true
			}
		}
		stack = stack[:len(stack)-1]
		color[id] = black
		return false
	}

	ids := make([]string, 0, len(selected))
	for id := range selected {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if visit(id) {
			return found, true
		}
	}
	return nil, false
}

// sortedReqKeys 返回需求表中排序后的插件标识，保证求解过程确定。
func sortedReqKeys(reqs map[string][]requirement) []string {
	keys := make([]string, 0, len(reqs))
	for id := range reqs {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	return keys
}

func describeFrom(reqs []requirement) string {
	seen := make(map[string]struct{}, len(reqs))
	names := make([]string, 0, len(reqs))
	for _, r := range reqs {
		if _, ok := seen[r.from]; ok {
			continue
		}
		seen[r.from] = struct{}{}
		if r.from == rootRef {
			names = append(names, "安装目标")
		} else {
			names = append(names, r.from)
		}
	}
	sort.Strings(names)
	return strings.Join(names, "、")
}

func describeRequirements(reqs []requirement) string {
	parts := make([]string, 0, len(reqs))
	for _, r := range reqs {
		from := r.from
		if from == rootRef {
			from = "安装目标"
		}
		parts = append(parts, fmt.Sprintf("%s 要求 %s", from, r.constraint))
	}
	sort.Strings(parts)
	return strings.Join(parts, "；")
}

// DependentsOf 在给定插件集合中查找直接依赖 target 的插件。
func DependentsOf(target string, installed map[string]*Manifest) []string {
	var out []string
	for id, m := range installed {
		if id == target {
			continue
		}
		if _, ok := m.Dependencies[target]; ok {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

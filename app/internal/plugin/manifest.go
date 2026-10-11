// Package plugin 实现工具箱的插件体系。
//
// 本文件是插件协议的唯一权威定义：清单字段、取值约束与解析规则。
// 插件仓库（toolbox-plugins）的构建工具必须遵守同一份规则，
// 双方以 schema/manifest.schema.json 与这里的校验逻辑为准。
package plugin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"toolbox/app/internal/semver"
)

// ManifestFileName 插件清单文件名。
const ManifestFileName = "manifest.json"

// ManifestVersion 当前支持的清单格式版本。
//
// 它与插件自身的 version 无关：version 描述插件功能迭代，
// manifestVersion 描述清单结构的版本。结构变化时递增，
// 宿主只接受自己认识的版本，不做无限兼容。
const ManifestVersion = 1

// PluginAPIVersion 宿主当前提供的插件 API 版本。
//
// 插件用 engines.pluginApi 声明自己需要的 API 范围；宿主用本常量
// 做匹配。新增破坏性 API 变化时提升 Major。
const PluginAPIVersion = "1.0.0"

// 防止恶意清单造成资源耗尽。
const (
	maxIDLen          = 128
	maxNameLen        = 64
	maxDescriptionLen = 512
	maxContributions  = 64
	maxDependencies   = 64
	maxExports        = 64
)

// idPattern 插件标识：反向域名风格，至少两段，全小写。
var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`)

// toolTypePattern 工具类型。
//
// 允许两种写法：内置工具风格（connections）与命名空间风格（com.toolbox.x.tool）。
// 与内置工具同名的类型表示「接管该入口」，由前端注册表按显式规则处理。
var toolTypePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$`)

// publisherPattern 发布者标识。
var publisherPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// handlerNamePattern 后端 handler 名。
var handlerNamePattern = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$.-]*$`)

// Engines 声明插件对宿主环境的版本要求。
type Engines struct {
	// Toolbox 宿主应用版本约束（semver 范围语法），例如 ">=0.2.0"
	Toolbox string `json:"toolbox,omitempty"`
	// PluginAPI 插件依赖的宿主插件 API 版本范围，例如 "^1.0.0"
	PluginAPI string `json:"pluginApi,omitempty"`
}

// BackendKind 归一化后的后端运行时类型。
type BackendKind string

const (
	// BackendNone 纯前端插件，无后端逻辑
	BackendNone BackendKind = "none"
	// BackendJS goja JavaScript 运行时
	BackendJS BackendKind = "js"
)

// RuntimeSpec 声明插件的运行时形态。
type RuntimeSpec struct {
	// Backend 后端运行时：js / none（缺省为 js）
	Backend string `json:"backend,omitempty"`
	// Entry 后端入口（相对插件版本目录），默认 backend/index.js
	Entry string `json:"entry,omitempty"`
	// Frontend 前端 UI 入口（相对插件版本目录），默认 frontend/index.js
	Frontend string `json:"frontend,omitempty"`
	// Exports 对外公开的后端 handler 名。
	//
	// 其它插件只有在「依赖本插件」且「本插件在 Exports 中声明了该 handler」
	// 时才能调用它。没有列出的 handler 一律视为插件内部实现。
	Exports []string `json:"exports,omitempty"`
}

// ToolContribution 插件贡献的一个工具（侧栏入口 + 内容区视图）。
type ToolContribution struct {
	// Type 工具类型标识，全局唯一；与内置工具同名表示接管该入口
	Type string `json:"type"`
	// Label 菜单与标签展示名
	Label string `json:"label"`
	// Icon 图标名；内置图标库没有的名字渲染为通用图标
	Icon string `json:"icon,omitempty"`
	// Multi 是否多例（可同时打开多个实例标签）
	Multi bool `json:"multi,omitempty"`
	// Description 单行说明
	Description string `json:"description,omitempty"`
	// Group 侧栏分组 id：可引用 contributes.sidebar.groups 里声明的 id
	Group string `json:"group,omitempty"`
	// Order 组内排序，小的在前
	Order int `json:"order,omitempty"`
	// Picker 是否出现在「新建标签」菜单；省略时跟随 Multi
	Picker *bool `json:"picker,omitempty"`
}

// SidebarContribution 插件对左侧菜单分组的定义。
type SidebarContribution struct {
	Groups []SidebarGroup `json:"groups,omitempty"`
}

// SidebarGroup 左侧菜单中的一个分组。
type SidebarGroup struct {
	// ID 分组标识，供 tool.group 引用
	ID string `json:"id"`
	// Label 分组展示名（省略时用 ID）
	Label string `json:"label,omitempty"`
	// Icon 分组图标名
	Icon string `json:"icon,omitempty"`
	// Order 分组排序，小的在前（内置分组占用 0-99）
	Order int `json:"order,omitempty"`
}

// CommandContribution 插件贡献的命令（可被快捷键或其它插件调用）。
type CommandContribution struct {
	// ID 命令标识，必须形如 "<插件id>.<命令名>"
	ID string `json:"id"`
	// Title 展示名
	Title string `json:"title"`
}

// SettingContribution 插件贡献的配置项（存于 plugin_settings 表）。
type SettingContribution struct {
	// Key 配置键（插件内唯一）
	Key string `json:"key"`
	// Type 值类型：string / number / boolean / select / json
	Type string `json:"type"`
	// Title 展示名
	Title string `json:"title"`
	// Default 默认值（字符串形式）
	Default string `json:"default,omitempty"`
	// Description 说明
	Description string `json:"description,omitempty"`
	// Options 可选项（Type 为 select 时使用）
	Options []SettingOption `json:"options,omitempty"`
	// Panel 所属设置面板 id；省略时归入以插件名命名的面板
	Panel string `json:"panel,omitempty"`
	// Order 面板内排序，小的在前
	Order int `json:"order,omitempty"`
}

// SettingOption 配置项的可选项。
type SettingOption struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// SettingsPanelContribution 插件声明的自定义设置面板。
type SettingsPanelContribution struct {
	// ID 面板标识，设置页页签用它区分
	ID string `json:"id"`
	// Title 页签标题
	Title string `json:"title"`
	// Icon 页签图标名
	Icon string `json:"icon,omitempty"`
	// Order 页签排序，小的在前（内置页签占用 0-99）
	Order int `json:"order,omitempty"`
}

// MCPToolContribution 插件通过 MCP 服务对外开放的工具声明。
type MCPToolContribution struct {
	// Name MCP 工具名，全局唯一
	Name string `json:"name"`
	// Description 供 LLM 理解用途
	Description string `json:"description,omitempty"`
	// InputSchema JSON Schema（原样透传给 MCP 客户端）
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	// Handler 后端 handler 名；为空时默认与 Name 相同
	Handler string `json:"handler,omitempty"`
}

// MCPContribution 插件的 MCP 贡献集合。
type MCPContribution struct {
	Tools []MCPToolContribution `json:"tools,omitempty"`
}

// Contributions 插件向宿主声明的一切扩展点。
type Contributions struct {
	// Sidebar 左侧菜单分组定义（可选，不写则按 tool.group 自动建组）
	Sidebar *SidebarContribution `json:"sidebar,omitempty"`
	// Tools 工具入口
	Tools []ToolContribution `json:"tools,omitempty"`
	// Commands 命令
	Commands []CommandContribution `json:"commands,omitempty"`
	// Settings 声明式配置项（宿主按 Type 自动渲染成表单）
	Settings []SettingContribution `json:"settings,omitempty"`
	// SettingsPanels 自定义设置面板（内容由插件渲染）
	SettingsPanels []SettingsPanelContribution `json:"settingsPanels,omitempty"`
	// MCP MCP 工具声明
	MCP *MCPContribution `json:"mcp,omitempty"`
}

// Manifest 插件清单。
type Manifest struct {
	// ManifestVersion 清单格式版本，必须等于 ManifestVersion 常量
	ManifestVersion int `json:"manifestVersion"`

	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Publisher   string   `json:"publisher"`
	Description string   `json:"description,omitempty"`
	Author      string   `json:"author,omitempty"`
	Homepage    string   `json:"homepage,omitempty"`
	License     string   `json:"license,omitempty"`
	Icon        string   `json:"icon,omitempty"`
	Keywords    []string `json:"keywords,omitempty"`

	// Engines 宿主与 API 版本要求
	Engines Engines `json:"engines,omitempty"`
	// Dependencies 依赖：插件标识 → semver 约束
	Dependencies map[string]string `json:"dependencies,omitempty"`
	// Permissions 申请的权限
	Permissions Permissions `json:"permissions,omitempty"`
	// Runtime 运行时形态
	Runtime RuntimeSpec `json:"runtime,omitempty"`
	// Contributes 扩展点
	Contributes Contributions `json:"contributes,omitempty"`

	// legacy 标记清单来自旧协议（缺少 manifestVersion），并非持久化字段。
	legacy bool
}

// Legacy 报告清单是否来自旧协议（仅内存标记，用于界面提示重新安装）。
func (m *Manifest) Legacy() bool { return m != nil && m.legacy }

// ParseManifest 解析并严格校验清单内容（新协议，要求 manifestVersion）。
func ParseManifest(raw []byte) (*Manifest, error) {
	m, err := decodeManifest(raw)
	if err != nil {
		return nil, err
	}
	if m.ManifestVersion == 0 {
		return nil, fmt.Errorf(
			"插件清单缺少 manifestVersion（应为 %d）：请升级插件或改用当前协议重新构建",
			ManifestVersion)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return m, nil
}

// ParseLegacyManifest 解析旧协议清单（无 manifestVersion、无 engines.pluginApi）。
//
// 只用于读取用户本地历史安装留下的清单，使升级到新协议之前它们仍可被识别；
// 任何新安装、升级、构建都必须走 ParseManifest 严格路径。
func ParseLegacyManifest(raw []byte) (*Manifest, error) {
	m, err := decodeManifest(raw)
	if err != nil {
		return nil, err
	}
	if m.ManifestVersion != 0 {
		return nil, fmt.Errorf("清单已包含 manifestVersion，不应按旧协议解析")
	}
	m.legacy = true
	if err := m.validateCore(); err != nil {
		return nil, err
	}
	if err := m.Permissions.Validate(); err != nil {
		return nil, err
	}
	return m, nil
}

// decodeManifest 反序列化清单，拒绝未知字段。
func decodeManifest(raw []byte) (*Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	// 拒绝未知字段：清单是信任输入，拼写错误必须暴露而不是静默忽略
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("解析插件清单失败: %w", err)
	}
	return &m, nil
}

// LoadManifest 从目录读取并校验 manifest.json（严格路径）。
func LoadManifest(dir string) (*Manifest, error) {
	m, _, err := loadManifestFile(filepath.Join(dir, ManifestFileName))
	return m, err
}

// LoadInstalledManifest 读取已安装插件版本目录中的清单。
//
// 先按新协议严格解析；只有「缺少 manifestVersion」这一种情况才回退到旧协议，
// 并在返回值上打 legacy 标记。这样升级过程不会静默丢掉用户已装插件，
// 也不会为了让老清单通过而放宽新协议。
func LoadInstalledManifest(dir string) (*Manifest, error) {
	m, raw, err := loadManifestFile(filepath.Join(dir, ManifestFileName))
	if err == nil {
		return m, nil
	}
	if !strings.Contains(err.Error(), "缺少 manifestVersion") {
		return nil, err
	}
	legacy, legacyErr := ParseLegacyManifest(raw)
	if legacyErr != nil {
		return nil, err
	}
	return legacy, nil
}

func loadManifestFile(path string) (*Manifest, []byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("读取插件清单失败(%s): %w", path, err)
	}
	m, err := ParseManifest(raw)
	if err != nil {
		return nil, raw, err
	}
	return m, nil, nil
}

// Validate 校验清单的全部字段。
func (m *Manifest) Validate() error {
	if m.ManifestVersion != ManifestVersion {
		return fmt.Errorf("不支持的清单格式版本: %d（当前支持 %d）", m.ManifestVersion, ManifestVersion)
	}
	if err := m.validateCore(); err != nil {
		return err
	}
	if err := m.validateEngines(); err != nil {
		return err
	}
	if err := m.Permissions.Validate(); err != nil {
		return err
	}
	if err := m.Runtime.Validate(m.ID); err != nil {
		return err
	}
	return m.Contributes.Validate(m.ID)
}

// validateCore 校验与协议版本无关的公共字段。
func (m *Manifest) validateCore() error {
	if m.ID == "" {
		return fmt.Errorf("插件清单缺少 id")
	}
	if len(m.ID) > maxIDLen {
		return fmt.Errorf("插件 id 过长（> %d）", maxIDLen)
	}
	if !idPattern.MatchString(m.ID) {
		return fmt.Errorf("插件 id 非法（需为反向域名风格，如 com.example.hello）: %q", m.ID)
	}
	if m.Name == "" {
		return fmt.Errorf("插件清单缺少 name")
	}
	if len([]rune(m.Name)) > maxNameLen {
		return fmt.Errorf("插件 name 过长（> %d 字符）", maxNameLen)
	}
	if len([]rune(m.Description)) > maxDescriptionLen {
		return fmt.Errorf("插件 description 过长（> %d 字符）", maxDescriptionLen)
	}
	if !semver.IsValid(m.Version) {
		return fmt.Errorf("插件版本号非法: %q", m.Version)
	}
	if m.Publisher == "" {
		return fmt.Errorf("插件清单缺少 publisher")
	}
	if !publisherPattern.MatchString(m.Publisher) {
		return fmt.Errorf("插件 publisher 非法（小写字母数字与连字符）: %q", m.Publisher)
	}
	return m.validateDependencies()
}

func (m *Manifest) validateEngines() error {
	if m.Engines.Toolbox == "" {
		return fmt.Errorf("插件清单缺少 engines.toolbox（宿主版本兼容范围）")
	}
	if _, err := semver.ParseConstraint(m.Engines.Toolbox); err != nil {
		return fmt.Errorf("engines.toolbox 约束非法: %w", err)
	}
	if m.Engines.PluginAPI == "" {
		return fmt.Errorf("插件清单缺少 engines.pluginApi（插件 API 兼容范围）")
	}
	if _, err := semver.ParseConstraint(m.Engines.PluginAPI); err != nil {
		return fmt.Errorf("engines.pluginApi 约束非法: %w", err)
	}
	return nil
}

func (m *Manifest) validateDependencies() error {
	if len(m.Dependencies) > maxDependencies {
		return fmt.Errorf("依赖数量过多（> %d）", maxDependencies)
	}
	for id, constraint := range m.Dependencies {
		if !idPattern.MatchString(id) {
			return fmt.Errorf("依赖 id 非法: %q", id)
		}
		if id == m.ID {
			return fmt.Errorf("插件不能依赖自身: %q", id)
		}
		if _, err := semver.ParseConstraint(constraint); err != nil {
			return fmt.Errorf("依赖 %s 的约束非法: %w", id, err)
		}
	}
	return nil
}

// Validate 校验运行时声明。
func (r *RuntimeSpec) Validate(pluginID string) error {
	kind, err := r.Kind()
	if err != nil {
		return err
	}
	if r.Entry != "" && kind == BackendNone {
		return fmt.Errorf("runtime.backend = none 时不允许声明 runtime.entry")
	}
	for _, p := range []string{r.Entry, r.Frontend} {
		if p == "" {
			continue
		}
		if err := validateRelPath(p); err != nil {
			return err
		}
	}
	if len(r.Exports) > maxExports {
		return fmt.Errorf("runtime.exports 数量过多（> %d）", maxExports)
	}
	if len(r.Exports) > 0 && kind != BackendJS {
		return fmt.Errorf("只有 runtime.backend = js 的插件才能声明 runtime.exports")
	}
	seen := make(map[string]struct{}, len(r.Exports))
	for _, name := range r.Exports {
		if !handlerNamePattern.MatchString(name) {
			return fmt.Errorf("runtime.exports 中的 handler 名非法: %q", name)
		}
		if _, dup := seen[name]; dup {
			return fmt.Errorf("runtime.exports 中 handler 名重复: %q", name)
		}
		seen[name] = struct{}{}
	}
	_ = pluginID
	return nil
}

// Kind 归一化后端运行时类型；未支持的类型返回错误。
func (r *RuntimeSpec) Kind() (BackendKind, error) {
	switch strings.ToLower(strings.TrimSpace(r.Backend)) {
	case "", "js", "javascript":
		return BackendJS, nil
	case "none":
		return BackendNone, nil
	default:
		return "", fmt.Errorf("runtime.backend 非法（仅支持 js / none）: %q", r.Backend)
	}
}

// BackendKind 归一化后端运行时类型（兼容旧调用点）。
func (m *Manifest) BackendKind() BackendKind {
	kind, err := m.Runtime.Kind()
	if err != nil {
		return BackendKind(strings.ToLower(strings.TrimSpace(m.Runtime.Backend)))
	}
	return kind
}

// BackendEntry 返回后端入口相对路径（未声明时给默认值）。
func (m *Manifest) BackendEntry() string {
	if m.Runtime.Entry != "" {
		return m.Runtime.Entry
	}
	if m.BackendKind() == BackendNone {
		return ""
	}
	return "backend/index.js"
}

// FrontendEntry 返回前端入口相对路径；没有前端界面时返回空串。
func (m *Manifest) FrontendEntry() string {
	if m.Runtime.Frontend != "" {
		return m.Runtime.Frontend
	}
	if !m.HasFrontend() {
		return ""
	}
	return "frontend/index.js"
}

// HasFrontend 报告插件是否声明了前端界面。
//
// 只有贡献了工具、设置面板或显式声明 runtime.frontend 的插件
// 才需要前端产物；纯后端插件（例如只提供服务的插件）不需要。
func (m *Manifest) HasFrontend() bool {
	return m.Runtime.Frontend != "" ||
		len(m.Contributes.Tools) > 0 ||
		len(m.Contributes.SettingsPanels) > 0
}

// ExportsHandler 报告某个 handler 是否被插件公开给其它插件。
func (m *Manifest) ExportsHandler(handler string) bool {
	for _, name := range m.Runtime.Exports {
		if name == handler {
			return true
		}
	}
	return false
}

// SortedDependencies 返回按插件 id 排序的依赖清单，便于生成稳定输出。
func (m *Manifest) SortedDependencies() []DependencyRef {
	refs := make([]DependencyRef, 0, len(m.Dependencies))
	for id, constraint := range m.Dependencies {
		refs = append(refs, DependencyRef{ID: id, Constraint: constraint})
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
	return refs
}

// DependencyRef 一条依赖声明。
type DependencyRef struct {
	// ID 被依赖插件标识
	ID string `json:"id"`
	// Constraint semver 约束原文
	Constraint string `json:"constraint"`
}

// Validate 校验扩展点声明。
func (c *Contributions) Validate(pluginID string) error {
	total := len(c.Tools) + len(c.Commands) + len(c.Settings) + len(c.SettingsPanels)
	if c.Sidebar != nil {
		total += len(c.Sidebar.Groups)
	}
	if c.MCP != nil {
		total += len(c.MCP.Tools)
	}
	if total > maxContributions {
		return fmt.Errorf("扩展点数量过多（> %d）", maxContributions)
	}

	seenTool := make(map[string]struct{}, len(c.Tools))
	for _, t := range c.Tools {
		if !toolTypePattern.MatchString(t.Type) {
			return fmt.Errorf("工具类型非法（小写字母数字与连字符）: %q", t.Type)
		}
		if _, dup := seenTool[t.Type]; dup {
			return fmt.Errorf("工具类型重复: %q", t.Type)
		}
		seenTool[t.Type] = struct{}{}
		if t.Label == "" {
			return fmt.Errorf("工具 %s 缺少 label", t.Type)
		}
	}

	seenCmd := make(map[string]struct{}, len(c.Commands))
	for _, cmd := range c.Commands {
		if cmd.ID == "" {
			return fmt.Errorf("命令缺少 id")
		}
		// 命令 id 必须带插件前缀，避免不同插件靠加载顺序抢占同一命令
		if !strings.HasPrefix(cmd.ID, pluginID+".") || len(cmd.ID) <= len(pluginID)+1 {
			return fmt.Errorf("命令 id 必须以插件 id 为前缀（形如 %s.命令名）: %q", pluginID, cmd.ID)
		}
		if _, dup := seenCmd[cmd.ID]; dup {
			return fmt.Errorf("命令 id 重复: %q", cmd.ID)
		}
		seenCmd[cmd.ID] = struct{}{}
	}

	if c.Sidebar != nil {
		seenGroup := make(map[string]struct{}, len(c.Sidebar.Groups))
		for _, g := range c.Sidebar.Groups {
			if g.ID == "" {
				return fmt.Errorf("侧栏分组缺少 id")
			}
			if _, dup := seenGroup[g.ID]; dup {
				return fmt.Errorf("侧栏分组 id 重复: %q", g.ID)
			}
			seenGroup[g.ID] = struct{}{}
		}
	}

	seenPanel := make(map[string]struct{}, len(c.SettingsPanels))
	for _, p := range c.SettingsPanels {
		if p.ID == "" {
			return fmt.Errorf("设置面板缺少 id")
		}
		if _, dup := seenPanel[p.ID]; dup {
			return fmt.Errorf("设置面板 id 重复: %q", p.ID)
		}
		seenPanel[p.ID] = struct{}{}
	}

	seenSetting := make(map[string]struct{}, len(c.Settings))
	for _, s := range c.Settings {
		if s.Key == "" {
			return fmt.Errorf("配置项缺少 key")
		}
		if _, dup := seenSetting[s.Key]; dup {
			return fmt.Errorf("配置项 key 重复: %q", s.Key)
		}
		seenSetting[s.Key] = struct{}{}
		switch s.Type {
		case "string", "number", "boolean", "select", "json":
		default:
			return fmt.Errorf("配置项 %s 的类型非法: %q", s.Key, s.Type)
		}
		if s.Type == "select" && len(s.Options) == 0 {
			return fmt.Errorf("配置项 %s 是 select 类型，必须提供 options", s.Key)
		}
		if s.Title == "" {
			return fmt.Errorf("配置项 %s 缺少 title", s.Key)
		}
	}

	if c.MCP != nil {
		seenMCP := make(map[string]struct{}, len(c.MCP.Tools))
		for _, t := range c.MCP.Tools {
			if t.Name == "" {
				return fmt.Errorf("MCP 工具缺少 name")
			}
			if _, dup := seenMCP[t.Name]; dup {
				return fmt.Errorf("MCP 工具名重复: %q", t.Name)
			}
			seenMCP[t.Name] = struct{}{}
			if len(t.InputSchema) > 0 && !json.Valid(t.InputSchema) {
				return fmt.Errorf("MCP 工具 %s 的 inputSchema 不是合法 JSON", t.Name)
			}
		}
	}
	return nil
}

// validateRelPath 校验清单里声明的相对路径，防止路径穿越。
func validateRelPath(p string) error {
	if p == "" {
		return nil
	}
	slashed := filepath.ToSlash(p)
	if filepath.IsAbs(p) || strings.HasPrefix(slashed, "/") {
		return fmt.Errorf("插件内路径不允许为绝对路径: %q", p)
	}
	if strings.HasPrefix(slashed, "./") {
		return fmt.Errorf("插件内路径不允许以 ./ 开头: %q", p)
	}
	cleaned := filepath.ToSlash(filepath.Clean(slashed))
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return fmt.Errorf("插件内路径不允许越出插件目录: %q", p)
	}
	return nil
}

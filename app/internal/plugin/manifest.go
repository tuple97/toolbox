// Package plugin 实现工具箱的插件体系。
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

// 防止恶意清单造成资源耗尽。
const (
	maxIDLen          = 128
	maxNameLen        = 64
	maxDescriptionLen = 512
	maxContributions  = 64
	maxDependencies   = 64
)

// idPattern 插件标识：反向域名风格，至少两段，全小写。
var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`)

// toolTypePattern 工具类型：小写字母数字与连字符。
var toolTypePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// publisherPattern 发布者标识。
var publisherPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// Engines 声明插件对宿主环境的版本要求。
type Engines struct {
	// Toolbox 宿主应用版本约束（semver 范围语法），例如 ">=0.2.0"
	Toolbox string `json:"toolbox,omitempty"`
}

// RuntimeSpec 声明插件的运行时形态。
type RuntimeSpec struct {
	// Backend 后端运行时：js / wasm / none（缺省为 js）
	Backend string `json:"backend,omitempty"`
	// Entry 后端入口（相对插件版本目录），默认 backend/index.js
	Entry string `json:"entry,omitempty"`
	// Frontend 前端 UI 入口（相对插件版本目录），默认 frontend/index.js
	Frontend string `json:"frontend,omitempty"`
}

// BackendKind 归一化后的后端运行时类型。
type BackendKind string

const (
	// BackendNone 纯前端插件，无后端逻辑
	BackendNone BackendKind = "none"
	// BackendJS goja JavaScript 运行时
	BackendJS BackendKind = "js"
	// BackendWASM wazero WebAssembly 运行时（预留，尚未落地）
	BackendWASM BackendKind = "wasm"
)

// ToolContribution 插件贡献的一个工具（侧栏入口 + 内容区视图）。
type ToolContribution struct {
	// Type 工具类型标识，全局唯一，不得与内置工具重名
	Type string `json:"type"`
	// Label 菜单与标签展示名
	Label string `json:"label"`
	// Icon 图标名；内置图标库没有的名字渲染为通用图标
	Icon string `json:"icon,omitempty"`
	// Multi 是否多例（可同时打开多个实例标签）
	Multi bool `json:"multi,omitempty"`
	// Description 单行说明
	Description string `json:"description,omitempty"`
	// Group 侧栏分组 id：可引用 contributes.sidebar.groups 里声明的 id，
	// 也可直接写分组名（未在 sidebar 中声明时按该名字新建分组）
	Group string `json:"group,omitempty"`
	// Order 组内排序，小的在前
	Order int `json:"order,omitempty"`
	// Picker 是否出现在「新建标签」菜单；省略时跟随 Multi
	Picker *bool `json:"picker,omitempty"`
}

// SidebarContribution 插件对左侧菜单分组的定义。
//
// 不声明时宿主会按工具的 group 字段自动建组；声明后可以额外指定
// 分组图标与排序，从而把插件自己的菜单放到想要的位置。
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
	// ID 命令标识，形如 "插件id.命令名"
	ID string `json:"id"`
	// Title 展示名
	Title string `json:"title"`
}

// SettingContribution 插件贡献的配置项（存于 plugin_settings 表）。
//
// 宿主会按 Type 自动渲染成表单项，因此简单配置不需要插件写任何界面代码。
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
//
// 声明后宿主在设置页为它建一个页签，内容由插件的
// api.registerSettingsPanel 渲染；只声明不注册时会提示面板未实现。
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

	// Engines 宿主版本要求
	Engines Engines `json:"engines,omitempty"`
	// Dependencies 依赖：插件标识 → semver 约束
	Dependencies map[string]string `json:"dependencies,omitempty"`
	// Permissions 申请的权限
	Permissions Permissions `json:"permissions,omitempty"`
	// Runtime 运行时形态
	Runtime RuntimeSpec `json:"runtime,omitempty"`
	// Contributes 扩展点
	Contributes Contributions `json:"contributes,omitempty"`
}

// LoadManifest 从目录读取 manifest.json 并校验。
func LoadManifest(dir string) (*Manifest, error) {
	path := filepath.Join(dir, ManifestFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取插件清单失败(%s): %w", path, err)
	}
	return ParseManifest(raw)
}

// ParseManifest 解析并校验清单内容。
func ParseManifest(raw []byte) (*Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	// 拒绝未知字段：清单是信任输入，拼写错误必须暴露而不是静默忽略
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("解析插件清单失败: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate 校验清单的全部字段。
func (m *Manifest) Validate() error {
	if err := m.validateIdentity(); err != nil {
		return err
	}
	if err := m.validateEngines(); err != nil {
		return err
	}
	if err := m.validateDependencies(); err != nil {
		return err
	}
	if err := m.Permissions.Validate(); err != nil {
		return err
	}
	if err := m.validateRuntime(); err != nil {
		return err
	}
	return m.Contributes.Validate()
}

func (m *Manifest) validateIdentity() error {
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
	return nil
}

func (m *Manifest) validateEngines() error {
	if m.Engines.Toolbox == "" {
		return nil
	}
	if _, err := semver.ParseConstraint(m.Engines.Toolbox); err != nil {
		return fmt.Errorf("engines.toolbox 约束非法: %w", err)
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

func (m *Manifest) validateRuntime() error {
	backend := m.BackendKind()
	switch backend {
	case BackendNone, BackendJS, BackendWASM:
	default:
		return fmt.Errorf("runtime.backend 非法: %q", m.Runtime.Backend)
	}
	for _, p := range []string{m.Runtime.Entry, m.Runtime.Frontend} {
		if p == "" {
			continue
		}
		if err := validateRelPath(p); err != nil {
			return err
		}
	}
	return nil
}

// Validate 校验扩展点声明。
func (c *Contributions) Validate() error {
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
		case "", "string", "number", "boolean", "select", "json":
		default:
			return fmt.Errorf("配置项 %s 的类型非法: %q", s.Key, s.Type)
		}
		if s.Type == "select" && len(s.Options) == 0 {
			return fmt.Errorf("配置项 %s 是 select 类型，必须提供 options", s.Key)
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

// BackendKind 归一化后端运行时类型。
func (m *Manifest) BackendKind() BackendKind {
	switch strings.ToLower(strings.TrimSpace(m.Runtime.Backend)) {
	case "", "js", "javascript":
		return BackendJS
	case "none":
		return BackendNone
	case "wasm", "webassembly":
		return BackendWASM
	default:
		return BackendKind(m.Runtime.Backend)
	}
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

// FrontendEntry 返回前端入口相对路径（未声明时给默认值）。
func (m *Manifest) FrontendEntry() string {
	if m.Runtime.Frontend != "" {
		return m.Runtime.Frontend
	}
	return "frontend/index.js"
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

// validateRelPath 校验清单里声明的相对路径，防止路径穿越。
func validateRelPath(p string) error {
	if p == "" {
		return nil
	}
	if filepath.IsAbs(p) {
		return fmt.Errorf("插件内路径不允许为绝对路径: %q", p)
	}
	cleaned := filepath.ToSlash(filepath.Clean(p))
	if strings.HasPrefix(cleaned, "../") || cleaned == ".." || strings.Contains(cleaned, "/../") {
		return fmt.Errorf("插件内路径不允许越出插件目录: %q", p)
	}
	return nil
}

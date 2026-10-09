package plugin

import "toolbox/app/internal/semver"

// PluginSummary 已启用插件的概览（供插件间互相发现）。
type PluginSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

// InstalledInfo 已安装插件的完整信息（插件管理页使用）。
type InstalledInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description"`
	Author      string `json:"author"`
	Homepage    string `json:"homepage"`
	License     string `json:"license"`
	Icon        string `json:"icon"`

	// Enabled 是否启用
	Enabled bool `json:"enabled"`
	// Trusted 是否已获得用户信任
	Trusted bool `json:"trusted"`
	// Official 是否来自官方索引的官方审核条目
	Official bool `json:"official"`
	// Source 安装来源类型
	Source string `json:"source"`
	// SourceRef 安装来源引用
	SourceRef string `json:"sourceRef"`

	// Loaded 后端运行时是否已成功加载
	Loaded bool `json:"loaded"`
	// LoadError 加载失败原因
	LoadError string `json:"loadError"`
	// Handlers 已注册的后端处理方法
	Handlers []string `json:"handlers"`

	// Compatible 是否与当前宿主版本兼容
	Compatible bool `json:"compatible"`
	// IncompatReason 不兼容原因
	IncompatReason string `json:"incompatReason"`

	// InUseBy 依赖本插件的其它插件
	InUseBy []string `json:"inUseBy"`

	// Permissions 权限的中文描述
	Permissions []string `json:"permissions"`
	// Dependencies 依赖声明
	Dependencies []DependencyRef `json:"dependencies"`
	// MissingDependencies 未满足的依赖（非空表示装了但缺依赖，界面标红）
	MissingDependencies []MissingDependency `json:"missingDependencies"`

	// 扩展点
	SidebarGroups  []SidebarGroup              `json:"sidebarGroups"`
	Tools          []ToolContribution          `json:"tools"`
	Commands       []CommandContribution       `json:"commands"`
	Settings       []SettingContribution       `json:"settings"`
	SettingsPanels []SettingsPanelContribution `json:"settingsPanels"`
	MCPTools       []MCPToolContribution       `json:"mcpTools"`
	Engines        Engines                     `json:"engines"`
	Runtime        RuntimeSpec                 `json:"runtime"`
	Installed      string                      `json:"installedAt"`
	Updated        string                      `json:"updatedAt"`
	// PreviousVersion 可回滚到的上一个版本（无则为空）
	PreviousVersion string `json:"previousVersion"`
}

// InstallRequest 安装请求。
type InstallRequest struct {
	// Source 来源：registry / url / file / local
	Source string `json:"source"`
	// ID registry 来源时必填
	ID string `json:"id,omitempty"`
	// Version registry 来源时可选，缺省取满足约束的最高版本
	Version string `json:"version,omitempty"`
	// Ref url / file / local 来源时的地址或路径
	Ref string `json:"ref,omitempty"`
	// Trust 用户是否已确认信任该来源
	Trust bool `json:"trust"`
	// AcceptPermissions 升级时是否接受新增权限
	AcceptPermissions bool `json:"acceptPermissions"`
}

// InstallPlanItem 依赖求解后单个插件的动作。
type InstallPlanItem struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	// Action install / upgrade / keep
	Action string `json:"action"`
	// Scanned 依赖由安装时扫描同级目录得到（用户并未显式选中），会就地安装
	Scanned bool `json:"scanned"`
}

// InstallPreview 安装前的预览信息（权限确认弹窗的数据源）。
type InstallPreview struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Homepage    string `json:"homepage"`
	License     string `json:"license"`

	// Source 来源类型
	Source string `json:"source"`
	// SourceRef 来源引用
	SourceRef string `json:"sourceRef"`
	// Official 是否官方可信（可直接安装，无需二次确认）
	Official bool `json:"official"`
	// Trusted 该来源/发布者是否已被本地信任
	Trusted bool `json:"trusted"`
	// NeedTrust 是否需要用户点击「信任并安装」
	NeedTrust bool `json:"needTrust"`
	// Checksum 安装包摘要
	Checksum string `json:"checksum"`
	// Signed 是否带有可验证的发布者签名
	Signed bool `json:"signed"`

	// Upgrade 是否为升级既有插件
	Upgrade bool `json:"upgrade"`
	// CurrentVersion 当前已安装版本（升级时非空）
	CurrentVersion string `json:"currentVersion"`
	// Permissions 权限中文描述
	Permissions []string `json:"permissions"`
	// AddedPermissions 本次升级新增的权限（需要用户重新确认）
	AddedPermissions []string `json:"addedPermissions"`
	// Dependencies 依赖声明
	Dependencies []DependencyRef `json:"dependencies"`
	// Plan 依赖闭包安装计划
	Plan []InstallPlanItem `json:"plan"`
	// MissingDependencies 无法满足的依赖：不阻断安装，由界面标红提示
	MissingDependencies []MissingDependency `json:"missingDependencies"`
	// Warnings 风险提示
	Warnings []string `json:"warnings"`
}

// MissingDependency 一条无法满足的依赖。
type MissingDependency struct {
	ID         string `json:"id"`
	Constraint string `json:"constraint"`
	// Reason 未满足的原因（未安装 / 已装版本不符）
	Reason string `json:"reason"`
}

// UpdateInfo 单个插件的可用更新。
type UpdateInfo struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	CurrentVersion   string   `json:"currentVersion"`
	LatestVersion    string   `json:"latestVersion"`
	Official         bool     `json:"official"`
	AddedPermissions []string `json:"addedPermissions"`
	// CanAutoUpgrade 权限未扩张时可静默升级
	CanAutoUpgrade bool `json:"canAutoUpgrade"`
}

// RegistryEntry 官方索引中的一条插件记录。
type RegistryEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Homepage    string `json:"homepage,omitempty"`
	License     string `json:"license,omitempty"`
	Author      string `json:"author,omitempty"`

	// Repo 源码仓库地址
	Repo string `json:"repo,omitempty"`
	// Download 安装包下载地址
	Download string `json:"download"`
	// Checksum 安装包摘要，形如 sha256:xxxx
	Checksum string `json:"checksum"`
	// Signature 发布者对安装包摘要的 Ed25519 签名（base64）
	Signature string `json:"signature,omitempty"`
	// Official 是否官方审核通过
	Official bool `json:"official,omitempty"`

	Engines      Engines           `json:"engines,omitempty"`
	Dependencies map[string]string `json:"dependencies,omitempty"`
	Permissions  Permissions       `json:"permissions,omitempty"`
	Runtime      RuntimeSpec       `json:"runtime,omitempty"`
	Contributes  Contributions     `json:"contributes,omitempty"`
}

// Manifest 把索引条目转换为清单对象。
//
// 校验在解析索引时统一做一次；转换出的清单仅用于依赖求解与展示。
func (e RegistryEntry) Manifest() *Manifest {
	return &Manifest{
		ID:           e.ID,
		Name:         e.Name,
		Version:      e.Version,
		Publisher:    e.Publisher,
		Description:  e.Description,
		Icon:         e.Icon,
		Homepage:     e.Homepage,
		License:      e.License,
		Author:       e.Author,
		Engines:      e.Engines,
		Dependencies: e.Dependencies,
		Permissions:  e.Permissions,
		Runtime:      e.Runtime,
		Contributes:  e.Contributes,
	}
}

// RegistryIndex 官方索引文件结构。
type RegistryIndex struct {
	// SchemaVersion 索引格式版本
	SchemaVersion int `json:"schemaVersion"`
	// UpdatedAt 索引更新时间（RFC3339）
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Plugins 插件条目
	Plugins []RegistryEntry `json:"plugins"`
}

// Find 在索引中查找指定插件与版本；version 为空时返回该插件最高版本。
func (idx *RegistryIndex) Find(id, version string) *RegistryEntry {
	if idx == nil {
		return nil
	}
	var best *RegistryEntry
	var bestVersion semver.Version
	for i := range idx.Plugins {
		entry := &idx.Plugins[i]
		if entry.ID != id {
			continue
		}
		if version != "" {
			if entry.Version == version {
				return entry
			}
			continue
		}
		v, err := semver.Parse(entry.Version)
		if err != nil {
			continue
		}
		if best == nil || v.Compare(bestVersion) > 0 {
			best = entry
			bestVersion = v
		}
	}
	return best
}

// MarketplaceItem 插件市场列表项（已安装状态与本地对比后的结果）。
type MarketplaceItem struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Homepage    string `json:"homepage"`
	Official    bool   `json:"official"`

	Installed        bool     `json:"installed"`
	InstalledVersion string   `json:"installedVersion"`
	Enabled          bool     `json:"enabled"`
	Updatable        bool     `json:"updatable"`
	Permissions      []string `json:"permissions"`
	Dependencies     []string `json:"dependencies"`
}

// MarketplaceSnapshot 插件市场快照。
type MarketplaceSnapshot struct {
	// State idle / loading / ready / error
	State string `json:"state"`
	// Source 索引地址
	Source string `json:"source"`
	// UpdatedAt 索引自带更新时间
	UpdatedAt string `json:"updatedAt"`
	// Verified 索引签名是否校验通过
	Verified bool `json:"verified"`
	// Error 加载失败原因
	Error string `json:"error"`
	// Items 条目列表
	Items []MarketplaceItem `json:"items"`
}

// RegistryProvider 官方索引与安装包的来源配置。
type RegistryProvider struct {
	// IndexURL registry.json 地址
	IndexURL string
	// SignatureURL 分离式签名地址（留空表示签名内联在索引的同级 .sig）
	SignatureURL string
}

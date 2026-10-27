package plugin

// PluginSummary 已启用插件的概览（供插件间互相发现）。
type PluginSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

// InstalledInfo 已安装插件的完整信息（插件管理页使用）。
//
// 注意 enabled 与 active 的区别：
//   - Enabled 表示「用户希望启用」；
//   - Active 表示「依据完整依赖闭包与兼容性计算后，确实在运行」。
//
// 界面不应把 enabled 直接当成运行状态。
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

	// Enabled 用户是否希望启用
	Enabled bool `json:"enabled"`
	// Active 是否实际已激活（依赖满足 + 兼容 + 已加载）
	Active bool `json:"active"`
	// Trusted 是否已获得用户或官方索引的信任
	Trusted bool `json:"trusted"`
	// TrustLevel 信任等级：none / user / official
	TrustLevel string `json:"trustLevel"`
	// TrustReason 信任判定依据
	TrustReason string `json:"trustReason"`
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
	// Exports 对外公开的后端处理方法
	Exports []string `json:"exports"`

	// Compatible 是否与当前宿主版本及插件 API 版本兼容
	Compatible bool `json:"compatible"`
	// IncompatReason 不兼容原因
	IncompatReason string `json:"incompatReason"`
	// BlockedReason 有效状态被阻塞的原因（依赖缺失/被停用/循环依赖等）
	BlockedReason string `json:"blockedReason"`

	// InUseBy 依赖本插件的其它插件
	InUseBy []string `json:"inUseBy"`

	// Permissions 权限的中文描述
	Permissions []string `json:"permissions"`
	// Dependencies 依赖声明
	Dependencies []DependencyRef `json:"dependencies"`
	// MissingDependencies 未满足的依赖
	MissingDependencies []MissingDependency `json:"missingDependencies"`

	// ManifestOutdated 清单来自旧协议，需要重新安装才能升级到当前协议
	ManifestOutdated bool `json:"manifestOutdated"`

	// 扩展点
	SidebarGroups  []SidebarGroup              `json:"sidebarGroups"`
	Tools          []ToolContribution          `json:"tools"`
	Commands       []CommandContribution       `json:"commands"`
	Settings       []SettingContribution       `json:"settings"`
	SettingsPanels []SettingsPanelContribution `json:"settingsPanels"`
	MCPTools       []MCPToolContribution       `json:"mcpTools"`
	Engines        Engines                     `json:"engines"`
	Runtime        RuntimeSpec                 `json:"runtime"`

	Installed       string `json:"installedAt"`
	Updated         string `json:"updatedAt"`
	PreviousVersion string `json:"previousVersion"`
}

// MissingDependency 一条无法满足的依赖。
type MissingDependency struct {
	ID         string `json:"id"`
	Constraint string `json:"constraint"`
	// Reason 未满足的原因
	Reason string `json:"reason"`
}

// PackageInput 一次安装请求中的一个包输入。
type PackageInput struct {
	// Source 来源：registry / url / file / local / archive
	Source string `json:"source"`
	// SourceURL registry 来源时指定的插件源地址；留空表示跨全部已启用来源
	// 自动挑选提供该插件（且版本最高）的那个来源。
	SourceURL string `json:"sourceUrl"`
	// ID registry 来源时必填
	ID string `json:"id"`
	// Version registry 来源时可选，缺省取满足约束的最高版本
	Version string `json:"version"`
	// Ref url / file / local 来源时的地址或路径；archive 来源时可作为展示名
	Ref string `json:"ref"`
	// Content archive 来源的安装包原始内容
	Content []byte `json:"-"`
}

// PackagePreview 单个待安装包的展示信息。
type PackagePreview struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Homepage    string `json:"homepage"`
	License     string `json:"license"`

	Source    string `json:"source"`
	SourceRef string `json:"sourceRef"`
	Official  bool   `json:"official"`
	Checksum  string `json:"checksum"`

	// Upgrade 是否为升级既有插件
	Upgrade bool `json:"upgrade"`
	// CurrentVersion 当前已安装版本（升级时非空）
	CurrentVersion string `json:"currentVersion"`

	Permissions      []string        `json:"permissions"`
	AddedPermissions []string        `json:"addedPermissions"`
	Dependencies     []DependencyRef `json:"dependencies"`
}

// PlanItem 安装计划中的一条动作。
type PlanItem struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	// Action install / upgrade / reinstall / keep
	Action string `json:"action"`
	// Source 包的来源类型：registry / url / file / local / batch
	Source string `json:"source"`
	// SourceRef 来源引用（下载地址 / 本地路径 / 包文件名）
	SourceRef string `json:"sourceRef"`
	// Checksum 安装包摘要
	Checksum string `json:"checksum"`
	// Official 是否可信的官方条目（= 索引声明 official 且该来源验签通过）
	Official bool `json:"official"`
	// SourceVerified 该条目所在来源的索引是否验签通过
	SourceVerified bool `json:"sourceVerified"`
	// Root 是否为用户显式选择的包
	Root bool `json:"root"`
	// NeedTrust 是否需要用户确认信任
	NeedTrust bool `json:"needTrust"`
	// TrustReason 信任判定依据
	TrustReason string `json:"trustReason"`
	// AddedPermissions 本次相对已安装版本新增的权限
	AddedPermissions []string `json:"addedPermissions"`
	// Cached 本地已有可复用的包内容
	Cached bool `json:"cached"`
}

// InstallPreview 安装预览：完整依赖计划 + 需要用户确认的事项。
//
// 预览与安装共用同一个计划（PlanID），安装时不会重新求解。
type InstallPreview struct {
	// PlanID 安装计划标识；调用 InstallPlan 时回传它
	PlanID string `json:"planId"`
	// ExpiresAt 计划过期时间（RFC3339）
	ExpiresAt string `json:"expiresAt"`
	// Packages 用户显式选择的包
	Packages []PackagePreview `json:"packages"`
	// Plan 完整依赖闭包（含已满足的 keep 项）
	Plan []PlanItem `json:"plan"`
	// Warnings 风险提示
	Warnings []string `json:"warnings"`
	// NeedTrust 是否存在需要用户确认信任的来源
	NeedTrust bool `json:"needTrust"`
	// TrustReason 为什么需要确认信任
	TrustReason string `json:"trustReason"`
	// AddedPermissions 需要用户确认的新增权限
	AddedPermissions []string `json:"addedPermissions"`
	// PendingDownloads 需要联网下载的安装包数量
	PendingDownloads int `json:"pendingDownloads"`
}

// PackageInputWire 前端传来的安装输入（离线包内容用 base64 承载）。
type PackageInputWire struct {
	// Source 来源：registry / url / file / local / archive
	Source string `json:"source"`
	// SourceURL registry 来源时指定的插件源地址；留空表示自动跨源挑选
	SourceURL string `json:"sourceUrl"`
	// ID registry 来源时的插件标识
	ID string `json:"id"`
	// Version registry 来源时可选，缺省取满足约束的最高版本
	Version string `json:"version"`
	// Ref url / file / local 来源的地址或路径；archive 来源的展示名
	Ref string `json:"ref"`
	// FileName 离线包文件名（仅用于展示）
	FileName string `json:"fileName"`
	// ContentBase64 离线包内容的 base64 编码
	ContentBase64 string `json:"contentBase64"`
}

// UpdateInfo 单个插件的可用更新。
type UpdateInfo struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	// Official 是否可信的官方条目（= 索引声明 official 且来源验签通过）
	Official bool `json:"official"`
	// SourceURL / SourceName 提供该最新版本的插件源
	SourceURL  string `json:"sourceUrl"`
	SourceName string `json:"sourceName"`
	// SourceVerified 提供该版本的来源是否验签通过
	SourceVerified   bool     `json:"sourceVerified"`
	AddedPermissions []string `json:"addedPermissions"`
	// CanAutoUpgrade 权限未扩张且来源已信任时可静默升级
	CanAutoUpgrade bool `json:"canAutoUpgrade"`
}

// MarketplaceItem 插件市场列表项（已安装状态与本地对比后的结果）。
//
// 同一个插件在多个来源都存在时会各占一条 —— 这样界面能并排看到
// 「官方源 v1.2.0」与「第三方源 v1.3.0」的差异。
type MarketplaceItem struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Homepage    string `json:"homepage"`
	// Official 是否可信的官方条目（= 索引声明 official 且来源验签通过）
	Official bool `json:"official"`
	// SourceURL / SourceName 该条目来自哪个插件源
	SourceURL  string `json:"sourceUrl"`
	SourceName string `json:"sourceName"`
	// SourceVerified 该条目所在来源是否验签通过
	SourceVerified bool `json:"sourceVerified"`

	Installed        bool     `json:"installed"`
	InstalledVersion string   `json:"installedVersion"`
	Enabled          bool     `json:"enabled"`
	Active           bool     `json:"active"`
	Updatable        bool     `json:"updatable"`
	Permissions      []string `json:"permissions"`
	Dependencies     []string `json:"dependencies"`
}

// MarketplaceSource 单个插件源在本轮快照中的状态。
type MarketplaceSource struct {
	URL  string `json:"url"`
	Name string `json:"name"`
	// Enabled 是否参与合并展示
	Enabled bool `json:"enabled"`
	// Official 是否为宿主内置的官方源（只有它会被强制要求验签）
	Official bool `json:"official"`
	// State ready / error / disabled
	State string `json:"state"`
	// Verified 索引签名是否校验通过
	Verified bool `json:"verified"`
	// UpdatedAt 索引自带更新时间
	UpdatedAt string `json:"updatedAt"`
	// Count 该来源提供的插件条目数
	Count int `json:"count"`
	// Error 读取失败原因
	Error string `json:"error"`
}

// MarketplaceSnapshot 插件市场快照。
type MarketplaceSnapshot struct {
	// State idle / ready / error
	//
	// ready 表示至少有一个来源读到了索引；error 表示所有已启用来源都失败；
	// idle 表示没有任何已启用的来源。
	State string `json:"state"`
	// Sources 各插件源的状态（含被禁用的，便于界面管理）
	Sources []MarketplaceSource `json:"sources"`
	// SignatureEnabled 宿主是否配置了索引签名公钥
	SignatureEnabled bool `json:"signatureEnabled"`
	// Error 汇总的加载失败原因
	Error string `json:"error"`
	// Items 合并后的条目列表（按来源区分，不去重）
	Items []MarketplaceItem `json:"items"`
}

// RegistrySource 一个插件源（索引地址）。
type RegistrySource struct {
	// URL 索引地址（registry.json 的完整地址）
	URL string `json:"url"`
	// Name 展示名；留空时界面回落到地址
	Name string `json:"name,omitempty"`
	// Enabled 是否参与合并展示
	Enabled bool `json:"enabled"`
}

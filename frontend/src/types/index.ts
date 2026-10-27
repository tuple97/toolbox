/** 信息卡片中的单条数据 */
export interface InfoItem {
  label: string
  value: string
}

/** 自定义右键菜单的菜单项定义 */
export interface ContextMenuAction {
  /** 唯一标识 */
  key: string
  /** 显示文案 */
  label: string
  /** 快捷键提示，仅用于展示 */
  shortcut?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 是否为危险操作 */
  danger?: boolean
  /** 该项之后插入分割线 */
  divided?: boolean
  /** 子菜单项：有值时该项变为父项 */
  children?: ContextMenuAction[]
}

/**
 * 工具类型标识。
 *
 * 内置工具（plugins / settings / connections / sql-template / db-query /
 * command-executor / dictionary / placeholder）是固定枚举；
 * 插件贡献的工具是运行时才知道的任意标识，因此这里放宽为 string。
 * 后端的 database.Tab.ToolType 同样是 string。
 */
export type ToolType = string

/** 内置工具类型（仅用于代码内做穷尽判断时的参考） */
export type BuiltinToolType =
  | 'placeholder'
  | 'db-query'
  | 'command-executor'
  | 'connections'
  | 'sql-template'
  | 'dictionary'
  | 'settings'
  | 'plugins'

/** 工作台 Tab，与后端 database.Tab 对应 */
export interface WorkbenchTab {
  /** 会话内稳定标识，不落库；渲染 key 与按标签的缓存一律用它，id 只负责持久化 */
  uid: string
  id: number
  name: string
  sortOrder: number
  isActive: boolean
  isLocked: boolean
  /** 工具标识；'placeholder' 表示尚未绑定工具 */
  toolType: string
  /** 各工具私有状态的 JSON 字符串 */
  payload: string
  schemaVersion: number
}

/** 数据库连接配置，与后端 database.DBConnection 对应 */
export interface DBConnection {
  id: number
  name: string
  dbType: string
  host: string
  port: number
  database: string
  username: string
  password: string
  extra: string
  /** 备注 */
  note: string
  /** 颜色标记，空表示不标记 */
  color: string
  /** MySQL 字符集，空表示 utf8mb4 */
  charset: string
  /** PostgreSQL 默认 schema（MySQL 留空） */
  defaultSchema: string
  /** 建立连接超时（秒），0 表示默认 10 */
  connectTimeoutSecs: number
  /** 单条语句超时（秒），0 表示默认 60 */
  queryTimeoutSecs: number
  /** 空闲连接回收时间（秒），0 表示默认 30 */
  keepaliveSecs: number
  /** SSL 模式：disable / prefer / require / verify-ca / verify-full */
  sslMode: string
  /** CA 证书路径 */
  sslCaPath: string
  /** 客户端证书路径 */
  sslCertPath: string
  /** 客户端私钥路径 */
  sslKeyPath: string
  /** 追加到连接串的自定义参数：key=value&key2=value2 */
  urlParams: string
  /** 只读连接：后端拒绝执行写操作 */
  readOnly: boolean
  /** 本地库标记（环境标识，与 isTest / isProduction 互斥） */
  isLocal: boolean
  /** 测试库标记（环境标识，与 isLocal / isProduction 互斥） */
  isTest: boolean
  /** 生产库标记：界面高亮提示（环境标识，与 isLocal / isTest 互斥） */
  isProduction: boolean
}

/** 连接的环境标识，三者互斥；空串表示未标记 */
export type ConnectionEnv = '' | 'local' | 'test' | 'production'

/** SQL 模板配置，与后端 database.SQLTemplate 对应 */
export interface SQLTemplate {
  id: number
  connId: number
  name: string
  sqlText: string
  /** 模板自带的库 / 模式；空表示用连接配置里的默认库 */
  database: string
  /** JSON: 变量 UI 配置 */
  variables: string
  /** JSON: 字段映射配置 */
  fieldMappings: string
  /** JSON: 导出模板配置 */
  exportTemplates: string
  preScript: string
  postScript: string
  /** 是否启用：停用后保留配置但不允许执行 */
  enabled: boolean
  /** 每页条数（保留字段） */
  pageSize?: number
}

/** 库列表项，与后端 services.DatabaseInfo 对应 */
export interface DatabaseInfo {
  name: string
  isSystem: boolean
}

/** 表的外键约束，与后端 services.ForeignKey 对应 */
export interface TableForeignKey {
  /** 本表的列名 */
  column: string
  /** 被引用的表 */
  referencedTable: string
  /** 被引用的列名（通常是 id） */
  referencedColumn: string
}

/** 词典，与后端 database.Dictionary 对应 */
export interface Dictionary {
  id: number
  name: string
  description: string
}

/** 命令执行器 Tab 的持久化状态 */
export interface ExecutorPayload {
  /** 选中的数据库连接 */
  connId: number | null
  /** 执行时使用的库；空串表示连接默认库 */
  database: string
  /** 编辑器中的 SQL */
  sql: string
  /** SQL 编辑器高度（px） */
  editorHeight?: number
  /** 每页条数（0 表示不分页） */
  pageSize?: number
}

/** 命令执行器：执行请求 */
export interface ExecutorRequest {
  connId: number
  database: string
  sql: string
  limit: number
  /** 页码，从 1 开始；小于等于 0 表示不分页 */
  page?: number
  /** 每页条数 */
  pageSize?: number
  /** 上一次的总数 */
  total?: number
  /** 是否重新统计总数 */
  countTotal?: boolean
  /** 生产库写操作的确认标记，后端也会校验 */
  allowProductionWrite?: boolean
}

/** 命令执行器：表的字段信息 */
export interface ExecutorColumn {
  name: string
  /** 完整类型定义（如 varchar(32) / decimal(10,2)） */
  dataType: string
  comment: string
}

/** 「执行全部」时单条语句的执行记录（摘要页签用） */
export interface StatementRunRecord {
  /** 语句序号，从 1 开始 */
  index: number
  /** 语句原文 */
  sql: string
  /** 执行状态：运行中 / 成功 / 失败 / 已取消 */
  status: 'running' | 'success' | 'failed' | 'cancelled'
  /** 开始时间（毫秒时间戳） */
  startedAt: number
  /** 结束时间（毫秒时间戳）；未结束为 0 */
  finishedAt: number
  /** 本条耗时（ms） */
  elapsedMs: number
  /** 结果类型 */
  kind?: 'query' | 'exec'
  /** 查询返回行数 */
  rowCount?: number
  /** 写操作影响行数 */
  affectedRows?: number
  /** 失败原因 / 取消说明 */
  error?: string
}

/** 一次「执行全部」的汇总（摘要页签顶部信息） */
export interface ScriptRunSummary {
  /** 每条语句的执行记录（按执行顺序） */
  records: StatementRunRecord[]
  /** 整体开始时间（毫秒时间戳） */
  startedAt: number
  /** 整体结束时间（毫秒时间戳）；执行中为 0 */
  finishedAt: number
  /** 总耗时（ms） */
  totalMs: number
  /** 成功条数 */
  successCount: number
  /** 失败条数（含被取消的语句） */
  failedCount: number
}

/** 命令执行器：执行结果（kind 区分查询与写操作） */
export interface ExecutorResult {
  kind: 'query' | 'exec'
  columns: ColumnMeta[]
  rows: Record<string, unknown>[]
  sql: string
  /** 实际生效的库 / 模式 */
  database: string
  elapsedMs: number
  rowCount: number
  truncated: boolean
  affectedRows: number
  /** 满足条件的数据总量；未分页时等于 rowCount */
  total: number
  /** 当前页码，从 1 开始；未分页时为 1 */
  page: number
  /** 每页条数；未分页时为 0 */
  pageSize: number
  /** 总页数；未分页时为 1 */
  pageCount: number
}

/** 词典项，与后端 database.DictionaryItem 对应 */
export interface DictionaryItem {
  id: number
  dictionaryId: number
  value: string
  meaning: string
  description: string
  sortOrder: number
}

/** 结果集列元信息，与后端 services.ColumnMeta 对应 */
export interface ColumnMeta {
  name: string
  type: string
  /** 字段注释 */
  comment: string
  /** 来源表 */
  table?: string
}

/** 查询结果，与后端 services.QueryResult 对应 */
export interface QueryResult {
  columns: ColumnMeta[]
  rows: Record<string, unknown>[]
  sql: string
  /** 实际生效的库 / 模式 */
  database?: string
  elapsedMs: number
  rowCount: number
  truncated: boolean
  /** 满足条件的数据总量；未分页时等于 rowCount */
  total: number
  /** 当前页码，从 1 开始；未分页时为 1 */
  page: number
  /** 每页条数；未分页时为 0 */
  pageSize: number
  /** 总页数；未分页时为 1 */
  pageCount: number
  /** 是否为 EXPLAIN 分析结果 */
  analysis?: boolean
}

/** 查询请求，与后端 services.ExecuteRequest 对应 */
export interface ExecuteRequest {
  connId: number
  sqlTemplate: string
  variables: Record<string, unknown>
  preScript: string
  postScript: string
  /** 库 / 模式；空表示用连接配置里的默认库 */
  database?: string
  /** 页码，从 1 开始；小于等于 0 表示不分页 */
  page?: number
  /** 每页条数；小于等于 0 时取后端默认值 */
  pageSize?: number
  /** 上一次的总数 */
  total?: number
  /** 是否重新统计总数 */
  countTotal?: boolean
}

/** 模板执行请求，与后端 services.TemplateExecuteRequest 对应 */
export interface TemplateExecuteRequest {
  templateId: number
  connId: number
  variables: Record<string, unknown>
  /** 库 / 模式；空表示用连接配置里的默认库 */
  database?: string
  /** 页码，从 1 开始；小于等于 0 表示本次不分页 */
  page?: number
  /** 每页条数；小于等于 0 时取后端默认值 */
  pageSize?: number
  /** 上一次返回的总数 */
  total?: number
  /** 是否重新统计总数 */
  countTotal?: boolean
}



/** 模板列表项（含截断的 SQL 预览），与后端 services.TemplateListItem 对应 */
export interface TemplateListItem {
  id: number
  name: string
  connId: number
  sqlText: string
  /** 是否启用：停用的模板拒绝执行 */
  enabled: boolean
}

/** 应用配置项，与后端 database.Setting 对应 */
export interface Setting {
  key: string
  type: string
  value: string
}

/** 更新流程阶段，与后端 update.Snapshot.state 一一对应 */
export type UpdateState =
  | 'unconfigured'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'error'

/**
 * 更新状态快照，与后端 update.Snapshot 对应。
 *
 * 这是前端唯一的状态源：`wails:updater:*` 事件只当作「状态可能变了」的通知，
 * 收到后回后端重新拉一次快照，前端不自己推断状态。
 */
export interface UpdateSnapshot {
  /** 当前阶段 */
  state: UpdateState
  /** 当前运行的版本 */
  currentVersion: string
  /** 已发现的新版本（无则空） */
  latestVersion: string
  /** 发版说明 */
  notes: string
  /** 发布时间（RFC3339，未知时为空） */
  publishedAt: string
  /** 更新包文件名 */
  assetName: string
  /** 更新包字节数 */
  assetSize: number
  /** 是否已发现可安装的新版本 */
  available: boolean
  /** 下载进度百分比；-1 表示总长未知 */
  progress: number
  /** 已下载字节数 */
  written: number
  /** 更新包总字节数（未知为 0） */
  total: number
  /** 状态说明（更新不可用的原因 / 已取消等） */
  message: string
  /** 最近一次失败原因（无失败为空） */
  error: string
  /** 现在可以发起检查 */
  canCheck: boolean
  /** 现在可以（或重试）下载 */
  canDownload: boolean
  /** 现在可以取消下载 */
  canCancel: boolean
  /** 现在可以重启生效 */
  canRestart: boolean
}

/** 应用启动状态：degraded 表示初始化失败（界面仍可用，本地数据功能不可用） */
export interface AppStartupState {
  state: 'initializing' | 'ready' | 'degraded'
  error: string
}

/** 全局配置的键名 */
export type SettingKey =
  | 'theme'
  /** 界面缩放比例（百分比） */
  | 'ui_scale'
  /** 历史项：字号 / 控件大小 / 代码字号已由缩放比例承担，保留以兼容旧配置 */
  | 'font_size'
  | 'control_size'
  | 'editor_font_size'
  /** 编辑器字体分中英两档：_zh 只负责中文字形 */
  | 'editor_font_family'
  | 'editor_font_family_zh'
  | 'log_max_lines'

  | 'font_family'
  | 'font_family_zh'
  | 'sidebar_config'
  | 'picker_config'
  | 'sidebar_view'
  | 'sql_completion_trigger'
  | 'sql_completion_alias'
  | 'sql_show_system_databases'
  | 'template_placeholder_tab'
  | 'shortcut_config'
  /** 启动后自动检查新版本 */
  | 'app_auto_update'

/** 主题标识：dark（默认）/ midnight / idea 为暗色，light 为亮色 */
export type ThemeMode = 'dark' | 'midnight' | 'idea' | 'light'

/** Element Plus 控件尺寸 */
export type ControlSize = 'large' | 'default' | 'small'

/** 变量可选的 UI 组件类型 */
export type VariableComponent =
  | 'input'
  | 'textarea'
  | 'select'
  | 'multi-select'
  | 'date-picker'
  | 'slider'
  | 'switch'

/** 变量数据类型 */
export type VariableDataType = 'string' | 'int' | 'float' | 'bool' | 'date'

/** 下拉选项 */
export interface VariableOption {
  label: string
  value: string
}

/** 变量的动态选项来源配置 */
export interface VariableDynamicOption {
  /** 取选项的 SQL */
  sql: string
  /** 作为 value 的列名 */
  valueColumn: string
  /** 作为 label 的列名 */
  labelColumn: string
  /** 取选项用的数据源；缺省表示跟随模板 */
  connId?: number
  /** 取选项用的库 / 模式；缺省或为空表示跟随模板 */
  database?: string
}

/** 变量 UI 元数据配置 */
export interface VariableConfig {
  /** 变量名，与模板中的标识符一致 */
  name: string
  /** 展示名称 */
  label: string
  /** 渲染组件类型 */
  component: VariableComponent
  /** 数据类型，决定传往后端的值的类型 */
  dataType: VariableDataType
  /** 默认值 */
  defaultValue?: unknown
  /** 静态选项（select / multi-select 使用） */
  options?: VariableOption[]
  /** 动态选项来源（select / multi-select 使用） */
  dynamicOptions?: VariableDynamicOption
  /** 数字输入的取值范围（slider 使用） */
  min?: number
  max?: number
  step?: number
  /** 占位提示 */
  placeholder?: string
}

/** 单元格展示模板配置 */
export interface FieldMapping {
  /** 结果集中的列名 */
  column: string
  /** 展示别名 */
  label: string
  /** 列宽，留空则自适应 */
  width?: number
  /** 对齐方式 */
  align?: 'left' | 'center' | 'right'
  /** 绑定的词典 ID，用于翻译单元格值 */
  dictionaryId?: number
  /** 展示模板，支持 {{value}} 与 {{meaning}} 占位符 */
  template?: string
}

/** 导出模板：把结果行渲染成一段文本，供「复制为…」直接复制 */
export interface ExportTemplate {
  /** 模板内唯一标识，用于右键菜单项的 key */
  id: string
  /** 名称，显示在「复制为…」子菜单里 */
  name: string
  /** 模板内容，用 {{ 列名 }} 引用结果行的列 */
  content: string
  /** 是否启用（默认启用） */
  enabled?: boolean
}

/** 数据库查询工具在 Tab payload 中保存的状态（只保存引用哪个模板与用哪个连接） */
export interface DbQueryPayload {
  /** 引用的模板 ID */
  templateId: number | null
  /** 当前选中的连接；为空时回退到模板自身配置的连接 */
  connId: number | null
  /** 上次填写的变量值，用于恢复表单 */
  variableValues?: Record<string, unknown>
  /** 该标签自己的每页条数，不随模板保存 */
  pageSize?: number
}

// ============================================================ 插件体系

/** 插件贡献的工具（与后端 plugin.ToolContribution 对应） */
export interface PluginToolContribution {
  type: string
  label: string
  icon?: string
  multi?: boolean
  description?: string
  /** 侧栏分组 id 或分组名 */
  group?: string
  /** 组内排序，小的在前 */
  order?: number
  /** 是否出现在「新建标签」菜单；省略时跟随 multi */
  picker?: boolean
}

/** 插件定义的侧栏分组 */
export interface PluginSidebarGroup {
  id: string
  label?: string
  icon?: string
  order?: number
}

/** 插件声明的自定义设置面板 */
export interface PluginSettingsPanel {
  id: string
  title: string
  icon?: string
  order?: number
}

/** 配置项的可选项 */
export interface PluginSettingOption {
  label: string
  value: string
}

/** 插件贡献的命令 */
export interface PluginCommandContribution {
  id: string
  title: string
}

/** 插件贡献的配置项（宿主按 type 自动渲染成表单） */
export interface PluginSettingContribution {
  key: string
  /** string / number / boolean / select / json */
  type: string
  title: string
  default?: string
  description?: string
  /** select 类型的可选项 */
  options?: PluginSettingOption[]
  /** 所属设置面板 id；省略时归入以插件名命名的面板 */
  panel?: string
  /** 面板内排序，小的在前 */
  order?: number
}

/** 插件贡献的 MCP 工具 */
export interface PluginMCPToolContribution {
  name: string
  description?: string
  handler?: string
}

/** 一条插件依赖声明 */
export interface PluginDependencyRef {
  id: string
  constraint: string
}

/** 一条当前无法满足的依赖（不阻断安装，界面标红提示） */
export interface PluginMissingDependency {
  id: string
  constraint: string
  /** 未满足的原因：未安装 / 已装版本不符 */
  reason: string
}

/** 已安装插件的完整信息（与后端 plugin.InstalledInfo 对应） */
export interface InstalledPlugin {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  author: string
  homepage: string
  license: string
  icon: string

  enabled: boolean
  trusted: boolean
  official: boolean
  source: string
  sourceRef: string

  loaded: boolean
  loadError: string
  handlers: string[]

  compatible: boolean
  incompatReason: string
  inUseBy: string[]

  permissions: string[]
  dependencies: PluginDependencyRef[]
  /** 未满足的依赖：非空表示装了但缺依赖，补齐前无法启用 */
  missingDependencies: PluginMissingDependency[]

  tools: PluginToolContribution[]
  sidebarGroups: PluginSidebarGroup[]
  commands: PluginCommandContribution[]
  settings: PluginSettingContribution[]
  settingsPanels: PluginSettingsPanel[]
  mcpTools: PluginMCPToolContribution[]

  engines: { toolbox?: string }
  runtime: { backend?: string, entry?: string, frontend?: string }

  installedAt: string
  updatedAt: string
  previousVersion: string
}

/**
 * 插件安装来源。
 *
 * archive 是前端已把包读成字节流（拖拽 / 文件选择）的情况：
 * 路径与网络地址都由后端读取，只有它必须把内容传给后端。
 */
export type PluginInstallSource = 'registry' | 'url' | 'file' | 'local' | 'archive'

/**
 * 一次安装中的一个包输入。
 *
 * 与后端 PackageInputWire 对应：市场来源给 sourceUrl + id (+ version)，
 * 本地来源给 ref（路径），离线包给 fileName + contentBase64。
 * 信任与权限不在这里 —— 它们属于「确认安装」那一步，见 PluginInstallPlan。
 */
export interface PluginPackageInput {
  source: PluginInstallSource
  /** registry 来源时点选的插件源地址；留空表示跨来源自动挑选 */
  sourceUrl?: string
  /** registry 来源时的插件标识 */
  id?: string
  /** registry 来源时可选，缺省取满足约束的最高版本 */
  version?: string
  /** url / file / local 来源的地址或路径；archive 来源的展示名 */
  ref?: string
  /** archive 来源的包文件名（仅用于展示） */
  fileName?: string
  /** archive 来源的包内容（base64） */
  contentBase64?: string
}

/** 一个插件源（索引地址） */
export interface PluginRegistrySource {
  url: string
  name: string
  enabled: boolean
}

/** 单个插件源在某次读取中的状态 */
export interface PluginMarketplaceSource {
  url: string
  name: string
  /** 是否参与合并展示 */
  enabled: boolean
  /** 是否为宿主内置的官方源（只有它被强制要求验签） */
  official: boolean
  /** ready 读到索引 / error 读取失败 / idle 未读取 */
  state: string
  /** 索引签名是否校验通过 */
  verified: boolean
  updatedAt: string
  /** 该来源提供的插件条目数 */
  count: number
  error: string
}

/** 依赖闭包中的单个动作；计划一次求解、安装时不再重新求解 */
export interface PluginPlanItem {
  id: string
  version: string
  action: 'install' | 'upgrade' | 'reinstall' | 'keep' | string
  /** 包的来源类型：registry / url / file / local / batch */
  source: string
  /** 来源引用（下载地址 / 本地路径 / 包文件名） */
  sourceRef: string
  checksum: string
  /** 是否可信的官方条目（= 索引声明 official 且该来源验签通过） */
  official: boolean
  /** 该条目所在来源的索引是否验签通过 */
  sourceVerified: boolean
  /** 是否用户显式选择（false 表示由依赖带出来的） */
  root: boolean
  /** 是否需要用户确认信任 */
  needTrust: boolean
  trustReason: string
  /** 本次相对已安装版本新增的权限 */
  addedPermissions: string[]
  /** 本地已有可复用的包内容 */
  cached: boolean
}

/** 用户显式选择的一个待安装包（确认弹窗里的一张卡片） */
export interface PluginPackagePreview {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  icon: string
  homepage: string
  license: string

  source: string
  sourceRef: string
  official: boolean
  checksum: string

  /** 是否为升级既有插件 */
  upgrade: boolean
  /** 当前已安装版本（升级时非空） */
  currentVersion: string

  permissions: string[]
  addedPermissions: string[]
  dependencies: PluginDependencyRef[]
}

/**
 * 安装预览（权限确认弹窗的数据源）。
 *
 * 一份预览对应一次安装的完整依赖闭包：选中的包在 packages 里，
 * 连它们带出来的依赖一起在 plan 里。planId 是安装的唯一凭据。
 */
export interface PluginInstallPreview {
  /** 安装计划标识；只读清单（不求解依赖）时为空 */
  planId: string
  /** 计划过期时间（RFC3339） */
  expiresAt: string
  /** 用户显式选择的包 */
  packages: PluginPackagePreview[]
  /** 完整依赖闭包（含已满足的 keep 项，按依赖在前排序） */
  plan: PluginPlanItem[]
  /** 风险提示 */
  warnings: string[]
  /** 是否存在需要用户确认信任的来源 */
  needTrust: boolean
  /** 为什么需要确认信任 */
  trustReason: string
  /** 需要用户确认的新增权限（已去重） */
  addedPermissions: string[]
  /** 需要联网下载的安装包数量 */
  pendingDownloads: number
}

/** 插件市场条目 */
export interface PluginMarketplaceItem {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  icon: string
  homepage: string
  /** 是否可信的官方条目（= 索引声明 official 且来源验签通过） */
  official: boolean
  /** 该条目来自哪个插件源 */
  sourceUrl: string
  sourceName: string
  /** 该来源的索引是否验签通过 */
  sourceVerified: boolean

  installed: boolean
  installedVersion: string
  enabled: boolean
  updatable: boolean
  permissions: string[]
  dependencies: string[]
}

/** 插件市场快照（合并全部已启用来源） */
export interface PluginMarketplaceSnapshot {
  /** ready 至少一个来源可用 / error 全部失败 / idle 没有已启用来源 */
  state: string
  /** 各来源状态（含被禁用的，便于设置里管理） */
  sources: PluginMarketplaceSource[]
  /** 宿主是否配置了索引签名公钥；关闭时任何来源都无法验签 */
  signatureEnabled: boolean
  error: string
  /** 合并后的条目列表：同名插件在不同来源各占一条 */
  items: PluginMarketplaceItem[]
}

/** 单个插件源的快照（设置里按源预览） */
export interface PluginSourceSnapshot {
  source: PluginMarketplaceSource
  items: PluginMarketplaceItem[]
}

/** 单个插件的可用更新 */
export interface PluginUpdateInfo {
  id: string
  name: string
  currentVersion: string
  latestVersion: string
  official: boolean
  /** 提供该最新版本的插件源 */
  sourceUrl: string
  sourceName: string
  sourceVerified: boolean
  addedPermissions: string[]
  canAutoUpgrade: boolean
}

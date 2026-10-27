/**
 * 插件体系的后端调用封装。
 *
 * 与其它 api/*.ts 一致：这一层负责把后端返回值规整成前端类型
 * （后端 JSON 里缺字段会是 undefined，这里统一兜底），
 * 让上层组件与 store 不必到处判空。
 */

import {
  PluginAssetBase,
  PluginCheckUpdates,
  PluginGetSetting,
  PluginInstallPlan,
  PluginInvoke,
  PluginList,
  PluginListSources,
  PluginMarketplace,
  PluginPreviewPackages,
  PluginReadAsset,
  PluginReload,
  PluginRollback,
  PluginSaveSources,
  PluginSetEnabled,
  PluginSetSetting,
  PluginSetTrusted,
  PluginSourceMarketplace,
  PluginUninstall,
  PluginUpgrade,
} from './bindings'
import type {
  InstalledPlugin,
  PluginDependencyRef,
  PluginInstallPreview,
  PluginMarketplaceItem,
  PluginMarketplaceSnapshot,
  PluginMarketplaceSource,
  PluginMCPToolContribution,
  PluginMissingDependency,
  PluginPackageInput,
  PluginPackagePreview,
  PluginPlanItem,
  PluginRegistrySource,
  PluginSettingsPanel,
  PluginSidebarGroup,
  PluginSourceSnapshot,
  PluginToolContribution,
  PluginUpdateInfo,
} from '@/types'

/** 把后端返回转成字符串（null / undefined 统一为空串） */
function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** 把后端返回转成布尔 */
function bool(value: unknown): boolean {
  return value === true
}

/** 把后端返回转成数字（无法解析时为 0） */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 把后端返回转成字符串数组 */
function strList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(item => String(item))
}

/** 规整单条依赖声明 */
function toDependency(raw: unknown): PluginDependencyRef {
  const item = (raw ?? {}) as Record<string, unknown>
  return { id: str(item.id), constraint: str(item.constraint) }
}

/** 规整工具贡献 */
function toToolContribution(raw: unknown): PluginToolContribution {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    type: str(item.type),
    label: str(item.label),
    icon: str(item.icon),
    multi: bool(item.multi),
    description: str(item.description),
    group: str(item.group),
    order: typeof item.order === 'number' ? item.order : 0,
    picker: typeof item.picker === 'boolean' ? item.picker : undefined,
  }
}

/** 规整未满足的依赖 */
function toMissingDependency(raw: unknown): PluginMissingDependency {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    constraint: str(item.constraint),
    reason: str(item.reason),
  }
}

/** 规整侧栏分组定义 */
function toSidebarGroup(raw: unknown): PluginSidebarGroup {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    label: str(item.label),
    icon: str(item.icon),
    order: typeof item.order === 'number' ? item.order : 0,
  }
}

/** 规整设置面板声明 */
function toSettingsPanel(raw: unknown): PluginSettingsPanel {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    title: str(item.title),
    icon: str(item.icon),
    order: typeof item.order === 'number' ? item.order : 0,
  }
}

/** 规整 MCP 工具贡献 */
function toMCPTool(raw: unknown): PluginMCPToolContribution {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    name: str(item.name),
    description: str(item.description),
    handler: str(item.handler),
  }
}

/** 规整已安装插件 */
function toInstalledPlugin(raw: unknown): InstalledPlugin {
  const item = (raw ?? {}) as Record<string, any>
  return {
    id: str(item.id),
    name: str(item.name),
    version: str(item.version),
    publisher: str(item.publisher),
    description: str(item.description),
    author: str(item.author),
    homepage: str(item.homepage),
    license: str(item.license),
    icon: str(item.icon),

    enabled: bool(item.enabled),
    trusted: bool(item.trusted),
    official: bool(item.official),
    source: str(item.source),
    sourceRef: str(item.sourceRef),

    loaded: bool(item.loaded),
    loadError: str(item.loadError),
    handlers: strList(item.handlers),

    compatible: item.compatible === undefined ? true : bool(item.compatible),
    incompatReason: str(item.incompatReason),
    inUseBy: strList(item.inUseBy),

    permissions: strList(item.permissions),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(toDependency) : [],
    missingDependencies: Array.isArray(item.missingDependencies)
      ? item.missingDependencies.map(toMissingDependency)
      : [],

    tools: Array.isArray(item.tools) ? item.tools.map(toToolContribution) : [],
    sidebarGroups: Array.isArray(item.sidebarGroups) ? item.sidebarGroups.map(toSidebarGroup) : [],
    commands: Array.isArray(item.commands)
      ? item.commands.map((cmd: Record<string, unknown>) => ({ id: str(cmd?.id), title: str(cmd?.title) }))
      : [],
    settings: Array.isArray(item.settings)
      ? item.settings.map((s: Record<string, unknown>) => ({
          key: str(s?.key),
          type: str(s?.type) || 'string',
          title: str(s?.title),
          default: str(s?.default),
          description: str(s?.description),
          options: Array.isArray(s?.options)
            ? (s.options as Record<string, unknown>[]).map(o => ({ label: str(o?.label), value: str(o?.value) }))
            : [],
          panel: str(s?.panel),
          order: typeof s?.order === 'number' ? s.order : 0,
        }))
      : [],
    settingsPanels: Array.isArray(item.settingsPanels)
      ? item.settingsPanels.map(toSettingsPanel)
      : [],
    mcpTools: Array.isArray(item.mcpTools) ? item.mcpTools.map(toMCPTool) : [],

    engines: { toolbox: str(item.engines?.toolbox) },
    runtime: {
      backend: str(item.runtime?.backend),
      entry: str(item.runtime?.entry),
      frontend: str(item.runtime?.frontend),
    },

    installedAt: str(item.installedAt),
    updatedAt: str(item.updatedAt),
    previousVersion: str(item.previousVersion),
  }
}

/** 规整安装计划里的一条动作 */
function toPlanItem(raw: unknown): PluginPlanItem {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    version: str(item.version),
    action: str(item.action),
    source: str(item.source),
    sourceRef: str(item.sourceRef),
    checksum: str(item.checksum),
    official: bool(item.official),
    sourceVerified: bool(item.sourceVerified),
    root: bool(item.root),
    needTrust: bool(item.needTrust),
    trustReason: str(item.trustReason),
    addedPermissions: strList(item.addedPermissions),
    cached: bool(item.cached),
  }
}

/** 规整一个待安装包 */
function toPackagePreview(raw: unknown): PluginPackagePreview {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    name: str(item.name),
    version: str(item.version),
    publisher: str(item.publisher),
    description: str(item.description),
    icon: str(item.icon),
    homepage: str(item.homepage),
    license: str(item.license),

    source: str(item.source),
    sourceRef: str(item.sourceRef),
    official: bool(item.official),
    checksum: str(item.checksum),

    upgrade: bool(item.upgrade),
    currentVersion: str(item.currentVersion),

    permissions: strList(item.permissions),
    addedPermissions: strList(item.addedPermissions),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(toDependency) : [],
  }
}

/** 规整安装预览 */
function toInstallPreview(raw: unknown): PluginInstallPreview {
  const item = (raw ?? {}) as Record<string, any>
  return {
    planId: str(item.planId),
    expiresAt: str(item.expiresAt),
    packages: Array.isArray(item.packages) ? item.packages.map(toPackagePreview) : [],
    plan: Array.isArray(item.plan) ? item.plan.map(toPlanItem) : [],
    warnings: strList(item.warnings),
    needTrust: bool(item.needTrust),
    trustReason: str(item.trustReason),
    addedPermissions: strList(item.addedPermissions),
    pendingDownloads: num(item.pendingDownloads),
  }
}

/** 规整市场条目 */
function toMarketplaceItem(raw: unknown): PluginMarketplaceItem {
  const item = (raw ?? {}) as Record<string, any>
  return {
    id: str(item.id),
    name: str(item.name),
    version: str(item.version),
    publisher: str(item.publisher),
    description: str(item.description),
    icon: str(item.icon),
    homepage: str(item.homepage),
    official: bool(item.official),
    sourceUrl: str(item.sourceUrl),
    sourceName: str(item.sourceName),
    sourceVerified: bool(item.sourceVerified),
    installed: bool(item.installed),
    installedVersion: str(item.installedVersion),
    enabled: bool(item.enabled),
    updatable: bool(item.updatable),
    permissions: strList(item.permissions),
    dependencies: strList(item.dependencies),
  }
}

/** 读取全部已安装插件 */
export async function fetchPlugins(): Promise<InstalledPlugin[]> {
  const list = await PluginList()
  return (list ?? []).map(toInstalledPlugin)
}

/** 规整单个插件源的状态 */
function toMarketplaceSource(raw: unknown): PluginMarketplaceSource {
  const item = (raw ?? {}) as Record<string, any>
  return {
    url: str(item.url),
    name: str(item.name),
    enabled: bool(item.enabled),
    official: bool(item.official),
    state: str(item.state) || 'idle',
    verified: bool(item.verified),
    updatedAt: str(item.updatedAt),
    count: num(item.count),
    error: str(item.error),
  }
}

/** 读取插件市场快照（合并全部已启用来源） */
export async function fetchMarketplace(refresh = false): Promise<PluginMarketplaceSnapshot> {
  const raw = (await PluginMarketplace(refresh)) as Record<string, any> | null
  const item = raw ?? {}
  return {
    state: str(item.state) || 'ready',
    sources: Array.isArray(item.sources) ? item.sources.map(toMarketplaceSource) : [],
    signatureEnabled: bool(item.signatureEnabled),
    error: str(item.error),
    items: Array.isArray(item.items) ? item.items.map(toMarketplaceItem) : [],
  }
}

/** 读取插件源列表 */
export async function fetchPluginSources(): Promise<PluginRegistrySource[]> {
  const raw = (await PluginListSources()) as unknown
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map((entry) => {
    const item = (entry ?? {}) as Record<string, any>
    return {
      url: str(item.url),
      name: str(item.name),
      enabled: bool(item.enabled),
    }
  })
}

/** 整体保存插件源列表 */
export async function savePluginSources(sources: PluginRegistrySource[]): Promise<void> {
  await PluginSaveSources(sources.map(source => ({
    url: source.url,
    name: source.name,
    enabled: source.enabled,
  })))
}

/**
 * 读取「单个来源」的插件列表（不看启用状态）。
 *
 * 后端在读取失败时仍会返回来源状态，界面据此展示失败原因并把 error 抛出。
 */
export async function fetchSourceMarketplace(
  url: string,
  refresh = false,
): Promise<PluginSourceSnapshot> {
  const raw = (await PluginSourceMarketplace(url, refresh)) as Record<string, any> | null
  const item = raw ?? {}
  return {
    source: toMarketplaceSource(item.source),
    items: Array.isArray(item.items) ? item.items.map(toMarketplaceItem) : [],
  }
}

/**
 * 把前端输入转成后端绑定期望的形状。
 *
 * 后端 PackageInputWire 里的可选字段在 Wails 生成的类型中是必填的
 * （生成器不解析 omitempty），统一在这里补空串，
 * 免得每个调用点各自做类型断言。
 */
function toBackendInput(input: PluginPackageInput) {
  return {
    source: input.source,
    sourceUrl: input.sourceUrl ?? '',
    id: input.id ?? '',
    version: input.version ?? '',
    ref: input.ref ?? '',
    fileName: input.fileName ?? '',
    contentBase64: input.contentBase64 ?? '',
  }
}

/**
 * 预览一批插件包的安装。
 *
 * resolveDependencies 为 false 时只读清单（本地读取，毫秒级），
 * 用于先把卡片渲染出来；为 true 时求解完整依赖闭包并生成安装计划
 * （可能访问插件源），返回的 planId 是提交安装的唯一凭据。
 *
 * 整批一次性求解，因此同一批里互相依赖的包能在同一次求解里处理。
 */
export async function previewPackages(
  inputs: PluginPackageInput[],
  options: { resolveDependencies?: boolean, offline?: boolean } = {},
): Promise<PluginInstallPreview> {
  const raw = await PluginPreviewPackages(
    inputs.map(toBackendInput),
    options.resolveDependencies ?? false,
    options.offline ?? false,
  )
  return toInstallPreview(raw)
}

/**
 * 按已确认的安装计划完成安装。
 *
 * trust 表示用户已确认信任这些来源，acceptPermissions 表示接受本次新增权限；
 * 计划是一次性的：提交后（无论成败）该 planId 都作废，需要重新预览。
 */
export function installPlan(planId: string, trust: boolean, acceptPermissions: boolean): Promise<void> {
  return PluginInstallPlan(planId, trust, acceptPermissions)
}

/**
 * 把 File 对象读成 base64（去掉 data URL 前缀）。
 *
 * 用 FileReader 而不是自行拼接字节：后者在大文件上要分块处理
 * 才不会爆栈，而这里由浏览器实现负责，稳定且代码更短。
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 读取插件内的文本资源。
 *
 * 开发模式下用于以 Blob 方式加载插件前端产物：Wails 在 dev 时把窗口
 * 指向 Vite dev server，/plugins/ 静态地址会被 Vite 接管而读不到文件。
 */
export function readPluginAsset(id: string, version: string, path: string): Promise<string> {
  return PluginReadAsset(id, version, path)
}

/**
 * 卸载插件。
 *
 * force 为 true 时，依赖它的插件会被后端自动停用，
 * 返回这些被停用的插件 id（供界面提示用户）。
 */
export function uninstallPlugin(id: string, force = false): Promise<string[]> {
  return PluginUninstall(id, force)
}

/**
 * 启用 / 停用插件。
 *
 * cascade 为 true 时，停用被其它插件依赖的插件会一并停用依赖方；
 * 返回本次实际变更（含被级联停用）的插件 id。
 */
export function setPluginEnabled(id: string, enabled: boolean, cascade = false): Promise<string[]> {
  return PluginSetEnabled(id, enabled, cascade)
}

/** 设置插件信任状态 */
export function setPluginTrusted(id: string, trusted: boolean): Promise<void> {
  return PluginSetTrusted(id, trusted)
}

/** 检查更新 */
export async function checkPluginUpdates(): Promise<PluginUpdateInfo[]> {
  const list = (await PluginCheckUpdates()) ?? []
  return list.map((raw: Record<string, any>) => ({
    id: str(raw?.id),
    name: str(raw?.name),
    currentVersion: str(raw?.currentVersion),
    latestVersion: str(raw?.latestVersion),
    official: bool(raw?.official),
    sourceUrl: str(raw?.sourceUrl),
    sourceName: str(raw?.sourceName),
    sourceVerified: bool(raw?.sourceVerified),
    addedPermissions: strList(raw?.addedPermissions),
    canAutoUpgrade: bool(raw?.canAutoUpgrade),
  }))
}

/** 升级插件 */
export function upgradePlugin(id: string, acceptPermissions: boolean): Promise<void> {
  return PluginUpgrade(id, acceptPermissions)
}

/** 回滚插件到上一个版本 */
export function rollbackPlugin(id: string): Promise<void> {
  return PluginRollback(id)
}

/** 重新加载全部插件 */
export function reloadPlugins(): Promise<void> {
  return PluginReload()
}

/** 读取插件配置项 */
export function getPluginSetting(pluginId: string, key: string): Promise<string> {
  return PluginGetSetting(pluginId, key)
}

/** 写入插件配置项 */
export function setPluginSetting(pluginId: string, key: string, value: string): Promise<void> {
  return PluginSetSetting(pluginId, key, value)
}



/** 读取插件前端资源 URL 前缀 */
export async function fetchAssetBase(): Promise<string> {
  const base = await PluginAssetBase()
  return str(base) || '/plugins/'
}

/**
 * 调用插件后端 handler。
 *
 * 参数与返回值都按 JSON 传递；调用失败（插件未启用、缺少权限、
 * 插件内部抛错）都会以异常形式抛出，调用方负责展示。
 */
export async function invokePlugin<T = unknown>(
  pluginId: string,
  handler: string,
  args: unknown = {},
): Promise<T> {
  const result = await PluginInvoke(pluginId, handler, JSON.stringify(args ?? {}))
  const text = str(result)
  if (!text || text === 'null') {
    return null as T
  }
  try {
    return JSON.parse(text) as T
  }
  catch {
    // 插件返回的不是合法 JSON 时原样返回，避免调用方拿到空值
    return text as unknown as T
  }
}

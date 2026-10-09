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
  PluginInstall,
  PluginInstallArchive,
  PluginInvoke,
  PluginList,
  PluginMarketplace,
  PluginPreviewArchive,
  PluginPreviewArchiveBasic,
  PluginPreviewBasic,
  PluginPreviewInstall,
  PluginReadAsset,
  PluginRegistryURL,
  PluginReload,
  PluginRollback,
  PluginSetEnabled,
  PluginSetRegistryURL,
  PluginSetSetting,
  PluginSetTrusted,
  PluginUninstall,
  PluginUpgrade,
} from './bindings'
import type {
  InstalledPlugin,
  PluginDependencyRef,
  PluginInstallPreview,
  PluginInstallRequest,
  PluginMarketplaceItem,
  PluginMarketplaceSnapshot,
  PluginMCPToolContribution,
  PluginMissingDependency,
  PluginSettingsPanel,
  PluginSidebarGroup,
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

/** 规整安装预览 */
function toInstallPreview(raw: unknown): PluginInstallPreview {
  const item = (raw ?? {}) as Record<string, any>
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
    trusted: bool(item.trusted),
    needTrust: bool(item.needTrust),
    checksum: str(item.checksum),
    signed: bool(item.signed),

    upgrade: bool(item.upgrade),
    currentVersion: str(item.currentVersion),

    permissions: strList(item.permissions),
    addedPermissions: strList(item.addedPermissions),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(toDependency) : [],
    missingDependencies: Array.isArray(item.missingDependencies)
      ? item.missingDependencies.map(toMissingDependency)
      : [],
    plan: Array.isArray(item.plan)
      ? item.plan.map((p: Record<string, unknown>) => ({
          id: str(p?.id),
          version: str(p?.version),
          action: str(p?.action),
          scanned: bool(p?.scanned),
        }))
      : [],
    warnings: strList(item.warnings),
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

/** 读取插件市场快照 */
export async function fetchMarketplace(refresh = false): Promise<PluginMarketplaceSnapshot> {
  const raw = (await PluginMarketplace(refresh)) as Record<string, any> | null
  const item = raw ?? {}
  return {
    state: str(item.state) || 'ready',
    source: str(item.source),
    updatedAt: str(item.updatedAt),
    verified: bool(item.verified),
    error: str(item.error),
    items: Array.isArray(item.items) ? item.items.map(toMarketplaceItem) : [],
  }
}

/**
 * 把前端请求转成后端绑定期望的形状。
 *
 * 后端 InstallRequest 里的可选字段在 Wails 生成的类型中是必填的
 * （生成器不解析 omitempty），统一在这里补空串，
 * 免得每个调用点各自做类型断言。
 */
function toBackendRequest(req: PluginInstallRequest) {
  return {
    source: req.source,
    id: req.id ?? '',
    version: req.version ?? '',
    ref: req.ref ?? '',
    trust: req.trust,
    acceptPermissions: req.acceptPermissions,
  }
}

/** 生成安装预览 */
export async function previewInstall(req: PluginInstallRequest): Promise<PluginInstallPreview> {
  return toInstallPreview(await PluginPreviewInstall(toBackendRequest(req)))
}

/** 执行安装 */
export function installPlugin(req: PluginInstallRequest): Promise<void> {
  return PluginInstall(toBackendRequest(req))
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

/** 预览从离线包安装 */
export async function previewPluginArchive(fileName: string, contentBase64: string): Promise<PluginInstallPreview> {
  return toInstallPreview(await PluginPreviewArchive(fileName, contentBase64))
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
 * 快速预览：只读取插件包基本信息，不求解依赖（不联网）。
 *
 * 界面先用它渲染插件卡片，再调 previewInstall 补齐依赖计划 ——
 * 依赖求解可能要走官方索引，不该让基本信息陪着一起等。
 */
export async function previewPluginBasic(req: PluginInstallRequest): Promise<PluginInstallPreview> {
  return toInstallPreview(await PluginPreviewBasic(toBackendRequest(req)))
}

/** 快速预览离线包：只读基本信息，不求解依赖 */
export async function previewPluginArchiveBasic(
  fileName: string,
  contentBase64: string,
): Promise<PluginInstallPreview> {
  return toInstallPreview(await PluginPreviewArchiveBasic(fileName, contentBase64))
}

/** 从离线包安装 */
export function installPluginArchive(
  fileName: string,
  contentBase64: string,
  trust: boolean,
  acceptPermissions: boolean,
): Promise<void> {
  return PluginInstallArchive(fileName, contentBase64, trust, acceptPermissions)
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

/** 启用 / 停用插件 */
export function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  return PluginSetEnabled(id, enabled)
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

/** 读取当前插件索引地址 */
export function fetchRegistryUrl(): Promise<string> {
  return PluginRegistryURL()
}

/** 更换插件索引地址 */
export function saveRegistryUrl(url: string): Promise<void> {
  return PluginSetRegistryURL(url)
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

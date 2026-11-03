/** 插件前端加载器 */

import { fetchAssetBase, fetchPlugins, readPluginAsset } from '@/api/plugins'
import { createPluginApi, installSharedRuntime } from './hostApi'
import {
  clearPluginContributions,
  registerPluginGroups,
  registerPluginSettings,
  unregisterPluginContributions,
} from './registry'
import type { InstalledPlugin } from '@/types'

/** 插件返回的清理句柄 */
interface PluginDeactivation {
  deactivate: () => void | Promise<void>
}

/** activate 的返回值：可以不返回，也可以返回清理句柄 */
type PluginActivateResult = void | PluginDeactivation

/** 插件前端入口导出签名 */
type PluginActivate = (api: unknown) => PluginActivateResult | Promise<PluginActivateResult>

/** 插件前端模块的形状 */
interface PluginModule {
  activate?: PluginActivate
  default?: PluginActivate
}

/** 加载失败记录：插件 id → 原因 */
const loadErrors = new Map<string, string>()

/** 已加载插件登记的清理函数：插件 id → deactivate */
const deactivations = new Map<string, () => void | Promise<void>>()

/** 插件前端资源 URL 前缀（由后端提供，默认 /plugins/） */
let assetBase = '/plugins/'

/** 当前插件资源前缀 */
export function pluginAssetBase(): string {
  return assetBase
}

/** 读取加载失败原因 */
export function pluginLoadError(pluginId: string): string {
  return loadErrors.get(pluginId) ?? ''
}

/** 初始化插件宿主：读取资源前缀并加载全部插件 */
export async function initPluginHost(): Promise<void> {
  try {
    assetBase = await fetchAssetBase()
  }
  catch {
    assetBase = '/plugins/'
  }
  // 先挂上共享运行时，插件的 ESM 产物才能取到 Vue 与 UI 组件
  installSharedRuntime(assetBase)
  await reloadPluginHost()
}

/** 清空并重新加载全部插件 */
export async function reloadPluginHost(): Promise<void> {
  // 先让已加载的插件释放自己持有的资源，再清空贡献点重新加载
  await deactivateAllPlugins()
  clearPluginContributions()
  loadErrors.clear()

  let plugins: InstalledPlugin[] = []
  try {
    plugins = await fetchPlugins()
  }
  catch (error) {
    console.error('[plugin] 读取插件列表失败', error)
    return
  }

  for (const plugin of plugins) {
    if (!shouldLoad(plugin)) {
      continue
    }

    // 纯声明式的贡献先登记（侧栏分组、设置面板），
    // 即使插件前端加载失败，菜单分组与设置页签的归属依然成立
    registerPluginGroups(plugin.id, plugin.sidebarGroups)
    registerPluginSettings(plugin)

    try {
      await loadPlugin(plugin)
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      loadErrors.set(plugin.id, reason)
      console.error(`[plugin] 加载插件失败: ${plugin.id}`, error)
    }
  }
}

/** 卸载单个插件：先让它释放资源，再注销其前端贡献 */
export async function unloadPlugin(pluginId: string): Promise<void> {
  await deactivatePlugin(pluginId)
  unregisterPluginContributions(pluginId)
  loadErrors.delete(pluginId)
}

/** 调用单个插件的 deactivate（若已登记） */
async function deactivatePlugin(pluginId: string): Promise<void> {
  const deactivate = deactivations.get(pluginId)
  deactivations.delete(pluginId)
  if (deactivate) {
    await runDeactivation(pluginId, deactivate)
  }
}

/** 调用并清空全部插件的 deactivate */
async function deactivateAllPlugins(): Promise<void> {
  const pending = [...deactivations]
  deactivations.clear()
  for (const [pluginId, deactivate] of pending) {
    await runDeactivation(pluginId, deactivate)
  }
}

/** 调用 deactivate；单个插件失败只记录，不影响其它插件 */
async function runDeactivation(pluginId: string, deactivate: () => void | Promise<void>): Promise<void> {
  try {
    await deactivate()
  }
  catch (error) {
    console.error(`[plugin] 释放插件资源失败: ${pluginId}`, error)
  }
}

/** 判断 activate 的返回值是否为清理句柄 */
function isPluginDeactivation(value: unknown): value is PluginDeactivation {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { deactivate?: unknown }).deactivate === 'function'
}

/** 判断插件是否需要加载前端 */
function shouldLoad(plugin: InstalledPlugin): boolean {
  if (!plugin.enabled || !plugin.trusted || !plugin.compatible) {
    return false
  }
  // 只贡献设置项、没有工具视图的插件同样需要加载
  return plugin.tools.length > 0
    || plugin.settings.length > 0
    || plugin.settingsPanels.length > 0
    || Boolean(plugin.runtime.frontend)
}

/** 加载单个插件的前端产物 */
async function loadPlugin(plugin: InstalledPlugin): Promise<void> {
  const entry = plugin.runtime.frontend || 'frontend/index.js'
  const module = await importPluginModule(plugin, entry)

  const activate = module?.activate ?? module?.default
  if (typeof activate !== 'function') {
    throw new Error('插件前端入口必须导出 activate(api) 函数')
  }

  const api = createPluginApi(plugin, assetBase)
  const result = await activate(api)

  // 插件返回 { deactivate } 时登记清理函数，留待停用/卸载/重载前调用。
  // 覆盖旧值：同一插件重复 activate 时以最后一次登记为准。
  if (isPluginDeactivation(result)) {
    const { deactivate } = result
    deactivations.set(plugin.id, () => deactivate.call(result))
  }
}

/** 插件入口的静态地址 */
function pluginEntryUrl(plugin: InstalledPlugin, entry: string): string {
  const url = `${assetBase}${plugin.id}/${plugin.version}/${entry}`
  const token = plugin.updatedAt || plugin.installedAt
  return token ? `${url}?v=${encodeURIComponent(token)}` : url
}

/** 取出插件的 ESM 模块 */
async function importPluginModule(plugin: InstalledPlugin, entry: string): Promise<PluginModule> {
  const url = pluginEntryUrl(plugin, entry)

  // 优先静态地址：生产模式下由 Wails 资产服务直接从磁盘提供
  // （URL 带安装令牌，重装后必然换 URL，force-cache 不会命中旧条目）
  try {
    const response = await fetch(url, { cache: 'force-cache' })
    if (response.ok) {
      assertHostModules(await response.text())
      return await import(/* @vite-ignore */ url) as PluginModule
    }
  }
  catch {
    // 静态地址不可用（例如请求被 dev server 接管），落到下面的 IPC 通道
  }

  const source = await readPluginAsset(plugin.id, plugin.version, entry)
  assertHostModules(source)
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  // 模块已求值，延后回收即可；产物里没有动态 import，不会受影响
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)

  try {
    return await import(/* @vite-ignore */ blobUrl) as PluginModule
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法加载插件前端入口（${entry}）：${reason}`)
  }
}

/** 校验插件产物引用的宿主内核模块是否都已注册 */
function assertHostModules(source: string): void {
  const host = (globalThis as Record<string, unknown>).__TOOLBOX_HOST__
  if (!host || typeof host !== 'object') {
    throw new Error('宿主内核未就绪：__TOOLBOX_HOST__ 不存在')
  }

  const table = host as Record<string, unknown>
  const missing = new Set<string>()
  for (const match of source.matchAll(/__TOOLBOX_HOST__\["([^"]+)"\]/g)) {
    if (!(match[1] in table)) {
      missing.add(match[1])
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `插件依赖的宿主模块未注册：${[...missing].join('、')}（宿主与应用版本可能不匹配）`,
    )
  }
}

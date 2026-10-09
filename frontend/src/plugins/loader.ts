/**
 * 插件前端加载器。
 *
 * 加载流程：
 *   1. 从后端读取已安装插件，筛出「启用 + 已信任 + 兼容 + 有前端入口」的；
 *   2. 动态 import 插件的 ESM 产物（由 Wails 资产服务从磁盘提供服务）；
 *   3. 调用插件导出的 activate(api)，把宿主能力与共享 Vue 交给它；
 *   4. 插件在 activate 中通过 api.registerTool 注册界面。
 *
 * 单个插件加载失败只影响它自己（记录错误并继续），
 * 避免一个坏插件让整个工具箱不可用。
 */

import { fetchAssetBase, fetchPlugins, readPluginAsset } from '@/api/plugins'
import { createPluginApi, installSharedRuntime } from './hostApi'
import {
  clearPluginContributions,
  registerPluginGroups,
  registerPluginSettings,
  unregisterPluginContributions,
} from './registry'
import type { InstalledPlugin } from '@/types'

/** 插件前端入口导出签名 */
type PluginActivate = (api: unknown) => void | Promise<void>

/** 插件前端模块的形状 */
interface PluginModule {
  activate?: PluginActivate
  default?: PluginActivate
}

/** 加载失败记录：插件 id → 原因 */
const loadErrors = new Map<string, string>()

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

/** 卸载单个插件的前端贡献 */
export function unloadPlugin(pluginId: string): void {
  unregisterPluginContributions(pluginId)
  loadErrors.delete(pluginId)
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
  await activate(api)
}

/**
 * 插件入口的静态地址。
 *
 * 除版本号外再带一个「安装时间」令牌：插件资源由宿主以
 * `immutable, max-age=1y` 下发，浏览器还会按 URL 缓存 ESM 模块本身，
 * 因此只按 <version> 分段的话，同版本重装永远取不到新产物
 * （表现为「重装了插件但界面没变」）。
 *
 * 令牌取 updatedAt（每次重装/升级都会刷新，见后端 writeRecordLocked），
 * 缺失时回落到 installedAt。两者都拿不到就不带参数——
 * 此时按老行为走，至少不比改动前更差。
 */
function pluginEntryUrl(plugin: InstalledPlugin, entry: string): string {
  const url = `${assetBase}${plugin.id}/${plugin.version}/${entry}`
  const token = plugin.updatedAt || plugin.installedAt
  return token ? `${url}?v=${encodeURIComponent(token)}` : url
}

/**
 * 取出插件的 ESM 模块。
 *
 * 优先用 `/plugins/<id>/<version>/...` 静态地址（生产模式下由 Wails
 * 资产服务直接从磁盘提供）。开发模式必须退回 Blob：
 * Wails 在 dev 时把窗口指向 Vite dev server，这类请求会被 Vite 接管
 * （404 或返回 index.html），根本拿不到插件的 JS。此时改走 IPC 读源码，
 * 再用 Blob URL 加载 —— 插件产物是单文件 ESM（构建时关闭了代码分割），
 * 没有相对导入，在 Blob 里可以正常求值。
 */
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

/**
 * 校验插件产物引用的宿主内核模块是否都已注册。
 *
 * 构建期把 `@/xxx` 改写成了 `globalThis.__TOOLBOX_HOST__["@/xxx"]`。
 * 一旦宿主没有这个键（路径写法不一致、宿主版本过旧），运行时只会抛
 * 一句 `Cannot read properties of undefined (reading 'default')`，
 * 从报错里完全看不出缺了什么。这里提前把缺失的键名点出来。
 */
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

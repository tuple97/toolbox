/**
 * 插件状态中心。
 *
 * 承担三件事：
 *   1. 缓存已安装插件列表与市场快照，供插件管理页展示；
 *   2. 封装安装 / 卸载 / 启停 / 信任 / 升级等动作，并在动作后同步刷新；
 *   3. 驱动前端插件宿主的加载（安装或启停后重新加载插件贡献点）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  checkPluginUpdates,
  fetchMarketplace,
  fetchPlugins,
  fetchRegistryUrl,
  installPlugin,
  installPluginArchive,
  previewInstall,
  previewPluginArchive,
  previewPluginArchiveBasic,
  previewPluginBasic,
  reloadPlugins,
  rollbackPlugin,
  saveRegistryUrl,
  setPluginEnabled,
  setPluginTrusted,
  uninstallPlugin,
  upgradePlugin,
} from '@/api/plugins'
import { initPluginHost, reloadPluginHost } from '@/plugins/loader'
import type {
  InstalledPlugin,
  PluginInstallPreview,
  PluginInstallRequest,
  PluginMarketplaceSnapshot,
  PluginUpdateInfo,
} from '@/types'

/**
 * 自动检查更新的冷却时间。
 *
 * 装 / 卸 / 升级 / 启停之后都会自动查一次更新，而这一步要拉完整的网络索引，
 * 连点几下就会串行拉好几轮。冷却期内直接跳过，手动点「检查更新」不受限制。
 */
const UPDATE_CHECK_COOLDOWN_MS = 30_000

/** 空的插件索引地址常量，避免模板中到处判空 */
const EMPTY_SNAPSHOT: PluginMarketplaceSnapshot = {
  state: 'idle',
  source: '',
  updatedAt: '',
  verified: false,
  error: '',
  items: [],
}

export const usePluginStore = defineStore('plugins', () => {
  /** 已安装插件 */
  const installed = ref<InstalledPlugin[]>([])
  /** 插件市场快照 */
  const marketplace = ref<PluginMarketplaceSnapshot>({ ...EMPTY_SNAPSHOT })
  /** 可用更新 */
  const updates = ref<PluginUpdateInfo[]>([])
  /** 正在执行耗时动作（安装 / 卸载 / 升级 / 刷新） */
  const busy = ref(false)
  /**
   * 正在检查更新。
   *
   * 单独一位，不并进 busy：检查更新要拉网络索引（最长 12s，网络不通就耗满超时），
   * 并进 busy 会让插件管理页上所有绑了 busy 的按钮跟着一起转圈，看起来像卡死。
   */
  const checkingUpdates = ref(false)
  /** 最近一次失败原因 */
  const error = ref('')
  /** 当前索引地址 */
  const registryUrl = ref('')

  /** 已启用且受信任的插件 */
  const activePlugins = computed(() =>
    installed.value.filter(plugin => plugin.enabled && plugin.trusted && plugin.compatible),
  )

  /** 插件 id → 可用更新 */
  const updateOf = computed(() => {
    const map = new Map<string, PluginUpdateInfo>()
    for (const item of updates.value) {
      map.set(item.id, item)
    }
    return map
  })

  /** 存在更新的插件数量 */
  const updatableCount = computed(() => updates.value.length)

  /** 刷新已安装插件列表 */
  async function refreshInstalled(): Promise<void> {
    try {
      installed.value = await fetchPlugins()
      error.value = ''
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 加载插件市场（refresh 为 true 时强制刷新索引） */
  async function loadMarketplace(refresh = false): Promise<void> {
    busy.value = true
    try {
      marketplace.value = await fetchMarketplace(refresh)
      error.value = marketplace.value.error
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      busy.value = false
    }
  }

  /** 读取当前索引地址 */
  async function loadRegistryUrl(): Promise<void> {
    try {
      registryUrl.value = await fetchRegistryUrl()
    }
    catch {
      registryUrl.value = ''
    }
  }

  /** 更换索引地址 */
  async function updateRegistryUrl(url: string): Promise<void> {
    await saveRegistryUrl(url)
    registryUrl.value = url
    await loadMarketplace(true)
  }

  /** 最近一次检查完成的时间戳（含失败），用于给自动检查做冷却 */
  let lastCheckedAt = 0

  /** 检查全部插件的更新 */
  async function checkUpdates(options: { background?: boolean } = {}): Promise<void> {
    // 已经在查了就直接返回：并发触发只会重复拉同一份索引
    if (checkingUpdates.value) {
      return
    }
    // 动作后自动触发的检查带冷却，避免连续装/卸时串行拉多次索引
    if (options.background && Date.now() - lastCheckedAt < UPDATE_CHECK_COOLDOWN_MS) {
      return
    }
    checkingUpdates.value = true
    try {
      updates.value = await checkPluginUpdates()
      error.value = ''
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      checkingUpdates.value = false
      lastCheckedAt = Date.now()
    }
  }

  /** 生成安装预览 */
  async function preview(req: PluginInstallRequest): Promise<PluginInstallPreview> {
    return previewInstall(req)
  }

  /** 快速预览：只读基本信息，不求解依赖（毫秒级返回） */
  async function previewBasic(req: PluginInstallRequest): Promise<PluginInstallPreview> {
    return previewPluginBasic(req)
  }

  /** 生成离线包的安装预览 */
  async function previewArchive(fileName: string, contentBase64: string): Promise<PluginInstallPreview> {
    return previewPluginArchive(fileName, contentBase64)
  }

  /** 快速预览离线包：只读基本信息 */
  async function previewArchiveBasic(fileName: string, contentBase64: string): Promise<PluginInstallPreview> {
    return previewPluginArchiveBasic(fileName, contentBase64)
  }

  /**
   * 批量安装离线包。
   *
   * 逐个安装（后端按单个插件包处理依赖与信任），
   * 全部结束后统一刷新一次，避免 N 个包触发 N 次全量重载。
   */
  async function installArchives(
    items: Array<{ fileName: string, contentBase64: string }>,
    trust: boolean,
    acceptPermissions: boolean,
  ): Promise<void> {
    busy.value = true
    try {
      for (const item of items) {
        await installPluginArchive(item.fileName, item.contentBase64, trust, acceptPermissions)
      }
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /**
   * 批量安装（按来源请求，本地路径 / 网络地址 / 市场都走这里）。
   *
   * 与 installArchives 同样的取舍：逐个安装、最后统一刷新一次。
   * 用户一次选中多个插件目录或插件包时，这一步能把 N 次全量重载压成 1 次。
   */
  async function installAll(
    requests: PluginInstallRequest[],
    trust: boolean,
    acceptPermissions: boolean,
  ): Promise<void> {
    busy.value = true
    try {
      for (const req of requests) {
        await installPlugin({
          ...req,
          trust: trust || req.trust,
          acceptPermissions: acceptPermissions || req.acceptPermissions,
        })
      }
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /**
   * 执行安装（或升级）。
   *
   * 安装完成后需要两件事：刷新后端状态、重新加载前端插件宿主，
   * 否则新插件的菜单入口不会出现。
   */
  async function install(req: PluginInstallRequest): Promise<void> {
    busy.value = true
    try {
      await installPlugin(req)
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /**
   * 卸载插件。
   *
   * force 为 true 时后端会先停用依赖它的插件（含传递依赖）再卸载，
   * 返回值即被停用的插件 id；force 为 false 时被依赖会被后端拒绝。
   */
  async function uninstall(id: string, force = false): Promise<string[]> {
    busy.value = true
    try {
      const disabled = await uninstallPlugin(id, force)
      await afterMutation()
      return disabled
    }
    finally {
      busy.value = false
    }
  }

  /** 启用 / 停用插件 */
  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    busy.value = true
    try {
      await setPluginEnabled(id, enabled)
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /** 设置信任状态 */
  async function setTrusted(id: string, trusted: boolean): Promise<void> {
    busy.value = true
    try {
      await setPluginTrusted(id, trusted)
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /** 升级到最新版本 */
  async function upgrade(id: string, acceptPermissions: boolean): Promise<void> {
    busy.value = true
    try {
      await upgradePlugin(id, acceptPermissions)
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /** 回滚到上一个版本 */
  async function rollback(id: string): Promise<void> {
    busy.value = true
    try {
      await rollbackPlugin(id)
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /** 重新加载全部插件（开发者改了插件后用） */
  async function reload(): Promise<void> {
    busy.value = true
    try {
      await reloadPlugins()
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /** 动作完成后的统一收尾：刷新后端状态 + 重载前端宿主 */
  async function afterMutation(): Promise<void> {
    await refreshInstalled()
    await reloadPluginHost()
    // 已安装集合变化后，旧的更新信息可能失效，重新检查一次
    // （后台检查：不带 busy、带冷却，不阻塞界面）
    void checkUpdates({ background: true })
  }

  /** 应用启动时初始化：先加载宿主，再拉取状态 */
  async function init(): Promise<void> {
    await initPluginHost()
    await refreshInstalled()
    void loadRegistryUrl()
  }

  return {
    // state
    installed,
    marketplace,
    updates,
    busy,
    checkingUpdates,
    error,
    registryUrl,
    // getters
    activePlugins,
    updateOf,
    updatableCount,
    // actions
    init,
    refreshInstalled,
    loadMarketplace,
    loadRegistryUrl,
    updateRegistryUrl,
    checkUpdates,
    preview,
    previewBasic,
    previewArchive,
    previewArchiveBasic,
    installArchives,
    installAll,
    install,
    uninstall,
    setEnabled,
    setTrusted,
    upgrade,
    rollback,
    reload,
  }
})

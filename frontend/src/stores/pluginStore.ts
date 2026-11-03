/** 插件状态中心：缓存插件与市场数据、封装插件动作并驱动前端宿主加载 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  checkPluginUpdates,
  fetchDeveloperMode,
  fetchMarketplace,
  fetchPluginSources,
  fetchPlugins,
  fetchSourceMarketplace,
  installPlan as installPluginPlan,
  setDeveloperMode as setPluginDeveloperMode,
  previewPackages as previewPluginPackages,
  reloadPlugins,
  rollbackPlugin,
  savePluginSources,
  setPluginEnabled,
  setPluginTrusted,
  uninstallPlugin,
  upgradePlugin,
} from '@/api/plugins'
import { initPluginHost, reloadPluginHost } from '@/plugins/loader'
import type {
  InstalledPlugin,
  PluginInstallPreview,
  PluginMarketplaceItem,
  PluginMarketplaceSnapshot,
  PluginMarketplaceSource,
  PluginPackageInput,
  PluginRegistrySource,
  PluginSourceSnapshot,
  PluginUpdateInfo,
} from '@/types'

/** 自动检查更新的冷却时间，避免动作后连续串行拉取索引 */
const UPDATE_CHECK_COOLDOWN_MS = 30_000

/** 空的市场快照常量，避免模板中到处判空 */
const EMPTY_SNAPSHOT: PluginMarketplaceSnapshot = {
  state: 'idle',
  sources: [],
  signatureEnabled: false,
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
  /** 正在检查更新；单列一位，不并进 busy */
  const checkingUpdates = ref(false)
  /** 最近一次失败原因 */
  const error = ref('')
  /** 插件源列表（设置里管理） */
  const sources = ref<PluginRegistrySource[]>([])
  /** 市场页的来源过滤（多选）；空数组表示不过滤 */
  const marketFilter = ref<string[]>([])

  /** 开发者模式镜像；权威状态在后端（它才真正拦截源码目录安装） */
  const developerMode = ref(false)
  /** 设置里预览的插件源地址 */
  const previewSourceUrl = ref('')
  /** 设置里预览到的插件简略列表 */
  const sourceSnapshot = ref<PluginSourceSnapshot | null>(null)

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

  /** 市场页当前展示的条目（按选中的来源过滤） */
  const marketItems = computed<PluginMarketplaceItem[]>(() => {
    const items = marketplace.value.items
    if (marketFilter.value.length === 0) {
      return items
    }
    const picked = new Set(marketFilter.value)
    return items.filter(item => picked.has(item.sourceUrl))
  })

  /** 市场页来源下拉的选项（含被禁用的，便于用户看出自己挂过哪些源） */
  const marketSources = computed<PluginMarketplaceSource[]>(() => marketplace.value.sources)

  /** 可作为过滤条件的来源：只列已启用的 */
  const enabledMarketSources = computed<PluginMarketplaceSource[]>(
    () => marketSources.value.filter(source => source.enabled),
  )

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

  /** 读取插件源列表 */
  async function loadSources(): Promise<void> {
    try {
      sources.value = await fetchPluginSources()
    }
    catch {
      sources.value = []
    }
    if (!previewSourceUrl.value && sources.value.length > 0) {
      previewSourceUrl.value = sources.value[0].url
    }
  }

  /** 整体保存插件源列表，保存后重拉市场 */
  async function updateSources(next: PluginRegistrySource[]): Promise<void> {
    await savePluginSources(next)
    await loadSources()

    // 被删掉或被停用的来源不能继续当过滤条件，否则市场会一直空着
    const remaining = new Set(next.filter(source => source.enabled).map(source => source.url))
    marketFilter.value = marketFilter.value.filter(url => remaining.has(url))
    if (previewSourceUrl.value && !next.some(source => source.url === previewSourceUrl.value)) {
      previewSourceUrl.value = ''
      sourceSnapshot.value = null
    }
    await loadMarketplace(true)
  }

  /** 预览单个来源提供哪些插件（设置里选中某个源时用） */
  async function loadSourceSnapshot(url: string, refresh = false): Promise<void> {
    previewSourceUrl.value = url
    if (!url) {
      sourceSnapshot.value = null
      return
    }
    sourceSnapshot.value = await fetchSourceMarketplace(url, refresh)
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

  /** 预览一批插件包的安装，返回安装预览 */
  async function previewPackages(
    inputs: PluginPackageInput[],
    options: { resolveDependencies?: boolean, offline?: boolean } = {},
  ): Promise<PluginInstallPreview> {
    return previewPluginPackages(inputs, options)
  }

  /** 按已确认的安装计划完成安装，并重载前端宿主 */
  async function installPlan(planId: string, trust: boolean, acceptPermissions: boolean): Promise<void> {
    busy.value = true
    try {
      await installPluginPlan(planId, trust, acceptPermissions)
      await afterMutation()
    }
    finally {
      busy.value = false
    }
  }

  /** 卸载插件；force 为 true 时先停用依赖它的插件并返回这些 id */
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

  /** 启用 / 停用插件；cascade 为 true 时级联停用依赖方，返回实际变更的 id */
  async function setEnabled(id: string, enabled: boolean, cascade = false): Promise<string[]> {
    busy.value = true
    try {
      const affected = await setPluginEnabled(id, enabled, cascade)
      await afterMutation()
      return affected
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
  /** 读取开发者模式（权威状态在后端，这里只做镜像） */
  async function loadDeveloperMode(): Promise<void> {
    try {
      developerMode.value = await fetchDeveloperMode()
    }
    catch {
      // 读不到就按关闭处理：这个开关放宽的是安装校验，不能猜成开启
      developerMode.value = false
    }
  }

  /** 开关开发者模式（后端负责落库与即时生效） */
  async function updateDeveloperMode(enabled: boolean): Promise<void> {
    await setPluginDeveloperMode(enabled)
    developerMode.value = enabled
  }

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
    void loadSources()
    void loadDeveloperMode()
  }

  return {
    // state
    installed,
    marketplace,
    updates,
    busy,
    checkingUpdates,
    error,
    sources,
    marketFilter,
    enabledMarketSources,
    developerMode,
    previewSourceUrl,
    sourceSnapshot,
    // getters
    activePlugins,
    updateOf,
    updatableCount,
    marketItems,
    marketSources,
    // actions
    init,
    refreshInstalled,
    loadMarketplace,
    loadSources,
    updateSources,
    loadSourceSnapshot,
    checkUpdates,
    previewPackages,
    installPlan,
    loadDeveloperMode,
    updateDeveloperMode,
    uninstall,
    setEnabled,
    setTrusted,
    upgrade,
    rollback,
    reload,
  }
})

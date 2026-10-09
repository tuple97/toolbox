<script setup lang="ts">
/**
 * 插件管理页（单例视图）。
 *
 * 两个标签页：
 *   - 已安装：启停、信任、升级、回滚、卸载，并展示权限与依赖；
 *   - 插件市场：浏览官方索引、安装或更新插件。
 *
 * 安装永远经过「预览 → 确认」两步：预览把权限、依赖闭包与风险提示摊开，
 * 非官方来源必须显式勾选信任，升级引入新权限也必须二次确认。
 */

import { computed, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Checkbox from '@/components/ui/Checkbox.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import PluginSettingsDialog from '@/components/PluginSettingsDialog.vue'
import Dialog from '@/components/ui/Dialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import Switch from '@/components/ui/Switch.vue'
import Tag from '@/components/ui/Tag.vue'
import { pickDirectories, pickFiles } from '@/api/dialog'
import { readFileAsBase64 } from '@/api/plugins'
import { pluginLoadError } from '@/plugins/loader'
import { usePluginStore } from '@/stores/pluginStore'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import type {
  ContextMenuAction,
  InstalledPlugin,
  PluginInstallPlanItem,
  PluginInstallPreview,
  PluginInstallRequest,
  PluginInstallSource,
  PluginMarketplaceItem,
} from '@/types'

const emit = defineEmits<{ (e: 'ready'): void }>()

const store = usePluginStore()

/** 当前标签页 */
const activeTab = ref<'installed' | 'market'>('installed')
/** 市场搜索关键字 */
const search = ref('')
/** 详情弹窗里正在查看的插件 id（存 id 而非对象引用，列表刷新后自动同步） */
const detailId = ref('')
/** 详情弹窗可见 */
const detailVisible = ref(false)
/** 设置弹窗里正在配置的插件 id */
const settingsId = ref('')
/** 设置弹窗可见 */
const settingsVisible = ref(false)

// ------------------------------------------------------------ 多选 / 右键菜单

/** 是否处于多选模式：卡片右上角显示复选框 */
const selectMode = ref(false)
/** 已选中的插件 id */
const selectedIds = ref<Set<string>>(new Set())
/** 已选中的插件数量 */
const selectedCount = computed(() => selectedIds.value.size)

/** 卡片右键菜单可见 */
const menuVisible = ref(false)
/** 卡片右键菜单坐标 */
const menuX = ref(0)
const menuY = ref(0)
/** 右键菜单当前作用的插件 id */
const menuPluginId = ref('')

// ------------------------------------------------------------ 安装确认

/**
 * 一个待安装项。
 *
 * 两种来源共用同一条确认流程与同一个弹窗：
 *   - 市场安装：带 request（后端按 id 去索引取包）；
 *   - 离线包安装：带文件名与 base64 内容（拖拽 / 多选文件进来）。
 * 让「信任」与「权限」这两道关卡只写一次，避免两条路径策略分叉。
 */
interface PendingInstall {
  /** 基本信息（本地读取，先到）：卡片先用它渲染 */
  info: PluginInstallPreview | null
  /** 含依赖计划的完整预览（可能联网求解，后到） */
  preview: PluginInstallPreview | null
  /** 依赖解析失败的原因；不影响安装，单独展示 */
  depsError?: string
  /** 读取基本信息失败的原因 */
  error?: string
  /** 读取期间展示的标识：本地路径或安装包文件名 */
  label: string
  request?: PluginInstallRequest
  fileName?: string
  contentBase64?: string
}

/** 确认弹窗可见 */
const previewVisible = ref(false)
/** 待安装队列（离线包可一次拖入多个） */
const pendingItems = ref<PendingInstall[]>([])
/** 用户已勾选「信任该来源」 */
const trustConfirmed = ref(false)
/** 用户已勾选「接受新增权限」 */
const permissionsAccepted = ref(false)
/** 正在安装 */
const installing = ref(false)

/** 是否正在拖拽文件（用于显示投放区） */
const dragging = ref(false)
/** 拖拽进出计数：子元素也会触发 dragleave，用计数避免高亮闪烁 */
let dragDepth = 0

/** 确认弹窗标题 */
const confirmTitle = computed(() => {
  if (pendingItems.value.length > 1) {
    return `确认安装 ${pendingItems.value.length} 个插件`
  }
  return pendingItems.value[0]?.info?.upgrade ? '确认升级' : '确认安装'
})

/** 队列中是否存在需要用户确认信任的项（模板里用箭头函数会丢类型，这里集中算） */
const needsTrustConfirm = computed(() =>
  pendingItems.value.some(item => item.info?.needTrust === true),
)

/** 队列中全部新增权限（去重） */
const mergedAddedPermissions = computed(() => {
  const set = new Set<string>()
  for (const item of pendingItems.value) {
    for (const permission of item.info?.addedPermissions ?? []) {
      set.add(permission)
    }
  }
  return Array.from(set)
})

/** 已完成校验的条目 */
const readyItems = computed<ReadyInstall[]>(() =>
  pendingItems.value.filter(
    (item): item is ReadyInstall => Boolean(item.info) && !item.error,
  ))

// ------------------------------------------------------------ 手动安装

/** 手动安装弹窗可见 */
const manualVisible = ref(false)
/** 手动安装来源类型 */
const manualSource = ref<PluginInstallSource>('local')
/** 手动安装的路径或地址 */
const manualRef = ref('')

// ------------------------------------------------------------ 索引地址

/** 索引地址输入框 */
const registryInput = ref('')
/** 是否处于编辑索引地址状态 */
const editingRegistry = ref(false)

// ------------------------------------------------------------ 生命周期

onMounted(() => {
  /*
   * 立刻上报就绪，不要让联网动作拖住整页的初始化遮罩。
   *
   * 已安装列表与索引地址都是本地读取（毫秒级），而市场索引要访问
   * GitHub：仓库未建 / 网络不通时请求会一直挂到超时，
   * 之前把 emit('ready') 放在 Promise.all 之后，页面就会长时间
   * 停在「正在加载」上。
   */
  emit('ready')

  void store.refreshInstalled()
  void store.loadRegistryUrl().then(() => {
    registryInput.value = store.registryUrl
  })
  void store.loadMarketplace()
})

// 离开「已安装」页签时退出多选，避免下次回来还停在一堆复选框上
watch(activeTab, (tab) => {
  if (tab !== 'installed') {
    exitSelectMode()
  }
})

// ------------------------------------------------------------ 派生数据

/** 过滤后的市场条目 */
const marketItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) {
    return store.marketplace.items
  }
  return store.marketplace.items.filter(item =>
    item.name.toLowerCase().includes(keyword)
    || item.id.toLowerCase().includes(keyword)
    || item.description.toLowerCase().includes(keyword)
    || item.publisher.toLowerCase().includes(keyword),
  )
})

/** 市场数据是否可用 */
const marketReady = computed(() => store.marketplace.state === 'ready' || store.marketplace.items.length > 0)

// ------------------------------------------------------------ 交互辅助

/** 当前查看详情的插件 */
const detailPlugin = computed(() =>
  store.installed.find(plugin => plugin.id === detailId.value) ?? null)

/** 打开插件详情弹窗 */
function openDetail(plugin: InstalledPlugin): void {
  detailId.value = plugin.id
  detailVisible.value = true
}

/** 当前在设置弹窗里配置的插件 */
const settingsPlugin = computed(() =>
  store.installed.find(plugin => plugin.id === settingsId.value) ?? null)

/** 打开插件设置弹窗（配置项与面板由插件自己贡献） */
function openSettings(plugin: InstalledPlugin): void {
  settingsId.value = plugin.id
  settingsVisible.value = true
}

/** 插件是否贡献了设置项（含声明式配置项与自定义面板） */
function hasSettingsOf(plugin: InstalledPlugin): boolean {
  return plugin.settings.length > 0 || plugin.settingsPanels.length > 0
}

// ------------------------------------------------------------ 多选 / 右键菜单

/** 多选模式下点卡片即选中；否则打开详情 */
function handleTileClick(plugin: InstalledPlugin): void {
  if (selectMode.value) {
    toggleSelect(plugin)
    return
  }
  openDetail(plugin)
}

/** 切换单个插件的选中状态（整体替换 Set，保证触发响应式更新） */
function toggleSelect(plugin: InstalledPlugin): void {
  const next = new Set(selectedIds.value)
  if (next.has(plugin.id)) {
    next.delete(plugin.id)
  }
  else {
    next.add(plugin.id)
  }
  selectedIds.value = next
}

/** 从右键菜单进入多选模式，并把当前这张卡片一并选中 */
function startSelect(plugin: InstalledPlugin): void {
  selectMode.value = true
  const next = new Set(selectedIds.value)
  next.add(plugin.id)
  selectedIds.value = next
}

/** 退出多选模式并清空已选 */
function exitSelectMode(): void {
  selectMode.value = false
  selectedIds.value = new Set()
}

/** 右键菜单当前作用的插件 */
const menuPlugin = computed(() =>
  store.installed.find(plugin => plugin.id === menuPluginId.value) ?? null)

/** 右键菜单项：启停 / 信任 / 卸载 / 属性 */
const menuItems = computed<ContextMenuAction[]>(() => {
  const plugin = menuPlugin.value
  if (!plugin) {
    return []
  }
  const canToggle = !store.busy && (plugin.enabled || (plugin.trusted && plugin.compatible))
  return [
    { key: 'select', label: '选择', divided: true },
    {
      key: 'toggle-enabled',
      label: plugin.enabled ? '停用' : '启用',
      disabled: !canToggle,
    },
    {
      key: 'toggle-trusted',
      label: plugin.trusted ? '取消信任' : '信任',
      disabled: store.busy,
    },
    {
      key: 'settings',
      label: '配置',
      disabled: !hasSettingsOf(plugin),
    },
    {
      key: 'uninstall',
      label: '卸载',
      danger: true,
      divided: true,
      // 被依赖也允许点：handleUninstall 会说明依赖方并支持强制卸载
      disabled: store.busy,
    },
    { key: 'properties', label: '属性' },
  ]
})

/** 在卡片上按下右键：记录坐标与目标插件 */
function handleTileContextMenu(event: MouseEvent, plugin: InstalledPlugin): void {
  event.preventDefault()
  menuPluginId.value = plugin.id
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuVisible.value = true
}

/** 右键菜单选择 */
function handleMenuSelect(item: ContextMenuAction): void {
  const plugin = menuPlugin.value
  if (!plugin) {
    return
  }
  switch (item.key) {
    case 'select':
      startSelect(plugin)
      break
    case 'toggle-enabled':
      void handleToggleEnabled(plugin, !plugin.enabled)
      break
    case 'toggle-trusted':
      void handleToggleTrusted(plugin, !plugin.trusted)
      break
    case 'settings':
      openSettings(plugin)
      break
    case 'uninstall':
      void handleUninstall(plugin)
      break
    case 'properties':
      openDetail(plugin)
      break
  }
}

/** 插件显示名（找不到时回落 id，用于提示文案） */
function pluginName(id: string): string {
  return store.installed.find(plugin => plugin.id === id)?.name ?? id
}

/**
 * 求卸载顺序：依赖方在前。
 *
 * A 依赖 B 时先卸 A —— 顺序反了，卸 B 会被「被 A 依赖」拦下。
 * 选中集合里出现依赖环时按访问顺序跳过，不会死循环。
 */
function uninstallOrder(ids: string[]): string[] {
  const state = new Set<string>()
  const out: string[] = []
  /** 选中集合里依赖 id 的插件 */
  const dependentsOf = (id: string): string[] =>
    ids.filter(other => other !== id
      && (store.installed.find(plugin => plugin.id === other)?.dependencies ?? [])
        .some(dep => dep.id === id))

  const visit = (id: string): void => {
    if (state.has(id)) {
      return
    }
    state.add(id)
    for (const dependent of dependentsOf(id)) {
      visit(dependent)
    }
    out.push(id)
  }
  for (const id of ids) {
    visit(id)
  }
  return out
}

/** 批量卸载选中的插件 */
async function handleUninstallSelected(): Promise<void> {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) {
    return
  }

  const confirmed = await askConfirm({
    message: `确定卸载选中的 ${ids.length} 个插件（${ids.map(pluginName).join('、')}）吗？插件的本地数据会一并清理，此操作不可撤销。`,
    title: '批量卸载',
    confirmText: '卸载',
  })
  if (!confirmed) {
    return
  }

  const failed: Array<{ id: string, reason: string }> = []
  for (const id of uninstallOrder(ids)) {
    try {
      await store.uninstall(id)
    }
    catch (e) {
      failed.push({ id, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  /*
   * 剩下的失败基本都是「被没选中的插件依赖」。
   * 这里不直接报错收场：先讲清楚是谁依赖它，再让用户决定要不要强制卸载
   * （强制卸载会把依赖方停用，插件本身保留，可随时重新启用）。
   */
  if (failed.length > 0) {
    const forced = await askConfirm({
      message: `以下插件被其它插件依赖，普通卸载会被拒绝：${failed.map(item => pluginName(item.id)).join('、')}。`
        + '强制卸载会先停用依赖它们的插件（插件保留，可随时重新启用），确定继续吗？',
      title: '强制卸载',
      confirmText: '强制卸载',
    })
    if (!forced) {
      exitSelectMode()
      notify.error(`部分插件未卸载：${failed.map(item => pluginName(item.id)).join('、')}`)
      return
    }

    const remaining: Array<{ id: string, reason: string }> = []
    for (const item of failed) {
      try {
        await store.uninstall(item.id, true)
      }
      catch (e) {
        remaining.push({ id: item.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    exitSelectMode()
    if (remaining.length > 0) {
      notify.error(`部分插件卸载失败：${remaining.map(item => `${pluginName(item.id)}：${item.reason}`).join('；')}`)
      return
    }
    notify.success(`已卸载 ${ids.length} 个插件`)
    return
  }

  exitSelectMode()
  notify.success(`已卸载 ${ids.length} 个插件`)
}

/** 已读到基本信息的待安装项 */
type ReadyInstall = PendingInstall & { info: PluginInstallPreview }

/** 待安装项的依赖（安装计划里排除主包自身；未完成校验时返回空） */
function dependenciesOf(preview: PluginInstallPreview | null): PluginInstallPlanItem[] {
  if (!preview) {
    return []
  }
  return preview.plan.filter(item => item.id !== preview.id)
}

/** 某条依赖未满足的原因；已满足时返回空串 */
function missingReasonOf(plugin: InstalledPlugin, depId: string): string {
  return plugin.missingDependencies.find(item => item.id === depId)?.reason ?? ''
}

/**
 * 依赖的状态标签。
 *
 * 「自动扫描」用于安装时从同级目录扫出来的依赖：它不是用户显式选中的，
 * 也不在官方索引里，标成「新装」会让人误以为是去市场下载的。
 */
function dependencyTag(dep: PluginInstallPlanItem): { text: string, tone: 'info' | 'success' | 'warning' | 'brand' } {
  if (dep.action === 'keep') {
    return { text: '已安装', tone: 'success' }
  }
  if (dep.scanned) {
    return { text: '自动扫描', tone: 'info' }
  }
  if (dep.action === 'upgrade') {
    return { text: '升级', tone: 'warning' }
  }
  return { text: '新装', tone: 'brand' }
}

/**
 * 按依赖顺序排列待安装项。
 *
 * 后端在单次安装内求解依赖闭包，因此一次选中多个互相依赖的插件时，
 * 被依赖者必须先落地 —— 否则先装的那个会因为「依赖未安装」而失败。
 * 这里按各插件声明的依赖做一次拓扑排序；出现环时保持原顺序，不做死循环。
 */
function sortByDependencies(items: ReadyInstall[]): ReadyInstall[] {
  const byId = new Map(items.map(item => [item.info.id, item]))
  const result: ReadyInstall[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()

  const visit = (item: ReadyInstall): void => {
    const id = item.info.id
    if (done.has(id) || visiting.has(id)) {
      return
    }
    visiting.add(id)
    for (const dep of item.info.dependencies) {
      const target = byId.get(dep.id)
      if (target) {
        visit(target)
      }
    }
    visiting.delete(id)
    done.add(id)
    result.push(item)
  }

  for (const item of items) {
    visit(item)
  }
  return result
}

/** 来源的中文说明 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'registry':
      return '官方市场'
    case 'url':
      return '网络地址'
    case 'file':
      return '本地安装包'
    case 'local':
      return '本地目录'
    default:
      return source || '未知来源'
  }
}

/** 工具名称拼接（模板里直接用箭头函数会丢类型，这里集中处理） */
function toolLabels(plugin: InstalledPlugin): string {
  return plugin.tools.map(tool => tool.label).join('、')
}

/** 命令名称拼接 */
function commandTitles(plugin: InstalledPlugin): string {
  return plugin.commands.map(command => command.title).join('、')
}

/** MCP 工具名拼接 */
function mcpToolNames(plugin: InstalledPlugin): string {
  return plugin.mcpTools.map(tool => tool.name).join('、')
}

/** 插件状态标签 */
function statusTags(plugin: InstalledPlugin): Array<{ text: string, tone: 'info' | 'success' | 'warning' | 'danger' | 'brand' }> {
  const tags: Array<{ text: string, tone: 'info' | 'success' | 'warning' | 'danger' | 'brand' }> = []
  if (plugin.official) {
    tags.push({ text: '官方', tone: 'brand' })
  }
  else if (plugin.trusted) {
    tags.push({ text: '已信任', tone: 'success' })
  }
  else {
    tags.push({ text: '未信任', tone: 'warning' })
  }
  if (!plugin.compatible) {
    tags.push({ text: '不兼容', tone: 'danger' })
  }
  if (plugin.missingDependencies.length > 0) {
    tags.push({ text: `缺 ${plugin.missingDependencies.length} 个依赖`, tone: 'danger' })
  }
  if (plugin.loadError) {
    tags.push({ text: '加载失败', tone: 'danger' })
  }
  else if (plugin.enabled && plugin.trusted && plugin.loaded) {
    tags.push({ text: '运行中', tone: 'success' })
  }
  if (store.updateOf.get(plugin.id)) {
    tags.push({ text: '可更新', tone: 'brand' })
  }
  if (plugin.inUseBy.length > 0) {
    tags.push({ text: `被 ${plugin.inUseBy.length} 个插件依赖`, tone: 'info' })
  }
  return tags
}

// ------------------------------------------------------------ 已安装操作

/** 切换启用状态 */
async function handleToggleEnabled(plugin: InstalledPlugin, enabled: boolean): Promise<void> {
  try {
    await store.setEnabled(plugin.id, enabled)
    notify.success(enabled ? `已启用 ${plugin.name}` : `已停用 ${plugin.name}`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 切换信任状态 */
async function handleToggleTrusted(plugin: InstalledPlugin, trusted: boolean): Promise<void> {
  if (!trusted) {
    const confirmed = await askConfirm({
      message: `撤销对「${plugin.name}」的信任后，插件会立即停止运行，直到你重新信任它。确定继续吗？`,
      title: '撤销信任',
      confirmText: '撤销信任',
    })
    if (!confirmed) {
      return
    }
  }
  try {
    await store.setTrusted(plugin.id, trusted)
    notify.success(trusted ? `已信任 ${plugin.name}` : `已撤销对 ${plugin.name} 的信任`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/**
 * 卸载插件。
 *
 * 被其它插件依赖时不直接禁用按钮，而是把「谁会受影响」讲清楚，
 * 用户确认后走强制卸载：依赖方被停用，插件数据照常清理。
 */
async function handleUninstall(plugin: InstalledPlugin): Promise<void> {
  const dependents = plugin.inUseBy ?? []
  const confirmed = await askConfirm(dependents.length > 0
    ? {
        message: `「${plugin.name}」正被 ${dependents.map(pluginName).join('、')} 依赖。`
          + '强制卸载会先把它们停用（插件列表里保留，随时可以重新启用或装回本插件），'
          + '然后清理本插件的本地数据，此操作不可撤销。',
        title: '强制卸载',
        confirmText: '强制卸载',
      }
    : {
        message: `确定卸载「${plugin.name}」吗？插件的本地数据会一并清理，此操作不可撤销。`,
        title: '卸载插件',
        confirmText: '卸载',
      })
  if (!confirmed) {
    return
  }
  try {
    const disabled = await store.uninstall(plugin.id, dependents.length > 0)
    notify.success(disabled.length > 0
      ? `已卸载 ${plugin.name}，并停用依赖它的 ${disabled.map(pluginName).join('、')}`
      : `已卸载 ${plugin.name}`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 回滚到上一个版本 */
async function handleRollback(plugin: InstalledPlugin): Promise<void> {
  const confirmed = await askConfirm({
    message: `确定把「${plugin.name}」回滚到 ${plugin.previousVersion} 吗？`,
    title: '回滚版本',
    confirmText: '回滚',
  })
  if (!confirmed) {
    return
  }
  try {
    await store.rollback(plugin.id)
    notify.success(`已回滚 ${plugin.name}`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 重新加载全部插件 */
async function handleReload(): Promise<void> {
  try {
    await store.reload()
    notify.success('插件已重新加载')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

// ------------------------------------------------------------ 安装流程

/** 重置确认态：官方来源、权限未扩张时默认勾选，减少无谓点击 */
function resetConfirmState(items: PendingInstall[]): void {
  const scanned = items.filter(item => Boolean(item.info))
  trustConfirmed.value = scanned.length > 0
    && scanned.length === items.length
    && scanned.every(item => item.info?.official === true)
  permissionsAccepted.value = items.length > 0
    && items.every(item => (item.info?.addedPermissions.length ?? 0) === 0)
}

/** 读取单项的基本信息（本地完成，毫秒级） */
async function loadBasic(item: PendingInstall, index: number): Promise<void> {
  try {
    if (item.request) {
      pendingItems.value[index].info = await store.previewBasic(item.request)
      return
    }
    if (item.fileName && item.contentBase64) {
      pendingItems.value[index].info = await store.previewArchiveBasic(item.fileName, item.contentBase64)
    }
  }
  catch (e) {
    pendingItems.value[index].error = e instanceof Error ? e.message : String(e)
  }
}

/** 解析单项的依赖计划（可能联网，较慢） */
async function loadPlan(item: PendingInstall, index: number): Promise<void> {
  try {
    if (item.request) {
      pendingItems.value[index].preview = await store.preview(item.request)
      return
    }
    if (item.fileName && item.contentBase64) {
      pendingItems.value[index].preview = await store.previewArchive(item.fileName, item.contentBase64)
    }
  }
  catch (e) {
    pendingItems.value[index].depsError = e instanceof Error ? e.message : String(e)
  }
}

/**
 * 把待安装项推进队列，分两步补全信息。
 *
 * 第一步（基本信息）只读本地清单，毫秒级返回 —— 卡片可以立刻出来；
 * 第二步（依赖计划）可能要访问官方索引，慢得多，只影响依赖那一栏。
 *
 * 所有赋值都必须走 pendingItems.value[index]：ref 会深代理数组，
 * 直接改闭包里的原始对象不会触发更新（曾导致界面永远停在转圈状态）。
 */
async function loadPendingItems(items: PendingInstall[]): Promise<void> {
  pendingItems.value = items
  resetConfirmState(pendingItems.value)
  previewVisible.value = true

  await Promise.all(pendingItems.value.map((item, index) => loadBasic(item, index)))
  resetConfirmState(pendingItems.value)

  await Promise.all(pendingItems.value.map((item, index) =>
    pendingItems.value[index].info ? loadPlan(item, index) : Promise.resolve(),
  ))
}

/** 打开市场安装预览 */
async function openPreview(req: PluginInstallRequest): Promise<void> {
  await loadPendingItems([{
    info: null,
    preview: null,
    label: req.id || req.ref || '插件',
    request: req,
  }])
}

/** 打开离线包的安装预览（支持一次多个文件，拖拽进来的） */
async function openArchivePreview(files: File[]): Promise<void> {
  if (files.length === 0) {
    return
  }

  const items: PendingInstall[] = []
  for (const file of files) {
    try {
      const contentBase64 = await readFileAsBase64(file)
      items.push({
        info: null,
        preview: null,
        label: file.name,
        fileName: file.name,
        contentBase64,
      })
    }
    catch (e) {
      items.push({
        info: null,
        preview: null,
        label: file.name,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await loadPendingItems(items)
}

/**
 * 从本地路径批量预览安装。
 *
 * 走 request 分派（source + ref），后端直接按路径读取，
 * 因此系统选择器选出的多个目录 / 安装包可以一次全部预览。
 */
async function openPathPreview(source: PluginInstallSource, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return
  }

  await loadPendingItems(paths.map(path => ({
    info: null,
    preview: null,
    label: path,
    request: { source, ref: path, trust: false, acceptPermissions: false },
  })))
}

/**
 * 手动安装弹窗里的「选择」按钮。
 *
 * 选完直接进确认弹窗（不再需要先手输路径再点下一步）；
 * 只选一个时顺便回填输入框，方便用户下次复用或微调。
 */
async function pickManualPaths(): Promise<void> {
  const paths = manualSource.value === 'local'
    ? await pickDirectories('选择插件目录（可多选）')
    : await pickFiles('选择插件包（可多选）', [{ DisplayName: '插件包', Pattern: '*.zip' }])

  if (paths.length === 0) {
    return
  }
  manualRef.value = paths.length === 1 ? paths[0] : ''
  manualVisible.value = false
  await openPathPreview(manualSource.value, paths)
}

// ------------------------------------------------------------ 拖拽 / 多选

/** 从 FileList 中筛出插件包 */
function archiveFilesOf(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter(file => file.name.toLowerCase().endsWith('.zip'))
}

/** 顶部「导入插件包」：打开系统文件选择器（支持多选） */
async function pickPluginPackages(): Promise<void> {
  const paths = await pickFiles('选择插件包（可多选）', [{ DisplayName: '插件包', Pattern: '*.zip' }])
  await openPathPreview('file', paths)
}

function handleDragEnter(event: DragEvent): void {
  event.preventDefault()
  dragDepth += 1
  dragging.value = true
}

function handleDragOver(event: DragEvent): void {
  // 必须阻止默认行为，否则浏览器会直接打开被拖入的文件
  event.preventDefault()
}

function handleDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) {
    dragging.value = false
  }
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false

  const files = archiveFilesOf(event.dataTransfer?.files)
  if (files.length === 0) {
    notify.warning('请拖入 .zip 插件包')
    return
  }
  await openArchivePreview(files)
}

/** 从市场安装 */
function handleInstallFromMarket(item: PluginMarketplaceItem): void {
  void openPreview({
    source: 'registry',
    id: item.id,
    version: item.version,
    trust: false,
    acceptPermissions: false,
  })
}

/** 从市场更新 */
function handleUpgrade(item: InstalledPlugin): void {
  const update = store.updateOf.get(item.id)
  if (!update) {
    return
  }
  void openPreview({
    source: 'registry',
    id: item.id,
    version: update.latestVersion,
    trust: true,
    acceptPermissions: false,
  })
}

/** 打开手动安装弹窗 */
function openManual(): void {
  manualSource.value = 'local'
  manualRef.value = ''
  manualVisible.value = true
}

/** 提交手动安装 */
function submitManual(): void {
  const ref = manualRef.value.trim()
  if (!ref) {
    notify.warning('请填写路径或地址')
    return
  }
  manualVisible.value = false
  void openPreview({
    source: manualSource.value,
    ref,
    trust: false,
    acceptPermissions: false,
  })
}

/** 是否可以确认安装 */
const canConfirm = computed(() => {
  const items = pendingItems.value
  if (items.length === 0) {
    return false
  }
  // 还在读基本信息、或读取失败时不允许提交。
  // 依赖计划解析慢（可能联网），但它不影响安装的正确性 —— 不阻塞确认。
  if (items.some(item => !item.info || item.error)) {
    return false
  }
  // 任一插件需要信任确认，就必须整体勾选（批量安装沿用同一决定）
  if (items.some(item => item.info?.needTrust) && !trustConfirmed.value) {
    return false
  }
  if (items.some(item => (item.info?.addedPermissions.length ?? 0) > 0) && !permissionsAccepted.value) {
    return false
  }
  return true
})

/** 确认安装：市场单项 或 离线包批量 */
async function confirmInstall(): Promise<void> {
  const items = pendingItems.value
  if (items.length === 0 || !canConfirm.value) {
    return
  }
  installing.value = true
  try {
    const ready = readyItems.value

    const archives = ready.filter(
      (item): item is ReadyInstall & { fileName: string, contentBase64: string } =>
        Boolean(item.fileName && item.contentBase64),
    )

    if (archives.length > 0) {
      await store.installArchives(
        archives.map(item => ({ fileName: item.fileName, contentBase64: item.contentBase64 })),
        trustConfirmed.value,
        permissionsAccepted.value,
      )
    }

    // 本地路径 / 网络地址 / 市场来源都走 request 分派；
    // 一次选中多个时先按依赖排序（被依赖者先装），再交给 installAll 统一收尾
    const requests = sortByDependencies(ready)
      .map(item => item.request)
      .filter((req): req is PluginInstallRequest => Boolean(req))

    if (requests.length > 0) {
      await store.installAll(requests, trustConfirmed.value, permissionsAccepted.value)
    }

    notify.success(
      ready.length > 1
        ? `已安装 ${ready.length} 个插件`
        : `已安装 ${ready[0]?.info.name ?? '插件'}`,
    )

    previewVisible.value = false
    pendingItems.value = []
    // 市场快照刷新要拉网络索引（最长 12s）：放后台跑，装完就该立刻能继续操作，
    // 不能让弹窗一直停在「安装中」
    void store.loadMarketplace()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    installing.value = false
  }
}

// ------------------------------------------------------------ 索引地址

/** 保存索引地址 */
async function saveRegistry(): Promise<void> {
  const url = registryInput.value.trim()
  if (!url) {
    notify.warning('索引地址不能为空')
    return
  }
  try {
    await store.updateRegistryUrl(url)
    editingRegistry.value = false
    notify.success('索引地址已更新')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div
    class="plugin-manager"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖拽投放遮罩 -->
    <div v-if="dragging" class="plugin-manager__dropzone">
      <Icon name="download" />
      <span>松开以安装插件包（支持一次拖入多个 .zip）</span>
    </div>

    <!-- 顶部：标签页 + 全局动作 -->
    <header class="plugin-manager__head">
      <div class="plugin-manager__tabs">
        <button
          class="plugin-manager__tab"
          :class="{ 'is-active': activeTab === 'installed' }"
          type="button"
          @click="activeTab = 'installed'"
        >
          已安装
          <span v-if="store.installed.length" class="plugin-manager__count">{{ store.installed.length }}</span>
        </button>
        <button
          class="plugin-manager__tab"
          :class="{ 'is-active': activeTab === 'market' }"
          type="button"
          @click="activeTab = 'market'"
        >
          插件市场
          <span v-if="store.updatableCount" class="plugin-manager__count is-brand">{{ store.updatableCount }}</span>
        </button>
      </div>

      <div class="plugin-manager__actions">
        <Button variant="ghost" size="sm" :disabled="store.busy" @click="handleReload">
          <Icon name="refresh" />
          重新加载
        </Button>
        <!-- 用独立的 checkingUpdates：更新检查要拉网络索引，占用 busy 会让整个页面跟着转圈 -->
        <Button
          variant="secondary"
          size="sm"
          :loading="store.checkingUpdates"
          :disabled="store.checkingUpdates"
          @click="store.checkUpdates()"
        >
          <Icon name="download" />
          检查更新
        </Button>
        <Button variant="secondary" size="sm" @click="pickPluginPackages">
          <Icon name="download" />
          导入插件包
        </Button>
        <Button variant="secondary" size="sm" @click="openManual">
          <Icon name="plus" />
          手动安装
        </Button>
        <!-- 卡片被选中后才出现（紧挨「手动安装」）：批量卸载 + 退出多选 -->
        <template v-if="selectedCount > 0">
          <Button
            variant="danger"
            size="sm"
            :disabled="store.busy"
            @click="handleUninstallSelected"
          >
            <Icon name="trash" />
            卸载选中插件({{ selectedCount }})
          </Button>
          <Button variant="ghost" size="sm" @click="exitSelectMode">
            <Icon name="close" />
            取消选择
          </Button>
        </template>
      </div>
    </header>

    <div class="plugin-manager__body">
      <!-- ------------------------------------------------ 已安装 -->
      <template v-if="activeTab === 'installed'">
        <EmptyState
          v-if="store.installed.length === 0"
          description="还没有安装任何插件。可以到「插件市场」看看，或用「手动安装」加载本地插件。"
        />

        <div v-else class="plugin-grid">
          <article
            v-for="plugin in store.installed"
            :key="plugin.id"
            class="plugin-tile"
            :class="{
              'is-disabled': !plugin.enabled,
              'is-selected': selectMode && selectedIds.has(plugin.id),
            }"
            @click="handleTileClick(plugin)"
            @contextmenu="handleTileContextMenu($event, plugin)"
          >
            <!-- 右上角操作区；阻止冒泡，避免点按钮顺带打开详情 -->
            <div class="plugin-tile__corner" @click.stop>
              <!-- 多选模式：右上角换成复选框，点卡片任意处也能选中 -->
              <Checkbox
                v-if="selectMode"
                :model-value="selectedIds.has(plugin.id)"
                @update:model-value="() => toggleSelect(plugin)"
              />
              <template v-else>
                <Switch
                  :model-value="plugin.enabled"
                  :disabled="store.busy || !plugin.trusted || !plugin.compatible"
                  @update:model-value="(value: boolean) => handleToggleEnabled(plugin, value)"
                />
                <!-- 被依赖时不禁用：点进去会说明依赖方，并允许强制卸载（依赖方自动停用） -->
                <button
                  type="button"
                  class="plugin-tile__icon-btn"
                  :disabled="store.busy"
                  :title="plugin.inUseBy.length
                    ? `被 ${plugin.inUseBy.length} 个插件依赖，卸载会先停用它们`
                    : '卸载'"
                  @click="handleUninstall(plugin)"
                >
                  <Icon name="trash" />
                </button>
              </template>
            </div>

            <div class="plugin-tile__icon">
              <Icon :name="plugin.icon || 'puzzle'" />
            </div>

            <h3 class="plugin-tile__name">{{ plugin.name }}</h3>
            <p class="plugin-tile__meta">v{{ plugin.version }} · {{ plugin.publisher }}</p>
            <p class="plugin-tile__desc">{{ plugin.description || '该插件未提供描述' }}</p>

            <div class="plugin-tile__tags">
              <Tag
                v-for="tag in statusTags(plugin)"
                :key="tag.text"
                :tone="tag.tone"
                effect="plain"
                size="sm"
              >
                {{ tag.text }}
              </Tag>
              <Tag v-if="store.updateOf.get(plugin.id)" tone="brand" effect="plain" size="sm">
                可更新
              </Tag>
            </div>

            <p v-if="plugin.loadError || pluginLoadError(plugin.id)" class="plugin-tile__error">
              <Icon name="alert-triangle" />
              <span>{{ plugin.loadError || pluginLoadError(plugin.id) }}</span>
            </p>
            <p v-else-if="!plugin.compatible" class="plugin-tile__error">
              <Icon name="alert-triangle" />
              <span>{{ plugin.incompatReason }}</span>
            </p>
          </article>
        </div>
      </template>

      <!-- ------------------------------------------------ 插件市场 -->
      <template v-else>
        <div class="plugin-market__bar">
          <Input
            v-model="search"
            placeholder="搜索插件名称、标识或发布者"
            prefix-icon="search"
            clearable
            size="sm"
            class="plugin-market__search"
          />
          <div class="plugin-market__source">
            <template v-if="editingRegistry">
              <Input v-model="registryInput" size="sm" class="plugin-market__source-input" />
              <Button size="sm" @click="saveRegistry">保存</Button>
              <Button variant="ghost" size="sm" @click="editingRegistry = false">取消</Button>
            </template>
            <template v-else>
              <span class="plugin-market__source-text" :title="store.registryUrl">
                索引：{{ store.registryUrl || '未配置' }}
              </span>
              <Button variant="ghost" size="sm" @click="editingRegistry = true">修改</Button>
              <Button variant="ghost" size="sm" :disabled="store.busy" @click="store.loadMarketplace(true)">
                <Icon name="refresh" />
                刷新索引
              </Button>
            </template>
          </div>
        </div>

        <div v-if="store.marketplace.error" class="plugin-market__error">
          <Icon name="alert-triangle" />
          <span>{{ store.marketplace.error }}</span>
          <Button variant="ghost" size="sm" @click="store.loadMarketplace(true)">重试</Button>
        </div>

        <EmptyState
          v-else-if="!marketReady"
          description="正在读取插件索引…"
        />

        <EmptyState
          v-else-if="marketItems.length === 0"
          description="没有匹配的插件。"
        />

        <ul v-else class="plugin-list">
          <li v-for="item in marketItems" :key="item.id" class="plugin-card">
            <div class="plugin-card__main">
              <div class="plugin-card__icon">
                <Icon :name="item.icon || 'puzzle'" />
              </div>

              <div class="plugin-card__info">
                <div class="plugin-card__title-row">
                  <span class="plugin-card__name">{{ item.name }}</span>
                  <span class="plugin-card__version">v{{ item.version }}</span>
                  <Tag v-if="item.official" tone="brand" effect="plain" size="sm">官方</Tag>
                  <Tag v-else tone="warning" effect="plain" size="sm">第三方</Tag>
                  <Tag v-if="item.installed" tone="info" effect="plain" size="sm">
                    已安装 v{{ item.installedVersion }}
                  </Tag>
                </div>
                <p class="plugin-card__desc">{{ item.description || '该插件未提供描述' }}</p>
                <div class="plugin-card__meta">
                  <span>{{ item.publisher }}</span>
                  <span v-if="item.dependencies.length" class="plugin-card__dot">·</span>
                  <span v-if="item.dependencies.length">依赖 {{ item.dependencies.join('、') }}</span>
                </div>
                <p v-if="item.permissions.length" class="plugin-card__permissions">
                  权限：{{ item.permissions.join('；') }}
                </p>
              </div>

              <div class="plugin-card__ops">
                <Button
                  v-if="item.updatable"
                  size="sm"
                  @click="handleInstallFromMarket(item)"
                >
                  更新
                </Button>
                <Button
                  v-else-if="item.installed"
                  variant="secondary"
                  size="sm"
                  disabled
                >
                  已安装
                </Button>
                <Button v-else size="sm" @click="handleInstallFromMarket(item)">
                  安装
                </Button>
              </div>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <!-- ------------------------------------------------ 卡片右键菜单 -->
    <ContextMenu
      v-model:visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="handleMenuSelect"
    />

    <!-- ------------------------------------------------ 插件设置弹窗 -->
    <PluginSettingsDialog v-model="settingsVisible" :plugin="settingsPlugin" />

    <!-- ------------------------------------------------ 安装确认弹窗 -->
    <Dialog v-model="previewVisible" :title="confirmTitle" :width="580">
      <div class="plugin-preview">
        <!-- 待安装清单：离线包可一次拖入多个 -->
        <div
          v-for="(entry, index) in pendingItems"
          :key="`${entry.label}-${index}`"
          class="plugin-preview__item"
          :class="{ 'is-error': entry.error }"
        >
          <!-- 读不到基本信息才算失败；依赖还没解析完不算 -->
          <div v-if="!entry.info" class="plugin-preview__scan">
            <span v-if="!entry.error" class="plugin-preview__spinner" aria-hidden="true" />
            <Icon v-else name="alert-triangle" />
            <span>{{ entry.error || `正在读取 ${entry.label}…` }}</span>
          </div>

          <template v-else>
            <div class="plugin-preview__head">
              <div class="plugin-card__icon">
                <Icon :name="entry.info.icon || 'puzzle'" />
              </div>
              <div class="plugin-preview__title">
                <div class="plugin-preview__name">
                  {{ entry.info.name }}
                  <span class="plugin-card__version">
                    {{ entry.info.upgrade
                      ? `v${entry.info.currentVersion} → v${entry.info.version}`
                      : `v${entry.info.version}` }}
                  </span>
                </div>
                <div class="plugin-preview__publisher">{{ entry.info.publisher }}</div>
              </div>
              <Tag :tone="entry.info.official ? 'brand' : 'warning'" effect="plain" size="sm">
                {{ entry.info.official ? '官方' : '第三方' }}
              </Tag>
              <Tag :tone="entry.info.signed ? 'success' : 'warning'" effect="plain" size="sm">
                {{ entry.info.signed ? '已签名' : '未签名' }}
              </Tag>
            </div>

            <p v-if="entry.info.description" class="plugin-preview__desc">
              {{ entry.info.description }}
            </p>

            <p v-if="entry.fileName" class="plugin-preview__from">
              来源文件：{{ entry.fileName }}
            </p>

            <!-- 依赖：解析中先转圈，完成后展示计划或缺失项 -->
            <section class="plugin-preview__section">
              <h4>依赖</h4>

              <div v-if="!entry.preview && !entry.depsError" class="plugin-preview__scan">
                <span class="plugin-preview__spinner" aria-hidden="true" />
                <span>正在解析依赖…</span>
              </div>

              <p v-else-if="entry.depsError" class="plugin-preview__note is-warning">
                {{ entry.depsError }}
              </p>

              <template v-else-if="entry.preview">
                <ul
                  v-if="entry.preview.missingDependencies.length"
                  class="plugin-preview__deps is-missing"
                >
                  <li v-for="dep in entry.preview.missingDependencies" :key="dep.id">
                    <Icon name="alert-triangle" />
                    <span class="plugin-preview__dep-name">{{ dep.id }}</span>
                    <span class="plugin-preview__dep-version">{{ dep.reason }}</span>
                  </li>
                </ul>

                <ul v-if="dependenciesOf(entry.preview).length" class="plugin-preview__deps">
                  <li v-for="dep in dependenciesOf(entry.preview)" :key="dep.id">
                    <Icon name="package" />
                    <span class="plugin-preview__dep-name">{{ dep.id }}</span>
                    <Tag size="sm" effect="plain" :tone="dependencyTag(dep).tone">
                      {{ dependencyTag(dep).text }}
                    </Tag>
                    <span class="plugin-preview__dep-version">v{{ dep.version }}</span>
                  </li>
                </ul>

                <!-- 「无依赖」以清单声明的依赖为准，而不是求解计划：
                     依赖都装齐时计划里同样没有待装项，但插件依然是有依赖的 -->
                <p v-if="!entry.preview.dependencies.length" class="plugin-preview__note">
                  无依赖，可独立运行。
                </p>
                <p v-else-if="entry.preview.missingDependencies.length" class="plugin-preview__note">
                  仍可继续安装，但在依赖补齐之前该插件无法启用。
                </p>
              </template>
            </section>

            <section v-if="entry.info.permissions.length" class="plugin-preview__section">
              <h4>申请权限</h4>
              <ul class="plugin-detail__list">
                <li v-for="permission in entry.info.permissions" :key="permission">
                  {{ permission }}
                </li>
              </ul>
            </section>

            <section v-if="entry.info.warnings.length" class="plugin-preview__section">
              <h4>风险提示</h4>
              <ul class="plugin-preview__list is-warning">
                <li v-for="warning in entry.info.warnings" :key="warning">
                  <Icon name="alert-triangle" />
                  <span>{{ warning }}</span>
                </li>
              </ul>
            </section>
          </template>
        </div>

        <!-- 汇总：新增权限 + 两道确认关卡 -->
        <section v-if="mergedAddedPermissions.length" class="plugin-preview__section">
          <h4>本次新增权限</h4>
          <ul class="plugin-detail__list">
            <li v-for="permission in mergedAddedPermissions" :key="permission">{{ permission }}</li>
          </ul>
        </section>

        <label v-if="needsTrustConfirm" class="plugin-preview__check">
          <input v-model="trustConfirmed" type="checkbox">
          <span>我了解其中包含不在官方信任列表中的插件，并确认信任其发布者</span>
        </label>

        <label v-if="mergedAddedPermissions.length" class="plugin-preview__check">
          <input v-model="permissionsAccepted" type="checkbox">
          <span>我接受本次新增的权限</span>
        </label>
      </div>

      <template #footer>
        <div class="plugin-preview__footer">
          <Button variant="ghost" @click="previewVisible = false">取消</Button>
          <Button :disabled="!canConfirm" :loading="installing" @click="confirmInstall">
            {{ needsTrustConfirm ? '信任并安装' : '安装' }}
          </Button>
        </div>
      </template>
    </Dialog>

    <!-- ------------------------------------------------ 插件详情弹窗 -->
    <!-- v-if 放在 Dialog 上：只有存在目标插件时才渲染，内部引用无需反复判空 -->
    <Dialog v-if="detailPlugin" v-model="detailVisible" :title="detailPlugin.name" :width="620">
      <div class="plugin-detail">
        <div class="plugin-detail__head">
          <div class="plugin-card__icon">
            <Icon :name="detailPlugin.icon || 'puzzle'" />
          </div>
          <div class="plugin-detail__head-info">
            <div class="plugin-detail__head-title">
              {{ detailPlugin.name }}
              <span class="plugin-card__version">v{{ detailPlugin.version }}</span>
            </div>
            <div class="plugin-detail__head-meta">
              {{ detailPlugin.publisher }} · {{ sourceLabel(detailPlugin.source) }}
            </div>
          </div>
        </div>

        <div class="plugin-detail__tags">
          <Tag
            v-for="tag in statusTags(detailPlugin)"
            :key="tag.text"
            :tone="tag.tone"
            effect="plain"
            size="sm"
          >
            {{ tag.text }}
          </Tag>
        </div>

        <p v-if="detailPlugin.description" class="plugin-detail__desc">
          {{ detailPlugin.description }}
        </p>

        <ul
          v-if="detailPlugin.loadError || pluginLoadError(detailPlugin.id)"
          class="plugin-preview__list is-warning"
        >
          <li>
            <Icon name="alert-triangle" />
            <span>{{ detailPlugin.loadError || pluginLoadError(detailPlugin.id) }}</span>
          </li>
        </ul>
        <ul v-else-if="!detailPlugin.compatible" class="plugin-preview__list is-warning">
          <li>
            <Icon name="alert-triangle" />
            <span>{{ detailPlugin.incompatReason }}</span>
          </li>
        </ul>

        <div class="plugin-detail__grid">
          <section class="plugin-detail__block">
            <h4>权限</h4>
            <ul v-if="detailPlugin.permissions.length" class="plugin-detail__list">
              <li v-for="item in detailPlugin.permissions" :key="item">{{ item }}</li>
            </ul>
            <p v-else class="plugin-detail__empty">未申请任何权限</p>
          </section>

          <section class="plugin-detail__block">
            <h4>依赖</h4>
            <ul v-if="detailPlugin.dependencies.length" class="plugin-detail__list">
              <li v-for="dep in detailPlugin.dependencies" :key="dep.id">
                {{ dep.id }}
                <span class="plugin-detail__muted">{{ dep.constraint }}</span>
                <!-- 未满足的依赖标红：插件已装上但补齐前无法启用 -->
                <span v-if="missingReasonOf(detailPlugin, dep.id)" class="plugin-detail__missing">
                  {{ missingReasonOf(detailPlugin, dep.id) }}
                </span>
              </li>
            </ul>
            <p v-else class="plugin-detail__empty">无依赖</p>
          </section>

          <section class="plugin-detail__block">
            <h4>扩展点</h4>
            <ul class="plugin-detail__list">
              <li v-if="detailPlugin.tools.length">工具：{{ toolLabels(detailPlugin) }}</li>
              <li v-if="detailPlugin.commands.length">命令：{{ commandTitles(detailPlugin) }}</li>
              <li v-if="detailPlugin.mcpTools.length">
                MCP 工具：{{ mcpToolNames(detailPlugin) }}
              </li>
              <li
                v-if="!detailPlugin.tools.length && !detailPlugin.commands.length && !detailPlugin.mcpTools.length"
                class="plugin-detail__empty"
              >
                无
              </li>
            </ul>
          </section>

          <section class="plugin-detail__block">
            <h4>来源</h4>
            <ul class="plugin-detail__list">
              <li>类型：{{ sourceLabel(detailPlugin.source) }}</li>
              <li v-if="detailPlugin.sourceRef" class="plugin-detail__break">
                {{ detailPlugin.sourceRef }}
              </li>
              <li v-if="detailPlugin.handlers.length">
                后端方法：{{ detailPlugin.handlers.length }} 个
              </li>
              <li v-if="detailPlugin.engines.toolbox">
                要求应用版本：{{ detailPlugin.engines.toolbox }}
              </li>
              <li v-if="detailPlugin.installedAt">
                安装于：{{ detailPlugin.installedAt.replace('T', ' ').slice(0, 19) }}
              </li>
              <li v-if="detailPlugin.inUseBy.length">
                被依赖：{{ detailPlugin.inUseBy.join('、') }}
              </li>
            </ul>
          </section>
        </div>
      </div>

      <template #footer>
        <div class="plugin-detail__ops">
          <Button
            v-if="store.updateOf.get(detailPlugin.id)"
            variant="default"
            size="sm"
            @click="handleUpgrade(detailPlugin)"
          >
            更新到 {{ store.updateOf.get(detailPlugin.id)?.latestVersion }}
          </Button>
          <Button
            v-if="!detailPlugin.trusted"
            variant="default"
            size="sm"
            @click="handleToggleTrusted(detailPlugin, true)"
          >
            信任该插件
          </Button>
          <Button
            v-else
            variant="ghost"
            size="sm"
            @click="handleToggleTrusted(detailPlugin, false)"
          >
            撤销信任
          </Button>
          <Button
            v-if="detailPlugin.previousVersion"
            variant="secondary"
            size="sm"
            @click="handleRollback(detailPlugin)"
          >
            回滚到 {{ detailPlugin.previousVersion }}
          </Button>
          <Button variant="danger" size="sm" @click="handleUninstall(detailPlugin)">
            卸载
          </Button>
        </div>
      </template>
    </Dialog>

    <!-- ------------------------------------------------ 手动安装弹窗 -->
    <Dialog v-model="manualVisible" title="手动安装插件" :width="520">
      <div class="plugin-manual">
        <p class="plugin-manual__hint">
          支持三种来源：本地目录（开发者模式，直接指向插件源码目录）、
          本地安装包（.zip）、网络地址。非官方来源都需要在下一步确认信任。
        </p>

        <div class="plugin-manual__sources">
          <button
            v-for="option in ([
              { value: 'local', label: '本地目录', hint: '插件源码目录' },
              { value: 'file', label: '安装包', hint: '.zip 文件' },
              { value: 'url', label: '网络地址', hint: 'https://…' },
            ] as Array<{ value: PluginInstallSource, label: string, hint: string }>)"
            :key="option.value"
            class="plugin-manual__source"
            :class="{ 'is-active': manualSource === option.value }"
            type="button"
            @click="manualSource = option.value"
          >
            <span class="plugin-manual__source-label">{{ option.label }}</span>
            <span class="plugin-manual__source-hint">{{ option.hint }}</span>
          </button>
        </div>

        <div class="plugin-manual__field">
          <button
            v-if="manualSource !== 'url'"
            class="plugin-manual__pick"
            type="button"
            :title="manualSource === 'local' ? '选择插件目录（可多选）' : '选择插件包（可多选）'"
            @click="pickManualPaths"
          >
            <Icon :name="manualSource === 'local' ? 'folder' : 'package'" />
          </button>
          <Input
            v-model="manualRef"
            :placeholder="manualSource === 'url' ? 'https://example.com/plugin.zip' : 'D:\\path\\to\\plugin'"
            size="default"
          />
        </div>
      </div>

      <template #footer>
        <div class="plugin-preview__footer">
          <Button variant="ghost" @click="manualVisible = false">取消</Button>
          <Button @click="submitManual">下一步</Button>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.plugin-manager {
  display: flex;
  flex-direction: column;
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/* 拖拽投放遮罩 */
.plugin-manager__dropzone {
  position: absolute;
  inset: 8px;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 2px dashed var(--brand-color);
  border-radius: 10px;
  background: color-mix(in srgb, var(--brand-color) 12%, var(--bg-color));
  color: var(--brand-color);
  font-size: var(--app-font-size);
  pointer-events: none;
}

.plugin-manager__dropzone svg {
  font-size: 20px;
}

.plugin-manager__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
}

.plugin-manager__tabs {
  display: flex;
  gap: 4px;
}

.plugin-manager__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size);
  cursor: pointer;
}

.plugin-manager__tab:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.plugin-manager__tab.is-active {
  background: var(--active-bg);
  color: var(--brand-color);
}

.plugin-manager__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--hover-bg);
  font-size: var(--app-font-size-xs);
  text-align: center;
}

.plugin-manager__count.is-brand {
  background: var(--brand-color);
  color: #fff;
}

.plugin-manager__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.plugin-manager__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 20px;
}

/* ------------------------------------------------ 已安装插件卡片网格 */

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.plugin-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--panel-bg);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.plugin-tile:hover {
  border-color: color-mix(in srgb, var(--brand-color) 45%, transparent);
}

.plugin-tile.is-disabled {
  opacity: 0.66;
}

/* 卡片被选中（多选模式） */
.plugin-tile.is-selected {
  border-color: var(--brand-color);
  background: color-mix(in srgb, var(--brand-color) 10%, var(--panel-bg));
}

/* 右上角操作区：开关 + 卸载按钮（多选模式下换成复选框） */
.plugin-tile__corner {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 卡片上的图标按钮（卸载） */
.plugin-tile__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.plugin-tile__icon-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger-color) 14%, transparent);
  color: var(--danger-color);
}

.plugin-tile__icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.plugin-tile__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--active-bg);
  color: var(--brand-color);
  font-size: 19px;
}

.plugin-tile__name {
  margin: 0;
  /* 给右上角的开关 + 卸载按钮让位 */
  padding-right: 74px;
  overflow: hidden;
  color: var(--text-color);
  font-size: var(--app-font-size);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-tile__meta {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
}

.plugin-tile__desc {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.plugin-tile__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.plugin-tile__error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 2px 0 0;
  color: var(--warning-color);
  font-size: var(--app-font-size-2xs);
  line-height: 1.5;
}

/* ------------------------------------------------ 插件详情弹窗 */

.plugin-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plugin-detail__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plugin-detail__head-info {
  flex: 1;
  min-width: 0;
}

.plugin-detail__head-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-color);
  font-size: var(--app-font-size);
  font-weight: 600;
}

.plugin-detail__head-meta {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-detail__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.plugin-detail__desc {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.6;
}

.plugin-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--panel-bg);
}

.plugin-card.is-disabled {
  opacity: 0.72;
}

.plugin-card__main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
}

.plugin-card__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--active-bg);
  color: var(--brand-color);
  font-size: 18px;
}

.plugin-card__info {
  flex: 1;
  min-width: 0;
}

.plugin-card__title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.plugin-card__name {
  font-size: var(--app-font-size);
  font-weight: 600;
  color: var(--text-color);
}

.plugin-card__version {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-card__desc {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.5;
}

.plugin-card__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-card__dot {
  opacity: 0.5;
}

.plugin-card__error {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 6px 0 0;
  color: var(--danger-color);
  font-size: var(--app-font-size-xs);
}

.plugin-card__permissions {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-card__ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.plugin-card__detail {
  padding: 12px;
  border-top: 1px solid var(--border-color);
}

.plugin-detail__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.plugin-detail__block h4 {
  margin: 0 0 6px;
  color: var(--text-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.plugin-detail__list {
  margin: 0;
  padding-left: 16px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.7;
}

.plugin-detail__list.is-warning {
  padding-left: 0;
  list-style: none;
}

.plugin-detail__list.is-warning li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--warning-color);
}

.plugin-detail__empty {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
}

.plugin-detail__muted {
  color: var(--text-muted);
  opacity: 0.8;
}

.plugin-detail__break {
  word-break: break-all;
}

.plugin-detail__ops {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

/* ------------------------------------------------ 市场 */

.plugin-market__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.plugin-market__search {
  max-width: 320px;
}

.plugin-market__source {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.plugin-market__source-text {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-market__source-input {
  width: 320px;
}

.plugin-market__error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border: 1px solid var(--danger-color);
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.08);
  color: var(--danger-color);
  font-size: var(--app-font-size-sm);
}

/* ------------------------------------------------ 预览 */

.plugin-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 待安装清单中的单项（离线包批量安装会有多张） */
.plugin-preview__item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--panel-bg);
}

.plugin-preview__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plugin-preview__title {
  flex: 1;
  min-width: 0;
}

.plugin-preview__from {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  word-break: break-all;
}

/* 依赖清单 */
.plugin-preview__deps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-preview__deps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--panel-bg);
  font-size: var(--app-font-size-sm);
}

.plugin-preview__dep-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-preview__dep-version {
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
  font-variant-numeric: tabular-nums;
}

.plugin-preview__note {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
  line-height: 1.6;
}

.plugin-preview__note.is-warning {
  color: var(--danger-color);
}

/* 缺失的依赖：标红提示，不阻断安装 */
.plugin-preview__deps.is-missing li {
  border-color: color-mix(in srgb, var(--danger-color) 40%, transparent);
  color: var(--danger-color);
}

/* 校验中的条目 */
.plugin-preview__scan {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 2px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
}

.plugin-preview__spinner {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--brand-color);
  border-radius: 50%;
  animation: plugin-preview-spin 0.7s linear infinite;
}

@keyframes plugin-preview-spin {
  to {
    transform: rotate(360deg);
  }
}

.plugin-preview__item.is-error {
  border-color: color-mix(in srgb, var(--danger-color) 45%, transparent);
}

/* 详情里的缺失依赖说明 */
.plugin-detail__missing {
  margin-left: 6px;
  color: var(--danger-color);
  font-size: var(--app-font-size-2xs);
}

.plugin-preview__name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--text-color);
  font-size: var(--app-font-size);
  font-weight: 600;
}

.plugin-preview__publisher {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-preview__desc {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
}

.plugin-preview__section h4 {
  margin: 0 0 6px;
  color: var(--text-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.plugin-preview__list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.7;
}

.plugin-preview__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-color);
  font-size: var(--app-font-size-sm);
  cursor: pointer;
}

.plugin-preview__check input {
  margin-top: 2px;
}

.plugin-preview__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ------------------------------------------------ 手动安装 */

.plugin-manual {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 路径输入行：图标按钮 + 输入框 */
.plugin-manual__field {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 输入框占满剩余宽度（Input 的根元素层级不固定，用子选择器兜住） */
.plugin-manual__field > :last-child {
  flex: 1;
  min-width: 0;
}

.plugin-manual__pick {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--panel-bg);
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.plugin-manual__pick:hover {
  border-color: var(--brand-color);
  color: var(--brand-color);
}

.plugin-manual__hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.6;
}

.plugin-manual__sources {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.plugin-manual__source {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-color);
  text-align: left;
  cursor: pointer;
}

.plugin-manual__source.is-active {
  border-color: var(--brand-color);
  background: var(--active-bg);
}

.plugin-manual__source-label {
  font-size: var(--app-font-size);
}

.plugin-manual__source-hint {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}
</style>

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
import MultiSelect from '@/components/ui/MultiSelect.vue'
import Switch from '@/components/ui/Switch.vue'
import Tag from '@/components/ui/Tag.vue'
import { pickDirectories, pickFiles } from '@/api/dialog'
import { openPluginFolder, readFileAsBase64 } from '@/api/plugins'
import { pluginLoadError } from '@/plugins/loader'
import { usePluginStore } from '@/stores/pluginStore'
import { useTabStore } from '@/stores/tabStore'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import { openSettingPanel } from '@/utils/settingsNav'
import type { MultiSelectOption } from '@/components/ui/MultiSelect.vue'
import type {
  ContextMenuAction,
  InstalledPlugin,
  PluginInstallPreview,
  PluginInstallSource,
  PluginMarketplaceItem,
  PluginPackageInput,
  PluginPackagePreview,
  PluginPlanItem,
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
 * 一次安装 = 一批包输入 + 一份安装计划。
 *
 * 四种来源共用同一条确认流程与同一个弹窗：
 *   - 市场安装：source = registry，带 sourceUrl + id（+ version）；
 *   - 网络地址 / 本地路径：带 ref；
 *   - 拖拽或文件选择进来的离线包：带 fileName + base64 内容。
 *
 * 后端按「整批」一次性求解依赖闭包，因此批量包的相互依赖由后端处理，
 * 前端只需要把输入凑齐、把计划摊开给用户确认。
 */
/** 待安装的包输入 */
const pendingInputs = ref<PluginPackageInput[]>([])
/** 各输入的展示名（本地路径 / 包文件名），只用于读取期间的占位文案 */
const pendingLabels = ref<string[]>([])
/** 基本信息（本地读取，毫秒级）：卡片先用它渲染 */
const basicPreview = ref<PluginInstallPreview | null>(null)
/** 含依赖计划的完整预览（可能联网求解，后到）：planId 在这里 */
const planPreview = ref<PluginInstallPreview | null>(null)
/** 读取基本信息失败的原因 */
const basicError = ref('')
/** 求解依赖计划失败的原因；计划是安装的前提，失败时无法提交 */
const planError = ref('')

/** 确认弹窗可见 */
const previewVisible = ref(false)
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

/** 弹窗里的卡片：求解后以完整预览为准，否则先用基本信息 */
const previewPackages = computed<PluginPackagePreview[]>(() =>
  planPreview.value?.packages ?? basicPreview.value?.packages ?? [])

/** 确认弹窗标题 */
const confirmTitle = computed(() => {
  const count = previewPackages.value.length || pendingInputs.value.length
  if (count > 1) {
    return `确认安装 ${count} 个插件`
  }
  return previewPackages.value[0]?.upgrade ? '确认升级' : '确认安装'
})

/** 计划里由依赖带出来的条目（用户并未显式选择的那部分） */
const previewDependencies = computed<PluginPlanItem[]>(() =>
  (planPreview.value?.plan ?? []).filter(item => !item.root))

/** 风险提示：求解后更全（含未验签数量与待下载数量） */
const previewWarnings = computed<string[]>(() =>
  planPreview.value?.warnings ?? basicPreview.value?.warnings ?? [])

/** 本次需要用户确认的新增权限（后端已按整批去重） */
const mergedAddedPermissions = computed<string[]>(() => planPreview.value?.addedPermissions ?? [])

/** 是否需要用户确认信任来源 */
const needsTrustConfirm = computed(() => planPreview.value?.needTrust === true)

/** 需要确认信任的原因（后端的判定依据） */
const trustReason = computed(() => planPreview.value?.trustReason ?? '')

/** 是否已经拿到可直接提交的安装计划 */
const hasPlan = computed(() => Boolean(planPreview.value?.planId))

/**
 * 是否还在求解依赖计划。
 *
 * 只在读到基本信息之后才有意义：清单都还没读出来时谈「解析依赖」没有意义。
 */
const resolvingPlan = computed(() => !hasPlan.value && !planError.value)

// ------------------------------------------------------------ 手动安装

/** 手动安装弹窗可见 */
const manualVisible = ref(false)
/** 手动安装来源类型 */
const manualSource = ref<PluginInstallSource>('local')
/** 手动安装的路径或地址 */
const manualRef = ref('')

// ------------------------------------------------------------ 来源过滤

/**
 * 市场页来源过滤（多选）。
 *
 * 不选即不过滤，等价于「查询全部已启用来源」——因此不需要再额外提供一个
 * 「合并全部来源」的选项，清空选择就是那个语义。
 */
const marketFilter = computed({
  get: () => store.marketFilter,
  set: (value: string[]) => { store.marketFilter = value },
})

/** 来源多选选项：各个已配置来源（含已停用的，便于看出挂过哪些源） */
const sourceOptions = computed<MultiSelectOption[]>(() =>
  store.marketSources.map((source) => {
    const label = source.name || source.url
    return {
      // 多选下拉只显示一行文字，停用状态只能拼进标签里
      label: source.enabled ? label : `${label}（已停用）`,
      value: source.url,
    }
  }))

/** 只勾选了一个来源时的来源状态；未选或选了多个时为 null */
const activeSource = computed(() => {
  const picked = marketFilter.value
  if (picked.length !== 1) {
    return null
  }
  return store.marketSources.find(source => source.url === picked[0]) ?? null
})

/** 当前来源的验签提示：只在「验签已开启却没过」时提醒 */
const activeSourceWarning = computed(() => {
  const source = activeSource.value
  if (!source || source.state !== 'ready') {
    return ''
  }
  if (!store.marketplace.signatureEnabled) {
    return '未启用签名校验'
  }
  return source.verified ? '' : '该来源未验签'
})

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
  void store.loadSources()
  void store.loadMarketplace()
})

// 离开「已安装」页签时退出多选，避免下次回来还停在一堆复选框上
watch(activeTab, (tab) => {
  if (tab !== 'installed') {
    exitSelectMode()
  }
})

// 关掉确认弹窗就丢掉这一批输入：计划已经作废，留着只会在下次打开时误导人
watch(previewVisible, (visible) => {
  if (!visible) {
    resetPending()
  }
})

// ------------------------------------------------------------ 派生数据

/**
 * 过滤后的市场条目。
 *
 * store.marketItems 已经按来源下拉做过一次过滤（合并 / 单源），
 * 这里只再叠加关键字搜索。
 */
const marketItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  const base = store.marketItems
  if (!keyword) {
    return base
  }
  return base.filter(item =>
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
      key: 'open-folder',
      label: '查看文件',
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
    case 'open-folder':
      void handleOpenFolder(plugin)
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

/** 某条依赖未满足的原因；已满足时返回空串 */
function missingReasonOf(plugin: InstalledPlugin, depId: string): string {
  return plugin.missingDependencies.find(item => item.id === depId)?.reason ?? ''
}

/**
 * 依赖的状态标签。
 *
 * 计划由后端按依赖在前排好序，这里只负责把动作翻译成人话；
 * 非 root 的条目会额外标出「依赖」，免得被当成用户自己选的包。
 */
function dependencyTag(dep: PluginPlanItem): { text: string, tone: 'info' | 'success' | 'warning' | 'brand' } {
  switch (dep.action) {
    case 'keep':
      return { text: '已安装', tone: 'success' }
    case 'upgrade':
      return { text: '升级', tone: 'warning' }
    case 'reinstall':
      return { text: '重装', tone: 'info' }
    default:
      return { text: '新装', tone: 'brand' }
  }
}

/**
 * 某个包的来源索引是否验签通过；计划还没求解出来时返回 null（不显示标签）。
 *
 * 签名状态只存在于依赖计划的条目上（PackagePreview 里没有），
 * 因此求解前不该给卡片贴上「未签名」这种会误导人的结论。
 */
function sourceVerifiedOf(id: string): boolean | null {
  const item = planPreview.value?.plan.find(entry => entry.id === id)
  return item ? item.sourceVerified : null
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

/**
 * 切换启用状态。
 *
 * 停用被依赖的插件会被后端拒绝，所以先把「谁会受影响」讲清楚再级联停用，
 * 而不是让用户点一次、吃一个报错、再点一次。
 */
async function handleToggleEnabled(plugin: InstalledPlugin, enabled: boolean): Promise<void> {
  const cascade = !enabled && plugin.inUseBy.length > 0
  if (cascade) {
    const confirmed = await askConfirm({
      message: `「${plugin.name}」正被 ${plugin.inUseBy.map(pluginName).join('、')} 依赖。`
        + '停用它会把这些插件一并停用（插件保留，可随时重新启用）。确定继续吗？',
      title: '级联停用',
      confirmText: '一并停用',
    })
    if (!confirmed) {
      return
    }
  }
  try {
    const affected = await store.setEnabled(plugin.id, enabled, cascade)
    const others = affected.filter(id => id !== plugin.id)
    if (!enabled && others.length > 0) {
      notify.success(`已停用 ${plugin.name}，并一并停用 ${others.map(pluginName).join('、')}`)
      return
    }
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

/**
 * 用系统文件管理器打开插件的安装目录。
 *
 * 目录里是解包后的清单、前端产物与后端脚本：排查「插件加载失败」
 * 或改插件里的前端资源时，比自己去数据目录里翻要直接。
 */
async function handleOpenFolder(plugin: InstalledPlugin): Promise<void> {
  try {
    await openPluginFolder(plugin.id)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

// ------------------------------------------------------------ 安装流程

/**
 * 重置确认态：不需要确认的都默认勾上，减少无谓点击。
 *
 * 只能在拿到计划后调用 —— 信任与权限是整批求解出来的结论，
 * 求解前无从判断（基本信息里没有这两项）。
 */
function resetConfirmState(preview: PluginInstallPreview | null): void {
  trustConfirmed.value = preview ? !preview.needTrust : false
  permissionsAccepted.value = preview ? preview.addedPermissions.length === 0 : false
}

/** 清空待安装状态（关弹窗 / 装完之后） */
function resetPending(): void {
  pendingInputs.value = []
  pendingLabels.value = []
  basicPreview.value = null
  planPreview.value = null
  basicError.value = ''
  planError.value = ''
  trustConfirmed.value = false
  permissionsAccepted.value = false
}

/**
 * 求解依赖计划。
 *
 * 计划是安装的唯一凭据，因此这一步是必须的：失败就没有 planId，
 * 也就无法提交安装（重试请重新打开预览）。
 */
async function resolvePlan(): Promise<void> {
  if (pendingInputs.value.length === 0) {
    return
  }
  planError.value = ''
  try {
    const preview = await store.previewPackages(pendingInputs.value, { resolveDependencies: true })
    planPreview.value = preview
    resetConfirmState(preview)
  }
  catch (e) {
    planError.value = e instanceof Error ? e.message : String(e)
  }
}

/**
 * 把一批包输入推进确认弹窗，分两步补全信息。
 *
 * 第一步（基本信息）只读清单，毫秒级返回 —— 卡片可以立刻出来；
 * 第二步（依赖计划）要访问插件源，慢得多，但它决定「能不能装」，
 * 所以按钮在这之前一直是禁用的。
 */
async function loadPendingInputs(inputs: PluginPackageInput[], labels: string[]): Promise<void> {
  resetPending()
  pendingInputs.value = inputs
  pendingLabels.value = labels
  previewVisible.value = true

  try {
    basicPreview.value = await store.previewPackages(inputs)
  }
  catch (e) {
    basicError.value = e instanceof Error ? e.message : String(e)
    // 基本信息都读不到就没什么可确认的了，不必再空跑一次依赖求解
    return
  }

  await resolvePlan()
}

/** 打开安装预览（市场 / 手动填写的地址或路径都走这里） */
async function openPreview(input: PluginPackageInput): Promise<void> {
  await loadPendingInputs([input], [input.fileName || input.ref || input.id || '插件'])
}

/** 打开离线包的安装预览（支持一次多个文件，拖拽进来的） */
async function openArchivePreview(files: File[]): Promise<void> {
  if (files.length === 0) {
    return
  }

  const inputs: PluginPackageInput[] = []
  const labels: string[] = []
  const failed: string[] = []
  for (const file of files) {
    try {
      const contentBase64 = await readFileAsBase64(file)
      inputs.push({
        source: 'archive',
        ref: file.name,
        fileName: file.name,
        contentBase64,
      })
      labels.push(file.name)
    }
    catch (e) {
      failed.push(`${file.name}：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (failed.length > 0) {
    notify.error(`读取插件包失败：${failed.join('；')}`)
  }
  if (inputs.length === 0) {
    return
  }
  await loadPendingInputs(inputs, labels)
}

/**
 * 从本地路径批量预览安装。
 *
 * 只把路径交给后端（source + ref），由后端读取文件，
 * 因此系统选择器选出的多个目录 / 安装包可以一次全部提交。
 */
async function openPathPreview(source: PluginInstallSource, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return
  }

  await loadPendingInputs(
    paths.map(path => ({ source, ref: path })),
    paths,
  )
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
    // 同名插件在多个来源各占一条，必须把用户点中的那一条的来源带上，
    // 否则后端只会跨源取「最高版本」，装的可能不是他看的那一条
    sourceUrl: item.sourceUrl,
    id: item.id,
    version: item.version,
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
    sourceUrl: update.sourceUrl,
    id: item.id,
    version: update.latestVersion,
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
  })
}

/**
 * 是否可以确认安装。
 *
 * 关键是必须已经拿到安装计划：安装只认 planId，没有计划就没得提交。
 * 两道关卡则按计划给出的整批结论判断（批量安装沿用同一决定）。
 */
const canConfirm = computed(() => {
  const plan = planPreview.value
  if (!plan || !plan.planId) {
    return false
  }
  if (plan.needTrust && !trustConfirmed.value) {
    return false
  }
  if (plan.addedPermissions.length > 0 && !permissionsAccepted.value) {
    return false
  }
  return true
})

/** 确认安装：按已确认的计划提交，成功与否都会作废该计划 */
async function confirmInstall(): Promise<void> {
  const plan = planPreview.value
  if (!plan?.planId || !canConfirm.value) {
    return
  }
  installing.value = true
  try {
    await store.installPlan(plan.planId, trustConfirmed.value, permissionsAccepted.value)

    const count = previewPackages.value.length
    notify.success(count > 1
      ? `已安装 ${count} 个插件`
      : `已安装 ${previewPackages.value[0]?.name ?? '插件'}`)

    // 关窗由 previewVisible 的 watcher 负责清空这批输入（计划已作废）
    previewVisible.value = false
    // 市场快照刷新要拉网络索引（最长 12s）：放后台跑，装完就该立刻能继续操作，
    // 不能让弹窗一直停在「安装中」
    void store.loadMarketplace()
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
    /*
     * 计划是一次性的：后端在取出计划时就删掉了它，因此安装只要失败
     * （下载失败、信任关卡拒绝……），手里这个 planId 就已经作废。
     * 直接重新求解，用户改一下勾选就能重试，而不是对着一个装不动的计划反复点。
     */
    planPreview.value = null
    await resolvePlan()
  }
  finally {
    installing.value = false
  }
}

// ------------------------------------------------------------ 来源管理

/** 插件源的新增 / 删除 / 启停统一在设置页完成：跳过去并直接打开「插件源」面板 */
function openSourceSettings(): void {
  openSettingPanel('plugins')
  useTabStore().showSingleton('settings')
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
            <!-- 多选来源：不选就是查询全部已启用来源 -->
            <MultiSelect
              v-model="marketFilter"
              :options="sourceOptions"
              placeholder="全部来源"
              search-placeholder="搜索来源…"
              size="sm"
              class="plugin-market__source-select"
            />
            <Tag v-if="activeSourceWarning" tone="warning" effect="plain" size="sm">
              {{ activeSourceWarning }}
            </Tag>
            <Button variant="ghost" size="sm" @click="openSourceSettings">管理来源</Button>
            <Button variant="ghost" size="sm" :disabled="store.busy" @click="store.loadMarketplace(true)">
              <Icon name="refresh" />
              刷新索引
            </Button>
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
          <!-- key 必须带上来源：同名插件在多个来源各占一条 -->
          <li v-for="item in marketItems" :key="`${item.sourceUrl}::${item.id}`" class="plugin-card">
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
                  <span class="plugin-card__dot">·</span>
                  <!-- 合并展示时同名插件会有多条，必须标明各自来自哪个来源 -->
                  <span class="plugin-card__source-name" :title="item.sourceUrl">
                    来源：{{ item.sourceName || item.sourceUrl }}
                  </span>
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
        <!-- 一批包全部读不出来：直接说原因，没什么可确认的 -->
        <div v-if="basicError" class="plugin-preview__item is-error">
          <div class="plugin-preview__scan">
            <Icon name="alert-triangle" />
            <span>{{ basicError }}</span>
          </div>
        </div>

        <template v-else>
          <!-- 待安装清单：离线包可一次拖入多个 -->
          <div
            v-for="(pkg, index) in previewPackages"
            :key="`${pkg.id}-${index}`"
            class="plugin-preview__item"
          >
            <div class="plugin-preview__head">
              <div class="plugin-card__icon">
                <Icon :name="pkg.icon || 'puzzle'" />
              </div>
              <div class="plugin-preview__title">
                <div class="plugin-preview__name">
                  {{ pkg.name }}
                  <span class="plugin-card__version">
                    {{ pkg.upgrade
                      ? `v${pkg.currentVersion} → v${pkg.version}`
                      : `v${pkg.version}` }}
                  </span>
                </div>
                <div class="plugin-preview__publisher">{{ pkg.publisher }}</div>
              </div>
              <Tag :tone="pkg.official ? 'brand' : 'warning'" effect="plain" size="sm">
                {{ pkg.official ? '官方' : '第三方' }}
              </Tag>
              <!-- 签名与否是来源验签的结论，依赖计划出来之前不下判断 -->
              <Tag
                v-if="sourceVerifiedOf(pkg.id) !== null"
                :tone="sourceVerifiedOf(pkg.id) ? 'success' : 'warning'"
                effect="plain"
                size="sm"
              >
                {{ sourceVerifiedOf(pkg.id) ? '已签名' : '未签名' }}
              </Tag>
            </div>

            <p v-if="pkg.description" class="plugin-preview__desc">{{ pkg.description }}</p>

            <p v-if="pkg.sourceRef" class="plugin-preview__from">来源：{{ pkg.sourceRef }}</p>

            <section v-if="pkg.permissions.length" class="plugin-preview__section">
              <h4>申请权限</h4>
              <ul class="plugin-detail__list">
                <li v-for="permission in pkg.permissions" :key="permission">{{ permission }}</li>
              </ul>
            </section>
          </div>

          <!-- 清单还没读出来（本地读取，通常一闪而过） -->
          <div v-if="!previewPackages.length" class="plugin-preview__scan">
            <span class="plugin-preview__spinner" aria-hidden="true" />
            <span>正在读取 {{ pendingLabels.join('、') || '插件包' }}…</span>
          </div>

          <!--
            依赖：后端按整批一次性求解，这里只展示用户没直接选的那部分。
            求解不出来就没有 planId，也就没法安装，所以失败要明说而不是放过。
          -->
          <section v-if="basicPreview" class="plugin-preview__section">
            <h4>依赖</h4>

            <div v-if="resolvingPlan" class="plugin-preview__scan">
              <span class="plugin-preview__spinner" aria-hidden="true" />
              <span>正在解析依赖…</span>
            </div>

            <p v-else-if="planError" class="plugin-preview__note is-warning">
              {{ planError }}
            </p>

            <template v-else>
              <ul v-if="previewDependencies.length" class="plugin-preview__deps">
                <li v-for="dep in previewDependencies" :key="dep.id">
                  <Icon name="package" />
                  <span class="plugin-preview__dep-name">{{ dep.id }}</span>
                  <Tag size="sm" effect="plain" :tone="dependencyTag(dep).tone">
                    {{ dependencyTag(dep).text }}
                  </Tag>
                  <span class="plugin-preview__dep-version">v{{ dep.version }}</span>
                </li>
              </ul>
              <p v-else class="plugin-preview__note">本次无需额外安装其它插件。</p>
            </template>
          </section>
        </template>

        <!-- 汇总：风险提示 + 新增权限 + 两道确认关卡 -->
        <section v-if="previewWarnings.length" class="plugin-preview__section">
          <h4>风险提示</h4>
          <ul class="plugin-preview__list is-warning">
            <li v-for="warning in previewWarnings" :key="warning">
              <Icon name="alert-triangle" />
              <span>{{ warning }}</span>
            </li>
          </ul>
        </section>

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

        <p v-if="needsTrustConfirm && trustReason" class="plugin-preview__note is-warning">
          {{ trustReason }}
        </p>

        <label v-if="mergedAddedPermissions.length" class="plugin-preview__check">
          <input v-model="permissionsAccepted" type="checkbox">
          <span>我接受本次新增的权限</span>
        </label>
      </div>

      <template #footer>
        <div class="plugin-preview__footer">
          <!-- 按钮为什么点不动要说清楚，否则看着像卡住了 -->
          <span v-if="!hasPlan" class="plugin-preview__footer-hint">
            {{ basicError ? '读取插件包失败' : planError ? '依赖解析失败' : '正在生成安装计划…' }}
          </span>
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

.plugin-card__source-name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.plugin-market__source-select {
  width: 260px;
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

/* 按钮处于禁用状态的原因，靠左显示、不与按钮混在一起 */
.plugin-preview__footer-hint {
  margin-right: auto;
  align-self: center;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
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

<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Component, ComponentPublicInstance } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import { useAppStore } from '@/stores/appStore'
import { useTabStore } from '@/stores/tabStore'
import { useDictStore } from '@/stores/dictStore'
import { useConfigStore } from '@/stores/configStore'
import { useLogStore } from '@/stores/logStore'
import { EventsOn } from '@/api/runtime'
import { TOOLS, toolOf } from '@/utils/tools'
import { pluginToolOf } from '@/plugins/registry'
import { matchesShortcut, shortcutOf } from '@/utils/shortcuts'
import { parseSidebarView, serializeSidebarView } from '@/utils/sidebarView'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'
import Icon from '@/components/ui/Icon.vue'
import Button from '@/components/ui/Button.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import ToolPickerDialog from '@/components/ToolPickerDialog.vue'
import SettingsView from '@/views/SettingsView.vue'
import PluginManagerView from '@/views/plugins/PluginManagerView.vue'
import type { ToolType, WorkbenchTab } from '@/types'

const appStore = useAppStore()
const tabStore = useTabStore()
const dictStore = useDictStore()
const configStore = useConfigStore()
const logStore = useLogStore()

/** 工具图标名（缺省用问号） */
function iconOf(type: string): string {
  return toolOf(type)?.icon ?? 'question'
}

/** 内置单例视图的组件映射 */
const builtinSingletons: Record<string, Component> = {
  plugins: PluginManagerView,
  settings: SettingsView,
}

/** 解析工具类型对应的视图组件（查不到时由调用方降级） */
function componentOf(type: string): Component | undefined {
  return pluginToolOf(type)?.component ?? builtinSingletons[type]
}

/** 当前展示的单例视图类型；为 null 表示正在看标签 */
const singletonType = computed(() => tabStore.activeSingleton)

/** 展示过的单例视图类型：首次切到才挂载，之后常驻 */
const visitedSingletons = ref<ToolType[]>([])

/** 需要渲染的单例视图（取自已访问列表，组件取不到时自然消失） */
const mountedSingletons = computed<Array<{ type: string, component: Component }>>(() =>
  visitedSingletons.value
    .map(type => ({ type, component: componentOf(type) }))
    .filter((item): item is { type: string, component: Component } => Boolean(item.component)))

/** 已完成初始化的单例视图类型 */
const readySingletons = ref<ToolType[]>([])

// 切到单例视图时标记为已访问
watch(
  () => tabStore.activeSingleton,
  (type) => {
    if (type && !visitedSingletons.value.includes(type)) {
      visitedSingletons.value = [...visitedSingletons.value, type]
    }
  },
  { immediate: true },
)

/** 单例视图完成初始化 */
function handleSingletonReady(type: ToolType) {
  if (!readySingletons.value.includes(type)) {
    readySingletons.value = [...readySingletons.value, type]
  }
}

/** 左侧菜单是否收起（状态持久化在 settings.sidebar_view） */
const sidebarCollapsed = computed(
  () => parseSidebarView(configStore.values.sidebar_view).collapsed,
)

/** 切换侧栏收起状态并落盘 */
function toggleSidebar() {
  const state = parseSidebarView(configStore.values.sidebar_view)
  state.collapsed = !state.collapsed
  configStore.set('sidebar_view', serializeSidebarView(state))
}

/** 正在重命名的 Tab ID */
const renamingId = ref<number | null>(null)
/** 重命名输入框的临时值 */
const renameDraft = ref('')
/** 重命名输入框引用（函数式 ref 只记录当前编辑的那个） */
const renameInputRef = ref<HTMLInputElement | null>(null)

function setRenameInputRef(el: Element | ComponentPublicInstance | null) {
  renameInputRef.value = el instanceof HTMLInputElement ? el : null
}
/** 右键菜单锚点坐标 */
const menuPosition = ref({ x: 0, y: 0 })
/** 右键菜单当前作用的 Tab */
const menuTab = ref<WorkbenchTab | null>(null)

/** 拖拽绑定的可变数组：直接操作 store 的 tabs 以保持引用 */
const draggableList = computed({
  get: () => tabStore.tabs,
  set: (value: WorkbenchTab[]) => tabStore.reorder(value),
})

/** Tab 右键菜单项 */
interface TabMenuItem {
  key: string
  label: string
  disabled?: boolean
}

/** 右键菜单项；单例标签不提供重命名 */
const menuItems = computed<TabMenuItem[]>(() => {
  const tab = menuTab.value
  if (!tab) {
    return []
  }
  return [
    { key: 'lock', label: tab.isLocked ? '解锁标签' : '锁定标签' },
    ...(canRename(tab) ? [{ key: 'rename', label: '重命名' }] : []),
    { key: 'close', label: '关闭', disabled: tab.isLocked },
    { key: 'closeOthers', label: '关闭其他' },
    { key: 'closeAll', label: '关闭全部' },
  ]
})

/** 判断 Tab 是否可关闭：锁定状态隐藏关闭按钮 */
function canClose(tab: WorkbenchTab): boolean {
  return !tab.isLocked
}

/** 判断 Tab 是否可重命名（单例标签不允许） */
function canRename(tab: WorkbenchTab): boolean {
  const definition = toolOf(tab.toolType)
  return definition ? definition.multi : true
}

/** 事件监听的取消函数 */
let offQuit: (() => void) | null = null

// ------------------------------------------------------------ 初始加载

onMounted(async () => {
  await Promise.all([
    tabStore.load(),
    dictStore.loadAll(),
  ])

  // 退出前兜底保存
  offQuit = EventsOn('app:before-quit', () => {
    void tabStore.saveNow()
  })
  window.addEventListener('keydown', handleWorkbenchShortcut)
})

onBeforeUnmount(() => {
  offQuit?.()
  window.removeEventListener('keydown', handleWorkbenchShortcut)
})

// ------------------------------------------------------------ 初始化失败

/** 正在重试初始化 */
const retrying = ref(false)

/** 重试初始化，成功后补齐启动时跳过的数据 */
async function handleRetryInit() {
  retrying.value = true
  try {
    const ok = await appStore.retry()
    if (!ok) {
      notify.error(appStore.startup.error || '初始化仍然失败')
      return
    }
    await Promise.all([tabStore.load(), dictStore.loadAll(), configStore.load()])
    logStore.setMaxLines(configStore.logMaxLines)
    notify.success('初始化完成')
  }
  finally {
    retrying.value = false
  }
}

function handleWorkbenchShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented) {
    return
  }
  if (matchesShortcut(event, shortcutOf('new-tab', configStore.values.shortcut_config))) {
    event.preventDefault()
    pickerVisible.value = true
    return
  }
  if (matchesShortcut(event, shortcutOf('close-tab', configStore.values.shortcut_config))) {
    const tab = tabStore.activeTab
    if (tab && !tab.isLocked) {
      event.preventDefault()
      handleClose(tab)
    }
  }
}

// ------------------------------------------------------------ 激活与新建

function handleTabClick(tab: WorkbenchTab) {
  tabStore.setActive(tab.id)
}

/** 工具选择弹窗是否可见（标签栏 + 触发） */
const pickerVisible = ref(false)

/** 选中工具：多例新建标签，单例跳转已有标签 */
function handleToolPicked(type: ToolType) {
  const definition = toolOf(type)
  tabStore.openTool(type, { newInstance: definition?.multi ?? false })
}

// ------------------------------------------------------------ 标签栏滚动

/** 标签滚动容器 */
const tabsScroller = ref<HTMLDivElement | null>(null)
/** 是否还能向左 / 向右滚动（决定两端箭头的显隐） */
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

/** 根据滚动位置更新箭头显隐 */
function updateTabsScrollState() {
  const el = tabsScroller.value
  if (!el) {
    canScrollLeft.value = false
    canScrollRight.value = false
    return
  }
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

/** 标签栏滚轮：纵向滚动量转为横向滚动 */
function handleTabsWheel(event: WheelEvent) {
  if (event.deltaY === 0 || event.shiftKey) {
    return
  }
  event.preventDefault()
  tabsScroller.value?.scrollBy({ left: event.deltaY })
}

/** 点击箭头滚动，步长约为可视宽度的 60% */
function scrollTabs(direction: 1 | -1) {
  const el = tabsScroller.value
  if (!el) {
    return
  }
  el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.6), behavior: 'smooth' })
}

/** 标签数量变化后重新判定是否溢出 */
watch(
  () => tabStore.tabs.map(tab => tab.uid).join(','),
  async () => {
    await nextTick()
    updateTabsScrollState()
  },
)

/** 激活标签变化后把它滚入可视区 */
watch(
  () => tabStore.activeId,
  async () => {
    await nextTick()
    updateTabsScrollState()
    tabsScroller.value
      ?.querySelector('.workbench__tab--active')
      ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  },
)

/** 容器尺寸变化也会改变是否溢出 */
let tabsResizeObserver: ResizeObserver | null = null

onMounted(() => {
  tabsResizeObserver = new ResizeObserver(() => updateTabsScrollState())
  if (tabsScroller.value) {
    tabsResizeObserver.observe(tabsScroller.value)
  }
  updateTabsScrollState()
})

onBeforeUnmount(() => {
  tabsResizeObserver?.disconnect()
  tabsResizeObserver = null
})

// ------------------------------------------------------------ 重命名

function startRename(tab: WorkbenchTab) {
  // 单例标签不允许改名：双击与右键菜单都拦在这里
  if (!canRename(tab)) {
    return
  }
  renamingId.value = tab.id
  renameDraft.value = tab.name
  void nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

function commitRename() {
  if (renamingId.value === null) {
    return
  }
  tabStore.renameTab(renamingId.value, renameDraft.value)
  renamingId.value = null
}

function cancelRename() {
  renamingId.value = null
}

// ------------------------------------------------------------ 右键菜单

function openContextMenu(event: MouseEvent, tab: WorkbenchTab) {
  event.preventDefault()
  menuTab.value = tab
  menuPosition.value = { x: event.clientX, y: event.clientY }
}

function handleMenuSelect(key: string) {
  const tab = menuTab.value
  if (!tab) {
    return
  }

  switch (key) {
    case 'lock':
      tabStore.toggleLock(tab.id)
      break
    case 'rename':
      startRename(tab)
      break
    case 'close':
      handleClose(tab)
      break
    case 'closeOthers':
      tabStore.closeOthers(tab.id)
      break
    case 'closeAll':
      handleCloseAll()
      break
    default:
      break
  }
  menuTab.value = null
}

// ------------------------------------------------------------ 关闭

function handleClose(tab: WorkbenchTab) {
  if (tab.isLocked) {
    notify.warning('标签已锁定，请先解锁')
    return
  }
  tabStore.closeTab(tab.id)
}

async function handleCloseAll() {
  if (tabStore.closableTabs.length === 0) {
    return
  }
  // 用户取消是正常分支
  const confirmed = await askConfirm({
    message: '确定要关闭全部未锁定的标签吗？',
    title: '关闭全部',
    confirmText: '关闭',
  })
  if (!confirmed) {
    return
  }
  tabStore.closeAll()
}

// ------------------------------------------------------------ 内容区

/** 保存工具状态（显式传 tabId，避免异步回调写错标签） */
function handlePayloadChange(tabId: number, payload: unknown) {
  tabStore.updatePayload(tabId, payload)
}

/** 空 payload 常量（模板中复用同一引用） */
const EMPTY_PAYLOAD: Record<string, unknown> = {}

/** 各标签的 payload 快照，只在该标签被激活时刷新一次 */
const payloadCache = shallowRef<Record<string, Record<string, unknown>>>({})

/** 取某标签的 payload 快照 */
function payloadOf(uid: string): Record<string, unknown> {
  return payloadCache.value[uid] ?? EMPTY_PAYLOAD
}

/** 已挂载过的标签 uid（内容区常驻挂载，关闭时清理） */
const mountedTabUids = ref<string[]>([])

/** 需要渲染内容的标签，保持标签栏顺序 */
const mountedTabs = computed(() =>
  tabStore.tabs.filter(tab => mountedTabUids.value.includes(tab.uid)),
)

/** 插件不可用时的占位视图 */
const MissingToolView = defineComponent({
  name: 'MissingToolView',
  inheritAttrs: false,
  props: {
    toolLabel: { type: String, default: '' },
  },
  setup(props) {
    return () => h('div', { class: 'workbench__missing' }, [
      h(Icon, { name: 'alert-triangle' }),
      h('span', `工具「${props.toolLabel}」当前不可用：对应的插件已被停用或卸载，请到「插件市场」中启用或重新安装。`),
    ])
  },
})

/** 需要渲染的标签及其组件（component 为空时由占位视图兜底） */
const renderedTabs = computed(() =>
  mountedTabs.value.map(tab => ({
    tab,
    component: componentOf(tab.toolType),
    label: toolOf(tab.toolType)?.label ?? tab.toolType,
  })),
)

/** 激活标签：记录 payload 快照（供挂载时恢复状态）并标记为需要挂载 */
watch(
  () => tabStore.activeId,
  (id) => {
    if (id === null) {
      return
    }
    const tab = tabStore.tabs.find(item => item.id === id)
    if (!tab) {
      return
    }

    let parsed: Record<string, unknown> = EMPTY_PAYLOAD
    try {
      const value = JSON.parse(tab.payload || '{}')
      if (value && typeof value === 'object') {
        parsed = value as Record<string, unknown>
      }
    }
    catch {
      parsed = EMPTY_PAYLOAD
    }
    payloadCache.value = { ...payloadCache.value, [tab.uid]: parsed }

    if (!mountedTabUids.value.includes(tab.uid)) {
      mountedTabUids.value = [...mountedTabUids.value, tab.uid]
    }
  },
  { immediate: true },
)

/** 标签被关闭时清理挂载标记与 payload 快照 */
watch(
  () => tabStore.tabs.map(tab => tab.uid).join(','),
  () => {
    const alive = new Set(tabStore.tabs.map(tab => tab.uid))
    mountedTabUids.value = mountedTabUids.value.filter(uid => alive.has(uid))
    readyTabUids.value = readyTabUids.value.filter(uid => alive.has(uid))

    const nextCache: Record<string, Record<string, unknown>> = {}
    for (const uid of Object.keys(payloadCache.value)) {
      if (alive.has(uid)) {
        nextCache[uid] = payloadCache.value[uid]
      }
    }
    payloadCache.value = nextCache
  },
)

/** 已完成首次初始化的标签 uid（未就绪时遮挡内容区） */
const readyTabUids = ref<string[]>([])

/** 当前展示的视图是否已就绪；空白标签直接视为就绪 */
const activeReady = computed(() => {
  const singleton = tabStore.activeSingleton
  if (singleton) {
    return readySingletons.value.includes(singleton)
  }
  const tab = tabStore.activeTab
  if (!tab || !toolOf(tab.toolType)) {
    return true
  }
  return readyTabUids.value.includes(tab.uid)
})

/** 视图上报初始化完成 */
function handleTabReady(uid: string) {
  if (!readyTabUids.value.includes(uid)) {
    readyTabUids.value = [...readyTabUids.value, uid]
  }
}

/** 插件视图挂载即视为就绪 */
function handlePluginSingletonMounted(type: ToolType): void {
  if (pluginToolOf(type)) {
    handleSingletonReady(type)
  }
}

function handlePluginTabMounted(tab: { uid: string, toolType: ToolType }): void {
  if (pluginToolOf(tab.toolType)) {
    handleTabReady(tab.uid)
  }
}
</script>

<template>
  <section class="workbench">
    <!-- 左：菜单 -->
    <AppSidebar :collapsed="sidebarCollapsed" />

    <!-- 右：标签栏 + 内容 -->
    <div class="workbench__main">
      <div class="workbench__bar">
        <!-- 菜单缩进按钮 -->
        <button
          class="workbench__icon-btn"
          type="button"
          :title="sidebarCollapsed ? '展开菜单' : '收起菜单'"
          @click="toggleSidebar"
        >
          <Icon :name="sidebarCollapsed ? 'chevrons-right' : 'chevrons-left'" />
        </button>

        <!-- 新建：打开工具选择弹窗 -->
        <button
          class="workbench__icon-btn"
          type="button"
          title="新建标签（选择工具）"
          @click="pickerVisible = true"
        >
          <Icon name="plus" />
        </button>

        <span class="workbench__divider" aria-hidden="true" />

        <!-- 标签列表：横向滚动 + 拖拽排序 -->
        <div class="workbench__tabs-wrap">
          <div
            ref="tabsScroller"
            class="workbench__tabs"
            @wheel="handleTabsWheel"
            @scroll.passive="updateTabsScrollState"
          >
            <VueDraggable
              v-model="draggableList"
              class="workbench__tabs-list"
              :animation="150"
              ghost-class="workbench__tab--ghost"
              handle=".workbench__tab"
            >
          <div
            v-for="tab in tabStore.tabs"
            :key="tab.uid"
            class="workbench__tab"
            :class="{
              'workbench__tab--active': tab.id === tabStore.activeId,
              'workbench__tab--locked': tab.isLocked,
            }"
            @click="handleTabClick(tab)"
            @dblclick.stop="startRename(tab)"
            @contextmenu="openContextMenu($event, tab)"
          >
            <Icon
              v-if="toolOf(tab.toolType)"
              class="workbench__tab-icon"
              :name="iconOf(tab.toolType)"
            />
            <Icon v-if="tab.isLocked" name="lock" class="workbench__tab-icon" />

            <input
              v-if="renamingId === tab.id"
              :ref="setRenameInputRef"
              v-model="renameDraft"
              class="workbench__tab-input"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            >
            <span v-else class="workbench__tab-name">{{ tab.name }}</span>

            <Icon
              v-if="canClose(tab)"
              name="close"
              class="workbench__tab-close"
              @click.stop="handleClose(tab)"
            />
          </div>
            </VueDraggable>
          </div>

          <!-- 溢出时的滚动箭头，悬浮在标签两端 -->
          <button
            v-if="canScrollLeft"
            class="workbench__scroll-btn is-left"
            type="button"
            title="向左滚动"
            @click="scrollTabs(-1)"
          >
            <Icon name="arrow-left" />
          </button>
          <button
            v-if="canScrollRight"
            class="workbench__scroll-btn is-right"
            type="button"
            title="向右滚动"
            @click="scrollTabs(1)"
          >
            <Icon name="arrow-right" />
          </button>
        </div>
      </div>

      <!-- 初始化失败（degraded）时的提示与重试入口 -->
      <div
        v-if="appStore.degraded"
        class="flex flex-none items-center gap-2 border-b border-danger/35 bg-danger/10 px-4 py-2 text-sm text-danger"
      >
        <Icon name="alert-triangle" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate" :title="appStore.startup.error">
          初始化失败，本地数据（连接 / 模板 / 词典 / 设置）暂不可用：{{ appStore.startup.error || '未知原因' }}
        </span>
        <Button variant="danger" size="sm" :loading="retrying" @click="handleRetryInit">
          重试初始化
        </Button>
      </div>

      <!-- 内容区：单例视图与标签二选一展示（v-show 常驻挂载） -->
      <div class="workbench__body">
        <!-- 单例视图：不进标签栏，由侧边栏直接切换 -->
        <template v-for="view in mountedSingletons" :key="view.type">
          <component
            :is="view.component"
            v-show="singletonType === view.type"
            @ready="handleSingletonReady(view.type)"
            @vue:mounted="handlePluginSingletonMounted(view.type)"
            />
        </template>

        <template v-if="renderedTabs.length">
          <template v-for="item in renderedTabs" :key="item.tab.uid">
            <!-- 标签：组件不可用时渲染占位组件 -->
            <component
              :is="item.component ?? MissingToolView"
              v-show="item.tab.id === tabStore.activeId"
              :tab-id="item.tab.id"
              :initial-payload="payloadOf(item.tab.uid)"
              :tool-label="item.label"
              @change="handlePayloadChange"
              @ready="handleTabReady(item.tab.uid)"
              @vue:mounted="handlePluginTabMounted(item.tab)"
            />
          </template>
        </template>

        <!-- 首次初始化遮罩 -->
        <Transition name="workbench-loading">
          <div v-if="!activeReady" class="workbench__loading">
            <span class="workbench__loading-spinner" aria-hidden="true" />
            <span class="workbench__loading-text">正在加载…</span>
          </div>
        </Transition>
      </div>

    </div>

    <!-- 工具选择弹窗 -->
    <ToolPickerDialog v-model:visible="pickerVisible" @select="handleToolPicked" />

    <!-- Tab 右键菜单（Teleport 到 body） -->
    <Teleport to="body">
      <div
        v-if="menuTab"
        class="workbench__menu-mask"
        @mousedown="menuTab = null"
        @contextmenu.prevent="menuTab = null"
      />
      <ul
        v-if="menuTab"
        class="workbench__menu"
        :style="{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }"
      >
        <li
          v-for="item in menuItems"
          :key="item.key"
          class="workbench__menu-item"
          :class="{ 'is-disabled': item.disabled }"
          @click="handleMenuSelect(item.key)"
        >
          {{ item.label }}
        </li>
      </ul>
    </Teleport>
  </section>
</template>

<style scoped>
.workbench {
  display: flex;
  flex-direction: row;
  height: 100%;
  overflow: hidden;
}

.workbench__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* ------------------------------------------------------------ 标签栏 */

/* 标签栏：透明底 + 分隔线，高度固定 44px */
.workbench__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 44px;
  height: 44px;
  padding: 0 8px;
  background: transparent;
  border-bottom: 1px solid var(--border-color);
}

.workbench__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: calc(28px * var(--app-control-scale));
  height: calc(28px * var(--app-control-scale));
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size-xl);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.workbench__icon-btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.workbench__divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border-color);
}

/* 滚动容器外层：同时是滚动箭头的定位父级 */
.workbench__tabs-wrap {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

/* 标签滚动容器：溢出时横向滚动；滚动条隐藏，靠滚轮 / 箭头 / 自动滚入触达 */
.workbench__tabs {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.workbench__tabs::-webkit-scrollbar {
  display: none;
}

.workbench__tabs-list {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 溢出时的两端箭头：悬浮在标签之上并带同色渐隐，不占布局宽度 */
.workbench__scroll-btn {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}

.workbench__scroll-btn:hover {
  color: var(--text-color);
}

.workbench__scroll-btn.is-left {
  left: 0;
  background: linear-gradient(90deg, var(--panel-bg), transparent);
}

.workbench__scroll-btn.is-right {
  right: 0;
  background: linear-gradient(270deg, var(--panel-bg), transparent);
}

.workbench__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: calc(34px * var(--app-control-scale));
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-muted);
  font-size: var(--app-font-size);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  user-select: none;
}

.workbench__tab:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.workbench__tab--active {
  background: var(--active-bg);
  border-color: var(--brand-color);
  color: var(--text-color);
}

.workbench__tab--ghost {
  opacity: 0.4;
}

.workbench__tab-icon {
  font-size: var(--app-font-size-sm);
  color: var(--text-muted);
}

.workbench__tab-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench__tab-input {
  width: 120px;
  height: calc(22px * var(--app-control-scale));
  padding: 0 4px;
  border: 1px solid var(--brand-color);
  border-radius: 4px;
  background: var(--bg-color);
  color: var(--text-color);
  font-size: var(--app-font-size);
  outline: none;
}

.workbench__tab-close {
  font-size: var(--app-font-size-sm);
  border-radius: 50%;
  padding: 2px;
}

.workbench__tab-close:hover {
  background: rgba(248, 113, 113, 0.25);
  color: var(--danger-color);
}

/* ------------------------------------------------------------ 内容区 */

.workbench__body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 首次初始化遮罩：底色立即生效，转圈与文案延迟淡入 */
.workbench__loading {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  background: rgb(var(--bg-rgb) / 0.96);
}

.workbench__loading-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-color);
  border-top-color: var(--brand-color);
  border-radius: 50%;
  animation:
    workbench-loading-in 0.2s ease 0.25s both,
    workbench-spin 0.8s linear infinite;
}

/* 插件被停用/卸载后遗留的历史标签 */
.workbench__missing {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 24px;
  color: var(--text-muted);
  font-size: var(--app-font-size);
  text-align: center;
}

.workbench__loading-text {
  animation: workbench-loading-in 0.2s ease 0.25s both;
}

/* 就绪后淡出 200ms 再移除，期间不拦截点击 */
.workbench-loading-leave-active {
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.workbench-loading-leave-to {
  opacity: 0;
}

@keyframes workbench-loading-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes workbench-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ------------------------------------------------------------ 右键菜单 */

.workbench__menu-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.workbench__menu {
  position: fixed;
  z-index: 2001;
  min-width: 160px;
  margin: 0;
  padding: 6px;
  list-style: none;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-menu);
  /* 底色不透明，靠阴影区分层级即可 */
  box-shadow: var(--shadow-md);
  user-select: none;
}

.workbench__menu-item {
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--text-color);
  font-size: var(--app-font-size);
  cursor: pointer;
}

.workbench__menu-item:hover:not(.is-disabled) {
  background: var(--active-bg);
}

.workbench__menu-item.is-disabled {
  color: var(--text-muted);
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

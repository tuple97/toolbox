<script setup lang="ts">
/** 左侧菜单：市场固定在最上，插件工具扁平直出，隐藏项收进「更多」面板，底部为设置与编辑入口。 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import Icon from '@/components/ui/Icon.vue'
import { useTabStore } from '@/stores/tabStore'
import { useConfigStore } from '@/stores/configStore'
import {
  SIDEBAR_FIXED_SETTINGS,
  SIDEBAR_FIXED_TOP,
  SIDEBAR_PLUGIN_TOOLS,
  toolOf,
} from '@/utils/tools'
import type { ToolType } from '@/types'

const props = defineProps<{
  /** 是否收起 */
  collapsed: boolean
}>()

const tabStore = useTabStore()
const configStore = useConfigStore()

/** 工具图标名 */
function iconOf(type: string): string {
  return toolOf(type)?.icon ?? 'question'
}

// ------------------------------------------------------------ 菜单配置（排序 / 显示）

/** 菜单配置，持久化在 settings.sidebar_config */
interface SidebarConfig {
  /** 插件工具的整体顺序 */
  order: ToolType[]
  /** 被隐藏的工具 */
  hidden: ToolType[]
}

/** 插件工具的默认顺序（插件声明 order 排序） */
function defaultOrder(): ToolType[] {
  return SIDEBAR_PLUGIN_TOOLS.filter(type => type !== SIDEBAR_FIXED_TOP && type !== SIDEBAR_FIXED_SETTINGS)
}

/** 解析并校正持久化配置 */
function parseSidebarConfig(raw: string | undefined): SidebarConfig {
  const fallback = defaultOrder()
  const config: SidebarConfig = { order: fallback, hidden: [] }
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<SidebarConfig>
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden : []
    // 固定入口不参与隐藏
    config.hidden = hidden.filter(
      type => toolOf(type)
        && type !== SIDEBAR_FIXED_TOP
        && type !== SIDEBAR_FIXED_SETTINGS,
    )

    const saved = Array.isArray(parsed.order) ? parsed.order : []
    if (saved.length > 0) {
      // 保留用户顺序，新插件补在末尾
      config.order = [
        ...saved.filter(type => fallback.includes(type)),
        ...fallback.filter(type => !saved.includes(type)),
      ]
    }
  }
  catch {
    // 配置损坏时回退默认
  }
  return config
}

function serializeSidebarConfig(config: SidebarConfig): string {
  return JSON.stringify({ order: config.order, hidden: config.hidden })
}

/** 持久化的菜单配置 */
const sidebarConfig = computed(() => parseSidebarConfig(configStore.values.sidebar_config))

/** 正常模式下展示的工具（按用户顺序，去掉隐藏项） */
const visibleTools = computed(() =>
  sidebarConfig.value.order.filter(type => !sidebarConfig.value.hidden.includes(type)),
)

/** 被隐藏的工具（「更多」面板展示） */
const hiddenTools = computed(() =>
  sidebarConfig.value.order.filter(type => sidebarConfig.value.hidden.includes(type)),
)

// ------------------------------------------------------------ 编辑态

const editing = ref(false)
/** 编辑草稿：点「完成」才落盘 */
const draftOrder = ref<ToolType[]>([])
const draftHidden = ref<ToolType[]>([])

// 收起时退出编辑态并丢弃草稿
watch(() => props.collapsed, (now) => {
  if (now && editing.value) {
    editing.value = false
    closeMore()
  }
})

function enterEdit(): void {
  const config = parseSidebarConfig(configStore.values.sidebar_config)
  draftOrder.value = [...config.order]
  draftHidden.value = [...config.hidden]
  editing.value = true
  closeMore()
}

/** 草稿恢复为默认 */
function resetDraft(): void {
  draftOrder.value = defaultOrder()
  draftHidden.value = []
}

function finishEdit(): void {
  editing.value = false
  configStore.set('sidebar_config', serializeSidebarConfig({
    order: draftOrder.value,
    hidden: draftHidden.value,
  }))
}

function toggleDraftHidden(type: ToolType): void {
  draftHidden.value = draftHidden.value.includes(type)
    ? draftHidden.value.filter(item => item !== type)
    : [...draftHidden.value, type]
}

// ------------------------------------------------------------ 「更多」面板

const moreOpen = ref(false)
/** 「更多」按钮与面板各自的位置参照 */
const moreButtonRef = ref<HTMLElement | null>(null)
const morePanelRef = ref<HTMLElement | null>(null)

/** 面板坐标（fixed 定位，相对视口） */
const morePos = ref({ left: 0, top: 0, maxHeight: 0 })

/** 面板是否已就位 */
const moreReady = ref(false)

/** 退出编辑后还有没有隐藏项：决定「更多」是否出现 */
const showMore = computed(() => !editing.value && hiddenTools.value.length > 0)

/** 计算面板坐标与高度上限 */
function syncMorePosition(): void {
  const button = moreButtonRef.value
  if (!button) {
    return
  }
  const rect = button.getBoundingClientRect()
  const margin = 8

  // 顶部工具栏下沿：面板最高可达位置
  const titlebarHeight = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height'),
  ) || 48
  const topLimit = titlebarHeight + margin
  const bottomLimit = window.innerHeight - margin

  const panelWidth = morePanelRef.value?.offsetWidth
    ?? Math.round(168 * (Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--app-control-scale'),
    ) || 1))
  const panelHeight = morePanelRef.value?.offsetHeight ?? 0

  // 右侧放不下就翻到按钮左边
  const preferLeft = rect.right + 2
  const fitsRight = preferLeft + panelWidth <= window.innerWidth - margin
  const left = fitsRight
    ? preferLeft
    : Math.max(margin, rect.left - panelWidth - 2)

  // 与按钮底部对齐时的可用高度
  const availableHeight = Math.max(120, bottomLimit - topLimit)

  // 首帧面板未渲染时按可用高度预估，避免越界判断出错
  const estimatedHeight = panelHeight || Math.min(availableHeight, 240)
  const alignedTop = rect.bottom - estimatedHeight
  const overflowsTop = alignedTop < topLimit

  // 越界就贴工具栏下沿，否则与按钮底部对齐
  const top = overflowsTop ? topLimit : alignedTop
  // 高度上限：顶部到窗口底部
  const maxHeight = Math.max(120, bottomLimit - top)

  morePos.value = { left, top, maxHeight }
  moreReady.value = true
}

function toggleMore(): void {
  if (moreOpen.value) {
    closeMore()
    return
  }
  // 先粗算一次，打开后再按真实宽度校正
  syncMorePosition()
  moreOpen.value = true
  void nextTick(() => {
    if (moreOpen.value) {
      syncMorePosition()
    }
  })
}

function closeMore(): void {
  moreOpen.value = false
  moreReady.value = false
}

/** 点击面板与按钮以外处收起面板 */
function handleOutside(event: PointerEvent): void {
  if (!moreOpen.value) {
    return
  }
  const target = event.target
  if (!(target instanceof Node)) {
    return
  }
  if (moreButtonRef.value?.contains(target)) {
    return
  }
  if (morePanelRef.value?.contains(target)) {
    return
  }
  closeMore()
}

// 布局变化时重新定位面板
function handleLayoutChange(): void {
  if (moreOpen.value) {
    syncMorePosition()
  }
}

watch(moreOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', handleOutside, true)
    window.addEventListener('resize', handleLayoutChange)
    window.addEventListener('scroll', handleLayoutChange, true)
  }
  else {
    document.removeEventListener('pointerdown', handleOutside, true)
    window.removeEventListener('resize', handleLayoutChange)
    window.removeEventListener('scroll', handleLayoutChange, true)
  }
})

// 内容变化后在下一帧重算滚动状态
watch(
  () => [visibleTools.value.length, draftOrder.value.length, editing.value, props.collapsed],
  () => void nextTick(syncScrollState),
  { immediate: true },
)

watch(() => props.collapsed, handleLayoutChange)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutside, true)
  window.removeEventListener('resize', handleLayoutChange)
  window.removeEventListener('scroll', handleLayoutChange, true)
})

/** 面板里的项被点走之后收起面板 */
function selectFromMore(type: ToolType): void {
  closeMore()
  handleSelect(type)
}

// ------------------------------------------------------------ 菜单滚动

// 菜单超出高度时，两端浮出「…」提示，悬停自动滚动

const navRef = ref<HTMLElement | null>(null)
/** 上方 / 下方是否还有未显示的内容 */
const canScrollUp = ref(false)
const canScrollDown = ref(false)

/** 每次自动滚动的步长与间隔（毫秒） */
const SCROLL_STEP = 14
const SCROLL_INTERVAL = 24

let scrollTimer: number | null = null

/** 重新计算两端是否还有内容 */
function syncScrollState(): void {
  const nav = navRef.value
  if (!nav) {
    canScrollUp.value = false
    canScrollDown.value = false
    return
  }
  // 1px 容差：缩放比例非整数时 scrollTop 会有小数
  canScrollUp.value = nav.scrollTop > 1
  canScrollDown.value = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1
}

/** 停止自动滚动 */
function stopAutoScroll(): void {
  if (scrollTimer !== null) {
    window.clearInterval(scrollTimer)
    scrollTimer = null
  }
}

/** 鼠标停在提示块上时持续滚动（direction 为 -1 / 1） */
function startAutoScroll(direction: -1 | 1): void {
  stopAutoScroll()
  const nav = navRef.value
  if (!nav) {
    return
  }
  scrollTimer = window.setInterval(() => {
    const target = navRef.value
    if (!target) {
      stopAutoScroll()
      return
    }
    const atEdge = direction < 0
      ? target.scrollTop <= 0
      : target.scrollTop + target.clientHeight >= target.scrollHeight - 1
    if (atEdge) {
      stopAutoScroll()
      syncScrollState()
      return
    }
    target.scrollTop += direction * SCROLL_STEP
    syncScrollState()
  }, SCROLL_INTERVAL)
}

onBeforeUnmount(stopAutoScroll)

// ------------------------------------------------------------ 交互

/** 当前激活标签承载的工具类型 */
const activeToolType = computed(() => tabStore.activeTab?.toolType ?? '')

/** 菜单项是否高亮 */
function isActive(type: ToolType): boolean {
  const definition = toolOf(type)
  if (definition && !definition.multi) {
    return tabStore.activeSingleton === type
  }
  return activeToolType.value === type
}

/** 菜单项悬浮提示 */
function titleOf(type: ToolType): string {
  const definition = toolOf(type)
  if (!definition) {
    return ''
  }
  return definition.multi
    ? `${definition.description}；点击在实例标签间切换`
    : definition.description
}

/** 点击菜单项：单例跳转，多例在同类标签间轮转 */
function handleSelect(type: ToolType): void {
  // 编辑态点击不跳转
  if (editing.value) {
    return
  }

  const definition = toolOf(type)
  if (!definition) {
    return
  }

  if (!definition.multi) {
    tabStore.openTool(type)
    return
  }

  const sameKind = tabStore.tabs.filter(tab => tab.toolType === type)
  if (sameKind.length === 0) {
    tabStore.openTool(type, { newInstance: true })
    return
  }

  const currentIndex = sameKind.findIndex(tab => tab.id === tabStore.activeId)
  const next = currentIndex === -1
    ? sameKind[0]
    : sameKind[(currentIndex + 1) % sameKind.length]
  tabStore.setActive(next.id)
}

/** 多例工具：新建一个实例 */
function handleNewInstance(type: ToolType): void {
  tabStore.openTool(type, { newInstance: true })
}
</script>

<template>
  <aside class="app-sidebar" :class="{ 'app-sidebar--collapsed': collapsed }">
    <!-- 菜单滚动区：两端浮出「…」提示，悬停自动滚动 -->
    <nav
      ref="navRef"
      class="app-sidebar__nav"
      @scroll.passive="syncScrollState"
    >
      <!-- 编辑态：市场固定在上（不可拖），其余插件工具可拖 -->
      <ul v-if="editing" class="app-sidebar__items">
        <li class="app-sidebar__item is-editing is-fixed">
          <span class="app-sidebar__handle is-static" aria-hidden="true" />
          <Icon class="app-sidebar__icon" :name="iconOf(SIDEBAR_FIXED_TOP)" />
          <span class="app-sidebar__label">{{ toolOf(SIDEBAR_FIXED_TOP)?.label }}</span>
          <!-- 市场固定，不提供隐藏开关 -->
          <span class="app-sidebar__pin" title="固定第一个，不可排序，也不可隐藏">固定</span>
        </li>
      </ul>

      <VueDraggable
        v-if="editing"
        v-model="draftOrder"
        tag="ul"
        class="app-sidebar__items"
        handle=".app-sidebar__handle"
        :animation="220"
        easing="cubic-bezier(0.22, 1, 0.36, 1)"
      >
        <li
          v-for="type in draftOrder"
          :key="type"
          class="app-sidebar__item is-editing"
          :class="{ 'is-hidden': draftHidden.includes(type) }"
        >
          <!-- 拖拽把手：两列圆点，比箭头更准确地表达「可拖动」 -->
          <Icon name="grip" class="app-sidebar__handle" title="拖动排序" />
          <Icon class="app-sidebar__icon" :name="iconOf(type)" />
          <span class="app-sidebar__label">{{ toolOf(type)?.label }}</span>
          <button
            class="app-sidebar__eye"
            type="button"
            :title="draftHidden.includes(type) ? '显示菜单' : '隐藏菜单'"
            @click.stop="toggleDraftHidden(type)"
          >
            <Icon :name="draftHidden.includes(type) ? 'eye-off' : 'eye'" />
          </button>
        </li>
      </VueDraggable>

      <!-- 正常态：扁平直出 -->
      <ul v-else class="app-sidebar__items">
        <li
          class="app-sidebar__item"
          :class="{ 'is-active': isActive(SIDEBAR_FIXED_TOP) }"
          :title="titleOf(SIDEBAR_FIXED_TOP)"
          @click="handleSelect(SIDEBAR_FIXED_TOP)"
        >
          <Icon class="app-sidebar__icon" :name="iconOf(SIDEBAR_FIXED_TOP)" />
          <span class="app-sidebar__label">{{ toolOf(SIDEBAR_FIXED_TOP)?.label }}</span>
        </li>

        <li
          v-for="type in visibleTools"
          :key="type"
          class="app-sidebar__item"
          :class="{ 'is-active': isActive(type) }"
          :title="titleOf(type)"
          @click="handleSelect(type)"
        >
          <Icon class="app-sidebar__icon" :name="iconOf(type)" />
          <span class="app-sidebar__label">{{ toolOf(type)?.label }}</span>

          <!-- 多例工具：新建实例 -->
          <button
            v-if="toolOf(type)?.multi"
            class="app-sidebar__add"
            type="button"
            title="新建实例"
            @click.stop="handleNewInstance(type)"
          >
            <Icon name="plus" />
          </button>
        </li>
      </ul>

      <!--「更多」按钮：面板本体 Teleport 到 body（见下方），这里只放按钮-->
      <div v-if="showMore" class="app-sidebar__more">
        <button
          ref="moreButtonRef"
          class="app-sidebar__more-btn"
          :class="{ 'is-open': moreOpen }"
          type="button"
          title="显示已隐藏的菜单"
          @click="toggleMore"
        >
          <Icon name="more" class="app-sidebar__icon" />
          <span class="app-sidebar__label">更多</span>
          <span class="app-sidebar__more-count">{{ hiddenTools.length }}</span>
        </button>
      </div>

      <!-- 顶部溢出提示：还有内容在上方 -->
      <button
        v-if="canScrollUp"
        class="app-sidebar__scroll-hint is-up"
        type="button"
        title="向上滚动"
        @mouseenter="startAutoScroll(-1)"
        @mouseleave="stopAutoScroll"
      >
        <Icon name="chevron-up" />
      </button>

      <!-- 底部溢出提示：还有内容在下方 -->
      <button
        v-if="canScrollDown"
        class="app-sidebar__scroll-hint is-down"
        type="button"
        title="向下滚动"
        @mouseenter="startAutoScroll(1)"
        @mouseleave="stopAutoScroll"
      >
        <Icon name="chevron-down" />
      </button>
    </nav>

    <!--
      二级面板。

      Teleport 到 body + fixed 定位：侧栏根部是 overflow: hidden（收起动画需要），
      面板留在侧栏里就会被裁掉、也盖不到内容区。放到 body 之后：
        - 不受侧栏裁剪，能正常盖在右侧内容上；
        - 仍是普通 div（不是对话框、不带遮罩），点击面板外由 pointerdown 收起。

      层级取 3000：高于侧栏与内容，低于 Dialog（9990 起）——
      打开弹窗时面板不该压在弹窗上面。
    -->
    <Teleport to="body">
      <div
        v-if="moreOpen && moreReady"
        ref="morePanelRef"
        class="app-sidebar__more-panel"
        :style="{
          left: `${morePos.left}px`,
          top: `${morePos.top}px`,
          maxHeight: morePos.maxHeight ? `${morePos.maxHeight}px` : undefined,
        }"
      >
        <ul class="app-sidebar__more-list">
          <li
            v-for="type in hiddenTools"
            :key="type"
            class="app-sidebar__item app-sidebar__item--panel"
            :class="{ 'is-active': isActive(type) }"
            :title="titleOf(type)"
            @click="selectFromMore(type)"
          >
            <Icon class="app-sidebar__icon" :name="iconOf(type)" />
            <span class="app-sidebar__label">{{ toolOf(type)?.label }}</span>
          </li>
        </ul>
      </div>
    </Teleport>

    <!--
      底部操作区（收起态整体不显示）：设置作为图标按钮贴左，编辑按钮贴右。
    -->
    <footer v-if="!collapsed" class="app-sidebar__footer">
      <template v-if="editing">
        <button
          class="app-sidebar__footer-btn is-icon"
          type="button"
          title="打开设置"
          @click="handleSelect(SIDEBAR_FIXED_SETTINGS)"
        >
          <Icon :name="iconOf(SIDEBAR_FIXED_SETTINGS)" />
        </button>
        <span class="app-sidebar__footer-spacer" />
        <button class="app-sidebar__footer-btn" type="button" @click="resetDraft">
          恢复默认
        </button>
        <button
          class="app-sidebar__footer-btn is-primary"
          type="button"
          title="保存排序与显示设置"
          @click="finishEdit"
        >
          完成
        </button>
      </template>
      <template v-else>
        <button
          class="app-sidebar__footer-btn is-icon"
          type="button"
          title="打开设置"
          @click="handleSelect(SIDEBAR_FIXED_SETTINGS)"
        >
          <Icon :name="iconOf(SIDEBAR_FIXED_SETTINGS)" />
        </button>
        <span class="app-sidebar__footer-spacer" />
        <button
          class="app-sidebar__footer-btn"
          type="button"
          title="编辑菜单排序与显示"
          @click="enterEdit"
        >
          <Icon name="pencil" />
        </button>
      </template>
    </footer>
  </aside>
</template>

<style scoped>
.app-sidebar {
  display: flex;
  flex-direction: column;
  flex: 0 0 var(--sidebar-width);
  width: var(--sidebar-width);
  min-width: 0;
  overflow: hidden;
  background: var(--panel-bg);
  border-right: 1px solid var(--border-color);
  transition: flex-basis 0.18s ease, width 0.18s ease;
}

/* ------------------------------------------------------------ 收起态（图标栏） */

.app-sidebar--collapsed {
  flex-basis: var(--sidebar-width-collapsed);
  width: var(--sidebar-width-collapsed);
}

.app-sidebar--collapsed .app-sidebar__nav {
  padding: 10px 6px;
}

/* 收起态只剩图标：名称、把手、眼睛、计数都隐藏 */
.app-sidebar--collapsed .app-sidebar__label,
.app-sidebar--collapsed .app-sidebar__add,
.app-sidebar--collapsed .app-sidebar__handle,
.app-sidebar--collapsed .app-sidebar__eye,
.app-sidebar--collapsed .app-sidebar__pin,
.app-sidebar--collapsed .app-sidebar__more-count {
  display: none;
}

.app-sidebar--collapsed .app-sidebar__item {
  justify-content: center;
  padding: 0;
}

/* 收起态的「更多」按钮同样只剩图标，并把计数点收掉 */
.app-sidebar--collapsed .app-sidebar__more-btn {
  justify-content: center;
  padding: 0;
}

.app-sidebar__nav {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  padding: 10px 8px;
  overflow-y: auto;
  /* 滚动提示块要盖在列表上，这里给它一个定位参照 */
  isolation: isolate;
}

/* ------------------------------------------------------------ 滚动提示块 */

/* 「…」提示块：绝对定位叠在列表两端，不占布局高度 */
.app-sidebar__scroll-hint {
  position: sticky;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 100%;
  height: 24px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  cursor: pointer;
}

/* 用 sticky 而不是 absolute：块始终贴在滚动区边缘， 内容滚到底时它自然跟着离开，不用 JS 去算位置 */
.app-sidebar__scroll-hint.is-up {
  top: calc(-1 * 10px);
  /* 顶部提示：从导航区上沿向下淡出 */
  background: linear-gradient(to bottom, var(--panel-bg) 30%, transparent);
  border-radius: 0 0 6px 6px;
}

.app-sidebar__scroll-hint.is-down {
  bottom: calc(-1 * 10px);
  /* 底部提示：从下沿向上淡出 */
  background: linear-gradient(to top, var(--panel-bg) 30%, transparent);
  border-radius: 6px 6px 0 0;
}

.app-sidebar__scroll-hint:hover {
  color: var(--text-color);
}

.app-sidebar__items {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 菜单项：扁平直出，左侧缩进与图标对齐 */
.app-sidebar__item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(32px * var(--app-control-scale));
  margin-bottom: 2px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--text-color);
  font-size: var(--app-font-size);
  cursor: pointer;
  user-select: none;
}

.app-sidebar__item:hover {
  background: var(--hover-bg);
}

.app-sidebar__item.is-active {
  background: var(--active-bg);
  color: var(--brand-color);
}

.app-sidebar__icon {
  font-size: var(--app-font-size-lg);
  color: var(--text-muted);
}

.app-sidebar__item.is-active .app-sidebar__icon {
  color: var(--brand-color);
}

.app-sidebar__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 多例工具的新建按钮 */
.app-sidebar__add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: calc(20px * var(--app-control-scale));
  height: calc(20px * var(--app-control-scale));
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s ease, background-color 0.15s ease;
}

.app-sidebar__item:hover .app-sidebar__add {
  opacity: 1;
}

.app-sidebar__add:hover {
  background: var(--brand-color);
  color: var(--color-on-brand);
}

/* ------------------------------------------------------------ 编辑态 */

/* 拖动把手 */
.app-sidebar__handle {
  flex: 0 0 auto;
  color: var(--text-muted);
  opacity: 0.7;
  cursor: grab;
}

.app-sidebar__handle:active {
  cursor: grabbing;
}

/* 固定项不可拖，占位保持对齐 */
.app-sidebar__handle.is-static {
  opacity: 0.2;
  cursor: default;
}

/* 「固定」小标记：说明市场不参与排序 */
.app-sidebar__pin {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--active-bg);
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
}

/* 显示 / 隐藏切换 */
.app-sidebar__eye {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: calc(22px * var(--app-control-scale));
  height: calc(22px * var(--app-control-scale));
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.app-sidebar__eye:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

/* 编辑态不响应跳转；隐藏项变淡 */
.app-sidebar__item.is-editing {
  cursor: default;
}

.app-sidebar__item.is-hidden {
  opacity: 0.45;
}

/* ------------------------------------------------------------ 「更多」与二级面板 */

/* 按钮容器：只负责排版，面板本身已 Teleport 到 body */
.app-sidebar__more {
  flex: 0 0 auto;
  margin-top: 6px;
}

/* 「更多」按钮 */
.app-sidebar__more-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: calc(32px * var(--app-control-scale));
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-color);
  font-size: var(--app-font-size);
  text-align: left;
  cursor: pointer;
}

.app-sidebar__more-btn:hover,
.app-sidebar__more-btn.is-open {
  background: var(--hover-bg);
}

.app-sidebar__more-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--active-bg);
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
  line-height: 16px;
  text-align: center;
}

/* 二级面板：固定定位在「更多」按钮右侧 */
/* 二级面板：固定定位在「更多」按钮旁边 */
.app-sidebar__more-panel {
  position: fixed;
  z-index: 3000;
  min-width: calc(168px * var(--app-control-scale));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--overlay-bg);
  box-shadow: var(--shadow-md);
}

/* 面板里的项：宽度铺满，悬停用更实一点的底色区分 */
.app-sidebar__more-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.app-sidebar__item--panel {
  margin-bottom: 2px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
}

.app-sidebar__item--panel:last-child {
  margin-bottom: 0;
}

.app-sidebar__item--panel:hover {
  background: var(--hover-bg);
}

/* ------------------------------------------------------------ 底部操作区 */

.app-sidebar__footer {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
}

/* 把设置贴左、编辑贴右 */
.app-sidebar__footer-spacer {
  flex: 1;
}

.app-sidebar__footer-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  cursor: pointer;
}

.app-sidebar__footer-btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

/* 纯图标按钮：方形点击区，与文字按钮视觉重量接近 */
.app-sidebar__footer-btn.is-icon {
  width: calc(28px * var(--app-control-scale));
  height: calc(28px * var(--app-control-scale));
  padding: 0;
  font-size: var(--app-font-size-lg);
}

.app-sidebar__footer-btn.is-primary {
  color: var(--brand-color);
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import Icon from '@/components/ui/Icon.vue'
import { useTabStore } from '@/stores/tabStore'
import { useConfigStore } from '@/stores/configStore'
import { TOOL_GROUPS, TOP_LEVEL_TOOLS, toolOf } from '@/utils/tools'
import { parseSidebarView, serializeSidebarView } from '@/utils/sidebarView'
import type { ToolType } from '@/types'

defineProps<{
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
  /** 组 label → 工具顺序 */
  order: Record<string, ToolType[]>
  /** 被隐藏的工具 */
  hidden: ToolType[]
}

/** 解析并校正持久化配置 */
function parseSidebarConfig(raw: string | undefined): SidebarConfig {
  const config: SidebarConfig = { order: {}, hidden: [] }
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<SidebarConfig>
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden : []
    config.hidden = hidden.filter(type => toolOf(type))

    for (const group of TOOL_GROUPS) {
      const saved = parsed.order?.[group.label]
      config.order[group.label] = Array.isArray(saved)
        ? [
            ...saved.filter(type => group.tools.includes(type)),
            ...group.tools.filter(type => !saved.includes(type)),
          ]
        : [...group.tools]
    }
  }
  catch {
    // 配置损坏时回退默认结构
  }
  return config
}

function serializeSidebarConfig(config: SidebarConfig): string {
  return JSON.stringify({ order: config.order, hidden: config.hidden })
}

/** 持久化的菜单配置 */
const sidebarConfig = computed(() => parseSidebarConfig(configStore.values.sidebar_config))

/** 分组实际显示的工具 */
function visibleGroupTools(group: { label: string, tools: ToolType[] }): ToolType[] {
  const order = sidebarConfig.value.order[group.label] ?? [...group.tools]
  return order.filter(type => !sidebarConfig.value.hidden.includes(type))
}

function isGroupVisible(group: { label: string, tools: ToolType[] }): boolean {
  return visibleGroupTools(group).length > 0
}

/** 顶级工具（不分组），排在分组之后贴底渲染 */
const topTools = computed(() => TOP_LEVEL_TOOLS)
const visibleTopTools = computed(() =>
  topTools.value.filter(type => !sidebarConfig.value.hidden.includes(type)),
)

// ------------------------------------------------------------ 编辑态

const editing = ref(false)
/** 编辑草稿：点「完成」才落盘 */
const draftOrder = ref<Record<string, ToolType[]>>({})
const draftHidden = ref<ToolType[]>([])

/**
 * 真正会渲染出来的分组（按显示顺序）。
 *
 * 分隔线只能画在「有内容的两段之间」：一个插件都没有、或者分组被全部隐藏时，
 * 上方什么都没有，这时再画线就会留下悬空的横杠。
 */
const visibleGroupLabels = computed(() =>
  TOOL_GROUPS
    .filter(group => editing.value || isGroupVisible(group))
    .map(group => group.label))

/** 上方是否真的有分组 */
const hasVisibleGroups = computed(() => visibleGroupLabels.value.length > 0)

/**
 * 该分组上方是否还有别的分组（收起态下用它决定要不要画分隔线）。
 *
 * 不能用 CSS 的相邻兄弟选择器：被隐藏的分组仍在 DOM 里，
 * 「前一个隐藏、自己可见」时照样会命中，结果就是线画在空处。
 */
function isDividedGroup(label: string): boolean {
  const labels = visibleGroupLabels.value
  return labels.length > 0 && labels[0] !== label
}

function enterEdit() {
  const config = parseSidebarConfig(configStore.values.sidebar_config)
  const order: Record<string, ToolType[]> = {}
  for (const group of TOOL_GROUPS) {
    order[group.label] = config.order[group.label] ?? [...group.tools]
  }
  draftOrder.value = order
  draftHidden.value = [...config.hidden]
  editing.value = true
}

/** 草稿恢复为默认 */
function resetDraft() {
  for (const group of TOOL_GROUPS) {
    draftOrder.value[group.label] = [...group.tools]
  }
  draftHidden.value = []
}

function finishEdit() {
  editing.value = false
  configStore.set('sidebar_config', serializeSidebarConfig({
    order: draftOrder.value,
    hidden: draftHidden.value,
  }))
}

function toggleDraftHidden(type: ToolType) {
  draftHidden.value = draftHidden.value.includes(type)
    ? draftHidden.value.filter(item => item !== type)
    : [...draftHidden.value, type]
}

/** 展开的分组标签，持久化在 settings.sidebar_view */
const expandedGroups = computed(() =>
  TOOL_GROUPS
    .map(group => group.label)
    .filter(label => !parseSidebarView(configStore.values.sidebar_view).collapsedGroups.includes(label)),
)

/** 切换分组展开状态并落盘 */
function toggleGroup(label: string) {
  const state = parseSidebarView(configStore.values.sidebar_view)
  state.collapsedGroups = state.collapsedGroups.includes(label)
    ? state.collapsedGroups.filter(item => item !== label)
    : [...state.collapsedGroups, label]
  configStore.set('sidebar_view', serializeSidebarView(state))
}

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
function handleSelect(type: ToolType) {
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
function handleNewInstance(type: ToolType) {
  tabStore.openTool(type, { newInstance: true })
}
</script>

<template>
  <aside class="app-sidebar" :class="{ 'app-sidebar--collapsed': collapsed }">
    <nav class="app-sidebar__nav">
      <section
        v-for="group in TOOL_GROUPS"
        :key="group.label"
        v-show="editing || isGroupVisible(group)"
        class="app-sidebar__group"
        :class="{ 'is-divided': isDividedGroup(group.label) }"
      >
        <button
          class="app-sidebar__group-head"
          type="button"
          @click="toggleGroup(group.label)"
        >
          <Icon
            name="chevron-down"
            class="app-sidebar__arrow"
            :class="{ 'is-expanded': expandedGroups.includes(group.label) }"
          />
          <!-- 分组图标由插件在 contributes.sidebar 中声明，未声明时不显示 -->
          <Icon v-if="group.icon" class="app-sidebar__group-icon" :name="group.icon" />
          <span>{{ group.label }}</span>
        </button>

        <!-- 编辑态：拖动排序 + 眼睛控制显示 -->
        <VueDraggable
          v-if="editing"
          v-model="draftOrder[group.label]"
          tag="ul"
          class="app-sidebar__items"
          handle=".app-sidebar__handle"
          :animation="220"
          easing="cubic-bezier(0.22, 1, 0.36, 1)"
        >
          <li
            v-for="type in draftOrder[group.label]"
            :key="type"
            class="app-sidebar__item is-editing"
            :class="{ 'is-hidden': draftHidden.includes(type) }"
          >
            <Icon name="chevron-down" class="app-sidebar__handle" title="拖动排序" />
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

        <!-- 收起态没有分组标题，谈不上展开/收起，一律显示图标 -->
        <ul
          v-else
          v-show="collapsed || expandedGroups.includes(group.label)"
          class="app-sidebar__items"
        >
          <li
            v-for="type in visibleGroupTools(group)"
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
      </section>

      <!-- 贴底的顶级菜单项（不分组）；上方没有分组时不画分隔线 -->
      <ul
        v-show="editing || visibleTopTools.length > 0"
        class="app-sidebar__items app-sidebar__items--top"
        :class="{ 'is-divided': hasVisibleGroups }"
      >
        <template v-if="editing">
          <li
            v-for="type in topTools"
            :key="type"
            class="app-sidebar__item is-editing"
            :class="{ 'is-hidden': draftHidden.includes(type) }"
          >
            <span class="app-sidebar__handle is-static" aria-hidden="true" />
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
        </template>
        <template v-else>
          <li
            v-for="type in visibleTopTools"
            :key="type"
            class="app-sidebar__item"
            :class="{ 'is-active': isActive(type) }"
            :title="titleOf(type)"
            @click="handleSelect(type)"
          >
            <Icon class="app-sidebar__icon" :name="iconOf(type)" />
            <span class="app-sidebar__label">{{ toolOf(type)?.label }}</span>
          </li>
        </template>
      </ul>
    </nav>

    <!-- 底部操作区 -->
    <footer class="app-sidebar__footer">
      <template v-if="editing">
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
      <button
        v-else
        class="app-sidebar__footer-btn"
        type="button"
        title="编辑菜单排序与显示"
        @click="enterEdit"
      >
        <Icon name="pencil" />
      </button>
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

/* ------------------------------------------------------------ 收起态（64px 图标栏） */

.app-sidebar--collapsed {
  flex-basis: var(--sidebar-width-collapsed);
  width: var(--sidebar-width-collapsed);
}

.app-sidebar--collapsed .app-sidebar__nav {
  padding: 10px 6px;
}

.app-sidebar--collapsed .app-sidebar__label,
.app-sidebar--collapsed .app-sidebar__add,
.app-sidebar--collapsed .app-sidebar__handle,
.app-sidebar--collapsed .app-sidebar__eye,
.app-sidebar--collapsed .app-sidebar__group-head {
  display: none;
}

.app-sidebar--collapsed .app-sidebar__item {
  justify-content: center;
  padding: 0;
}

/* 收起态没有分组标题，用细线把相邻分组隔开（第一段上方没东西，不画） */
.app-sidebar--collapsed .app-sidebar__group.is-divided {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color);
}

.app-sidebar--collapsed .app-sidebar__items--top.is-divided {
  margin-top: 6px;
  padding-top: 6px;
}

.app-sidebar--collapsed .app-sidebar__footer {
  justify-content: center;
  padding: 8px 6px;
}

.app-sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  padding: 10px 8px;
  overflow-y: auto;
}

/* 分组标题 */
.app-sidebar__group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  letter-spacing: 0.4px;
  text-align: left;
  cursor: pointer;
}

.app-sidebar__group-head:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

/* 折叠指示器：收起时指向右，展开时指向下 */
.app-sidebar__arrow {
  font-size: var(--app-font-size-sm);
  transform: rotate(-90deg);
  transition: transform 0.18s ease;
}

.app-sidebar__arrow.is-expanded {
  transform: rotate(0deg);
}

.app-sidebar__items {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

/*
 * 顶级菜单段。
 *
 * 分隔线与间距只在「上方确实有分组」时才加（is-divided）：
 * 没有插件分组时它是最上面唯一的一段，再加就会留下一条悬空的横杠。
 */
.app-sidebar__items--top {
  margin: 0;
  padding: 0;
}

.app-sidebar__items--top.is-divided {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

/* 菜单项 */
.app-sidebar__item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(32px * var(--app-control-scale));
  margin-bottom: 2px;
  padding: 0 6px 0 22px;
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

/* ------------------------------------------------------------ 编辑态 */

/* 拖动把手：仅编辑态渲染 */
.app-sidebar__handle {
  flex: 0 0 auto;
  color: var(--text-muted);
  opacity: 0.7;
  cursor: grab;
}

.app-sidebar__handle:active {
  cursor: grabbing;
}

/* 顶级项不可拖，占位保持对齐 */
.app-sidebar__handle.is-static {
  opacity: 0.2;
  cursor: default;
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

/* 底部操作区 */
.app-sidebar__footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
}

.app-sidebar__footer-btn {
  display: inline-flex;
  align-items: center;
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

.app-sidebar__footer-btn.is-primary {
  color: var(--brand-color);
}

.app-sidebar__add:hover {
  background: var(--brand-color);
  color: #fff;
}
</style>

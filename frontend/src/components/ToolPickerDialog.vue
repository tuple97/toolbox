<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import Button from '@/components/ui/Button.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { TOOLS, toolOf } from '@/utils/tools'
import { useConfigStore } from '@/stores/configStore'
import type { ToolDefinition } from '@/utils/tools'
import type { ToolType } from '@/types'

/** 新建标签弹窗（3×3 网格），入口为标签栏左侧的 + 按钮 */

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'select', type: ToolType): void
}>()

const configStore = useConfigStore()

const dialogVisible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

/** 工具图标名 */
function iconOf(type: string): string {
  return toolOf(type)?.icon ?? 'question'
}

// ------------------------------------------------------------ 配置（排序 / 显示）

/** 弹窗自己的配置，持久化在 settings.picker_config */
interface PickerConfig {
  /** 全部工具的展示顺序 */
  order: ToolType[]
  /** 被隐藏的工具 */
  hidden: ToolType[]
}

/**
 * 可选工具。
 *
 * 默认取多例工具；插件可以通过工具声明里的 picker 字段
 * 显式决定是否出现在这里（例如单例工具也允许从这里新建）。
 * 用 computed 而不是模块级常量：插件是运行期注册的。
 */
const defaultOrder = computed<ToolType[]>(() =>
  TOOLS.filter(tool => tool.picker ?? tool.multi).map(tool => tool.type),
)

/** 解析并校正持久化配置 */
function parsePickerConfig(raw: string | undefined): PickerConfig {
  const defaults = defaultOrder.value
  const config: PickerConfig = { order: [...defaults], hidden: [] }
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<PickerConfig>
    const saved = Array.isArray(parsed.order) ? parsed.order : []
    config.order = [
      ...saved.filter(type => defaults.includes(type)),
      ...defaults.filter(type => !saved.includes(type)),
    ]
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden : []
    config.hidden = hidden.filter(type => defaults.includes(type))
  }
  catch {
    // 配置损坏时回退默认结构
  }
  return config
}

function serializePickerConfig(config: PickerConfig): string {
  return JSON.stringify({ order: config.order, hidden: config.hidden })
}

/** 持久化配置，普通态渲染依据 */
const pickerConfig = computed(() => parsePickerConfig(configStore.values.picker_config))

/** 普通态展示的卡片 */
const visibleTools = computed<ToolDefinition[]>(() => {
  const tools: ToolDefinition[] = []
  for (const type of pickerConfig.value.order) {
    if (pickerConfig.value.hidden.includes(type)) {
      continue
    }
    const definition = toolOf(type)
    if (definition) {
      tools.push(definition)
    }
  }
  return tools
})

// ------------------------------------------------------------ 编辑态

const editing = ref(false)
/** 编辑草稿：点「完成」才落盘 */
const draftOrder = ref<ToolType[]>([])
const draftHidden = ref<ToolType[]>([])

function enterEdit() {
  const config = parsePickerConfig(configStore.values.picker_config)
  draftOrder.value = config.order
  draftHidden.value = [...config.hidden]
  editing.value = true
}

/** 草稿恢复为默认 */
function resetDraft() {
  draftOrder.value = [...defaultOrder.value]
  draftHidden.value = []
}

function finishEdit() {
  editing.value = false
  configStore.set('picker_config', serializePickerConfig({
    order: draftOrder.value,
    hidden: draftHidden.value,
  }))
}

function toggleDraftHidden(type: ToolType) {
  draftHidden.value = draftHidden.value.includes(type)
    ? draftHidden.value.filter(item => item !== type)
    : [...draftHidden.value, type]
}

function isDraftHidden(type: ToolType): boolean {
  return draftHidden.value.includes(type)
}

/** 关闭弹窗即放弃未完成的编辑 */
watch(dialogVisible, (visible) => {
  if (!visible) {
    editing.value = false
  }
})

function handlePick(type: ToolType) {
  if (editing.value) {
    return
  }
  emit('select', type)
  dialogVisible.value = false
}
</script>

<template>
  <Dialog v-model="dialogVisible" title="新建标签" :width="680">
    <p v-if="editing" class="tool-picker__hint">
      拖动卡片排序，右上角眼睛控制显示
    </p>

    <!-- 编辑态：拖动排序 -->
    <VueDraggable
      v-if="editing"
      v-model="draftOrder"
      class="tool-picker__grid is-editing"
      :animation="220"
      easing="cubic-bezier(0.22, 1, 0.36, 1)"
    >
      <div
        v-for="type in draftOrder"
        :key="type"
        class="tool-picker__card is-editing"
        :class="{ 'is-hidden': isDraftHidden(type) }"
      >
        <button
          class="tool-picker__eye"
          type="button"
          :title="isDraftHidden(type) ? '显示工具' : '隐藏工具'"
          @click.stop="toggleDraftHidden(type)"
        >
          <Icon :name="isDraftHidden(type) ? 'eye-off' : 'eye'" />
        </button>
        <Icon class="tool-picker__icon" :name="iconOf(type)" />
        <span class="tool-picker__name">{{ toolOf(type)?.label }}</span>
        <span class="tool-picker__desc">{{ toolOf(type)?.description }}</span>
      </div>
    </VueDraggable>

    <div v-else class="tool-picker__grid">
      <button
        v-for="tool in visibleTools"
        :key="tool.type"
        class="tool-picker__card"
        type="button"
        @click="handlePick(tool.type)"
      >
        <Icon class="tool-picker__icon" :name="tool.icon" />
        <span class="tool-picker__name">{{ tool.label }}</span>
        <span class="tool-picker__desc">{{ tool.description }}</span>
      </button>
    </div>

    <template #footer>
      <div class="tool-picker__footer">
        <div class="tool-picker__footer-left">
          <template v-if="editing">
            <button class="tool-picker__footer-btn" type="button" @click="resetDraft">
              恢复默认
            </button>
            <button
              class="tool-picker__footer-btn is-primary"
              type="button"
              title="保存排序与显示设置"
              @click="finishEdit"
            >
              完成
            </button>
          </template>
          <button
            v-else
            class="tool-picker__footer-btn"
            type="button"
            title="编辑工具排序与显示"
            @click="enterEdit"
          >
            <Icon name="pencil" />
          </button>
        </div>
        <Button variant="secondary" size="sm" @click="dialogVisible = false">关闭</Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.tool-picker__hint {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.6;
}

/* 三列网格 */
.tool-picker__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.tool-picker__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-color);
  color: var(--text-color);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    background-color 0.15s ease,
    opacity 0.2s ease;
}

.tool-picker__card:hover {
  border-color: var(--brand-color);
  background: var(--active-bg);
  transform: translateY(-2px);
}

.tool-picker__icon {
  font-size: calc(20px * var(--app-control-scale));
  color: var(--brand-color);
}

.tool-picker__name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--app-font-size-lg);
  font-weight: 600;
}

.tool-picker__desc {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  line-height: 1.5;
}

/* ------------------------------------------------------------ 编辑态 */

/* 编辑态整卡可拖 */
.tool-picker__card.is-editing {
  cursor: grab;
  /* transform 不参与过渡，交给 Sortable 的排序动画 */
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    opacity 0.2s ease;
}

.tool-picker__card.is-editing:active {
  cursor: grabbing;
}

.tool-picker__card.is-editing:hover {
  transform: none;
}

/* 隐藏的卡片整体变淡 */
.tool-picker__card.is-hidden {
  opacity: 0.45;
}

/* 卡片右上角的显示/隐藏开关 */
.tool-picker__eye {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(24px * var(--app-control-scale));
  height: calc(24px * var(--app-control-scale));
  padding: 0;
  border: none;
  border-radius: 6px;
  background: var(--hover-bg);
  color: var(--text-muted);
  cursor: pointer;
}

.tool-picker__eye:hover {
  color: var(--text-color);
}

/* 底部操作区 */
.tool-picker__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.tool-picker__footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-picker__footer-btn {
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

.tool-picker__footer-btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.tool-picker__footer-btn.is-primary {
  color: var(--brand-color);
}
</style>

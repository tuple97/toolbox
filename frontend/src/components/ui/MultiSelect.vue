<script setup lang="ts">
/**
 * 多选下拉（替代 `el-select multiple`）。
 *
 * 与 `Combobox` 的分工：那个是单选（承载一个值），这个是「一组值」。
 * 交互按多选的习惯来：**选中不关闭**（连着勾几个是常态）、点外部 / Esc 才关，
 * 已选项在触发器里显示成标签，超过 2 个折叠成「+N」。
 *
 * 浮层定位与 `Combobox` 共用 `utils/popover.ts`，保证两者的翻转 / 跟随行为一致。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/Icon.vue'
import { usePopoverAnchor } from '@/utils/popover'

export interface MultiSelectOption {
  label: string
  value: string
}

const props = withDefaults(defineProps<{
  options: MultiSelectOption[]
  placeholder?: string
  disabled?: boolean
  searchPlaceholder?: string
  /** 触发器里最多显示几个标签，其余折叠成「+N」 */
  maxTags?: number
  size?: 'sm' | 'default'
  class?: string
}>(), {
  placeholder: '请选择',
  searchPlaceholder: '搜索…',
  maxTags: 2,
  size: 'default',
})

const model = defineModel<string[]>({ default: () => [] })

const open = ref(false)
const keyword = ref('')
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)

const { position, update, bind, unbind } = usePopoverAnchor(trigger, panel)

/** 已选项（顺序按 options 的顺序，避免勾选顺序造成的跳动） */
const selected = computed(() => props.options.filter(option => model.value.includes(option.value)))

/** 折叠后要显示的标签 */
const visibleTags = computed(() => selected.value.slice(0, props.maxTags))
const hiddenCount = computed(() => Math.max(0, selected.value.length - props.maxTags))

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) {
    return props.options
  }
  return props.options.filter(option =>
    option.label.toLowerCase().includes(text) || option.value.toLowerCase().includes(text))
})

function isSelected(value: string): boolean {
  return model.value.includes(value)
}

/** 勾选 / 取消：多选不关闭浮层，方便连着勾几个 */
function toggleValue(option: MultiSelectOption) {
  model.value = isSelected(option.value)
    ? model.value.filter(value => value !== option.value)
    : [...model.value, option.value]
}

function removeValue(value: string) {
  model.value = model.value.filter(item => item !== value)
}

function close() {
  open.value = false
  unbind()
}

async function show() {
  if (props.disabled) {
    return
  }
  open.value = true
  keyword.value = ''
  bind()
  await update()
  await nextTick()
  search.value?.focus()
}

function toggle() {
  if (open.value) {
    close()
  }
  else {
    void show()
  }
}

function clear() {
  model.value = []
}

/** 回车＝选中唯一匹配项（只有一条候选时最顺手）；Esc 关闭 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const only = filtered.value.length === 1 ? filtered.value[0] : undefined
    if (only) {
      toggleValue(only)
    }
  }
}

/**
 * 点外部关闭：必须同时检查 root 与 panel —— 浮层已 Teleport 到 body，
 * 不在 root 里，只看 root 会在点选项时被当成「点外部」而先关闭。
 */
function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) {
    return
  }
  const target = event.target as Node
  if (root.value?.contains(target) || panel.value?.contains(target)) {
    return
  }
  close()
}

document.addEventListener('pointerdown', onDocumentPointerDown, true)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  unbind()
})
</script>

<template>
  <div ref="root" :class="cn('relative', props.class)">
    <div
      :class="cn(
        'flex w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5',
        'transition-colors hover:border-brand/60',
        size === 'sm'
          ? 'min-h-[calc(26px*var(--app-control-scale))] text-xs'
          : 'min-h-[calc(32px*var(--app-control-scale))] text-sm',
        disabled && 'cursor-not-allowed opacity-50',
        open && 'border-brand/60',
      )"
    >
      <button
        ref="trigger"
        type="button"
        :disabled="disabled"
        class="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1 text-left"
        @click="toggle"
      >
        <template v-if="selected.length">
          <span
            v-for="option in visibleTags"
            :key="option.value"
            class="inline-flex max-w-[10rem] items-center gap-1 rounded border border-brand/30
              bg-brand/12 px-1.5 text-brand"
          >
            <span class="truncate">{{ option.label }}</span>
            <span
              class="shrink-0 cursor-pointer opacity-70 hover:opacity-100"
              title="移除"
              @click.stop="removeValue(option.value)"
            >
              <Icon name="close" class="text-2xs" />
            </span>
          </span>
          <span v-if="hiddenCount" class="shrink-0 text-muted">+{{ hiddenCount }}</span>
        </template>
        <span v-else class="truncate text-muted">{{ placeholder }}</span>
      </button>

      <button
        v-if="model.length"
        type="button"
        class="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-hover hover:text-text"
        title="清空"
        @click.stop="clear"
      >
        <Icon name="close" class="text-xs" />
      </button>

      <Icon name="chevron-down" class="shrink-0 text-muted" />
    </div>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="fixed z-[9996] overflow-hidden rounded-lg border border-border bg-overlay
          shadow-[var(--shadow-md)]"
        :style="{
          left: `${position.left}px`,
          top: `${position.top}px`,
          width: `${position.width}px`,
        }"
      >
        <div class="border-b border-border p-1.5">
          <input
            ref="search"
            v-model="keyword"
            :placeholder="searchPlaceholder"
            class="h-[calc(26px*var(--app-control-scale))] w-full rounded-md bg-surface px-2
              text-sm text-text outline-none placeholder:text-muted"
            @keydown="onKeydown"
          >
        </div>

        <div class="max-h-64 overflow-y-auto p-1">
          <button
            v-for="option in filtered"
            :key="option.value"
            type="button"
            :class="cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
              isSelected(option.value) ? 'text-brand hover:bg-hover' : 'text-text hover:bg-hover',
            )"
            @click="toggleValue(option)"
          >
            <!-- 勾选态用方框 + 对勾：多选必须是「可多选」的视觉，不能只靠颜色 -->
            <span
              :class="cn(
                'flex size-[15px] shrink-0 items-center justify-center rounded border transition-colors',
                isSelected(option.value)
                  ? 'border-brand bg-brand text-white'
                  : 'border-border bg-surface',
              )"
            >
              <Icon v-if="isSelected(option.value)" name="check" class="text-2xs" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          </button>

          <p v-if="!filtered.length" class="px-2 py-3 text-center text-xs text-muted">
            没有匹配项
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

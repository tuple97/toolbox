<script setup lang="ts">
/** 下拉选择（可搜索） */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/Icon.vue'
import { usePopoverAnchor } from '@/utils/popover'

export interface ComboboxOption {
  label: string
  value: string
  /** 次要说明 */
  hint?: string
}

const props = withDefaults(defineProps<{
  options: ComboboxOption[]
  placeholder?: string
  disabled?: boolean
  searchPlaceholder?: string
  /** 显示清除按钮 */
  clearable?: boolean
  /** 允许把搜索框内容直接当作值 */
  allowCreate?: boolean
  /** 是否提供搜索框 */
  filterable?: boolean
  /** 紧凑尺寸 */
  size?: 'sm' | 'default'
  class?: string
}>(), {
  placeholder: '请选择',
  searchPlaceholder: '搜索…',
  filterable: true,
  size: 'default',
})

const model = defineModel<string>({ default: '' })

const open = ref(false)
const keyword = ref('')
const active = ref(0)
/** 触发器所在容器 */
const root = ref<HTMLElement | null>(null)
/** 触发按钮：浮层定位基准 */
const trigger = ref<HTMLElement | null>(null)
/** 浮层本体 */
const list = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)

/* 浮层定位：与 MultiSelect 共用 */
const { position, update: updatePosition, bind: bindViewportListeners, unbind: unbindViewportListeners }
  = usePopoverAnchor(trigger, list)

const current = computed(() => props.options.find(option => option.value === model.value))

const filtered = computed<ComboboxOption[]>(() => {
  const text = keyword.value.trim().toLowerCase()
  const matched = !text
    ? props.options
    : props.options.filter(option =>
        option.label.toLowerCase().includes(text) || option.value.toLowerCase().includes(text))

  // allow-create：未精确命中时把输入作为一项附在末尾
  const raw = keyword.value.trim()
  if (!props.allowCreate || !raw) {
    return matched
  }
  const exact = matched.some(option =>
    option.label.toLowerCase() === text || option.value.toLowerCase() === text)
  return exact ? matched : [...matched, { label: raw, value: raw, hint: '手动输入' }]
})

function close() {
  open.value = false
  unbindViewportListeners()
}

async function show() {
  if (props.disabled) {
    return
  }
  open.value = true
  keyword.value = ''
  active.value = Math.max(0, props.options.findIndex(option => option.value === model.value))
  bindViewportListeners()
  await updatePosition()
  // 无搜索框时聚焦浮层本身
  if (props.filterable) {
    search.value?.focus()
  }
  else {
    list.value?.focus()
  }
}

function toggle() {
  if (open.value) {
    close()
  }
  else {
    void show()
  }
}

function pick(option: ComboboxOption) {
  model.value = option.value
  close()
}

/** 清除选择：值置空 */
function clear() {
  model.value = ''
}

/** 键盘移动时把候选项滚进视野 */
async function move(step: number) {
  const next = Math.min(Math.max(active.value + step, 0), filtered.value.length - 1)
  active.value = next
  await nextTick()
  list.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      void move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      void move(-1)
      break
    case 'Enter': {
      event.preventDefault()
      const hit = filtered.value[active.value]
      if (hit) {
        pick(hit)
      }
      break
    }
    case 'Escape':
      event.preventDefault()
      close()
      break
  }
}

/** 点击外部关闭（含 Teleport 到 body 的浮层） */
function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) {
    return
  }
  const target = event.target as Node
  if (root.value?.contains(target) || list.value?.contains(target)) {
    return
  }
  close()
}

watch(filtered, () => {
  active.value = 0
})

document.addEventListener('pointerdown', onDocumentPointerDown, true)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  unbindViewportListeners()
})
</script>

<template>
  <div ref="root" :class="cn('relative', props.class)">
    <button
      ref="trigger"
      type="button"
      :disabled="disabled"
      :class="cn(
        'flex w-full items-center gap-2 rounded-md',
        'border border-border bg-surface text-left text-text transition-colors',
        'hover:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm'
          ? 'h-[calc(26px*var(--app-control-scale))] px-2 text-xs'
          : 'h-[calc(32px*var(--app-control-scale))] px-2.5 text-sm',
        open && 'border-brand/60',
      )"
      :aria-expanded="open"
      @click="toggle"
    >
      <!-- 选中项：默认 label，#value 插槽可自定义 -->
      <span v-if="$slots.value" class="min-w-0 flex-1">
        <slot v-if="current" name="value" :option="current" />
        <span v-else class="block truncate">{{ placeholder }}</span>
      </span>
      <span v-else class="min-w-0 flex-1 truncate">
        {{ current?.label ?? placeholder }}
      </span>

      <button
        v-if="clearable && model"
        type="button"
        class="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-hover hover:text-text"
        title="清除"
        @click.stop="clear"
      >
        <Icon name="close" class="text-xs" />
      </button>

      <Icon name="chevron-down" class="size-3.5 shrink-0 text-muted" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="list"
        tabindex="-1"
        class="fixed z-[9996] overflow-hidden rounded-lg border border-border bg-overlay
          shadow-[var(--shadow-md)] outline-none"
        :style="{
          left: `${position.left}px`,
          top: `${position.top}px`,
          width: `${position.width}px`,
        }"
        @keydown="onKeydown"
      >
        <div v-if="filterable" class="border-b border-border p-1.5">
          <input
            ref="search"
            v-model="keyword"
            :placeholder="searchPlaceholder"
            class="h-[calc(26px*var(--app-control-scale))] w-full rounded-md bg-surface px-2
              text-sm text-text outline-none placeholder:text-muted"
          >
        </div>

        <div class="max-h-64 overflow-y-auto p-1">
          <button
            v-for="(option, index) in filtered"
            :key="option.value"
            type="button"
            :data-active="index === active"
            :class="cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
              index === active ? 'bg-active text-text' : 'text-muted hover:bg-hover hover:text-text',
            )"
            @mouseenter="active = index"
            @click="pick(option)"
          >
            <!-- 选项行：默认 label + hint，#option 插槽可自定义 -->
            <slot v-if="$slots.option" name="option" :option="option" />
            <template v-else>
              <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
              <span v-if="option.hint" class="shrink-0 text-xs text-muted">{{ option.hint }}</span>
            </template>
          </button>

          <p v-if="!filtered.length" class="px-2 py-3 text-center text-xs text-muted">
            没有匹配项
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
/**
 * 数字输入（替代 `el-input-number`）。
 *
 * 对应 EP 的 `controls-position="right"`：右侧竖排两个步进按钮 —— 竖排比横排窄，
 * 表单里一列数字字段不会把标签挤到换行。
 *
 * 取值规则（与 EP 一致的、也是用户预期的那几条）：
 *  - 输入过程中不强制夹取（否则想从 `1` 改成 `100` 时，中间态会被反复改写成 `1`）；
 *  - 失焦 / 回车时才夹到 [min, max] 并回写；
 *  - 输入不合法（空 / 非数字）时恢复成上一个有效值，而不是塞个 NaN 进去。
 */
import { computed, ref, watch } from 'vue'
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/Icon.vue'

const props = withDefaults(defineProps<{
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  placeholder?: string
  /** `sm` 用在工具条 / 分页这种紧凑行里 */
  size?: 'sm' | 'default'
  class?: string
}>(), {
  step: 1,
  size: 'default',
})

const emit = defineEmits<{
  /** 回车提交（调用方一般拿来做「跳到某页」这类即时动作） */
  (e: 'enter'): void
}>()

const model = defineModel<number>({ default: 0 })

/** 输入中的原始文本：允许「暂时不合法」，提交时再校正 */
const draft = ref(String(model.value))

watch(model, (value) => {
  // 外部改动（如切换编辑对象）时同步显示，但不要打断正在输入的内容
  if (Number(draft.value) !== value) {
    draft.value = String(value)
  }
})

const canDecrease = computed(() => props.disabled !== true && model.value > (props.min ?? Number.NEGATIVE_INFINITY))
const canIncrease = computed(() => props.disabled !== true && model.value < (props.max ?? Number.POSITIVE_INFINITY))

/** 夹取到合法区间（未设边界则原样返回） */
function clamp(value: number): number {
  let next = value
  if (props.min !== undefined) {
    next = Math.max(next, props.min)
  }
  if (props.max !== undefined) {
    next = Math.min(next, props.max)
  }
  return next
}

/** 提交输入框里的文本：合法就夹取采用，不合法就退回上一个有效值 */
function commit() {
  const parsed = Number(draft.value)
  if (draft.value.trim() === '' || !Number.isFinite(parsed)) {
    draft.value = String(model.value)
    return
  }
  const next = clamp(parsed)
  model.value = next
  draft.value = String(next)
}

function stepBy(delta: number) {
  const next = clamp(model.value + delta)
  model.value = next
  draft.value = String(next)
}
</script>

<template>
  <div
    :class="cn(
      'inline-flex items-stretch overflow-hidden rounded-md',
      size === 'sm' ? 'h-[calc(26px*var(--app-control-scale))]' : 'h-[calc(32px*var(--app-control-scale))]',
      'border border-border bg-surface transition-colors hover:border-brand/40 focus-within:border-brand/60',
      disabled && 'cursor-not-allowed opacity-50',
      props.class,
    )"
  >
    <input
      v-model="draft"
      type="text"
      inputmode="numeric"
      :disabled="disabled"
      :placeholder="placeholder"
      :class="cn('min-w-0 flex-1 bg-transparent text-text outline-none', size === 'sm' ? 'px-2 text-xs' : 'px-2.5 text-sm')"
      @blur="commit"
      @keydown.enter.prevent="commit(); emit('enter')"
    >
    <div class="flex w-6 shrink-0 flex-col border-l border-border">
      <button
        type="button"
        class="flex flex-1 items-center justify-center text-muted transition-colors
          hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canIncrease"
        title="增加"
        @click="stepBy(step)"
      >
        <Icon name="chevron-up" class="text-2xs" />
      </button>
      <button
        type="button"
        class="flex flex-1 items-center justify-center border-t border-border text-muted
          transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canDecrease"
        title="减少"
        @click="stepBy(-step)"
      >
        <Icon name="chevron-down" class="text-2xs" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 颜色选择；空串表示「未标记」 */
import { computed } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  disabled?: boolean
  class?: string
}>(), {})

const model = defineModel<string>({ default: '' })

/** 未标记时的兜底色（原生控件不接受空值） */
const FALLBACK_COLOR = '#409eff'

/** 取色器显示的颜色 */
const pickerColor = computed(() => model.value || FALLBACK_COLOR)

/** 取色：写回模型 */
function handlePick(event: Event) {
  model.value = (event.target as HTMLInputElement).value
}

/** 清除标记 */
function clear() {
  model.value = ''
}
</script>

<template>
  <div
    :class="cn('inline-flex items-center gap-2', disabled && 'cursor-not-allowed opacity-50', props.class)"
  >
    <!-- 不能用 label 包住 -->
    <input
      :value="pickerColor"
      type="color"
      :disabled="disabled"
      class="size-[calc(28px*var(--app-control-scale))] shrink-0 cursor-pointer rounded-md
        border border-border bg-surface p-0.5"
      @input="handlePick"
    >
    <code class="text-xs text-muted">{{ model || '未标记' }}</code>

    <button
      v-if="model && !disabled"
      type="button"
      class="inline-flex size-[calc(18px*var(--app-control-scale))] items-center justify-center
        rounded text-xs text-muted transition-colors hover:text-danger"
      title="清除颜色标记"
      aria-label="清除颜色标记"
      @click="clear"
    >
      <Icon name="close" />
    </button>
  </div>
</template>

<style scoped>
/* 抹平原生色块的内边距与直角 */
input[type='color']::-webkit-color-swatch-wrapper {
  padding: 0;
}

input[type='color']::-webkit-color-swatch {
  border: none;
  border-radius: 3px;
}
</style>

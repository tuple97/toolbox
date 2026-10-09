<script setup lang="ts">
/**
 * 分段式页签（segmented control）。
 *
 * 设置页用它而不是「下划线页签」：设置页的页签是**在同一屏内切换分组**，
 * 分段控件的「一组互斥选项」语义比下划线更贴切，视觉也更紧凑。
 * 页签内容由调用方用 `v-show` 渲染（保持各分组状态，符合项目「禁用 v-if 切换」的约定）。
 */
import { cn } from '@/lib/utils'

const props = defineProps<{
  items: Array<{ value: string, label: string }>
  class?: string
}>()

const model = defineModel<string>({ default: '' })
</script>

<template>
  <div
    role="tablist"
    :class="cn('inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5', props.class)"
  >
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      role="tab"
      :aria-selected="item.value === model"
      :class="cn(
        'rounded-md px-3 py-1 text-sm transition-colors',
        item.value === model ? 'bg-brand text-white' : 'text-muted hover:bg-hover hover:text-text',
      )"
      @click="model = item.value"
    >
      {{ item.label }}
    </button>
  </div>
</template>

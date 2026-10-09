<script setup lang="ts">
/**
 * 滑块（reka-ui 的 Slider 原语 + 自绘轨道/拇指）。
 *
 * 用于「缩放比例」「日志保留条数」这类连续数值；数值文本由调用方渲染，
 * 组件只管拖动（这样两处的排版可以各自决定）。
 */
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  class?: string
}>()

const model = defineModel<number>({ default: 0 })
</script>

<template>
  <SliderRoot
    v-model="model"
    :min="min ?? 0"
    :max="max ?? 100"
    :step="step ?? 1"
    :disabled="disabled"
    :class="cn('relative flex h-5 w-full touch-none items-center select-none', props.class)"
  >
    <SliderTrack class="relative h-[3px] w-full grow overflow-hidden rounded-full bg-surface">
      <SliderRange class="absolute h-full bg-brand" />
    </SliderTrack>
    <SliderThumb
      class="block size-3.5 rounded-full border border-border bg-panel shadow-sm transition-colors
             hover:border-brand focus-visible:outline-none disabled:opacity-50"
    />
  </SliderRoot>
</template>

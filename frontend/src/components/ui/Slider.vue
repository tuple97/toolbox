<script setup lang="ts">
/** 滑块（reka-ui 的 Slider 原语 + 自绘轨道/拇指） */
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
    :class="cn(
      'relative flex h-5 w-full touch-none items-center select-none',
      'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
      props.class,
    )"
  >
    <SliderTrack class="relative h-[3px] w-full grow overflow-hidden rounded-full bg-surface">
      <SliderRange class="absolute h-full bg-brand" />
    </SliderTrack>
    <!--
      焦点样式交给全局 :focus-visible（品牌色描边）：这里若写 outline-none，
      键盘拖动的用户就完全看不到焦点了。
      禁用态由 Root 上的 data-[disabled] 统一压暗，不在拇指上重复声明
      （Reka 的标记在 Root，写在 <span> 上的 disabled: 变体永远命中不了）。
    -->
    <SliderThumb
      class="block size-3.5 rounded-full border border-border bg-panel shadow-sm transition-colors
             hover:border-brand"
    />
  </SliderRoot>
</template>

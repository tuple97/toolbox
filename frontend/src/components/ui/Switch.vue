<script setup lang="ts">
/**
 * 开关。
 *
 * 用 reka-ui 的 Switch 原语（键盘可操作、`role="switch"`、aria 状态齐全），
 * 视觉自己写：轨道尺寸用 rem，跟着根字号（13px × 缩放比例）一起放大。
 */
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{
  disabled?: boolean
  class?: string
}>()

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <SwitchRoot
    v-model="model"
    :disabled="disabled"
    :class="cn(
      'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
      'data-[state=checked]:bg-brand data-[state=unchecked]:bg-surface data-[state=unchecked]:border-border',
      'disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  >
    <SwitchThumb
      class="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform
             data-[state=unchecked]:translate-x-0.5 data-[state=checked]:translate-x-4"
    />
  </SwitchRoot>
</template>

<script setup lang="ts">
/**
 * 标签（替代 `el-tag`）。
 *
 * 沿用 EP 的两个概念，迁移时只改属性名：
 *  - `tone`（EP 叫 `type`）：文案语气，决定颜色，取自应用语义色（含新的 success / warning）；
 *  - `effect`：`light` 是带淡底的实心标签（列表里的状态用），
 *    `plain` 是只有描边的空标签（列表右侧的「生产 / 只读」这种标记用，视觉更轻）。
 */
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'brand'
  effect?: 'light' | 'plain'
  size?: 'sm' | 'default'
  class?: string
}>(), {
  tone: 'info',
  effect: 'light',
  size: 'default',
})

/** 语气 → 文字色（light 与 plain 共用；底色 / 描边在下面按 effect 拼） */
const TONE_TEXT: Record<string, string> = {
  info: 'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  brand: 'text-brand',
}

/** 语气 → 淡底与描边（light 用「底 + 边」，plain 只用边） */
const TONE_SURFACE: Record<string, string> = {
  info: 'bg-muted/12 border-muted/25',
  success: 'bg-success/12 border-success/30',
  warning: 'bg-warning/12 border-warning/30',
  danger: 'bg-danger/12 border-danger/30',
  brand: 'bg-brand/12 border-brand/30',
}

const classes = computed(() => cn(
  'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 leading-[1.6] whitespace-nowrap',
  props.size === 'sm' ? 'text-xs' : 'text-sm',
  TONE_TEXT[props.tone],
  props.effect === 'light'
    ? TONE_SURFACE[props.tone]
    : `border-current/25 bg-transparent`,
  props.class,
))
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>

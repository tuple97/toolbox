<script setup lang="ts">
/** 自绘图标：尺寸用 1em，根节点带 app-icon 类 */
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { iconBody } from '@/utils/icons'

const props = defineProps<{
  /** 图标名（见 utils/icons.ts） */
  name: string
  /** 追加类 */
  class?: string
}>()

/* 注入的是仓库内置静态字符串，无注入面 */
const body = computed(() => iconBody(props.name))
</script>

<template>
  <svg
    class="app-icon"
    :class="cn('inline-block size-[1em] shrink-0 align-[-0.15em]', props.class)"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="body"
  />
</template>

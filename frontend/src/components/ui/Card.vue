<script setup lang="ts">
import Icon from '@/components/ui/Icon.vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  /** 标题；留空则不渲染标题行 */
  title?: string
  /** 标题左侧图标名 */
  icon?: string
  /** 内容区内边距，默认 p-4 */
  bodyClass?: string
  class?: string
}>(), {
  title: '',
  icon: '',
  bodyClass: 'p-4',
})
</script>

<template>
  <section
    :class="cn(
      'flex min-w-0 flex-col rounded-xl border border-border bg-surface',
      'transition-colors hover:border-brand/40',
      props.class,
    )"
  >
    <header
      v-if="title || $slots.action"
      class="flex items-center gap-2 border-b border-border px-4 py-2.5"
    >
      <Icon v-if="icon" class="text-brand" :name="icon" />
      <span class="truncate text-base font-semibold text-text">{{ title }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <slot name="action" />
      </div>
    </header>

    <div :class="cn('min-w-0 flex-1', bodyClass)">
      <slot />
    </div>
  </section>
</template>

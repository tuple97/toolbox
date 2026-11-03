<script setup lang="ts">
/** 分段式页签（segmented control） */
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
        item.value === model ? 'bg-brand text-on-brand' : 'text-muted hover:bg-hover hover:text-text',
      )"
      @click="model = item.value"
    >
      {{ item.label }}
    </button>
  </div>
</template>

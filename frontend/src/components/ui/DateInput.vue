<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  disabled?: boolean
  class?: string
}>(), {})

const model = defineModel<string>({ default: '' })
</script>

<template>
  <input
    v-model="model"
    type="date"
    :disabled="disabled"
    :class="cn(
      'h-[calc(32px*var(--app-control-scale))] w-full rounded-md border border-border bg-surface',
      'px-2.5 text-sm text-text transition-colors outline-none',
      'hover:border-brand/40 focus:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  >
</template>

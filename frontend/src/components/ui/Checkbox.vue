<script setup lang="ts">
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/Icon.vue'

const props = withDefaults(defineProps<{
  disabled?: boolean
  class?: string
}>(), {})

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <label
    :class="cn(
      'inline-flex cursor-pointer items-center gap-2 text-sm text-text select-none',
      disabled && 'cursor-not-allowed opacity-50',
      props.class,
    )"
  >
    <input v-model="model" type="checkbox" :disabled="disabled" class="peer sr-only">
    <span
      class="flex size-[15px] shrink-0 items-center justify-center rounded border border-border
        bg-surface transition-colors peer-checked:border-brand peer-checked:bg-brand
        peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent"
    >
      <Icon v-if="model" name="check" class="text-2xs text-white" />
    </span>
    <slot />
  </label>
</template>

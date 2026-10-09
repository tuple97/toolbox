<script setup lang="ts">
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'default' | 'lg' | 'icon'
  disabled?: boolean
  /** 载入中：转圈并禁用 */
  loading?: boolean
  /** 原生按钮类型 */
  type?: 'button' | 'submit' | 'reset'
  class?: string
}>(), {
  variant: 'default',
  size: 'default',
  type: 'button',
})

const emit = defineEmits<{ (e: 'click', event: MouseEvent): void }>()

const button = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap '
  + 'transition-colors select-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white hover:opacity-90',
        secondary: 'border border-border bg-surface text-text hover:bg-hover',
        outline: 'border border-border text-text hover:bg-hover',
        ghost: 'text-muted hover:bg-hover hover:text-text',
        danger: 'border border-danger/35 bg-danger/10 text-danger hover:bg-danger/20',
      },
      size: {
        sm: 'h-[calc(26px*var(--app-control-scale))] px-2 text-xs',
        default: 'h-[calc(32px*var(--app-control-scale))] px-3 text-sm',
        lg: 'h-[calc(38px*var(--app-control-scale))] px-4 text-base',
        icon: 'size-[calc(30px*var(--app-control-scale))]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="cn(button({ variant, size }), props.class)"
    @click="emit('click', $event)"
  >
    <span
      v-if="loading"
      class="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>

<script setup lang="ts">
/** 空状态 */
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/Icon.vue'

defineProps<{
  /** 说明文案 */
  description?: string
  class?: string
}>()
</script>

<template>
  <div :class="cn('flex h-full flex-col items-center justify-center gap-2 px-4 py-8', $props.class)">
    <Icon name="inbox" class="text-4xl text-muted opacity-60" />
    <p v-if="description" class="text-center text-sm text-muted">
      {{ description }}
    </p>
    <slot />
  </div>
</template>

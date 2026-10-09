<script setup lang="ts">
/** 设置项的一行：左侧标签、右侧控件、下方说明 */
defineProps<{
  label?: string
  /** 说明文字 */
  hint?: string
  /** 必填标记，只做视觉提示 */
  required?: boolean
  /** 标签列宽，默认 7rem */
  labelWidth?: string
}>()
</script>

<template>
  <div class="flex items-start gap-3 py-2">
    <span
      v-if="label"
      class="shrink-0 pt-1.5 text-sm text-muted"
      :style="{ width: labelWidth ?? '7rem' }"
    >
      {{ label }}<span v-if="required" class="ml-0.5 text-danger">*</span>
    </span>
    <div class="min-w-0 flex-1">
      <slot />
      <p v-if="hint" class="mt-1.5 text-xs leading-relaxed text-muted">
        {{ hint }}
      </p>
    </div>
  </div>
</template>

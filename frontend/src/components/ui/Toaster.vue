<script setup lang="ts">
/**
 * 提示宿主（`utils/notify.ts` 的渲染端）。
 *
 * 在 App.vue 根部挂**一个**即可：提示本身是全局队列，不需要每个页面各挂一份。
 * 位置固定在右下角 —— 那里不盖工具栏、编辑器和结果区的主要视线，也远离
 * 执行器里的「执行 / 终止」按钮。
 */
import Icon from '@/components/ui/Icon.vue'
import { activeNotices, dismiss } from '@/utils/notify'
import type { NoticeTone } from '@/utils/notify'

/** 语气 → 图标与颜色（颜色用语义类，四套主题自动跟随） */
const TONE_STYLE: Record<NoticeTone, { icon: string, class: string }> = {
  success: { icon: 'check-circle', class: 'text-success' },
  error: { icon: 'x-circle', class: 'text-danger' },
  warning: { icon: 'alert-triangle', class: 'text-warning' },
  info: { icon: 'info-circle', class: 'text-brand' },
}
</script>

<template>
  <Teleport to="body">
    <TransitionGroup
      name="app-toast"
      tag="div"
      class="pointer-events-none fixed bottom-4 right-4 z-[9995] flex flex-col items-end gap-2"
    >
      <div
        v-for="notice in activeNotices"
        :key="notice.id"
        class="pointer-events-auto flex max-w-[360px] items-start gap-2 rounded-lg border border-border
          bg-overlay px-3 py-2 shadow-panel"
        role="status"
      >
        <Icon
          :name="TONE_STYLE[notice.tone].icon"
          :class="['text-lg', TONE_STYLE[notice.tone].class]"
        />
        <span class="flex-1 text-sm leading-snug text-text">{{ notice.message }}</span>
        <button
          type="button"
          class="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded
            text-muted transition-colors hover:bg-hover hover:text-text"
          title="关闭提示"
          @click="dismiss(notice.id)"
        >
          <Icon name="close" class="text-xs" />
        </button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.app-toast-enter-active,
.app-toast-leave-active,
.app-toast-move {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.app-toast-enter-from,
.app-toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>

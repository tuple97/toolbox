<script setup lang="ts">
/** 对话框：居中弹窗 + 标题行 + 关闭按钮，内容与页脚走插槽 */
import { onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import { lockBodyScroll, nextOverlayZIndex } from '@/utils/overlay'

const props = withDefaults(defineProps<{
  /** 是否显示 */
  modelValue: boolean
  title?: string
  /** 面板宽度：数字按 px，字符串原样 */
  width?: number | string
  /** 点遮罩是否关闭 */
  closeOnMask?: boolean
}>(), {
  title: '',
  width: 520,
  closeOnMask: true,
})

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

/** 关闭：只抛事件，状态由调用方持有 */
function close() {
  emit('update:modelValue', false)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // 弹窗优先吃 Esc
    event.stopPropagation()
    close()
  }
}

/** 本实例的层级：每次打开都重新取号，保证后开的在上层 */
const zIndex = ref(nextOverlayZIndex())

/** 本实例是否持有滚动锁，避免重复解锁把外层弹窗的锁也放掉 */
let scrollLocked = false

watch(() => props.modelValue, (open) => {
  if (open) {
    zIndex.value = nextOverlayZIndex()
    window.addEventListener('keydown', handleKeydown)
    if (!scrollLocked) {
      lockBodyScroll(true)
      scrollLocked = true
    }
    return
  }
  window.removeEventListener('keydown', handleKeydown)
  if (scrollLocked) {
    lockBodyScroll(false)
    scrollLocked = false
  }
}, { immediate: true })

// 卸载时也要还原 body 滚动
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (scrollLocked) {
    lockBodyScroll(false)
    scrollLocked = false
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="app-dialog">
      <div
        v-if="modelValue"
        class="app-dialog fixed inset-0 flex items-center justify-center p-6"
        :style="{ zIndex }"
      >
        <div class="absolute inset-0 bg-[var(--app-mask)]" @click="closeOnMask && close()" />

        <div
          class="app-dialog__panel relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden
            rounded-lg border border-border bg-overlay shadow-panel"
          :style="{ width: typeof width === 'number' ? `${width}px` : width }"
          role="dialog"
          aria-modal="true"
        >
          <header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h3 class="text-sm font-semibold text-text">
              {{ title }}
            </h3>
            <button
              type="button"
              class="ml-auto inline-flex size-6 items-center justify-center rounded-md
                text-muted transition-colors hover:bg-hover hover:text-text"
              title="关闭"
              @click="close"
            >
              <Icon name="close" />
            </button>
          </header>

          <div class="flex-1 overflow-auto px-4 py-3 text-text">
            <slot />
          </div>

          <footer
            v-if="$slots.footer"
            class="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-dialog-enter-active,
.app-dialog-leave-active {
  transition: opacity 0.15s ease;
}

.app-dialog-enter-active .app-dialog__panel,
.app-dialog-leave-active .app-dialog__panel {
  transition: transform 0.15s ease;
}

.app-dialog-enter-from,
.app-dialog-leave-to {
  opacity: 0;
}

.app-dialog-enter-from .app-dialog__panel,
.app-dialog-leave-to .app-dialog__panel {
  transform: scale(0.97);
}
</style>

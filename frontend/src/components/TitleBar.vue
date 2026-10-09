<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  isWindowMaximised,
  minimiseWindow,
  toggleMaximiseWindow,
} from '@/api/window'
import { openExternalUrl } from '@/api/runtime'
import { fetchAppInfo } from '@/api/system'
import Icon from '@/components/ui/Icon.vue'
import logoUrl from '@/assets/images/logo.png'

/** 项目仓库地址 */
const REPOSITORY_URL = 'https://github.com/tuple97/toolbox'

withDefaults(defineProps<{
  /** 工具栏左侧的应用名称 */
  title?: string
  /** 是否显示设置按钮 */
  showSettings?: boolean
}>(), {
  title: 'Toolbox',
  showSettings: true,
})

const emit = defineEmits<{
  /** 点击关闭按钮 */
  (e: 'close'): void
  /** 点击设置按钮 */
  (e: 'settings'): void
  /** 标题栏空白区域右键 */
  (e: 'context-menu', payload: { x: number, y: number }): void
}>()

/** 当前窗口是否最大化 */
const maximised = ref(false)

/** 应用版本号（标题右侧小字） */
const version = ref('')

/** 双击空白区域切换最大化 */
function handleDoubleClick(event: MouseEvent) {
  if (!isBlankArea(event.target)) {
    return
  }
  event.preventDefault()
  toggleMaximiseWindow()
  window.setTimeout(syncMaximised, 60)
}

/** 同步窗口最大化状态 */
async function syncMaximised() {
  try {
    maximised.value = await isWindowMaximised()
  }
  catch {
    maximised.value = false
  }
}

/** 事件目标是否在工具栏空白区域 */
function isBlankArea(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return !target.closest('[data-no-drag]')
}

/** 标题栏右键：弹出自定义系统菜单 */
function handleContextMenu(event: MouseEvent) {
  if (!isBlankArea(event.target)) {
    return
  }
  event.preventDefault()
  emit('context-menu', { x: event.clientX, y: event.clientY })
}

/** 最大化 / 还原后刷新按钮图标 */
function handleWindowResize() {
  void syncMaximised()
}

onMounted(async () => {
  void syncMaximised()
  window.addEventListener('resize', handleWindowResize)
  version.value = String((await fetchAppInfo()).version ?? '')
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleWindowResize)
})
</script>

<template>
  <header
    class="titlebar"
    :class="{ 'titlebar--maximised': maximised }"
    @dblclick="handleDoubleClick"
    @contextmenu="handleContextMenu"
  >
    <!-- 应用标识 -->
    <div class="titlebar__brand">
      <img class="titlebar__logo" :src="logoUrl" alt="">
      <span class="titlebar__title">{{ title }}</span>
      <small v-if="version" class="titlebar__version">v{{ version }}</small>
    </div>

    <!-- 中间插槽 -->
    <div class="titlebar__slot">
      <slot name="center" />
    </div>

    <!-- 窗口控制按钮 -->
    <div class="titlebar__controls" data-no-drag>
      <button
        class="titlebar__btn"
        type="button"
        aria-label="GitHub 仓库"
        title="GitHub 仓库"
        @click="openExternalUrl(REPOSITORY_URL)"
      >
        <Icon name="github" />
      </button>

      <button
        v-if="showSettings"
        class="titlebar__btn"
        type="button"
        aria-label="设置"
        title="设置"
        @click="emit('settings')"
      >
        <Icon name="settings" />
      </button>

      <button
        class="titlebar__btn"
        type="button"
        aria-label="最小化"
        title="最小化"
        @click="minimiseWindow"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="5.5" width="8" height="1" rx="0.5" />
        </svg>
      </button>

      <button
        class="titlebar__btn"
        type="button"
        :aria-label="maximised ? '还原' : '最大化'"
        :title="maximised ? '还原' : '最大化'"
        @click="toggleMaximiseWindow(); syncMaximised()"
      >
        <svg v-if="!maximised" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="4" width="6" height="6" rx="1" />
          <path d="M4.5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H9" />
        </svg>
      </button>

      <button
        class="titlebar__btn titlebar__btn--close"
        type="button"
        aria-label="关闭"
        title="关闭"
        @click="emit('close')"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  position: relative;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  flex: 0 0 48px;
  padding-left: 14px;
  background: var(--titlebar-bg);
  border-bottom: 1px solid var(--border-color);
  user-select: none;
  -webkit-user-select: none;

  /* 交给 Wails 原生机制处理拖动；刻意不声明 cursor */
  --wails-draggable: drag;
}

.titlebar__brand,
.titlebar__slot {
  display: flex;
  align-items: center;
  min-width: 0;
}

.titlebar__brand {
  gap: 8px;
}

.titlebar__logo {
  width: 18px;
  height: 18px;
  pointer-events: none;
  -webkit-user-drag: none;
}

.titlebar__title {
  font-size: var(--app-font-size);
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 版本号：小字浅色，跟在应用名后面 */
.titlebar__version {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-weight: 400;
}

.titlebar__slot {
  flex: 1;
  height: 100%;
}

.titlebar__controls {
  display: flex;
  align-items: stretch;
  height: 100%;
  /* 按钮区域不参与拖动 */
  --wails-draggable: no-drag;
}

.titlebar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 宽度随控件缩放，高度撑满标题栏 */
  width: calc(46px * var(--app-control-scale));
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size-xl);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

/* 窗口控制按钮的内联 svg 统一尺寸；排除自绘图标 .app-icon */
.titlebar__btn > svg:not(.app-icon) {
  width: calc(12px * var(--app-control-scale));
  height: calc(12px * var(--app-control-scale));
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;
}

/* 自绘图标按钮保持字号大小 */
.titlebar__btn > .app-icon {
  font-size: var(--app-font-size-xl);
}

.titlebar__btn:focus-visible {
  outline: 1px solid var(--brand-color);
  outline-offset: -2px;
}

.titlebar__btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.titlebar__btn:active {
  background: var(--active-bg);
}

.titlebar__btn--close:hover {
  background: #e81123;
  color: #fff;
}

.titlebar__btn--close:active {
  background: #c50f1f;
}
</style>

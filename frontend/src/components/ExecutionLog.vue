<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { notify } from '@/utils/notify'
import type { EditorView } from '@codemirror/view'
import ContextMenu from '@/components/ContextMenu.vue'
import CodeEditor from '@/components/CodeEditor.vue'
import { copyText } from '@/utils/clipboard'
import { useLogStore } from '@/stores/logStore'
import { LOG_LANGUAGE_ID } from '@/utils/logLanguage'
import type { ContextMenuAction } from '@/types'

const logStore = useLogStore()

/** 日志文本 */
const logText = computed(() => logStore.entries.join('\n'))

/** 日志编辑器实例，用于取选中内容 / 复制 */
const viewRef = shallowRef<EditorView | null>(null)

function handleEditorMount(view: EditorView) {
  viewRef.value = view
}

// ---------------------------------------------------------------- 右键菜单

const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)

/** 菜单项：复制 / 复制全部 / 清空 */
const menuItems = computed<ContextMenuAction[]>(() => {
  const empty = !logStore.entries.length
  return [
    { key: 'copy', label: '复制', shortcut: 'Ctrl+C', disabled: empty },
    { key: 'copy-all', label: '复制全部', disabled: empty },
    { key: 'clear', label: '清空日志', disabled: empty, divided: true },
  ]
})

/** 右键：定位菜单，并把光标挪到点击处 */
function openMenu(event: MouseEvent) {
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuVisible.value = true

  const view = viewRef.value
  if (!view || !view.dom.contains(event.target as Node)) {
    return
  }
  if (!view.state.selection.main.empty) {
    return
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos != null) {
    view.dispatch({ selection: { anchor: pos } })
  }
}

/** 要复制的内容：有选中复制选中，否则复制所在行 */
function selectedOrCurrentLine(): string {
  const view = viewRef.value
  if (!view) {
    return logText.value
  }
  const range = view.state.selection.main
  if (!range.empty) {
    return view.state.sliceDoc(range.from, range.to)
  }
  const line = view.state.doc.lineAt(range.from)
  return view.state.sliceDoc(line.from, line.to)
}

/** 写剪贴板 + 统一提示 */
async function copyWithToast(text: string, message: string) {
  if (!text) {
    notify.warning('没有可复制的内容')
    return
  }
  try {
    await copyText(text)
    notify.success(message)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

async function handleMenuSelect(item: ContextMenuAction) {
  if (item.key === 'copy') {
    await copyWithToast(selectedOrCurrentLine(), '已复制')
    return
  }
  if (item.key === 'copy-all') {
    await copyWithToast(logText.value, `已复制全部 ${logStore.entries.length} 行`)
    return
  }
  if (item.key === 'clear') {
    logStore.clear()
    notify.success('执行记录已清空')
  }
}

/** 面板内快捷键：Ctrl/Cmd + A 全选、Ctrl/Cmd + C 复制选中内容 */
function handleKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
    return
  }
  const key = event.key.toLowerCase()
  if (key !== 'a' && key !== 'c') {
    return
  }

  const view = viewRef.value
  if (!view) {
    return
  }

  if (key === 'a') {
    event.preventDefault()
    view.focus()
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    return
  }

  if (view.state.selection.main.empty) {
    return
  }
  event.preventDefault()
  void copyWithToast(selectedOrCurrentLine(), '已复制')
}

// ---------------------------------------------------------------- 滚动到底部

/** 滚动到底部 */
function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = viewRef.value?.scrollDOM
    if (el instanceof HTMLElement) {
      el.scrollTop = el.scrollHeight
    }
  })
}

/** 日志变化后自动滚动到底部 */
watch(() => logStore.entries.length, async () => {
  await nextTick()
  scrollToBottom()
})

defineExpose({
  scrollToBottom,
})
</script>

<template>
  <section
    class="log-panel"
    @contextmenu.prevent="openMenu"
    @keydown="handleKeydown"
  >
    <div class="log-panel__body">
      <CodeEditor
        :model-value="logText"
        :language="LOG_LANGUAGE_ID"
        completion-mode="none"
        readonly
        disable-suggestions
        height="100%"
        @mount="handleEditorMount"
      />
    </div>

    <!-- 右键菜单：复制 / 复制全部 -->
    <ContextMenu
      v-model:visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="handleMenuSelect"
    />
  </section>
</template>

<style scoped>
/* 日志视图：占满容器 */
.log-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.log-panel__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 编辑器背景透明由 utils/logLanguage.ts 的主题负责 */
</style>

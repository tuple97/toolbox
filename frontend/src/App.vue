<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TitleBar from '@/components/TitleBar.vue'
import ConfirmHost from '@/components/ui/ConfirmHost.vue'
import Toaster from '@/components/ui/Toaster.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import EditingContextMenu from '@/components/EditingContextMenu.vue'
import WindowResizeEdges from '@/components/WindowResizeEdges.vue'
import Workbench from '@/layouts/Workbench.vue'
import { closeWindow, openDevTools, toggleMaximiseWindow } from '@/api/window'
import { useAppStore } from '@/stores/appStore'
import { useConfigStore } from '@/stores/configStore'
import { useLogStore } from '@/stores/logStore'
import { usePluginStore } from '@/stores/pluginStore'
import { useTabStore } from '@/stores/tabStore'
import { useUpdateStore } from '@/stores/updateStore'
import type { ContextMenuAction } from '@/types'
import { matchesShortcut, shortcutOf } from '@/utils/shortcuts'
import { autoCheckUpdateOnStartup } from '@/utils/appUpdate'

const appStore = useAppStore()
const configStore = useConfigStore()
const logStore = useLogStore()
const pluginStore = usePluginStore()
const tabStore = useTabStore()
const updateStore = useUpdateStore()

/** 自定义右键菜单状态（仅标题栏触发） */
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)

/** 打开设置（单例标签页） */
function openSettings() {
  tabStore.openTool('settings')
}

/** 标题栏系统右键菜单项 */
const titleBarMenuItems: ContextMenuAction[] = [
  { key: 'toggle-maximise', label: '最大化 / 还原', shortcut: '双击标题栏' },
  { key: 'reload', label: '重新载入界面', shortcut: 'Ctrl+R', divided: true },
  // 开发者工具
  { key: 'devtools', label: '检查元素', shortcut: 'F12', divided: true },
  { key: 'close', label: '退出应用', danger: true },
]

/** 打开右键菜单（仅由标题栏调用） */
function openContextMenu(payload: { x: number, y: number }) {
  menuX.value = payload.x
  menuY.value = payload.y
  menuVisible.value = true
}

/** 处理标题栏菜单项点击 */
function handleMenuSelect(item: ContextMenuAction) {
  switch (item.key) {
    case 'toggle-maximise':
      toggleMaximiseWindow()
      break
    case 'reload':
      window.location.reload()
      break
    case 'devtools':
      openDevTools()
      break
    case 'close':
      closeWindow()
      break
    default:
      break
  }
}

onMounted(async () => {
  // 加载后端初始化状态；本地库不可用时跳过依赖它的加载
  await appStore.load()
  if (!appStore.degraded) {
    // 加载全局配置并应用主题/字号
    await configStore.load()
    logStore.setMaxLines(configStore.logMaxLines)
    // 加载已启用插件的界面贡献
    void pluginStore.init()
  }

  // 更新能力始终可用（数据库损坏时也能靠更新自救）
  updateStore.init()
  void autoCheckUpdateOnStartup()
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) {
      return
    }
    if (matchesShortcut(event, shortcutOf('open-settings', configStore.values.shortcut_config))) {
      event.preventDefault()
      openSettings()
    }
  })
})
</script>

<template>
  <!-- 右键菜单仅在标题栏触发 -->
  <div class="app-root">
    <!-- 顶部工具栏：系统菜单与设置入口 -->
    <TitleBar
      title="Toolbox"
      @close="closeWindow"
      @settings="openSettings"
      @context-menu="openContextMenu"
    />

    <main class="app-main app-main--flush">
      <Workbench />
    </main>

    <!-- 窗口四周缩放宽边热区 -->
    <WindowResizeEdges />

    <!-- 标题栏系统右键菜单 -->
    <ContextMenu
      v-model:visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="titleBarMenuItems"
      @select="handleMenuSelect"
    />

    <!-- 全局默认右键菜单：复制 / 剪切 / 粘贴 -->
    <EditingContextMenu />

    <!-- 全局提示与确认框宿主 -->
    <Toaster />
    <ConfirmHost />
  </div>
</template>

<style scoped>
/* 工作台自行管理内部滚动，外层不再叠加内边距与滚动 */
.app-main--flush {
  overflow: hidden;
}
</style>

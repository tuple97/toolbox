<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TitleBar from '@/components/TitleBar.vue'
import ConfirmHost from '@/components/ui/ConfirmHost.vue'
import Toaster from '@/components/ui/Toaster.vue'
import ContextMenu from '@/components/ContextMenu.vue'
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

/** 打开设置：设置已改为单例标签页，不存在则新建并跳转 */
function openSettings() {
  tabStore.openTool('settings')
}

/** 标题栏系统右键菜单项 */
const titleBarMenuItems: ContextMenuAction[] = [
  { key: 'toggle-maximise', label: '最大化 / 还原', shortcut: '双击标题栏' },
  { key: 'reload', label: '重新载入界面', shortcut: 'Ctrl+R', divided: true },
  // 调试用：打开 WebView 的开发者工具（与 F12 相同），方便查样式
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
  // 先看后端初始化状态：失败（degraded）时本地数据功能不可用，
  // 但界面与更新能力仍然可用，所以下面只跳过依赖本地库的加载
  await appStore.load()
  if (!appStore.degraded) {
    // 启动时加载全局配置并应用主题/字号
    await configStore.load()
    logStore.setMaxLines(configStore.logMaxLines)
    // 插件宿主：加载已启用插件的界面贡献（不阻塞首屏，失败只影响插件）
    void pluginStore.init()
  }

  // 更新状态是应用级能力：先订阅状态变化（初始化一次），
  // 再按设置检查新版本——始终执行，数据库损坏时也能靠更新自救
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
  <!-- 注意：这里不接管右键，右键菜单仅在标题栏触发 -->
  <div class="app-root">
    <!-- 自定义顶部工具栏：系统菜单与设置入口都在这里 -->
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

    <!--
      全局反馈宿主：各挂一个即可（内部 Teleport 到 body）。
      提示与确认框都是「命令式调用 + 全局队列」，所以放在应用根部而不是逐页挂载。
    -->
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

import { createApp, watchEffect } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { syncWindowBackground } from './api/window'
import { openEditingContextMenu } from './utils/editingContextMenu'
import { installTitleTooltip } from './utils/tooltip'
import { useConfigStore } from './stores/configStore'

/*
 * 样式入口顺序：先 Tailwind 与设计令牌（含元素级重置），再应用自己的 global.css。
 * 自定义样式放最后，同特异性下由它说了算。
 */
import './styles/tailwind.css'
import './styles/global.css'
// 模板管理弹窗内面板的表单样式规范（变量配置 / 字段映射共用）
import './styles/template-panels.css'

const app = createApp(App)

app.use(createPinia())

// 主题由 configStore 在启动时从后端配置读取并应用，
// 这里先默认暗色，避免首帧闪白。
document.documentElement.classList.add('dark')

/**
 * 全局接管右键菜单。
 *
 * 一律 preventDefault：原生浏览器菜单在本应用里没有使用场景，输入框也不例外 ——
 * 那些位置改为弹出应用自己的「复制 / 剪切 / 粘贴」（utils/editingContextMenu.ts），
 * 菜单项的启用状态按选区与剪贴板实时判定。
 *
 * 例外：已经自带右键菜单的组件（标签页、插件卡片、日志、代码块……）会在冒泡阶段
 * 先调用 preventDefault，这里看到 defaultPrevented 就不再叠一层默认菜单。
 */
document.addEventListener('contextmenu', (event) => {
  if (event.defaultPrevented) {
    return
  }
  event.preventDefault()
  openEditingContextMenu(event)
})

app.mount('#app')

// 把原生 title 提示换成应用自己的小提示（样式见 global.css 的 #app-tip）
installTitleTooltip()

// 主题变化时同步窗口底色：窗口重绘时擦出的底色与页面一致，避免闪黑/闪白
// （配置由 App.vue 加载，这里只跟随结果，不重复请求）
const configStore = useConfigStore()
watchEffect(() => syncWindowBackground(configStore.theme))

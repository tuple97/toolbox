import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchSettings, persistSetting } from '@/api/settings'
import { DEFAULT_FONT, composeFontStack } from '@/utils/fonts'
import type { ControlSize, SettingKey, ThemeMode } from '@/types'

/** 防抖保存间隔 */
const SAVE_DEBOUNCE_MS = 400

/** 主题缓存键，index.html 内联脚本首帧据此应用主题 */
const APP_THEME_STORAGE_KEY = 'toolbox-theme'

/** 配置项默认值，与后端 defaultSettings 保持一致 */
const DEFAULTS: Record<SettingKey, string> = {
  theme: 'dark',
  // 界面缩放比例（百分比，100 = 100%）
  ui_scale: '100',
  font_size: '13',
  control_size: 'default',
  editor_font_size: '13',
  log_max_lines: '200',
  // 字体分中英两档：英文字体吃拉丁与符号，中文字体只负责中文字形
  font_family: DEFAULT_FONT,
  font_family_zh: DEFAULT_FONT,
  editor_font_family: DEFAULT_FONT,
  editor_font_family_zh: DEFAULT_FONT,
  sidebar_config: '{}',
  picker_config: '{}',
  sidebar_view: '{}',
  sql_completion_trigger: 'positional',
  sql_completion_alias: 'false',
  // 默认显示系统库
  sql_show_system_databases: 'true',
  // 片段插入后 Tab 在占位符之间跳转
  template_placeholder_tab: 'true',
  shortcut_config: '{}',
  // 启动后自动检查新版本
  app_auto_update: 'true',
}

export const useConfigStore = defineStore('config', () => {
  /** 全部配置的原始字符串值 */
  const values = ref<Record<string, string>>({ ...DEFAULTS })
  const loaded = ref(false)
  const error = ref('')

  /** 主题；未知值回退 dark */
  const theme = computed<ThemeMode>(() => {
    const raw = values.value.theme
    return raw === 'light' || raw === 'midnight' || raw === 'idea' ? raw : 'dark'
  })

  /** 界面缩放比例（1 = 100%），限制在 60%~200% */
  const uiScale = computed(() => {
    const raw = toNumber(values.value.ui_scale, 100)
    return Math.min(Math.max(raw, 60), 200) / 100
  })

  /** 控件大小（历史配置项，仅为兼容旧数据） */
  const controlSize = computed<ControlSize>(() => {
    const size = values.value.control_size
    return size === 'large' || size === 'small' ? size : 'default'
  })

  /** 编辑器字号 */
  const editorFontSize = computed(() => toNumber(values.value.editor_font_size, 13))

  /** 编辑器英文字体标识 */
  const editorFontFamily = computed(() => values.value.editor_font_family || DEFAULT_FONT)

  /** 编辑器中文字体标识 */
  const editorFontFamilyZh = computed(() => values.value.editor_font_family_zh || DEFAULT_FONT)

  /** 编辑器字体栈（英文在前，中文兜底） */
  const editorFontStack = computed(() =>
    composeFontStack(editorFontFamily.value, editorFontFamilyZh.value))

  const logMaxLines = computed(() => toNumber(values.value.log_max_lines, 200))

  /** 界面英文字体标识 */
  const fontFamily = computed(() => values.value.font_family || DEFAULT_FONT)

  /** 界面中文字体标识 */
  const fontFamilyZh = computed(() => values.value.font_family_zh || DEFAULT_FONT)

  /** 界面字体栈（英文在前，中文兜底） */
  const fontFamilyStack = computed(() =>
    composeFontStack(fontFamily.value, fontFamilyZh.value))

  function get(key: SettingKey): string {
    return values.value[key] ?? DEFAULTS[key]
  }

  // ------------------------------------------------------------ 持久化

  let saveTimer: number | null = null
  const dirtyKeys = new Set<string>()

  function scheduleSave(key: string) {
    dirtyKeys.add(key)
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
    }
    saveTimer = window.setTimeout(async () => {
      saveTimer = null
      const keys = Array.from(dirtyKeys)
      dirtyKeys.clear()

      for (const item of keys) {
        try {
          await persistSetting(item, values.value[item] ?? '')
        }
        catch (e) {
          error.value = e instanceof Error ? e.message : String(e)
        }
      }
    }, SAVE_DEBOUNCE_MS)
  }

  /** 设置某项配置并立即生效 */
  function set(key: SettingKey, value: string) {
    if (values.value[key] === value) {
      return
    }
    values.value[key] = value
    applyByKey(key)
    scheduleSave(key)
  }

  function applyByKey(key: SettingKey) {
    switch (key) {
      case 'theme':
        applyTheme()
        break
      case 'ui_scale':
        applyUiScale()
        break
      case 'control_size':
        applyControlScale()
        break
      case 'font_family':
      case 'font_family_zh':
        applyFontFamily()
        break
      case 'editor_font_family':
      case 'editor_font_family_zh':
        // 编辑器字体通过 CSS 变量传给 CodeMirror，无需动 DOM
        break
      default:
        break
    }
  }

  /** 全部配置恢复默认值 */
  function resetAll() {
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
      set(key, DEFAULTS[key])
    }
  }

  /** 从后端加载配置 */
  async function load() {
    try {
      const list = await fetchSettings()
      const next: Record<string, string> = { ...DEFAULTS }
      for (const item of list) {
        next[item.key] = item.value
      }
      values.value = next
      error.value = ''
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      loaded.value = true
      applyTheme()
      applyUiScale()
      applyControlScale()
      applyFontFamily()
    }
  }

  // ------------------------------------------------------------ 应用外观

  /** 应用主题：`.dark` 类区分明暗，`data-theme` 指定具体配色 */
  function applyTheme() {
    const root = document.documentElement
    const isDark = theme.value !== 'light'
    if (isDark) {
      root.classList.add('dark')
    }
    else {
      root.classList.remove('dark')
    }
    root.dataset.theme = theme.value

    // 缓存主题供 HTML 首帧读取
    try {
      localStorage.setItem(APP_THEME_STORAGE_KEY, theme.value)
    }
    catch {
      // localStorage 不可用时忽略
    }
  }

  /** 应用缩放比例：只写 `--app-scale` 乘数 */
  function applyUiScale() {
    document.documentElement.style.setProperty('--app-scale', String(uiScale.value))
  }

  /** 应用控件大小：写入 `--app-control-scale` 变量 */
  function applyControlScale() {
    const scale = controlSize.value === 'small' ? 0.9 : controlSize.value === 'large' ? 1.1 : 1
    document.documentElement.style.setProperty('--app-control-scale', String(scale))
  }

  /** 应用界面字体：写入 `--app-font-family` 变量 */
  function applyFontFamily() {
    document.documentElement.style.setProperty('--app-font-family', fontFamilyStack.value)
  }

  return {
    // state
    values,
    loaded,
    error,
    // getters
    theme,
    uiScale,
    controlSize,
    editorFontSize,
    editorFontFamily,
    editorFontFamilyZh,
    editorFontStack,
    logMaxLines,
    fontFamily,
    fontFamilyZh,
    fontFamilyStack,
    // actions
    get,
    set,
    resetAll,
    load,
    applyTheme,
    applyUiScale,
    applyControlScale,
    applyFontFamily,
  }
})

/** 把配置值转为数字，解析失败时回退默认值 */
function toNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

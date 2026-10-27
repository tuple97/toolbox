<script setup lang="ts">
/** 设置（单例标签页）：只展示工具箱自身的设置，改动即时生效并自动保存 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import Field from '@/components/ui/Field.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import Slider from '@/components/ui/Slider.vue'
import Switch from '@/components/ui/Switch.vue'
import Tag from '@/components/ui/Tag.vue'
import { fetchSystemFonts } from '@/api/fonts'
import { useConfigStore } from '@/stores/configStore'
import { useLogStore } from '@/stores/logStore'
import { useMetadataStore } from '@/stores/metadataStore'
import { usePluginStore } from '@/stores/pluginStore'
import { useUpdateStore } from '@/stores/updateStore'
import { installUpdate } from '@/utils/appUpdate'
import { buildFontOptions } from '@/utils/fonts'
import { notify } from '@/utils/notify'
import { pendingSettingPanel } from '@/utils/settingsNav'
import { SQL_TRIGGER_MODE_OPTIONS, parseSqlTriggerMode } from '@/utils/sql/sqlCompletionTrigger'
import { parseShowSystemDatabases } from '@/utils/sql/sqlVisibility'
import { parsePlaceholderTabJump } from '@/utils/sql/template/templatePlaceholder'
import type { PluginRegistrySource, ThemeMode } from '@/types'

const configStore = useConfigStore()
const logStore = useLogStore()
const metadataStore = useMetadataStore()
/** 插件源由插件 store 统一维护（插件市场页与本页共用） */
const pluginStore = usePluginStore()
/** 更新状态由后端快照驱动（见 stores/updateStore.ts），本页只读 */
const updateStore = useUpdateStore()

const emit = defineEmits<{
  /** 首次加载完成 */
  (e: 'ready'): void
}>()

// ---------------------------------------------------------------- 导航

/** 菜单叶子项：一个设置面板 */
interface SettingNavItem {
  /** 面板 id，与模板里各 section 的 v-show 对应 */
  id: string
  label: string
  icon: string
}

/** 菜单分组（可折叠） */
interface SettingNavGroup {
  id: string
  label: string
  items: SettingNavItem[]
}

/**
 * 左侧多级菜单结构。
 *
 * 只放工具箱自身的设置；插件设置由插件卡片右键菜单的「配置」弹窗承载，
 * 因此这里的分组不会随插件启停变化。
 */
const SETTING_GROUPS: SettingNavGroup[] = [
  {
    id: 'interface',
    label: '界面',
    items: [
      { id: 'general', label: '外观', icon: 'eye' },
      { id: 'editor', label: '编辑器', icon: 'pencil' },
    ],
  },
  {
    id: 'sql',
    label: 'SQL',
    items: [
      { id: 'sql', label: 'SQL 提示', icon: 'terminal' },
      { id: 'template', label: '模板', icon: 'braces' },
    ],
  },
  {
    id: 'plugins',
    label: '插件',
    items: [
      { id: 'plugins', label: '插件源', icon: 'puzzle' },
    ],
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { id: 'advanced', label: '高级', icon: 'wand' },
      { id: 'update', label: '更新', icon: 'download' },
    ],
  },
]

/** 当前选中的设置面板 */
const activeTab = ref('general')

/** 展开的分组；层级浅、项目少，默认全展开 */
const expandedGroups = ref<string[]>(SETTING_GROUPS.map(group => group.id))

/** 折叠 / 展开一个分组 */
function toggleGroup(id: string): void {
  expandedGroups.value = expandedGroups.value.includes(id)
    ? expandedGroups.value.filter(item => item !== id)
    : [...expandedGroups.value, id]
}

/** 选中某个面板；顺带展开它所在的分组（分组被折叠时也能直接跳过去） */
function selectTab(id: string): void {
  activeTab.value = id
  const group = SETTING_GROUPS.find(item => item.items.some(child => child.id === id))
  if (group && !expandedGroups.value.includes(group.id)) {
    expandedGroups.value = [...expandedGroups.value, group.id]
  }
}

/*
 * 别的页面跳过来时按目标面板定位（例如插件市场点「管理来源」）。
 *
 * 用 immediate 是因为存在两种时序：设置页还没挂载时目标先写入，
 * 挂载后要立刻用上；已经挂载时则由 watch 实时响应。
 */
watch(pendingSettingPanel, (id) => {
  if (!id) {
    return
  }
  selectTab(id)
  pendingSettingPanel.value = ''
}, { immediate: true })

// ---------------------------------------------------------------- 外观

const themeOptions: Array<{ label: string, value: string }> = [
  { label: '深蓝（默认）', value: 'dark' },
  { label: '极夜黑', value: 'midnight' },
  { label: 'IDEA 风格', value: 'idea' },
  { label: '亮色', value: 'light' },
]

/* v-model 是 string，类型收窄放在 setter 里做 */
const theme = computed<string>({
  get: () => configStore.theme,
  set: (value: string) => configStore.set('theme', value as ThemeMode),
})

/** 缩放比例的预设档位（百分比） */
const SCALE_STEPS = [80, 90, 100, 110, 120, 130, 150]

/** 缩放比例（下拉框，百分比） */
const uiScale = computed<string>({
  get: () => String(Math.round(configStore.uiScale * 100)),
  set: (value: string) => configStore.set('ui_scale', value),
})

/** 缩放比例下拉选项：预设档位 + 配置里的值 */
const scaleChoices = computed(() => {
  const current = Math.round(configStore.uiScale * 100)
  const values = SCALE_STEPS.includes(current)
    ? SCALE_STEPS
    : [...SCALE_STEPS, current].sort((left, right) => left - right)
  return values.map(value => ({
    label: value === 100 ? '100%（默认）' : `${value}%`,
    value: String(value),
  }))
})

/** 界面英文字体（吃拉丁与符号） */
const fontFamily = computed({
  get: () => configStore.fontFamily,
  set: (value: string) => configStore.set('font_family', value),
})

/** 界面中文字体（只负责中文字形） */
const fontFamilyZh = computed({
  get: () => configStore.fontFamilyZh,
  set: (value: string) => configStore.set('font_family_zh', value),
})

/** 本机已安装字体 */
const systemFonts = ref<string[]>([])

/** 字体下拉选项：内置字体 + 本机字体，中英两档各自一份 */
const enFontChoices = computed(() => buildFontOptions(systemFonts.value, 'en'))
const zhFontChoices = computed(() => buildFontOptions(systemFonts.value, 'zh'))

// ---------------------------------------------------------------- 编辑器

/** 编辑器英文字体（代码与符号，等宽） */
const editorFontFamily = computed({
  get: () => configStore.editorFontFamily,
  set: (value: string) => configStore.set('editor_font_family', value),
})

/** 编辑器中文字体（中文注释等） */
const editorFontFamilyZh = computed({
  get: () => configStore.editorFontFamilyZh,
  set: (value: string) => configStore.set('editor_font_family_zh', value),
})

// ---------------------------------------------------------------- SQL

const sqlTriggerMode = computed({
  get: () => parseSqlTriggerMode(configStore.values.sql_completion_trigger),
  set: (value: string) => configStore.set('sql_completion_trigger', value),
})

/** 提示触发方式的候选 */
const triggerChoices = SQL_TRIGGER_MODE_OPTIONS.map(option => ({
  label: option.label,
  value: option.value,
  hint: option.hint,
}))

const sqlAutoAlias = computed({
  get: () => configStore.values.sql_completion_alias === 'true',
  set: (value: boolean) => configStore.set('sql_completion_alias', value ? 'true' : 'false'),
})

const sqlShowSystemDatabases = computed({
  get: () => parseShowSystemDatabases(configStore.values.sql_show_system_databases),
  set: (value: boolean) => configStore.set('sql_show_system_databases', value ? 'true' : 'false'),
})

// ---------------------------------------------------------------- 模板

const templatePlaceholderTab = computed({
  get: () => parsePlaceholderTabJump(configStore.values.template_placeholder_tab),
  set: (value: boolean) => configStore.set('template_placeholder_tab', value ? 'true' : 'false'),
})

// ---------------------------------------------------------------- 高级

const logMaxLines = computed({
  get: () => configStore.logMaxLines,
  set: (value: number) => {
    configStore.set('log_max_lines', String(value))
    logStore.setMaxLines(value)
  },
})

/** 元数据缓存规模 */
const metadataCache = computed(() => ({
  databases: Object.keys(metadataStore.databases).length,
  tables: Object.keys(metadataStore.tables).length,
}))

/** 页内状态行（3 秒后淡出） */
const status = ref('')
let statusTimer: number | null = null

function flash(message: string) {
  status.value = message
  if (statusTimer) {
    window.clearTimeout(statusTimer)
  }
  statusTimer = window.setTimeout(() => {
    status.value = ''
  }, 3000)
}

function clearMetadataCache() {
  metadataStore.clear()
  flash('元数据缓存已清空，下次补全会重新读取')
}

/** 恢复默认设置的两段式确认状态 */
const resetArmed = ref(false)

function resetSettings() {
  if (!resetArmed.value) {
    resetArmed.value = true
    return
  }
  configStore.resetAll()
  // 日志上限需显式同步给 logStore
  logStore.setMaxLines(configStore.logMaxLines)
  resetArmed.value = false
  flash('已恢复默认设置')
}

// ---------------------------------------------------------------- 更新

/** 自动检查更新（默认开启） */
const autoUpdate = computed({
  get: () => configStore.values.app_auto_update === 'true',
  set: (value: boolean) => configStore.set('app_auto_update', value ? 'true' : 'false'),
})

/** 当前版本号（以后端快照为准，不另外查一次应用信息） */
const currentVersionLabel = computed(() =>
  updateStore.snapshot.currentVersion ? `v${updateStore.snapshot.currentVersion}` : '—',
)

/** 是否处于「进行中」阶段：下载 / 校验 / 安装 */
const updateInProgress = computed(() =>
  ['downloading', 'verifying', 'installing'].includes(updateStore.state),
)

/** 进度文案：区分下载 / 校验 / 安装 */
const updateProgressLabel = computed(() => {
  switch (updateStore.state) {
    case 'verifying':
      return '正在校验更新包…'
    case 'installing':
      return '正在安装更新…'
    default:
      return updateStore.progress >= 0 ? `${updateStore.progress}%` : '下载中'
  }
})

/** 进度条宽度（总长未知时不铺满） */
const updateProgressWidth = computed(() => `${updateStore.progress > 0 ? updateStore.progress : 0}%`)

/** 下载并安装（弹窗编排与启动流程共用一套） */
function handleInstallUpdate() {
  void installUpdate()
}

// ---------------------------------------------------------------- 插件源

/** 新增来源的地址输入 */
const newSourceUrl = ref('')
/** 新增来源的名称输入（可选） */
const newSourceName = ref('')

/** 已保存的来源列表 */
const pluginSources = computed(() => pluginStore.sources)

/** 选中来源的插件简略列表 */
const sourcePreview = computed(() => pluginStore.sourceSnapshot)

/** 添加一个插件源 */
async function addPluginSource(): Promise<void> {
  const url = newSourceUrl.value.trim()
  if (!url) {
    notify.warning('请填写插件源地址')
    return
  }
  if (pluginSources.value.some(source => source.url === url)) {
    notify.warning('该插件源已存在')
    return
  }
  try {
    await pluginStore.updateSources([
      ...pluginSources.value,
      { url, name: newSourceName.value.trim(), enabled: true },
    ])
    newSourceUrl.value = ''
    newSourceName.value = ''
    notify.success('插件源已添加')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 删除一个插件源 */
async function removePluginSource(source: PluginRegistrySource): Promise<void> {
  try {
    await pluginStore.updateSources(
      pluginSources.value.filter(item => item.url !== source.url),
    )
    notify.success('插件源已删除')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 启用 / 停用一个插件源（停用后不参与市场合并，但仍可单独查看） */
async function togglePluginSource(source: PluginRegistrySource, enabled: boolean): Promise<void> {
  try {
    await pluginStore.updateSources(
      pluginSources.value.map(item => (item.url === source.url ? { ...item, enabled } : item)),
    )
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 选中某个来源：右侧预览它提供哪些插件 */
function pickPluginSource(source: PluginRegistrySource): void {
  void pluginStore.loadSourceSnapshot(source.url)
}

/** 强制刷新选中来源的插件列表 */
function refreshSourcePreview(): void {
  if (pluginStore.previewSourceUrl) {
    void pluginStore.loadSourceSnapshot(pluginStore.previewSourceUrl, true)
  }
}

onMounted(async () => {
  // 打开本页时对齐一次权威状态：即便更新早就开始（启动自动检查），这里也能看到
  void updateStore.refresh()
  // 插件源列表是本地读取，先拉一次并顺带预览第一个来源
  void pluginStore.loadSources().then(() => {
    if (pluginStore.previewSourceUrl) {
      void pluginStore.loadSourceSnapshot(pluginStore.previewSourceUrl)
    }
  })
  try {
    systemFonts.value = await fetchSystemFonts()
  }
  finally {
    // 失败也要上报
    emit('ready')
  }
})

onBeforeUnmount(() => {
  if (statusTimer) {
    window.clearTimeout(statusTimer)
  }
})
</script>

<template>
  <div class="settings-view">
    <header class="settings-view__head">
      <span class="h-4 w-1 rounded-full bg-brand" aria-hidden="true" />
      <span class="font-semibold text-text">设置</span>
    </header>

    <div class="settings-view__body">
      <!-- 左侧多级菜单：分组可折叠，叶子项对应右侧一个设置面板 -->
      <nav class="settings-nav">
        <section v-for="group in SETTING_GROUPS" :key="group.id" class="settings-nav__group">
          <button
            class="settings-nav__group-head"
            type="button"
            @click="toggleGroup(group.id)"
          >
            <Icon
              name="chevron-down"
              class="settings-nav__arrow"
              :class="{ 'is-expanded': expandedGroups.includes(group.id) }"
            />
            <span class="settings-nav__group-label">{{ group.label }}</span>
          </button>

          <ul v-show="expandedGroups.includes(group.id)" class="settings-nav__items">
            <li
              v-for="item in group.items"
              :key="item.id"
              class="settings-nav__item"
              :class="{ 'is-active': activeTab === item.id }"
              @click="selectTab(item.id)"
            >
              <Icon class="settings-nav__icon" :name="item.icon" />
              <span class="settings-nav__label">{{ item.label }}</span>
            </li>
          </ul>
        </section>
      </nav>

      <!-- 右侧面板：一次只显示一个，独立滚动 -->
      <div class="settings-view__content">
        <p v-if="status" class="mb-2 text-xs text-brand">
          {{ status }}
        </p>

        <!-- 外观 -->
        <section v-show="activeTab === 'general'" class="space-y-1">
          <Field label="主题">
            <Combobox v-model="theme" :options="themeOptions" />
          </Field>

          <Field label="缩放比例">
            <Combobox v-model="uiScale" :options="scaleChoices" />
          </Field>

          <Field label="界面字体 · 英文">
            <Combobox
              v-model="fontFamily"
              :options="enFontChoices"
              search-placeholder="搜索字体…"
            />
          </Field>

          <Field label="界面字体 · 中文">
            <Combobox
              v-model="fontFamilyZh"
              :options="zhFontChoices"
              search-placeholder="搜索字体…"
            />
          </Field>
        </section>

        <!-- 编辑器 -->
        <section v-show="activeTab === 'editor'" class="space-y-1">
          <Field label="编辑器字体 · 英文">
            <Combobox
              v-model="editorFontFamily"
              :options="enFontChoices"
              search-placeholder="搜索字体…"
            />
          </Field>

          <Field label="编辑器字体 · 中文">
            <Combobox
              v-model="editorFontFamilyZh"
              :options="zhFontChoices"
              search-placeholder="搜索字体…"
            />
          </Field>
        </section>

        <!-- SQL -->
        <section v-show="activeTab === 'sql'" class="space-y-1">
          <Field label="提示触发">
            <Combobox v-model="sqlTriggerMode" :options="triggerChoices" />
          </Field>

          <Field label="表名自动别名">
            <Switch v-model="sqlAutoAlias" />
          </Field>

          <Field label="展示系统库">
            <Switch v-model="sqlShowSystemDatabases" />
          </Field>
        </section>

        <!-- 模板 -->
        <section v-show="activeTab === 'template'" class="space-y-1">
          <Field label="占位符跳转">
            <Switch v-model="templatePlaceholderTab" />
          </Field>
        </section>

        <!-- 高级 -->
        <section v-show="activeTab === 'advanced'" class="space-y-1">
          <Field label="日志保留条数">
            <div class="flex items-center gap-3">
              <Slider v-model="logMaxLines" :min="50" :max="1000" :step="50" class="w-56" />
              <span class="w-12 text-sm text-muted">{{ logMaxLines }}</span>
            </div>
          </Field>

          <Field label="元数据缓存">
            <div class="flex items-center gap-3">
              <span class="text-sm text-muted">
                {{ metadataCache.databases }} 个库 · {{ metadataCache.tables }} 张表
              </span>
              <Button variant="secondary" size="sm" @click="clearMetadataCache">
                清空缓存
              </Button>
            </div>
          </Field>

          <!-- 标签就是按钮本身，不再重复一遍「恢复默认设置」 -->
          <Field>
            <div class="flex items-center gap-2">
              <Button
                :variant="resetArmed ? 'danger' : 'secondary'"
                size="sm"
                @click="resetSettings"
              >
                {{ resetArmed ? '确认恢复默认' : '恢复默认设置' }}
              </Button>
              <Button v-if="resetArmed" variant="ghost" size="sm" @click="resetArmed = false">
                取消
              </Button>
            </div>
          </Field>
        </section>

        <!-- 更新 -->
        <section v-show="activeTab === 'update'" class="space-y-1">
          <Field label="当前版本">
            <span class="text-sm text-muted">{{ currentVersionLabel }}</span>
          </Field>

          <Field label="自动检查更新">
            <Switch v-model="autoUpdate" />
          </Field>

          <!-- 标签与按钮文案重复，去掉标签让按钮自己说话 -->
          <Field>
            <div class="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                :loading="updateStore.state === 'checking'"
                :disabled="!updateStore.snapshot.canCheck"
                @click="updateStore.check()"
              >
                检查更新
              </Button>
              <span v-if="updateStore.state === 'up-to-date'" class="text-sm text-muted">已是最新版本</span>
              <span v-else-if="updateStore.error" class="text-sm text-danger">{{ updateStore.error }}</span>
              <span v-else-if="updateStore.snapshot.message" class="text-sm text-muted">
                {{ updateStore.snapshot.message }}
              </span>
            </div>
          </Field>

          <!-- 发现新版本：下载入口（失败后按钮变成重试） -->
          <div
            v-if="updateStore.snapshot.canDownload"
            class="space-y-2 rounded-md border border-brand/30 bg-brand/8 p-3"
          >
            <div class="text-sm font-semibold text-brand">
              发现新版本 v{{ updateStore.snapshot.latestVersion }}
            </div>
            <p
              v-if="updateStore.snapshot.notes"
              class="max-h-40 overflow-auto whitespace-pre-line text-xs text-muted"
            >
              {{ updateStore.snapshot.notes }}
            </p>
            <Button size="sm" @click="handleInstallUpdate">
              {{ updateStore.state === 'error' ? '重试下载' : '下载并安装' }}
            </Button>
          </div>

          <!-- 下载 / 校验 / 安装：都算「进行中」，进度条常驻（后端快照带阶段） -->
          <Field v-if="updateInProgress" label="更新进度">
            <div class="flex items-center gap-3">
              <div class="h-1.5 w-56 overflow-hidden rounded-full bg-muted/20">
                <div
                  class="h-full bg-brand transition-[width] duration-200"
                  :style="{ width: updateProgressWidth }"
                />
              </div>
              <span class="text-sm text-muted">{{ updateProgressLabel }}</span>
              <Button
                v-if="updateStore.state === 'downloading'"
                variant="secondary"
                size="sm"
                :disabled="!updateStore.snapshot.canCancel"
                @click="updateStore.cancel()"
              >
                取消下载
              </Button>
            </div>
          </Field>

          <Field v-if="updateStore.state === 'ready'" label="更新已就绪">
            <div class="flex items-center gap-3">
              <span class="text-sm text-muted">重启应用后生效</span>
              <Button size="sm" :disabled="!updateStore.snapshot.canRestart" @click="updateStore.restart()">
                立即重启
              </Button>
            </div>
          </Field>
        </section>

        <!-- 插件源（面板标题已在左侧菜单上，这里不再重复） -->
        <section v-show="activeTab === 'plugins'" class="space-y-3">
          <div class="plugin-sources">
            <ul class="plugin-sources__list">
              <li v-for="source in pluginSources" :key="source.url" class="plugin-sources__item">
                <Switch
                  :model-value="source.enabled"
                  title="停用后不参与市场合并，但仍可单独查看"
                  @update:model-value="togglePluginSource(source, $event)"
                />
                <button
                  type="button"
                  class="plugin-sources__pick"
                  :class="{ 'is-active': pluginStore.previewSourceUrl === source.url }"
                  :title="source.url"
                  @click="pickPluginSource(source)"
                >
                  <span class="plugin-sources__name">{{ source.name || source.url }}</span>
                  <span class="plugin-sources__url">{{ source.url }}</span>
                </button>
                <Button variant="ghost" size="sm" @click="removePluginSource(source)">删除</Button>
              </li>
              <li v-if="pluginSources.length === 0" class="plugin-sources__empty">
                未配置时使用内置官方源。
              </li>
            </ul>

            <div class="plugin-sources__add">
              <Input
                v-model="newSourceUrl"
                size="sm"
                class="plugin-sources__url-input"
                placeholder="https://example.com/registry.json"
              />
              <Input v-model="newSourceName" size="sm" class="plugin-sources__name-input" placeholder="名称（可选）" />
              <Button size="sm" @click="addPluginSource">添加</Button>
            </div>
          </div>

          <!-- 选中来源的插件简略列表 -->
          <div v-if="pluginStore.previewSourceUrl" class="plugin-sources__preview">
            <div class="plugin-sources__preview-head">
              <span class="plugin-sources__preview-title">
                {{ sourcePreview?.source.name || pluginStore.previewSourceUrl }}
              </span>
              <Tag
                v-if="sourcePreview?.source.official"
                tone="brand"
                effect="plain"
                size="sm"
              >
                官方源
              </Tag>
              <Tag
                v-if="sourcePreview?.source.state === 'ready'"
                :tone="sourcePreview.source.verified ? 'success' : 'warning'"
                effect="plain"
                size="sm"
              >
                {{ sourcePreview.source.verified ? '已验签' : '未验签' }}
              </Tag>
              <Tag
                v-else-if="sourcePreview?.source.state === 'error'"
                tone="danger"
                effect="plain"
                size="sm"
              >
                读取失败
              </Tag>
              <span class="plugin-sources__preview-count">
                共 {{ sourcePreview?.items.length ?? 0 }} 个插件
              </span>
              <Button variant="ghost" size="sm" @click="refreshSourcePreview">
                <Icon name="refresh" />
                刷新
              </Button>
            </div>

            <p v-if="sourcePreview?.source.error" class="plugin-sources__error">
              {{ sourcePreview.source.error }}
            </p>

            <ul v-else-if="sourcePreview && sourcePreview.items.length > 0" class="plugin-sources__plugins">
              <li v-for="item in sourcePreview.items" :key="item.id" class="plugin-sources__plugin">
                <Icon class="plugin-sources__plugin-icon" :name="item.icon || 'puzzle'" />
                <span class="plugin-sources__plugin-name">{{ item.name }}</span>
                <span class="plugin-sources__plugin-version">v{{ item.version }}</span>
                <Tag v-if="item.installed" tone="info" effect="plain" size="sm">已安装</Tag>
                <span v-if="item.description" class="plugin-sources__plugin-desc">{{ item.description }}</span>
              </li>
            </ul>

            <p v-else class="text-sm text-muted">该来源暂无插件。</p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.settings-view__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px 10px;
}

.settings-view__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ------------------------------------------------ 左侧多级菜单 */

.settings-nav {
  flex: 0 0 auto;
  width: 190px;
  padding: 2px 10px 16px;
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
}

.settings-nav__group + .settings-nav__group {
  margin-top: 6px;
}

.settings-nav__group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  letter-spacing: 0.4px;
  text-align: left;
  cursor: pointer;
}

.settings-nav__group-head:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.settings-nav__group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 折叠指示器：收起时指向右，展开时指向下 */
.settings-nav__arrow {
  flex: 0 0 auto;
  font-size: var(--app-font-size-sm);
  transform: rotate(-90deg);
  transition: transform 0.18s ease;
}

.settings-nav__arrow.is-expanded {
  transform: rotate(0deg);
}

.settings-nav__items {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.settings-nav__item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(30px * var(--app-control-scale));
  margin-bottom: 2px;
  padding: 0 8px 0 22px;
  border-radius: 6px;
  color: var(--text-color);
  font-size: var(--app-font-size);
  cursor: pointer;
  user-select: none;
}

.settings-nav__item:hover {
  background: var(--hover-bg);
}

.settings-nav__item.is-active {
  background: var(--active-bg);
  color: var(--brand-color);
}

.settings-nav__icon {
  flex: 0 0 auto;
  font-size: var(--app-font-size-lg);
  color: var(--text-muted);
}

.settings-nav__item.is-active .settings-nav__icon {
  color: var(--brand-color);
}

.settings-nav__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------------------------ 右侧内容 */

.settings-view__content {
  flex: 1;
  min-width: 0;
  padding: 10px 24px 24px;
  overflow-y: auto;
}

/*
 * 设置项标签：按内容自适应宽度，且永不换行。
 *
 * Field 的默认标签列是固定 7rem，像「编辑器字体 · 英文」这种中文标签
 * 在 7rem 里放不下就会折成两行，看起来像被挤扁；这里放宽下限并禁止换行，
 * 长标签由内容决定宽度，控件（flex-1）拿走剩下的空间。
 */
.settings-view__content :deep(.field__label) {
  width: auto;
  min-width: 7rem;
  white-space: nowrap;
}

/* ---------------- 插件源 ---------------- */

.plugin-sources {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.plugin-sources__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-sources__item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.plugin-sources__pick {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.plugin-sources__pick:hover {
  background: var(--hover-bg);
}

.plugin-sources__pick.is-active {
  background: var(--active-bg);
  color: var(--brand-color);
}

.plugin-sources__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--app-font-size-sm);
}

.plugin-sources__url {
  max-width: 34rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-sources__empty {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-sources__add {
  display: flex;
  align-items: center;
  gap: 6px;
}

.plugin-sources__url-input {
  flex: 1;
  min-width: 0;
}

.plugin-sources__name-input {
  width: 12rem;
}

.plugin-sources__preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--surface-color);
}

.plugin-sources__preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.plugin-sources__preview-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.plugin-sources__preview-count {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.plugin-sources__error {
  margin: 0;
  color: var(--danger-color);
  font-size: var(--app-font-size-xs);
}

.plugin-sources__plugins {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-sources__plugin {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--app-font-size-xs);
}

.plugin-sources__plugin-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.plugin-sources__plugin-name {
  flex: 0 0 auto;
}

.plugin-sources__plugin-version {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.plugin-sources__plugin-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}
</style>

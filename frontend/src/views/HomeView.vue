<script setup lang="ts">
/** 工作台首页：欢迎条 + 卡片式概览 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Icon from '@/components/ui/Icon.vue'
import Tag from '@/components/ui/Tag.vue'
import { EventsOn } from '@/api/runtime'
import { fetchAppInfo } from '@/api/system'
import { fetchConnections } from '@/api/db'
import { fetchTemplateList } from '@/api/templates'
import { useDictStore } from '@/stores/dictStore'
import { usePluginStore } from '@/stores/pluginStore'
import { useTabStore } from '@/stores/tabStore'
import { connectionEnvBadge } from '@/utils/connectionDisplay'
import { TOOLS, toolOf } from '@/utils/tools'
import type { AppInfo } from '@/api/system'
import type { DBConnection, TemplateListItem, ToolType } from '@/types'

const emit = defineEmits<{ (e: 'ready'): void }>()

const tabStore = useTabStore()
const dictStore = useDictStore()
const pluginStore = usePluginStore()

// ---------------------------------------------------------------- 欢迎条

/** 按当前时段问候 */
const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 5) {
    return '夜深了'
  }
  if (hour < 11) {
    return '早上好'
  }
  if (hour < 13) {
    return '中午好'
  }
  if (hour < 18) {
    return '下午好'
  }
  return '晚上好'
})

/** 当前日期（中文长格式） */
const today = computed(() =>
  new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }),
)

// ---------------------------------------------------------------- 数据

const connections = ref<DBConnection[]>([])
const templates = ref<TemplateListItem[]>([])
const appInfo = ref<Partial<AppInfo>>({})
/** 是否还在首次读取 */
const loading = ref(true)

/** 加载连接列表（失败保留空数组） */
async function loadConnections() {
  try {
    connections.value = await fetchConnections()
  }
  catch {
    connections.value = []
  }
}

/** 加载模板列表（失败保留空数组） */
async function loadTemplates() {
  try {
    templates.value = await fetchTemplateList()
  }
  catch {
    templates.value = []
  }
}

/** 加载词典与词条 */
async function loadDictionaries() {
  await dictStore.loadAll()
}

/** 刷新全部卡片数据 */
async function refresh() {
  await Promise.allSettled([
    loadConnections(),
    loadTemplates(),
    loadDictionaries(),
    fetchAppInfo().then((info) => { appInfo.value = info }),
  ])
  loading.value = false
}

// ---------------------------------------------------------------- 快捷操作

interface QuickAction {
  type: ToolType
  label: string
  icon: string
  description: string
}

/**
 * 快捷入口从工具注册表动态生成。
 *
 * 宿主不再内置任何业务工具，所以这里不能写死清单：
 * 装了 SQL 插件就出现 SQL 入口，卸载后入口自动消失。
 */
const quickActions = computed<QuickAction[]>(() =>
  TOOLS
    .filter(tool => tool.type !== 'home')
    .map(tool => ({
      type: tool.type,
      label: tool.label,
      icon: tool.icon,
      description: tool.description,
    })),
)

function openTool(type: ToolType) {
  tabStore.openTool(type, { newInstance: toolOf(type)?.multi ?? false })
}

// ---------------------------------------------------------------- 插件概览

/** 插件统计 */
const pluginStats = computed(() => ({
  total: pluginStore.installed.length,
  active: pluginStore.activePlugins.length,
  updatable: pluginStore.updatableCount,
}))

/** 插件预览行：已启用的排在前面 */
const pluginPreview = computed(() => {
  const list = [...pluginStore.installed]
  list.sort((a, b) => Number(b.enabled) - Number(a.enabled))
  return list.slice(0, 4)
})

// ---------------------------------------------------------------- 打开的标签

/** 已打开的标签 */
const openTabs = computed(() => tabStore.tabs)

function activateTab(id: number) {
  tabStore.setActive(id)
}

// ---------------------------------------------------------------- 数据源概览

/** 环境分布统计 */
const envCounts = computed(() => {
  let local = 0
  let test = 0
  let production = 0
  for (const conn of connections.value) {
    if (conn.isProduction) {
      production += 1
    }
    else if (conn.isTest) {
      test += 1
    }
    else if (conn.isLocal) {
      local += 1
    }
  }
  return { local, test, production }
})

/** 卡片里最多列几条 */
const PREVIEW_LIMIT = 5

/** 连接预览行（带环境标签） */
const connectionPreview = computed(() =>
  connections.value.slice(0, PREVIEW_LIMIT).map(conn => ({
    conn,
    badge: connectionEnvBadge(conn),
  })))

// ---------------------------------------------------------------- SQL 模板概览

const templateStats = computed(() => ({
  total: templates.value.length,
  disabled: templates.value.filter(item => !item.enabled).length,
}))

/** 最近创建的 3 个模板 */
const recentTemplates = computed(() => [...templates.value].slice(-3).reverse())

// ---------------------------------------------------------------- 词典概览

const dictStats = computed(() => ({
  total: dictStore.dictionaries.length,
  items: Object.values(dictStore.items).reduce((sum, list) => sum + list.length, 0),
}))

const dictionaryPreview = computed(() => dictStore.dictionaries.slice(0, 3))

/** 某个词典的词条数 */
function itemCountOf(dictionaryId: number): number {
  return dictStore.items[dictionaryId]?.length ?? 0
}

// ---------------------------------------------------------------- 生命周期

/** 其它页面改了连接 / 模板后刷新对应卡片 */
const offConnectionsChanged = EventsOn('connections:changed', () => void loadConnections())
const offTemplatesChanged = EventsOn('templates:changed', () => void loadTemplates())

/** 切回首页时重新拉一次 */
watch(() => tabStore.activeSingleton, (current) => {
  if (current === 'home' && !loading.value) {
    void refresh()
  }
})

onMounted(async () => {
  try {
    await refresh()
  }
  finally {
    // 失败也要上报
    emit('ready')
  }
})

onBeforeUnmount(() => {
  offConnectionsChanged()
  offTemplatesChanged()
})
</script>

<template>
  <div class="home">
    <header class="home__welcome">
      <div class="home__welcome-main">
        <h1 class="home__hello">{{ greeting }}，欢迎使用 Toolbox</h1>
        <p class="home__sub">{{ today }}</p>
      </div>
      <Tag v-if="appInfo.version" tone="brand" effect="plain">v{{ appInfo.version }}</Tag>
    </header>

    <div class="home__grid">
      <Card title="快捷操作" icon="wand">
        <div v-if="quickActions.length" class="quick">
          <button
            v-for="action in quickActions"
            :key="action.type"
            type="button"
            class="quick__item"
            @click="openTool(action.type)"
          >
            <span class="quick__icon"><Icon :name="action.icon" /></span>
            <span class="quick__label">{{ action.label }}</span>
            <span class="quick__desc">{{ action.description }}</span>
          </button>
        </div>
        <p v-else class="home__empty">
          还没有可用的工具。到「插件管理」安装插件后，入口会自动出现在这里。
        </p>
      </Card>

      <Card title="插件概览" icon="puzzle">
        <template #action>
          <Button variant="ghost" size="sm" class="text-brand" @click="openTool('plugins')">
            管理插件
          </Button>
        </template>

        <div class="chips">
          <span class="chip chip--plain">
            共 <b>{{ pluginStats.total }}</b> 个插件
          </span>
          <span class="chip chip--success">运行中 {{ pluginStats.active }}</span>
          <span v-if="pluginStats.updatable" class="chip chip--warning">
            可更新 {{ pluginStats.updatable }}
          </span>
        </div>

        <ul v-if="pluginPreview.length" class="rows">
          <li v-for="plugin in pluginPreview" :key="plugin.id" class="rows__item">
            <Icon class="rows__icon" :name="plugin.icon || 'puzzle'" />
            <span class="rows__name">{{ plugin.name }}</span>
            <Tag v-if="plugin.enabled" size="sm" tone="success" effect="plain">运行中</Tag>
            <Tag v-else size="sm" effect="plain">已停用</Tag>
            <span class="rows__meta">v{{ plugin.version }}</span>
          </li>
        </ul>
        <p v-else class="home__empty">
          还没有安装插件。到「插件管理」浏览插件市场，或直接拖入离线插件包。
        </p>
      </Card>

      <Card title="打开的标签" icon="inbox">
        <template #action>
          <span class="home__count">{{ openTabs.length }}</span>
        </template>

        <ul v-if="openTabs.length" class="rows">
          <li
            v-for="tab in openTabs"
            :key="tab.uid"
            class="rows__item rows__item--clickable"
            :class="{ 'is-active': tab.id === tabStore.activeId }"
            @click="activateTab(tab.id)"
          >
            <Icon class="rows__icon" :name="toolOf(tab.toolType)?.icon ?? 'question'" />
            <span class="rows__name">{{ tab.name }}</span>
            <Tag v-if="tab.isLocked" size="sm" effect="plain">锁定</Tag>
          </li>
        </ul>
        <p v-else class="home__empty">
          {{ loading ? '正在读取…' : '还没有打开的标签' }}
        </p>
      </Card>

      <!-- 以下三张卡片展示的是宿主数据的现状，没有数据时整张隐藏，避免空卡片噪音 -->
      <Card v-if="connections.length" title="数据源概览" icon="link">
        <template #action>
          <Button variant="ghost" size="sm" class="text-brand" @click="openTool('connections')">
            查看全部
          </Button>
        </template>

        <div class="chips">
          <span class="chip chip--plain">
            共 <b>{{ connections.length }}</b> 个连接
          </span>
          <span class="chip chip--success">本地 {{ envCounts.local }}</span>
          <span class="chip chip--warning">测试 {{ envCounts.test }}</span>
          <span class="chip chip--danger">生产 {{ envCounts.production }}</span>
        </div>

        <ul v-if="connectionPreview.length" class="rows">
          <li v-for="row in connectionPreview" :key="row.conn.id" class="rows__item">
            <span
              class="rows__dot"
              :style="row.conn.color ? { background: row.conn.color } : undefined"
            />
            <span class="rows__name">{{ row.conn.name }}</span>
            <Tag v-if="row.conn.readOnly" size="sm" effect="plain">只读</Tag>
            <Tag v-if="row.badge" size="sm" effect="plain" :tone="row.badge.type">
              {{ row.badge.text }}
            </Tag>
            <span class="rows__meta">{{ row.conn.dbType }}</span>
          </li>
        </ul>
        <p v-else class="home__empty">
          {{ loading ? '正在读取…' : '还没有配置数据库连接' }}
        </p>
      </Card>

      <Card v-if="templates.length" title="SQL 模板概览" icon="document">
        <template #action>
          <Button variant="ghost" size="sm" class="text-brand" @click="openTool('sql-template')">
            查看全部
          </Button>
        </template>

        <div class="chips">
          <span class="chip chip--plain">
            共 <b>{{ templateStats.total }}</b> 个模板
          </span>
          <span v-if="templateStats.disabled" class="chip chip--warning">
            已停用 {{ templateStats.disabled }}
          </span>
        </div>

        <ul v-if="recentTemplates.length" class="rows">
          <li v-for="tpl in recentTemplates" :key="tpl.id" class="rows__item rows__item--stack">
            <div class="rows__line">
              <span class="rows__name">{{ tpl.name }}</span>
              <Tag v-if="!tpl.enabled" size="sm" tone="warning" effect="plain">已停用</Tag>
            </div>
            <code class="rows__code">{{ tpl.sqlText }}</code>
          </li>
        </ul>
        <p v-else class="home__empty">
          {{ loading ? '正在读取…' : '还没有创建 SQL 模板' }}
        </p>
      </Card>

      <Card v-if="dictStore.dictionaries.length" title="词典概览" icon="book">
        <template #action>
          <Button variant="ghost" size="sm" class="text-brand" @click="openTool('dictionary')">
            查看全部
          </Button>
        </template>

        <div class="chips">
          <span class="chip chip--plain">
            共 <b>{{ dictStats.total }}</b> 个词典
          </span>
          <span class="chip chip--plain">
            共 <b>{{ dictStats.items }}</b> 条词条
          </span>
        </div>

        <ul v-if="dictionaryPreview.length" class="rows">
          <li v-for="dict in dictionaryPreview" :key="dict.id" class="rows__item">
            <span class="rows__name">{{ dict.name }}</span>
            <span class="rows__meta">{{ itemCountOf(dict.id) }} 条词条</span>
          </li>
        </ul>
        <p v-else class="home__empty">
          {{ loading ? '正在读取…' : '还没有词典' }}
        </p>
      </Card>
    </div>
  </div>
</template>

<style scoped>
.home {
  height: 100%;
  padding: var(--space-5);
  overflow: auto;
}

/* ------------------------------------------------------------ 欢迎条 */

.home__welcome {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: 1400px;
  margin: 0 auto var(--space-4);
}

.home__welcome-main {
  min-width: 0;
}

.home__hello {
  margin: 0;
  color: var(--text-color);
  font-size: var(--app-font-size-xl);
  font-weight: 600;
}

.home__sub {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
}

/* ------------------------------------------------------------ 卡片网格 */

/* ------------------------------------------------------------ 卡片网格 */

.home__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  align-items: start;
  gap: var(--space-4);
  max-width: 1400px;
  margin: 0 auto;
}

.home__count {
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  font-variant-numeric: tabular-nums;
}

.home__empty {
  margin: 0;
  padding: var(--space-2) 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.6;
}

/* ------------------------------------------------------------ 快捷操作 */

.quick {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.quick__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-color);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.quick__item:hover {
  border-color: color-mix(in srgb, var(--brand-color) 45%, transparent);
  background: var(--hover-bg);
}

/* 图标块：跨行占据左侧两行高度 */
.quick__icon {
  display: inline-flex;
  grid-row: span 2;
  align-items: center;
  justify-content: center;
  width: calc(30px * var(--app-control-scale));
  height: calc(30px * var(--app-control-scale));
  border-radius: 8px;
  background: var(--active-bg);
  color: var(--brand-color);
  font-size: calc(16px * var(--app-control-scale));
}

.quick__label {
  font-size: var(--app-font-size);
  font-weight: 600;
}

.quick__desc {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------------------------------------ 统计胶囊 */

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.chip {
  padding: 2px var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
  line-height: 1.7;
}

.chip b {
  color: var(--text-color);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 环境胶囊：颜色只是提示 */
.chip--success {
  border-color: color-mix(in srgb, var(--success-color) 45%, transparent);
  color: var(--success-color);
}

.chip--warning {
  border-color: color-mix(in srgb, var(--warning-color) 45%, transparent);
  color: var(--warning-color);
}

.chip--danger {
  border-color: color-mix(in srgb, var(--danger-color) 45%, transparent);
  color: var(--danger-color);
}

/* ------------------------------------------------------------ 列表行 */

.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rows__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2) var(--space-2);
  border-radius: 8px;
}

.rows__item--clickable {
  cursor: pointer;
}

.rows__item--clickable:hover {
  background: var(--hover-bg);
}

.rows__item.is-active {
  background: var(--active-bg);
}

.rows__item--stack {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
}

.rows__line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.rows__icon {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
}

/* 连接色点：没设颜色时退化成灰点 */
.rows__dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--border-color);
}

.rows__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--app-font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rows__meta {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
}

.rows__code {
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

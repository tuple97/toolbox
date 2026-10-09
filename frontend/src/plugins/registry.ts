/**
 * 插件贡献点注册表。
 *
 * 插件通过三处向宿主声明自己的位置：
 *   1. contributes.tools        → 工具入口（侧栏 / 标签 / 新建菜单）
 *   2. contributes.sidebar      → 侧栏分组（图标与排序）
 *   3. contributes.settings     → 设置面板与声明式配置项
 */

import { markRaw, ref } from 'vue'
import type { Component } from 'vue'
import type { InstalledPlugin, PluginSettingContribution, PluginSidebarGroup } from '@/types'

/** 插件工具未声明分组时归入的分组名 */
export const DEFAULT_PLUGIN_GROUP = '插件'

/** 已注册的插件工具 */
export interface RegisteredPluginTool {
  type: string
  label: string
  icon: string
  multi: boolean
  description: string
  /** 侧栏分组 id 或分组名 */
  group: string
  /** 组内排序 */
  order: number
  /** 是否出现在「新建标签」菜单 */
  picker: boolean
  pluginId: string
  pluginVersion: string
  component: Component
}

/** 插件声明的侧栏分组 */
export interface RegisteredGroup {
  id: string
  label: string
  icon: string
  order: number
  pluginId: string
}

/** 设置面板 */
export interface RegisteredSettingsPanel {
  /** 全局唯一 id：<插件id>.<面板id> */
  id: string
  title: string
  icon: string
  order: number
  pluginId: string
  /** 声明式配置项，宿主按 type 自动渲染 */
  settings: PluginSettingContribution[]
  /** 插件注册的自定义渲染组件 */
  component?: Component
}

const tools = ref<RegisteredPluginTool[]>([])
const groups = ref<RegisteredGroup[]>([])
const panels = ref<RegisteredSettingsPanel[]>([])

/** 已注册的插件工具 */
export function pluginTools(): RegisteredPluginTool[] {
  return tools.value
}

/** 按类型查找插件工具 */
export function pluginToolOf(type: string): RegisteredPluginTool | undefined {
  return tools.value.find(item => item.type === type)
}

/** 插件声明的侧栏分组 */
export function pluginGroups(): RegisteredGroup[] {
  return groups.value
}

/** 插件贡献的设置面板 */
export function pluginSettingsPanels(): RegisteredSettingsPanel[] {
  return panels.value
}

/** 注册（或覆盖）一个插件工具 */
export function registerPluginTool(input: Omit<RegisteredPluginTool, 'component'> & { component: Component }): void {
  if (!input.type || !input.component) {
    return
  }
  const normalized: RegisteredPluginTool = {
    ...input,
    icon: input.icon || 'question',
    label: input.label || input.type,
    component: markRaw(input.component),
  }

  const index = tools.value.findIndex(item => item.type === normalized.type)
  if (index >= 0) {
    const next = [...tools.value]
    next[index] = normalized
    tools.value = next
    return
  }
  tools.value = [...tools.value, normalized]
}

/** 登记插件声明的侧栏分组 */
export function registerPluginGroups(pluginId: string, list: PluginSidebarGroup[]): void {
  if (!list.length) {
    return
  }
  const next = groups.value.filter(item => item.pluginId !== pluginId)
  for (const group of list) {
    if (!group.id) {
      continue
    }
    next.push({
      id: group.id,
      label: group.label || group.id,
      icon: group.icon || '',
      order: group.order ?? 100,
      pluginId,
    })
  }
  groups.value = next
}

/**
 * 登记插件的设置面板。
 *
 * 声明式配置项按 setting.panel 归并到面板；未声明 panel 的配置项
 * 归入以插件名命名的默认面板。这样「只写配置、不写界面」的插件
 * 也能在设置页拥有自己的位置。
 */
export function registerPluginSettings(plugin: InstalledPlugin): void {
  const built = new Map<string, RegisteredSettingsPanel>()

  const ensurePanel = (panelId: string, title: string, icon: string, order: number) => {
    const key = `${plugin.id}.${panelId}`
    let panel = built.get(key)
    if (!panel) {
      panel = {
        id: key,
        title,
        icon,
        order,
        pluginId: plugin.id,
        settings: [],
      }
      built.set(key, panel)
    }
    return panel
  }

  // 先创建显式声明的面板（可能只提供自定义组件，没有配置项）
  for (const declared of plugin.settingsPanels) {
    ensurePanel(declared.id, declared.title || declared.id, declared.icon || '', declared.order ?? 100)
  }

  // 再把配置项归入各自面板
  for (const setting of plugin.settings) {
    const panelId = setting.panel || 'default'
    const panel = ensurePanel(panelId, plugin.name, plugin.icon, 100)
    panel.settings.push(setting)
  }

  for (const panel of built.values()) {
    panel.settings.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  panels.value = [
    ...panels.value.filter(item => item.pluginId !== plugin.id),
    ...built.values(),
  ]
}

/**
 * 插件为自己的设置面板提供自定义渲染组件。
 *
 * 清单里声明过 settingsPanels 时面板已存在，这里只补组件；
 * 未声明时按注册时的标题新建，避免「注册了却没有位置」。
 */
export function attachSettingsComponent(
  pluginId: string,
  panelId: string,
  title: string,
  component: Component,
): void {
  const key = panelId.includes('.') ? panelId : `${pluginId}.${panelId}`
  const index = panels.value.findIndex(item => item.id === key)

  if (index >= 0) {
    const next = [...panels.value]
    next[index] = { ...next[index], component: markRaw(component) }
    panels.value = next
    return
  }

  panels.value = [...panels.value, {
    id: key,
    title: title || panelId,
    icon: '',
    order: 100,
    pluginId,
    settings: [],
    component: markRaw(component),
  }]
}

/** 注销某个插件的全部贡献 */
export function unregisterPluginContributions(pluginId: string): void {
  tools.value = tools.value.filter(item => item.pluginId !== pluginId)
  groups.value = groups.value.filter(item => item.pluginId !== pluginId)
  panels.value = panels.value.filter(item => item.pluginId !== pluginId)
}

/** 清空全部插件贡献（重载宿主时使用） */
export function clearPluginContributions(): void {
  tools.value = []
  groups.value = []
  panels.value = []
}

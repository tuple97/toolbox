/** 工具注册表：内置工具与插件工具的响应式合并结果 */

import { reactive, watchEffect } from 'vue'
import type { ToolType } from '@/types'
import { DEFAULT_PLUGIN_GROUP, pluginGroups, pluginTools } from '@/plugins/registry'

export interface ToolDefinition {
  type: ToolType
  /** 菜单与标签展示名 */
  label: string
  /** 图标名 */
  icon: string
  /** 是否多例：多例可同时打开多个标签 */
  multi: boolean
  /** 单行说明（菜单悬浮提示） */
  description: string
  /** 组内排序，小的在前 */
  order?: number
  /** 是否出现在「新建标签」菜单 */
  picker?: boolean
  /** 归属插件标识；内置工具为空 */
  pluginId?: string
  /** 归属插件版本 */
  pluginVersion?: string
}

/** 内置工具清单（插件市场、设置） */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'plugins',
    label: '插件市场',
    icon: 'puzzle',
    multi: false,
    description: '浏览、安装与升级插件（单例视图）',
  },
  {
    type: 'settings',
    label: '设置',
    icon: 'settings',
    multi: false,
    description: '应用外观与行为设置（单例视图）',
  },
]

/** 侧栏固定位置：市场在最上，设置在编辑按钮左侧 */
export const SIDEBAR_FIXED_TOP: ToolType = 'plugins'
export const SIDEBAR_FIXED_SETTINGS: ToolType = 'settings'

/** 工具分组（仅作插件清单的语义标签，不参与侧栏渲染） */
export interface ToolGroup {
  label: string
  /** 分组图标名 */
  icon?: string
  /** 分组排序，小的在前 */
  order?: number
  tools: ToolType[]
}

/** 内置分组清单（恒为空，保留以兼容旧引用） */
export const BUILTIN_GROUPS: readonly ToolGroup[] = []

/** 顶级（固定位置）工具 */
export const TOP_LEVEL_TOOLS: ToolType[] = ['plugins', 'settings']

/** 合并后的工具表（内置 + 插件），保持数组身份以兼容现有调用 */
export const TOOLS = reactive<ToolDefinition[]>([])

/** 侧栏展示的插件工具（不含固定入口），顺序即渲染顺序 */
export const SIDEBAR_PLUGIN_TOOLS = reactive<ToolType[]>([])

/** 整体替换数组内容，保持数组引用不变 */
function syncArray<T>(target: T[], next: T[]): void {
  target.splice(0, target.length, ...next)
}

/** 把插件贡献的工具转成统一的工具定义 */
function toDefinition(tool: ReturnType<typeof pluginTools>[number]): ToolDefinition {
  return {
    type: tool.type,
    label: tool.label,
    icon: tool.icon,
    multi: tool.multi,
    description: tool.description,
    order: tool.order,
    picker: tool.picker,
    pluginId: tool.pluginId,
    pluginVersion: tool.pluginVersion,
  }
}

/** 按工具与所属分组的 order 重建插件工具的扁平顺序（同键保持注册顺序） */
function buildPluginOrder(): ToolType[] {
  // 分组 id/名 → 分组 order
  const groupOrder = new Map<string, number>()
  for (const group of pluginGroups()) {
    groupOrder.set(group.id, group.order ?? 100)
    if (group.label) {
      groupOrder.set(group.label, group.order ?? 100)
    }
  }

  return pluginTools()
    .slice()
    .sort((a, b) => {
      const toolDiff = (a.order ?? 100) - (b.order ?? 100)
      if (toolDiff !== 0) {
        return toolDiff
      }
      const aGroup = groupOrder.get(a.group || DEFAULT_PLUGIN_GROUP) ?? 100
      const bGroup = groupOrder.get(b.group || DEFAULT_PLUGIN_GROUP) ?? 100
      return aGroup - bGroup
    })
    .map(tool => tool.type)
}

// 插件注册/注销工具时自动同步合并结果
watchEffect(() => {
  const pluginDefs = pluginTools().map(toDefinition)
  const overridden = new Set(pluginDefs.map(tool => tool.type))

  // 插件优先：同类型工具由插件接管，内置条目摘掉，保证侧栏只出现一次
  const builtins = BUILTIN_TOOLS.filter(tool => !overridden.has(tool.type))
  syncArray(TOOLS, [...builtins, ...pluginDefs])
  syncArray(SIDEBAR_PLUGIN_TOOLS, buildPluginOrder())
})

/** 按类型取工具定义 */
export function toolOf(type: string): ToolDefinition | undefined {
  return TOOLS.find(tool => tool.type === type)
}

/** 多例工具，供「新建标签」下拉使用 */
export function multiTools(): ToolDefinition[] {
  return TOOLS.filter(tool => tool.multi)
}

/** 工具默认名称 */
export function toolLabelOf(type: string): string {
  return toolOf(type)?.label ?? type
}

/** 判断是否为插件贡献的工具 */
export function isPluginTool(type: string): boolean {
  return Boolean(toolOf(type)?.pluginId)
}

/**
 * 工具注册表（左侧菜单、新建下拉、标签内容区的渲染都以本表为准）。
 *
 * 插件化改造要点：
 *   - 内置工具是静态清单（BUILTIN_TOOLS / BUILTIN_GROUPS）；
 *   - 插件工具来自 plugins/registry 的贡献点注册表；
 *   - 对外导出的 TOOLS / TOOL_GROUPS 是「内置 + 插件」的响应式合并结果，
 *     因此插件在运行期注册工具后，菜单与标签会立即出现对应入口，
 *     无需重启或刷新界面。
 */

import { reactive, watchEffect } from 'vue'
import type { ToolType } from '@/types'
import {
  DEFAULT_PLUGIN_GROUP,
  pluginGroups,
  pluginTools,
  type RegisteredGroup,
  type RegisteredPluginTool,
} from '@/plugins/registry'

export interface ToolDefinition {
  type: ToolType
  /** 菜单与标签上展示的名称 */
  label: string
  /** 图标名（自绘图标库 utils/icons.ts） */
  icon: string
  /** 是否多例：多例工具可同时打开多个标签，单例工具全局只有一个 */
  multi: boolean
  /** 单行说明，用于菜单悬浮提示 */
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

/**
 * 内置工具清单（不可变）。
 *
 * 工具箱的定位是「插件运行平台」，因此内置工具只保留平台自身的两件事：
 * 插件管理、设置。业务功能（SQL 工作台、词典等）一律以插件形式提供，
 * 宿主通过 plugin-sdk 向插件开放共享内核（stores / api / sql 引擎 / 组件）。
 */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'plugins',
    label: '插件管理',
    icon: 'puzzle',
    multi: false,
    description: '安装、信任与升级插件（单例标签）',
  },
  {
    type: 'settings',
    label: '设置',
    icon: 'settings',
    multi: false,
    description: '应用外观与行为设置（单例标签）',
  },
]

/** 左侧菜单分组；未列入分组的工具作为顶级菜单项展示 */
export interface ToolGroup {
  label: string
  /** 分组图标名（插件可在 contributes.sidebar 中声明） */
  icon?: string
  /** 分组排序，小的在前 */
  order?: number
  tools: ToolType[]
}

/**
 * 内置分组清单（不可变）。
 *
 * 恒为空：内置工具都是顶级入口，侧栏分组完全由插件声明的
 * contributes.tools[].group 决定（例如「数据库」「本地记录」）。
 */
export const BUILTIN_GROUPS: readonly ToolGroup[] = []

/** 顶级（不分组）工具，顺序即渲染顺序 */
export const TOP_LEVEL_TOOLS: ToolType[] = ['plugins', 'settings']

/**
 * 合并后的工具表（内置 + 插件）。
 *
 * 用 reactive 数组而不是 computed，是为了保持「TOOLS 就是一个数组」的用法：
 * 现有代码与模板大量使用 TOOLS.filter / v-for，改成 ref 会波及所有调用点。
 */
export const TOOLS = reactive<ToolDefinition[]>([])

/** 合并后的分组表（内置分组 + 插件按 group 归并出的分组） */
export const TOOL_GROUPS = reactive<ToolGroup[]>([])

/** 用新内容整体替换数组内容，保持数组身份不变（避免下游拿到失效引用） */
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

/**
 * 依据内置分组 + 插件声明重建分组列表。
 *
 * 分组信息优先取插件在 contributes.sidebar 里声明的定义（标题/图标/排序），
 * 没声明的按工具自己的 group 字段建组，顺序排在已声明的之后。
 */
function buildGroups(overridden: Set<string>): ToolGroup[] {
  const groups: ToolGroup[] = BUILTIN_GROUPS
    .map(group => ({
      label: group.label,
      icon: group.icon,
      order: group.order,
      tools: group.tools.filter(type => !overridden.has(type)),
    }))
    .filter(group => group.tools.length > 0)

  // 插件声明的分组定义（同 id 以先声明者为准，保证顺序稳定）；
  // 同时按 id 与 label 建索引，使 tool.group 写分组名也能命中
  const declared = new Map<string, RegisteredGroup>()
  for (const group of pluginGroups()) {
    if (!declared.has(group.id)) {
      declared.set(group.id, group)
    }
    if (group.label && !declared.has(group.label)) {
      declared.set(group.label, group)
    }
  }

  // 插件工具按 group 归并
  const buckets = new Map<string, RegisteredPluginTool[]>()
  for (const tool of pluginTools()) {
    const key = tool.group || DEFAULT_PLUGIN_GROUP
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(tool)
    }
    else {
      buckets.set(key, [tool])
    }
  }

  for (const [key, list] of buckets) {
    const decl = declared.get(key)
    groups.push({
      label: decl?.label ?? key,
      icon: decl?.icon ?? '',
      order: decl?.order ?? 100,
      tools: [...list].sort((a, b) => a.order - b.order).map(tool => tool.type),
    })
  }

  groups.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  return groups
}

// 插件注册/注销工具时自动同步合并结果
watchEffect(() => {
  const pluginDefs = pluginTools().map(toDefinition)
  const overridden = new Set(pluginDefs.map(tool => tool.type))

  /*
   * 插件优先：同一工具类型由插件接管，内置条目摘掉。
   *
   * 这样「把内置工具迁移成官方插件」是渐进的：
   *   - 插件已安装 → 用插件版本（可独立于应用发版升级）；
   *   - 插件未安装/被停用 → 回退到内置实现，功能不缺失。
   * 同时保证同一功能在侧栏只出现一次。
   */
  const builtins = BUILTIN_TOOLS.filter(tool => !overridden.has(tool.type))
  syncArray(TOOLS, [...builtins, ...pluginDefs])
  syncArray(TOOL_GROUPS, buildGroups(overridden))
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

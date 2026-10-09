/** 侧边菜单的视图状态（持久化在 settings.sidebar_view） */

import { TOOL_GROUPS } from '@/utils/tools'

/** 侧边菜单视图状态 */
export interface SidebarViewState {
  /** 侧栏是否收起（收起后只剩图标栏） */
  collapsed: boolean
  /** 被收起的分组标签；未列出的分组保持展开 */
  collapsedGroups: string[]
}

/** 默认状态：展开侧栏、所有分组展开 */
export const DEFAULT_SIDEBAR_VIEW: SidebarViewState = {
  collapsed: false,
  collapsedGroups: [],
}

/** 解析持久化配置；损坏或缺失时回退默认值（未知分组剔除） */
export function parseSidebarView(raw: string | undefined): SidebarViewState {
  const state: SidebarViewState = { ...DEFAULT_SIDEBAR_VIEW, collapsedGroups: [] }
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<SidebarViewState>
    state.collapsed = parsed.collapsed === true
    const groups = Array.isArray(parsed.collapsedGroups) ? parsed.collapsedGroups : []
    state.collapsedGroups = groups
      .filter((label): label is string => typeof label === 'string')
      .filter(label => TOOL_GROUPS.some(group => group.label === label))
  }
  catch {
    // 配置损坏时保持默认
  }
  return state
}

/** 序列化，只写有效字段 */
export function serializeSidebarView(state: SidebarViewState): string {
  return JSON.stringify({
    collapsed: state.collapsed,
    collapsedGroups: state.collapsedGroups,
  })
}

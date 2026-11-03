/** 侧边菜单的视图状态（持久化在 settings.sidebar_view） */

/** 侧边菜单视图状态：仅记录整体是否收起 */
export interface SidebarViewState {
  /** 侧栏是否收起（收起后只剩图标栏） */
  collapsed: boolean
}

/** 默认状态：展开侧栏 */
export const DEFAULT_SIDEBAR_VIEW: SidebarViewState = {
  collapsed: false,
}

/** 解析持久化配置；损坏或缺失时回退默认值 */
export function parseSidebarView(raw: string | undefined): SidebarViewState {
  const state: SidebarViewState = { ...DEFAULT_SIDEBAR_VIEW }
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<SidebarViewState>
    state.collapsed = parsed.collapsed === true
  }
  catch {
    // 配置损坏时保持默认
  }
  return state
}

/** 序列化，只写有效字段 */
export function serializeSidebarView(state: SidebarViewState): string {
  return JSON.stringify({ collapsed: state.collapsed })
}

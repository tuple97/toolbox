/** 连接的展示辅助：环境标识与下拉选项文本 */
import type { DBConnection } from '@/types'

/** 环境标签的展示信息 */
export interface ConnectionEnvBadge {
  /** 标签文案 */
  text: string
  /** tag 类型 */
  type: 'success' | 'warning' | 'danger'
}

/** 取连接的环境标签；未标记时返回 null */
export function connectionEnvBadge(conn: DBConnection): ConnectionEnvBadge | null {
  if (conn.isProduction) {
    return { text: '生产', type: 'danger' }
  }
  if (conn.isTest) {
    return { text: '测试', type: 'warning' }
  }
  if (conn.isLocal) {
    return { text: '本地', type: 'success' }
  }
  return null
}

/** 下拉选项的 label（同时也是选中后输入框显示的文本） */
export function connectionOptionLabel(conn: DBConnection): string {
  const marks = [connectionEnvBadge(conn)?.text, conn.readOnly ? '只读' : ''].filter(Boolean)
  return `${conn.name}${marks.length ? ` · ${marks.join(' · ')}` : ''} (${conn.dbType})`
}

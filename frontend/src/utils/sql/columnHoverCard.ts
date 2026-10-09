/** 列悬停卡片：编辑器列名悬停与结果表头悬停共用的一份 DOM 拼装 */

/** 「来源表」图标 */
export const TABLE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6"/><path d="M2.2 6.6h11.6M6.6 6.6v6.2"/></svg>'

/** 「注释」图标 */
export const COMMENT_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3.4 3.4h9.2a1.6 1.6 0 0 1 1.6 1.6v4.6a1.6 1.6 0 0 1-1.6 1.6H7.2L4.4 13.6v-2.4H3.4a1.6 1.6 0 0 1-1.6-1.6V5a1.6 1.6 0 0 1 1.6-1.6Z"/></svg>'

/** 卡片展示的列信息 */
export interface ColumnHoverCardInfo {
  /** 列名 */
  name: string
  /** 字段类型（完整定义，如 varchar(32)） */
  dataType?: string
  /** 来源表；派生列带 derived 时会标注 */
  table?: string
  /** 字段注释 / 描述 */
  comment?: string
  /** 该列来自派生表 / CTE 的静态解析 */
  derived?: boolean
}

export function buildColumnHoverCard(
  info: ColumnHoverCardInfo,
  options: { surface?: boolean } = {},
): HTMLElement {
  const root = document.createElement('div')
  root.className = options.surface ? 'column-hover column-hover--surface' : 'column-hover'

  const head = document.createElement('div')
  head.className = 'column-hover__head'

  const name = document.createElement('span')
  name.className = 'column-hover__name'
  name.textContent = info.name
  head.appendChild(name)

  if (info.dataType) {
    const type = document.createElement('span')
    type.className = 'column-hover__type'
    type.textContent = info.dataType
    head.appendChild(type)
  }

  root.appendChild(head)

  const rows: HTMLElement[] = []
  if (info.table) {
    rows.push(hoverRow('column-hover__icon--table', TABLE_ICON, info.derived ? `${info.table}（派生列）` : info.table))
  }
  if (info.comment) {
    rows.push(hoverRow('column-hover__icon--comment', COMMENT_ICON, info.comment))
  }
  if (rows.length) {
    const meta = document.createElement('div')
    meta.className = 'column-hover__meta'
    meta.append(...rows)
    root.appendChild(meta)
  }

  return root
}

/** 一行「图标 + 内容」；tone 决定图标的标识色 */
function hoverRow(tone: string, icon: string, value: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'column-hover__row'

  const glyph = document.createElement('span')
  glyph.className = `column-hover__icon ${tone}`
  glyph.innerHTML = icon
  row.appendChild(glyph)

  const text = document.createElement('span')
  text.className = 'column-hover__value'
  text.textContent = value
  row.appendChild(text)

  return row
}

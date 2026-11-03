/** 表结构卡片：一份 DOM 拼装，三处使用 —— 1 */
import type { TableIndexInfo } from '../tableIndexes'

/** 「复制」图标（两张纸） */
const COPY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="5.6" y="2.4" width="8" height="9.2" rx="1.4"/><path d="M10.4 13.6H3.8a1.4 1.4 0 0 1-1.4-1.4V5.6"/></svg>'

export interface TableCardColumn {
  name: string
  dataType?: string
  comment?: string
}

/** 外键：本表的某列引用了谁的哪列 */
export interface TableCardForeignKey {
  column: string
  referencedTable: string
  referencedColumn: string
}

export interface TableCardModel {
  tableName: string
  /** 库 / schema（展示用；派生表可能没有） */
  schemaName?: string
  columns: TableCardColumn[]
  /** 派生表 / CTE：没有 DDL，复制按钮不出现 */
  virtual?: boolean
  /** 有值时给「复制 CREATE TABLE」按钮（复制动作见 onCopyDdl） */
  createTableSql?: string
  onCopyDdl?: () => Promise<void>
  /** 主键列（异步补齐） */
  primaryKeys?: string[]
  /** 外键（异步补齐） */
  foreignKeys?: TableCardForeignKey[]
  /** 索引（异步补齐） */
  indexes?: TableIndexInfo[]
}

/** 拼装卡片 DOM（纯函数式：同一 model 永远得到同一结构） */
export function buildTableCard(model: TableCardModel): HTMLElement {
  const root = document.createElement('div')
  root.className = 'table-hover'

  const head = document.createElement('div')
  head.className = 'table-hover__head'

  const name = document.createElement('span')
  name.className = 'table-hover__name'
  name.textContent = model.schemaName ? `${model.schemaName}.${model.tableName}` : model.tableName
  head.appendChild(name)

  if (model.virtual) {
    // 派生表 / CTE 没有建表语句：不给复制按钮（宁可不提供，也不给半截 DDL）
    const hint = document.createElement('span')
    hint.className = 'table-hover__hint'
    hint.textContent = '派生列 · 无建表语句'
    head.appendChild(hint)
  }
  else if (model.createTableSql && model.onCopyDdl) {
    const copy = document.createElement('button')
    copy.className = 'table-hover__copy'
    copy.type = 'button'
    copy.title = '复制 CREATE TABLE'
    copy.innerHTML = COPY_ICON
    copy.addEventListener('mousedown', event => event.preventDefault())
    copy.addEventListener('click', () => {
      void (async () => {
        try {
          await model.onCopyDdl?.()
          copy.textContent = '✓ 已复制'
        }
        catch {
          copy.textContent = '复制失败'
        }
        setTimeout(() => {
          copy.innerHTML = COPY_ICON
        }, 1200)
      })()
    })
    head.appendChild(copy)
  }
  root.appendChild(head)

  const list = document.createElement('div')
  list.className = 'table-hover__list'
  for (const column of model.columns) {
    list.appendChild(buildColumnRow(model, column))
  }
  root.appendChild(list)

  if (model.indexes?.length) {
    root.appendChild(buildIndexesSection(model.indexes))
  }
  return root
}

/** 用新 model 重画既有宿主（异步补齐主外键 / 索引后调用） */
export function renderTableCardInto(host: HTMLElement, model: TableCardModel): void {
  host.replaceChildren(buildTableCard(model))
}

/** 列清单的一行：容器是跨行网格，行本身 `display: contents`，所以必须凑满三格 */
function buildColumnRow(model: TableCardModel, column: TableCardColumn): HTMLElement {
  const row = document.createElement('div')
  row.className = 'table-hover__row'

  const columnName = document.createElement('span')
  columnName.className = 'table-hover__column'
  columnName.dataset.columnName = column.name
  for (const badge of columnBadges(model, column.name)) {
    columnName.appendChild(badge)
  }
  columnName.appendChild(document.createTextNode(column.name))
  row.appendChild(columnName)

  const type = document.createElement('span')
  type.className = 'table-hover__type'
  type.textContent = column.dataType ?? ''
  row.appendChild(type)

  const comment = document.createElement('span')
  comment.className = 'table-hover__comment'
  comment.textContent = column.comment ?? ''
  row.appendChild(comment)

  return row
}

/** 列名旁的小徽标：主键（金）与外键（品牌色，title 写明引用目标） */
function columnBadges(model: TableCardModel, columnName: string): HTMLElement[] {
  const badges: HTMLElement[] = []
  const lower = columnName.toLowerCase()

  if (model.primaryKeys?.some(key => key.toLowerCase() === lower)) {
    const badge = document.createElement('span')
    badge.className = 'table-hover__badge table-hover__badge--pk'
    badge.textContent = 'PK'
    badge.title = '主键'
    badges.push(badge)
  }

  const fk = model.foreignKeys?.find(item => item.column.toLowerCase() === lower)
  if (fk) {
    const badge = document.createElement('span')
    badge.className = 'table-hover__badge table-hover__badge--fk'
    badge.textContent = 'FK'
    badge.title = `引用 ${fk.referencedTable}.${fk.referencedColumn}`
    badges.push(badge)
  }

  return badges
}

/** 索引区块：卡片最下面一块，名称 + 唯一标记 + 列序 */
function buildIndexesSection(indexes: TableIndexInfo[]): HTMLElement {
  const section = document.createElement('div')
  section.className = 'table-hover__indexes'

  const title = document.createElement('div')
  title.className = 'table-hover__indexes-title'
  title.textContent = '索引'
  section.appendChild(title)

  const list = document.createElement('div')
  list.className = 'table-hover__indexes-list'
  for (const index of indexes) {
    const row = document.createElement('div')
    row.className = 'table-hover__index'

    const name = document.createElement('span')
    name.className = 'table-hover__index-name'
    name.textContent = index.name
    row.appendChild(name)

    if (index.unique) {
      const tag = document.createElement('span')
      tag.className = 'table-hover__index-unique'
      tag.textContent = '唯一'
      row.appendChild(tag)
    }

    const columns = document.createElement('span')
    columns.className = 'table-hover__index-columns'
    columns.textContent = index.columns.join(', ')
    row.appendChild(columns)

    list.appendChild(row)
  }
  section.appendChild(list)
  return section
}

// ---------------------------------------------------------------- 独立浮层

let activePopup: HTMLElement | null = null
let activeDismiss: (() => void) | null = null

/** 收起当前打开的表卡片浮层（若开着） */
export function closeTableCardPopup(): void {
  activeDismiss?.()
}

/** 在锚点旁弹出表结构卡片（独立浮层，挂在 body 上不受编辑器裁切） */
export function openTableCardPopup(args: {
  model: TableCardModel
  anchor: { x: number, y: number }
  loadExtras?: () => Promise<Partial<TableCardModel>>
}): void {
  activeDismiss?.()

  const host = document.createElement('div')
  host.className = 'table-card-popup'
  renderTableCardInto(host, args.model)
  document.body.appendChild(host)
  activePopup = host

  // 先渲染再量尺寸，贴着锚点右侧摆；放不下就翻到左边，上下同理
  const place = () => {
    const width = host.offsetWidth
    const height = host.offsetHeight
    const margin = 8
    const left = args.anchor.x + width + margin > window.innerWidth
      ? Math.max(margin, args.anchor.x - width - margin)
      : args.anchor.x + margin
    const top = args.anchor.y + height + margin > window.innerHeight
      ? Math.max(margin, args.anchor.y - height - margin)
      : args.anchor.y + margin
    host.style.left = `${Math.round(left)}px`
    host.style.top = `${Math.round(top)}px`
  }
  place()
  requestAnimationFrame(place)

  const dismiss = () => {
    if (activePopup !== host) {
      return
    }
    activePopup = null
    activeDismiss = null
    host.remove()
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', dismiss)
  }
  const onPointerDown = (event: PointerEvent) => {
    if (!host.contains(event.target as Node)) {
      dismiss()
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      dismiss()
    }
  }
  const onScroll = () => dismiss()
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', dismiss)
  activeDismiss = dismiss

  if (args.loadExtras) {
    void args.loadExtras().then((extras) => {
      // 浮层可能已被关掉：宿主不在文档里就不画
      if (host.isConnected) {
        renderTableCardInto(host, { ...args.model, ...extras })
        place()
      }
    })
  }
}

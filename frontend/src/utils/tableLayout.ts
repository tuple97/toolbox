/** 表格列布局与取值（components/ui/DataTable.vue 的纯逻辑部分） */

export interface TableColumn {
  /** 列键：取 `row[key]`，也用来组插槽名 */
  key: string
  label: string
  /** 固定宽度（px） */
  width?: number
  /** 弹性列的最小宽度：决定分剩余空间时的权重 */
  minWidth?: number
  align?: 'left' | 'center' | 'right'
  /** 内容超出时截断并给悬停提示 */
  ellipsis?: boolean
}

/** 弹性列的默认权重（没写 minWidth 时） */
export const DEFAULT_MIN_WIDTH = 120

/** 弹性列的权重总和；全为固定宽度时返回 0 */
export function flexWeightOf(columns: TableColumn[]): number {
  return columns.reduce((sum, column) => sum + (column.width ? 0 : column.minWidth ?? DEFAULT_MIN_WIDTH), 0)
}

/** 该列的内联宽度样式：固定列按像素，弹性列按权重占剩余空间的百分比 */
export function columnWidthStyle(
  column: TableColumn,
  columns: TableColumn[],
): Record<string, string> {
  if (column.width) {
    return { width: `${column.width}px` }
  }
  const total = flexWeightOf(columns)
  if (total <= 0) {
    return {}
  }
  const weight = column.minWidth ?? DEFAULT_MIN_WIDTH
  return { width: `${(weight / total) * 100}%` }
}

/** 表格的最小总宽度（px）：各列「固定宽度或最小宽度」之和，撑出横向滚动 */
export function tableMinWidthOf(columns: TableColumn[], indexWidth = 0): number {
  const total = columns.reduce(
    (sum, column) => sum + (column.width ?? column.minWidth ?? DEFAULT_MIN_WIDTH),
    0,
  )
  return total + indexWidth
}

/** 对齐 → Tailwind 文本对齐类 */
export function alignClassOf(column: TableColumn): string {
  if (column.align === 'center') {
    return 'text-center'
  }
  return column.align === 'right' ? 'text-right' : 'text-left'
}

/** 单元格文本：`null` / `undefined` 一律显示为空串 */
export function cellTextOf(row: Record<string, unknown>, column: TableColumn): string {
  const value = row[column.key]
  return value === null || value === undefined ? '' : String(value)
}

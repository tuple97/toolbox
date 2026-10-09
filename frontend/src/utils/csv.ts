/** CSV 生成（结果表格「Ctrl+C 复制为 CSV」用） */

/** 出现这些字符就必须加引号 */
const MUST_QUOTE = /[",\r\n]/

/** 单元格值 → CSV 字段文本；空值给空串 */
export function csvCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'object') {
    // 对象（如 JSON 列）给 JSON
    try {
      return JSON.stringify(value)
    }
    catch {
      return String(value)
    }
  }
  return String(value)
}

/** 单个字段的转义 */
export function escapeCsvField(text: string): string {
  return MUST_QUOTE.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 生成 CSV 文本（含表头，行尾用 \r\n） */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(header => escapeCsvField(csvCellText(header))).join(','),
    ...rows.map(row => row.map(cell => escapeCsvField(csvCellText(cell))).join(',')),
  ]
  return lines.join('\r\n')
}

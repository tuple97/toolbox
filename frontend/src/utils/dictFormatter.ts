import type { ColumnMeta, DictionaryItem, FieldMapping } from '@/types'

/** 单元格渲染结果 */
export interface CellRenderResult {
  /** 最终展示文本 */
  text: string
  /** 悬浮提示 */
  tooltip: string
  /** 是否命中词典 */
  matched: boolean
  /** 原始值 */
  raw: string
}

/** 单元格展示模板中支持的占位符 */
const VALUE_TOKEN = /\{\{\s*value\s*\}\}/g
const MEANING_TOKEN = /\{\{\s*meaning\s*\}\}/g
const DESC_TOKEN = /\{\{\s*description\s*\}\}/g

/** 把原始值转为展示文本（命中词典按模板渲染，空值给 '-'） */
export function formatCell(
  value: unknown,
  mapping: FieldMapping | undefined,
  lookupFn: (dictionaryId: number, value: unknown) => DictionaryItem | undefined,
): CellRenderResult {
  const raw = value === null || value === undefined ? '' : String(value)

  if (raw === '') {
    return { text: '-', tooltip: '', matched: false, raw }
  }

  const dictionaryId = mapping?.dictionaryId
  if (!dictionaryId) {
    return { text: raw, tooltip: '', matched: false, raw }
  }

  const item = lookupFn(dictionaryId, value)
  if (!item) {
    return { text: raw, tooltip: '未在词典中找到该值', matched: false, raw }
  }

  const context = {
    value: raw,
    meaning: item.meaning,
    description: item.description ?? '',
  }

  const template = mapping?.template?.trim()
  const text = template
    ? renderTemplate(template, context)
    : item.meaning

  return {
    text,
    tooltip: item.description || item.meaning,
    matched: true,
    raw,
  }
}

/** 渲染展示模板（支持 {{value}} / {{meaning}} / {{description}}） */
export function renderTemplate(
  template: string,
  context: { value: string, meaning: string, description: string },
): string {
  return template
    .replace(VALUE_TOKEN, context.value)
    .replace(MEANING_TOKEN, context.meaning)
    .replace(DESC_TOKEN, context.description)
}

/** 生成结果表格的列定义（映射列在前，未映射列按结果集顺序追加） */
export function buildColumns(
  columns: ColumnMeta[],
  mappings: FieldMapping[],
): Array<{
  column: string
  label: string
  width?: number
  align: 'left' | 'center' | 'right'
  type: string
  comment: string
  table: string
}> {
  const names = columns.map(c => c.name)
  const metaOf = new Map(columns.map(c => [c.name, c]))
  const mapped = new Map(mappings.map(m => [m.column, m]))

  const result: Array<{
    column: string
    label: string
    width?: number
    align: 'left' | 'center' | 'right'
    type: string
    comment: string
    table: string
  }> = []

  // 已配置映射的列
  for (const mapping of mappings) {
    if (!names.includes(mapping.column)) {
      continue
    }
    result.push({
      column: mapping.column,
      label: mapping.label || mapping.column,
      width: mapping.width,
      align: mapping.align ?? 'left',
      type: metaOf.get(mapping.column)?.type ?? '',
      comment: metaOf.get(mapping.column)?.comment ?? '',
      table: metaOf.get(mapping.column)?.table ?? '',
    })
  }

  // 未配置映射的列
  for (const name of names) {
    if (mapped.has(name)) {
      continue
    }
    result.push({
      column: name,
      label: name,
      align: 'left',
      type: metaOf.get(name)?.type ?? '',
      comment: metaOf.get(name)?.comment ?? '',
      table: metaOf.get(name)?.table ?? '',
    })
  }

  return result
}

/** 创建按列查询映射配置的辅助函数 */
export function createMappingLookup(
  mappings: FieldMapping[],
): (column: string) => FieldMapping | undefined {
  const map = new Map(mappings.map(m => [m.column, m]))
  return (column: string) => map.get(column)
}

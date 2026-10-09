/**
 * 结果行 → SQL 语句（结果表格右键「复制为…」→ INSERT / UPDATE / DELETE）
 *
 * 约定：UPDATE / DELETE 一律以主键为条件，主键查不到就不生成
 */

import { executeStatement } from '@/api/executor'
import { renderExportTemplate } from '@/api/templates'
import { copyText } from '@/utils/clipboard'
import { notify } from '@/utils/notify'
import { IDENT_SOURCE } from './sqlLexemes'
import type { ContextMenuAction, ExportTemplate } from '@/types'

/** SQL 方言 */
export type SqlDialect = 'mysql' | 'postgres'

/** 复制类型 */
export type RowSqlKind = 'insert' | 'update' | 'delete'

/** 结果来源上下文：识别表名与查主键只需要这些 */
export interface ResultSourceContext {
  /** 连接 ID，用于查主键 */
  connId: number | null
  /** 当前库（未显式选择时为空串） */
  database: string
  /** 连接类型（DBConnection.dbType） */
  dbType: string
  /** 产生该结果集的 SQL，用于解析表名 */
  sql: string
}

/** 生成语句所需的上下文 */
export interface RowSqlContext extends ResultSourceContext {
  /** 结果列名（按展示顺序） */
  columns: string[]
  /** 被右键的那一行 */
  row: Record<string, unknown>
}

/** 「复制为…」里自定义导出模板项的 key 前缀：`export:<模板 id>` */
const EXPORT_TEMPLATE_PREFIX = 'export:'

/** 结果表格右键菜单项：两级结构「复制为… → INSERT / UPDATE / DELETE / 导出模板」 */
export function rowSqlMenuItems(
  rowCount = 1,
  exportTemplates: ExportTemplate[] = [],
): ContextMenuAction[] {
  const batch = rowCount > 1
  const suffix = batch ? `（${rowCount} 行）` : ''
  const children: ContextMenuAction[] = [
    { key: 'copy-insert', label: `INSERT${suffix}` },
    { key: 'copy-update', label: `UPDATE（按主键）${suffix}` },
    { key: 'copy-delete', label: `DELETE（按主键）${suffix}` },
  ]

  // 自定义导出模板接在内置三项之后，停用的不进菜单
  for (const item of exportTemplates) {
    if (item.enabled === false) {
      continue
    }
    children.push({ key: `${EXPORT_TEMPLATE_PREFIX}${item.id}`, label: `${item.name}${suffix}` })
  }

  return [
    {
      key: 'copy-as',
      label: batch ? `批量复制为…（${rowCount} 行）` : '复制为…',
      children,
    },
  ]
}

/** 菜单项 key 对应的导出模板；不是导出模板项（或模板已不存在）时返回 null */
export function exportTemplateOfMenuItem(
  key: string,
  templates: ExportTemplate[],
): ExportTemplate | null {
  if (!key.startsWith(EXPORT_TEMPLATE_PREFIX)) {
    return null
  }
  const id = key.slice(EXPORT_TEMPLATE_PREFIX.length)
  return templates.find(item => item.id === id) ?? null
}

/** 按导出模板渲染并复制若干结果行（渲染在后端，整批一次） */
export async function copyRowsByExportTemplate(
  template: ExportTemplate,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (!rows.length) {
    return
  }
  try {
    const rendered = await renderExportTemplate(template.content, rows)
    const text = rendered.filter(item => item !== '').join('\n')
    if (!text.trim()) {
      notify.warning(`导出模板「${template.name}」渲染结果为空`)
      return
    }

    await copyText(text)
    notify.success(rows.length > 1
      ? `已按「${template.name}」复制 ${rows.length} 行`
      : `已按「${template.name}」复制`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 把菜单项的 key 映射成复制类型；非本菜单的项返回 null */
export function kindOfMenuItem(key: string): RowSqlKind | null {
  switch (key) {
    case 'copy-insert':
      return 'insert'
    case 'copy-update':
      return 'update'
    case 'copy-delete':
      return 'delete'
    default:
      return null
  }
}

/** 连接类型 → 方言 */
export function dialectOf(dbType: string): SqlDialect {
  const value = (dbType || '').toLowerCase()
  return value === 'postgres' || value === 'postgresql' ? 'postgres' : 'mysql'
}

/** 主键缓存：connId:schema:table → 主键列名 */
const primaryKeyCache = new Map<string, string[]>()

/** 表限定名 */
interface TableRef {
  /** 库/模式名，可能为空 */
  schema: string
  table: string
}

/** 从 SQL 中解析出表限定名（第一个 FROM / UPDATE / INSERT INTO / DELETE FROM 之后）；解析失败返回 null */
export function parseTableRef(sql: string): TableRef | null {
  const pattern = new RegExp(
    `(?:\\bfrom\\b|\\bupdate\\b|\\binsert\\s+into\\b|\\bdelete\\s+from\\b)`
    + `\\s+([\`"[]?${IDENT_SOURCE}[\`"\\]]?(?:\\s*\\.\\s*[\`"[]?${IDENT_SOURCE}[\`"\\]]?){0,1})`,
    'i',
  )
  const matched = pattern.exec(sql)
  if (!matched) {
    return null
  }
  const parts = matched[1]
    .split('.')
    .map(part => part.trim().replace(/^[`"[]/, '').replace(/[`"\]]$/, ''))
    .filter(Boolean)

  if (parts.length === 1) {
    return { schema: '', table: parts[0] }
  }
  return { schema: parts[0], table: parts[1] }
}

/** 解析表名；SQL 里没写限定名时按方言回退到当前库 / public */
function resolveTable(ctx: ResultSourceContext, dialect: SqlDialect): TableRef | null {
  const parsed = parseTableRef(ctx.sql)
  if (!parsed) {
    return null
  }
  if (parsed.schema) {
    return parsed
  }
  const fallback = dialect === 'mysql' ? ctx.database : 'public'
  return { schema: fallback, table: parsed.table }
}

/** 标识符引用（SQL 补全也用它，保持两处一致） */
export function quoteIdent(name: string, dialect: SqlDialect): string {
  return dialect === 'postgres'
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, '``')}\``
}

/** 字符串字面量转义 */
function escapeString(text: string, dialect: SqlDialect): string {
  const escaped = text.replace(/'/g, "''")
  // MySQL 默认把反斜杠当转义符；PostgreSQL 默认不处理（standard_conforming_strings）
  return dialect === 'mysql' ? escaped.replace(/\\/g, '\\\\') : escaped
}

/** 值 → SQL 字面量（结果行 SQL 与补全的比较值共用一份转义规则） */
export function formatSqlValue(value: unknown, dialect: SqlDialect): string {
  return formatValue(value, dialect)
}

/** 单元格值 → SQL 字面量 */
function formatValue(value: unknown, dialect: SqlDialect): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? String(value) : 'NULL'
    case 'bigint':
      return value.toString()
    case 'boolean':
      return value ? '1' : '0'
    default:
      break
  }
  if (value instanceof Date) {
    return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`
  }
  return `'${escapeString(String(value), dialect)}'`
}

/** 生成限定名（带库名） */
function qualify(ref: TableRef, dialect: SqlDialect): string {
  return [ref.schema, ref.table]
    .filter(Boolean)
    .map(name => quoteIdent(name, dialect))
    .join('.')
}

/** 查询表主键（information_schema，MySQL / PostgreSQL 通用结构） */
export async function fetchPrimaryKeys(
  ctx: ResultSourceContext,
  ref: TableRef,
  dialect: SqlDialect,
): Promise<string[]> {
  const schema = ref.schema || (dialect === 'mysql' ? ctx.database : 'public')
  const cacheKey = `${ctx.connId}:${schema}:${ref.table}`
  const cached = primaryKeyCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const escapeLiteral = (text: string) => text.replace(/'/g, "''")
  const metaSql = `SELECT kcu.column_name AS name
  FROM information_schema.table_constraints AS tc
  JOIN information_schema.key_column_usage AS kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = '${escapeLiteral(schema)}'
    AND tc.table_name = '${escapeLiteral(ref.table)}'
  ORDER BY kcu.ordinal_position`

  const result = await executeStatement({
    connId: ctx.connId ?? 0,
    database: ctx.database,
    sql: metaSql,
    limit: 0,
  })
  const keys = (result?.rows ?? [])
    .map(row => String(row.name ?? Object.values(row)[0] ?? ''))
    .filter(Boolean)

  primaryKeyCache.set(cacheKey, keys)
  return keys
}

/** 结果集对应表的主键列名（表头标识用）；识别不出时安静返回空数组 */
export async function primaryKeysOfResult(ctx: ResultSourceContext): Promise<string[]> {
  if (!ctx.connId) {
    return []
  }
  const dialect = dialectOf(ctx.dbType)
  const ref = resolveTable(ctx, dialect)
  if (!ref) {
    return []
  }
  try {
    return await fetchPrimaryKeys(ctx, ref, dialect)
  }
  catch {
    // 权限不足 / 库不可用 / 网络断开：都只是「没有主键标识」
    return []
  }
}

/** 生成语句所需的表与主键信息 */
export interface RowSqlTarget {
  dialect: SqlDialect
  /** 已带库名的表限定名 */
  target: string
  /** 结果集里可用于定位的主键列（INSERT 时为空） */
  keys: string[]
}

/** 解析表名与主键（批量复制只解析一次）；失败时返回原因文案 */
async function prepareRowSql(
  kind: RowSqlKind,
  ctx: RowSqlContext,
): Promise<{ ok: true, value: RowSqlTarget } | { ok: false, reason: string }> {
  const dialect = dialectOf(ctx.dbType)
  const ref = resolveTable(ctx, dialect)
  if (!ref) {
    return { ok: false, reason: '无法从结果对应的 SQL 中识别表名，已取消生成' }
  }

  const target = qualify(ref, dialect)
  if (kind === 'insert') {
    return { ok: true, value: { dialect, target, keys: [] } }
  }

  // UPDATE / DELETE 必须拿到主键才生成
  const label = kind.toUpperCase()
  const allKeys = await fetchPrimaryKeys(ctx, ref, dialect)
  if (!allKeys.length) {
    return { ok: false, reason: `未识别到 ${target} 的主键，已取消生成 ${label}` }
  }
  const keys = allKeys.filter(key => ctx.columns.includes(key))
  if (!keys.length) {
    return {
      ok: false,
      reason: `结果集里没有主键列（${allKeys.join(', ')}），已取消生成 ${label}`,
    }
  }
  if (kind === 'update' && !ctx.columns.some(name => !keys.includes(name))) {
    return { ok: false, reason: '结果集里除主键外没有可更新的列，已取消生成 UPDATE' }
  }
  return { ok: true, value: { dialect, target, keys } }
}

/** 为一行生成 SQL（纯函数）；主键值缺失时返回 null */
export function buildRowSqlStatement(
  kind: RowSqlKind,
  ctx: RowSqlContext,
  resolved: RowSqlTarget,
): string | null {
  const { dialect, target: table, keys } = resolved
  const nameOf = (name: string) => quoteIdent(name, dialect)

  if (kind === 'insert') {
    const names = ctx.columns.map(nameOf).join(', ')
    const values = ctx.columns.map(name => formatValue(ctx.row[name], dialect)).join(', ')
    return `INSERT INTO ${table} (${names}) VALUES (${values});`
  }

  if (keys.some(key => ctx.row[key] === null || ctx.row[key] === undefined)) {
    return null
  }
  const where = keys
    .map(key => `${nameOf(key)} = ${formatValue(ctx.row[key], dialect)}`)
    .join(' AND ')

  if (kind === 'delete') {
    return `DELETE FROM ${table} WHERE ${where};`
  }

  const sets = ctx.columns
    .filter(name => !keys.includes(name))
    .map(name => `${nameOf(name)} = ${formatValue(ctx.row[name], dialect)}`)
  if (!sets.length) {
    return null
  }
  return `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where};`
}

/** 生成并复制某一行的 SQL（单行入口） */
export async function copyRowSql(kind: RowSqlKind, ctx: RowSqlContext): Promise<void> {
  await copyRowsSql(kind, [ctx])
}

/** 生成并复制若干行的 SQL（批量复制为…）；不能安全生成的行会跳过 */
export async function copyRowsSql(kind: RowSqlKind, contexts: RowSqlContext[]): Promise<void> {
  if (!contexts.length) {
    return
  }
  const label = kind.toUpperCase()

  try {
    const prepared = await prepareRowSql(kind, contexts[0])
    if (!prepared.ok) {
      notify.warning(prepared.reason)
      return
    }

    const statements: string[] = []
    let skipped = 0
    for (const ctx of contexts) {
      const sql = buildRowSqlStatement(kind, ctx, prepared.value)
      if (sql) {
        statements.push(sql)
      }
      else {
        skipped += 1
      }
    }

    if (!statements.length) {
      notify.warning(`选中的 ${contexts.length} 行都无法生成 ${label}（主键值缺失）`)
      return
    }

    await copyText(statements.join('\n'))
    if (skipped > 0) {
      notify.success(`已复制 ${statements.length} 条 ${label} 语句（跳过 ${skipped} 行：主键值缺失）`)
    }
    else if (statements.length > 1) {
      notify.success(`已复制 ${statements.length} 条 ${label} 语句`)
    }
    else {
      notify.success(`已复制 ${label} 语句`)
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

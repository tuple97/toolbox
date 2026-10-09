/**
 * 表的索引信息（表结构卡片底部的「索引」区块用）。
 *
 * 走 executeStatement 直查数据字典，与主键反查（rowSql.fetchPrimaryKeys）同一套路：
 * 不新增后端绑定（新增绑定要重跑 wails3 generate bindings，收益不成比例），
 * 结果在模块内缓存 —— 卡片反复打开不会反复打库。
 *
 * 拿不到（方言不支持 / 权限不足）就返回空数组：索引是展示增强，
 * 失败不该影响卡片的其余部分。
 */
import { executeStatement } from '@/api/executor'
import { dialectOf } from './rowSql'

/** 一个索引：名称、列序（按定义顺序）与是否唯一 */
export interface TableIndexInfo {
  name: string
  columns: string[]
  unique: boolean
}

/** 缓存：连接:方言:库:表 → 索引列表 */
const cache = new Map<string, TableIndexInfo[]>()

/** 查询某张表的索引 */
export async function fetchTableIndexes(
  connId: number,
  database: string,
  table: string,
  dbType: string,
): Promise<TableIndexInfo[]> {
  if (!connId || !table) {
    return []
  }
  const dialect = dialectOf(dbType)
  // 库 / schema 与主键反查同一口径：MySQL 空库退到 DATABASE()，PG 空模式退到 public
  const schema = database || (dialect === 'mysql' ? '' : 'public')
  const key = `${connId}:${dialect}:${schema}:${table}`
  const cached = cache.get(key)
  if (cached) {
    return cached
  }

  try {
    const indexes = dialect === 'postgres'
      ? await fetchPostgresIndexes(connId, schema, table)
      : await fetchMysqlIndexes(connId, schema, table)
    cache.set(key, indexes)
    return indexes
  }
  catch {
    return []
  }
}

/** MySQL / MariaDB：information_schema.statistics，PRIMARY 是主键本身（卡片另有标识），跳过 */
async function fetchMysqlIndexes(connId: number, schema: string, table: string): Promise<TableIndexInfo[]> {
  // executeStatement 不支持参数占位：值按字面量转义后内联（与主键反查同一做法）
  const escapeLiteral = (text: string) => text.replace(/'/g, "''")
  const schemaCondition = schema
    ? `table_schema = '${escapeLiteral(schema)}'`
    : 'table_schema = DATABASE()'
  const result = await executeStatement({
    connId,
    database: schema,
    sql: `
      SELECT index_name, non_unique, column_name
      FROM information_schema.statistics
      WHERE ${schemaCondition} AND table_name = '${escapeLiteral(table)}'
      ORDER BY index_name, seq_in_index`,
    limit: 0,
  })
  return groupMysqlIndexRows(result.rows)
}

/** MySQL 行 → 索引（同名多行是复合索引的各列，按 seq_in_index 排好序进来） */
function groupMysqlIndexRows(rows: Record<string, unknown>[]): TableIndexInfo[] {
  const grouped = new Map<string, { columns: string[], unique: boolean }>()
  for (const row of rows) {
    const name = String(row.name ?? '')
    if (!name || name === 'PRIMARY') {
      continue
    }
    const entry = grouped.get(name) ?? { columns: [], unique: true }
    entry.columns.push(String(row.column_name ?? ''))
    // non_unique 为 0 表示唯一索引；各列行都唯一整个索引才唯一
    entry.unique = entry.unique && Number(row.non_unique ?? 1) === 0
    grouped.set(name, entry)
  }
  return [...grouped.entries()].map(([name, entry]) => ({
    name,
    columns: entry.columns,
    unique: entry.unique,
  }))
}

/** PostgreSQL：pg_indexes（定义是文本，列清单从括号里解析，够展示用） */
async function fetchPostgresIndexes(connId: number, schema: string, table: string): Promise<TableIndexInfo[]> {
  const escapeLiteral = (text: string) => text.replace(/'/g, "''")
  const result = await executeStatement({
    connId,
    database: schema,
    sql: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '${escapeLiteral(schema || 'public')}' AND tablename = '${escapeLiteral(table)}'`,
    limit: 0,
  })
  return result.rows.flatMap((row) => {
    const name = String(row.indexname ?? '')
    const definition = String(row.indexdef ?? '')
    if (!name || name.endsWith('_pkey')) {
      // _pkey 是主键约束自带的索引，卡片另有标识
      return []
    }
    const columnPart = /\((.*)\)/.exec(definition)?.[1] ?? ''
    return [{
      name,
      columns: columnPart.split(',').map(column => column.trim().replace(/^"|"$/g, '')).filter(Boolean),
      unique: /^CREATE UNIQUE/i.test(definition),
    }]
  })
}

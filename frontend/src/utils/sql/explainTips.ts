/** EXPLAIN 结果的优化建议（纯规则，不发请求）；MySQL 列式与 PostgreSQL 文本式都覆盖 */

/** 一条优化建议：source 标注依据，text 是建议本身 */
export interface ExplainSuggestion {
  source: string
  text: string
}

/** 从列名判断这是不是一份执行计划（MySQL 列式 或 PostgreSQL 文本式） */
export function looksLikeExplainColumns(columns: string[]): boolean {
  const lower = columns.map(column => column.toLowerCase())
  if (lower.includes('type') && lower.includes('extra')) {
    return true
  }
  return lower.includes('query plan')
}

/** 取行内字段（列名不区分大小写） */
function fieldOf(row: Record<string, unknown>, name: string): string {
  const lower = name.toLowerCase()
  const key = Object.keys(row).find(key => key.toLowerCase() === lower)
  return key === undefined ? '' : String(row[key] ?? '').trim()
}

/** 行内数字字段；解析失败返回 null */
function numberFieldOf(row: Record<string, unknown>, name: string): number | null {
  const raw = fieldOf(row, name)
  if (!raw) {
    return null
  }
  const value = Number(raw.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

/** MySQL：Extra 字段的经典信号 */
const MYSQL_EXTRA_RULES: Array<{ match: string, text: string }> = [
  { match: 'Using filesort', text: '需要额外排序才能返回结果，考虑为 ORDER BY 涉及的列建索引，或让排序走索引顺序' },
  { match: 'Using temporary', text: '使用了临时表（常见于 GROUP BY / DISTINCT），考虑为相关列建索引或改写语句' },
  { match: 'Using index', text: '覆盖索引：取数全部来自索引、无需回表，是好现象' },
  { match: 'Using join buffer', text: '关联没有走索引而是在内存里做连接，考虑为被驱动表的关联列建索引' },
  { match: 'Impossible WHERE', text: 'WHERE 条件恒为假，检查条件拼写与类型' },
]

/** 单行建议上限 */
const MAX_SUGGESTIONS = 6

/** MySQL 列式 EXPLAIN：单行建议 */
function suggestionsForMysqlRow(row: Record<string, unknown>): ExplainSuggestion[] {
  const out: ExplainSuggestion[] = []
  const push = (source: string, text: string) => {
    if (out.length < MAX_SUGGESTIONS) {
      out.push({ source, text })
    }
  }

  const accessType = fieldOf(row, 'type').toUpperCase()
  if (accessType === 'ALL') {
    push('type=ALL', '全表扫描：为过滤条件与关联列建立合适的索引，或确认 WHERE 是否过于宽松')
  }
  else if (accessType === 'INDEX') {
    push('type=INDEX', '按索引顺序扫全表：若只取少数字段考虑覆盖索引，或加 LIMIT 减少扫描量')
  }

  const key = fieldOf(row, 'key')
  const possibleKeys = fieldOf(row, 'possible_keys')
  if (!key && possibleKeys) {
    push('key', '有候选索引但优化器没用：检查列类型是否匹配、索引列是否被函数包裹或隐式转换、统计信息是否过期')
  }

  const rows = numberFieldOf(row, 'rows')
  if (rows !== null && rows >= 10000) {
    push('rows', `预估扫描 ${rows.toLocaleString()} 行，代价较高：确认过滤条件是否足够收紧`)
  }

  const extra = fieldOf(row, 'extra')
  if (extra) {
    for (const rule of MYSQL_EXTRA_RULES) {
      if (extra.toLowerCase().includes(rule.match.toLowerCase())) {
        push(`Extra:${rule.match}`, rule.text)
      }
    }
  }

  const selectType = fieldOf(row, 'select_type').toUpperCase()
  if (selectType.startsWith('DEPENDENT')) {
    push('select_type', '相关子查询会随外层每一行执行一次，行数大时考虑改写为 JOIN 或 EXISTS')
  }

  return out
}

/** PostgreSQL 文本式 EXPLAIN：单行建议 */
function suggestionsForPostgresRow(row: Record<string, unknown>, index: number): ExplainSuggestion[] {
  const plan = fieldOf(row, 'QUERY PLAN') || fieldOf(row, 'Query Plan') || Object.values(row).map(String).join(' ')
  if (!plan) {
    return []
  }
  const out: ExplainSuggestion[] = []
  const push = (source: string, text: string) => {
    if (out.length < MAX_SUGGESTIONS) {
      out.push({ source, text })
    }
  }

  if (/Seq Scan on/i.test(plan)) {
    push('Seq Scan', '顺序扫描全表：数据量大时为过滤条件或关联列建索引')
  }
  const removed = /Rows Removed by Filter:\s*(\d+)/i.exec(plan)
  if (removed && Number(removed[1]) >= 1000) {
    push('Rows Removed by Filter', `过滤后丢弃了 ${Number(removed[1]).toLocaleString()} 行，索引选择性可能不足`)
  }
  if (/Nested Loop/i.test(plan)) {
    push('Nested Loop', '嵌套循环连接：确认被驱动表的关联列上有索引，否则行数放大后会明显变慢')
  }
  if (/Sort Method:\s*external merge/i.test(plan)) {
    push('Sort Method', '排序溢出到磁盘，考虑增大 work_mem 或减少排序的数据量')
  }
  const rows = /rows=(\d+)/i.exec(plan)
  if (rows && Number(rows[1]) >= 100000) {
    push(`rows=${rows[1]}`, `预估扫描 ${Number(rows[1]).toLocaleString()} 行，确认过滤条件是否足够收紧`)
  }

  if (!out.length && index === 0) {
    // 计划第一行给一句兜底说明
    push('QUERY PLAN', '未发现常见问题信号；如需更细的耗时信息可改用 EXPLAIN (ANALYZE, BUFFERS) 实际执行一次')
  }
  return out
}

/** 单行建议：按列名形态自动选择 MySQL / PostgreSQL 规则 */
export function suggestionsForRow(row: Record<string, unknown>, index = 0): ExplainSuggestion[] {
  if (fieldOf(row, 'QUERY PLAN')) {
    return suggestionsForPostgresRow(row, index)
  }
  if (fieldOf(row, 'select_type') || fieldOf(row, 'type') || fieldOf(row, 'extra')) {
    return suggestionsForMysqlRow(row)
  }
  return []
}

/** 列候选池：按「来源」缓存候选项，并在超宽表上按前缀取舍（纯数据，不依赖编辑器） */
import { columnItem, renderIdent } from './sqlCompletionInsert'
import type { ColumnCompletion } from './sqlCompletionInsert'
import type { SqlDialect } from './rowSql'

/** 单表进入候选池的列数上限 */
export const MAX_TABLE_COLUMNS = 400

/** 单次补全的候选总量上限（在排序之后截断，留下的都是最相关的） */
export const MAX_OPTIONS = 800

/** 池里的列形态：物理列与派生列共用的最小描述 */
export interface PoolColumn {
  name: string
  dataType?: string
  comment?: string
  /** 派生列可能有自己的来源表 */
  from?: string
}

/** 候选池的来源描述 */
export interface PoolSource {
  /** 库 / 模式名（未限定为空） */
  schema?: string
  /** 物理表名 / 派生表名 / CTE 名 */
  table: string
  /** 来源限定符：别名；没有别名时就是表名 */
  alias: string
}

/** 中文列名：前缀是 ASCII 时它们仍可能靠拼音首字母命中，截断时要优先保住 */
const CJK_RE = /[\u4e00-\u9fa5]/

/** 前缀截断结果最多缓存几个前缀（防止连续输入把 Map 撑大） */
const MAX_TRIMMED_PREFIXES = 8

/** 元数据数组 → （来源 + 方言 + 是否带限定符）→ 全量候选 */
const pools = new WeakMap<readonly PoolColumn[], Map<string, ColumnCompletion[]>>()

/** 元数据数组 → 缓存键 → 前缀 → 截断后的候选 */
const trimmedPools = new WeakMap<readonly PoolColumn[], Map<string, Map<string, ColumnCompletion[]>>>()

/** 缓存键：来源 / 方言 / 是否带限定符任一不同就是另一组候选（表名必须参与键） */
function poolKey(source: PoolSource, dialect: SqlDialect, qualified: boolean): string {
  return `${dialect}\u0000${source.schema ?? ''}\u0000${source.table}\u0000${source.alias}\u0000${qualified ? 'q' : 'p'}`
}

/** 取（或建立）某个来源的全量候选（同一份元数据只构造一次） */
function fullPool(
  columns: readonly PoolColumn[],
  source: PoolSource,
  dialect: SqlDialect,
  qualified: boolean,
): ColumnCompletion[] {
  let byKey = pools.get(columns)
  if (!byKey) {
    byKey = new Map()
    pools.set(columns, byKey)
  }

  const key = poolKey(source, dialect, qualified)
  let items = byKey.get(key)
  if (!items) {
    const qualifier = renderIdent(source.alias, dialect)
    items = columns.map(column => {
      const ident = renderIdent(column.name, dialect)
      return columnItem({
        name: column.name,
        displayName: qualified ? `${source.alias}.${column.name}` : undefined,
        insertText: qualified ? `${qualifier}.${ident}` : ident,
        // 限定符单独给一份，插入时判断文档里是否已写着
        prefix: qualified ? `${qualifier}.` : undefined,
        columnId: {
          schema: source.schema,
          table: source.table,
          source: source.alias,
          column: column.name,
        },
        detail: {
          dataType: column.dataType,
          // 「来源」列显示血缘源头表名，不是别名
          from: column.from ?? (source.schema ? `${source.schema}.${source.table}` : source.table),
          comment: column.comment,
        },
        dialect,
      })
    })
    byKey.set(key, items)
  }
  return items
}

/** 超限时的取舍：前缀命中 > 中文列名 > 元数据顺序（匹配用裸列名 label） */
function keepByPrefix(items: ColumnCompletion[], prefix: string): ColumnCompletion[] {
  if (!prefix) {
    return items.slice(0, MAX_TABLE_COLUMNS)
  }

  const preferred: ColumnCompletion[] = []
  const cjk: ColumnCompletion[] = []
  const rest: ColumnCompletion[] = []

  for (const item of items) {
    if (item.label.toLowerCase().startsWith(prefix)) {
      preferred.push(item)
    }
    else if (CJK_RE.test(item.label)) {
      cjk.push(item)
    }
    else {
      rest.push(item)
    }
  }

  return [...preferred, ...cjk, ...rest].slice(0, MAX_TABLE_COLUMNS)
}

/** 某个来源的列候选（columns 的引用即缓存键） */
export function pooledColumnItems(
  columns: readonly PoolColumn[],
  source: PoolSource,
  dialect: SqlDialect,
  prefix: string,
  qualified: boolean,
): ColumnCompletion[] {
  if (!columns.length) {
    return []
  }

  const all = fullPool(columns, source, dialect, qualified)
  if (all.length <= MAX_TABLE_COLUMNS) {
    return all
  }

  let bySource = trimmedPools.get(columns)
  if (!bySource) {
    bySource = new Map()
    trimmedPools.set(columns, bySource)
  }

  const sourceKey = poolKey(source, dialect, qualified)
  let byPrefix = bySource.get(sourceKey)
  if (!byPrefix) {
    byPrefix = new Map()
    bySource.set(sourceKey, byPrefix)
  }

  const key = prefix.toLowerCase()
  let kept = byPrefix.get(key)
  if (!kept) {
    kept = keepByPrefix(all, key)
    if (byPrefix.size >= MAX_TRIMMED_PREFIXES) {
      const oldest = byPrefix.keys().next().value
      if (oldest !== undefined) {
        byPrefix.delete(oldest)
      }
    }
    byPrefix.set(key, kept)
  }
  return kept
}

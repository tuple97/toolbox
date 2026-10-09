/** 建表语句来源：优先数据库自己给的 DDL，拿不到再用元数据生成 */
import { fetchCreateTableSql } from '@/api/executor'
import type { SqlDialect } from '../rowSql'

/** 这份 DDL 从哪来 */
export type CreateTableSqlSource = 'database' | 'generated'

export interface CreateTableSqlResult {
  sql: string
  source: CreateTableSqlSource
}

export interface CreateTableSqlArgs {
  connId: number
  /** 当前库（MySQL 库名 / PostgreSQL schema） */
  database: string
  dbType: string
  /** 表所在的 schema；空表示用当前库 */
  schema?: string
  table: string
  /** 本地按元数据生成的 DDL */
  generated: string
}

/** 原生 DDL 缓存：键为 连接 + 库/schema + 表，带 5 分钟 TTL */
const nativeCache = new Map<string, { sql: string, at: number }>()

const CACHE_TTL_MS = 5 * 60 * 1000

/** 按「原生优先」的策略给出建表语句 */
export async function resolveCreateTableSql(args: CreateTableSqlArgs): Promise<CreateTableSqlResult> {
  const native = await nativeCreateTableSql(args)
  return native ? { sql: native, source: 'database' } : { sql: args.generated, source: 'generated' }
}

/** 原生 DDL；拿不到返回空串，PostgreSQL 直接跳过 */
async function nativeCreateTableSql(args: CreateTableSqlArgs): Promise<string> {
  if (!args.connId || !args.table || /^postgres/i.test(args.dbType)) {
    return ''
  }

  const schema = args.schema || args.database
  const key = `${args.connId}:${schema}:${args.table}`
  const cached = nativeCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.sql
  }

  try {
    const sql = await fetchCreateTableSql(args.connId, schema, args.table)
    if (sql) {
      nativeCache.set(key, { sql, at: Date.now() })
    }
    return sql
  }
  catch {
    // 连不上 / 连接被删：当作没有原生 DDL
    return ''
  }
}

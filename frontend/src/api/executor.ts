/** 命令执行器 API：执行 SQL（可取消）与库 / 表 / 字段元数据 */
import type { CancellablePromise } from '@wailsio/runtime'
import {
  ExecuteStatement,
  FetchCreateTableSQL,
  ListDatabases,
  ListForeignKeys,
  ListTableColumns,
  ListTables,
} from './bindings'
import type {
  DatabaseInfo,
  ExecutorColumn,
  ExecutorRequest,
  ExecutorResult,
  TableForeignKey,
} from '@/types'

/** 执行 SQL，cancel() 可终止查询；page 为 0 表示本次不分页 */
export function executeStatement(req: ExecutorRequest): CancellablePromise<ExecutorResult> {
  return ExecuteStatement({
    ...req,
    page: req.page ?? 0,
    pageSize: req.pageSize ?? 0,
    total: req.total ?? 0,
    countTotal: req.countTotal ?? false,
    // 生产库写操作确认标记，后端会校验
    allowProductionWrite: req.allowProductionWrite ?? false,
  }) as unknown as CancellablePromise<ExecutorResult>
}

/** 库列表，isSystem 由后端按方言判定 */
export async function fetchDatabases(connId: number): Promise<DatabaseInfo[]> {
  const rows = await ListDatabases(connId)
  return (rows ?? []).map(row => ({
    name: String(row?.name ?? ''),
    isSystem: Boolean(row?.isSystem),
  }))
}

export async function fetchTables(connId: number, database: string): Promise<string[]> {
  const rows = await ListTables(connId, database)
  return (rows ?? []).map(row => String(row))
}

export async function fetchTableColumns(
  connId: number,
  database: string,
  table: string,
): Promise<ExecutorColumn[]> {
  const list = await ListTableColumns(connId, database, table)
  return (list ?? []).map(item => ({
    name: String(item?.name ?? ''),
    dataType: String(item?.dataType ?? ''),
    comment: String(item?.comment ?? ''),
  }))
}

/** 数据库原生建表语句，拿不到时返回空串 */
export async function fetchCreateTableSql(
  connId: number,
  database: string,
  table: string,
): Promise<string> {
  if (typeof FetchCreateTableSQL !== 'function') {
    return ''
  }
  const ddl = await FetchCreateTableSQL(connId, database, table)
  return String(ddl ?? '').trim()
}

export async function fetchForeignKeys(
  connId: number,
  database: string,
  table: string,
): Promise<TableForeignKey[]> {
  const list = await ListForeignKeys(connId, database, table)
  return (list ?? []).map(item => ({
    column: String(item?.column ?? ''),
    referencedTable: String(item?.referencedTable ?? ''),
    referencedColumn: String(item?.referencedColumn ?? ''),
  }))
}

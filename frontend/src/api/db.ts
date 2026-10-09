import {
  DeleteConnection,
  ExecuteQuery,
  GetConnection,
  ListConnections,
  QueryVariableOptions,
  RevealPassword,
  SaveConnection,
  TestConnection,
} from './bindings'
import type { DBConnection, ExecuteRequest, QueryResult } from '@/types'

/** 把后端连接对象规整为前端类型（白名单式映射） */
function toConnection(raw: {
  id: number
  name: string
  dbType: string
  host: string
  port: number
  database: string
  username: string
  password: string
  extra: string
  note?: string | null
  color?: string | null
  charset?: string | null
  defaultSchema?: string | null
  connectTimeoutSecs?: number | null
  queryTimeoutSecs?: number | null
  keepaliveSecs?: number | null
  sslMode?: string | null
  sslCaPath?: string | null
  sslCertPath?: string | null
  sslKeyPath?: string | null
  urlParams?: string | null
  readOnly?: boolean | null
  isLocal?: boolean | null
  isTest?: boolean | null
  isProduction?: boolean | null
}): DBConnection {
  return {
    id: Number(raw.id ?? 0),
    name: String(raw.name ?? ''),
    dbType: String(raw.dbType ?? 'mysql'),
    host: String(raw.host ?? ''),
    port: Number(raw.port ?? 0),
    database: String(raw.database ?? ''),
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
    extra: String(raw.extra ?? ''),
    note: String(raw.note ?? ''),
    color: String(raw.color ?? ''),
    charset: String(raw.charset ?? ''),
    defaultSchema: String(raw.defaultSchema ?? ''),
    connectTimeoutSecs: Number(raw.connectTimeoutSecs ?? 0),
    queryTimeoutSecs: Number(raw.queryTimeoutSecs ?? 0),
    keepaliveSecs: Number(raw.keepaliveSecs ?? 0),
    sslMode: String(raw.sslMode ?? ''),
    sslCaPath: String(raw.sslCaPath ?? ''),
    sslCertPath: String(raw.sslCertPath ?? ''),
    sslKeyPath: String(raw.sslKeyPath ?? ''),
    urlParams: String(raw.urlParams ?? ''),
    readOnly: Boolean(raw.readOnly ?? false),
    isLocal: Boolean(raw.isLocal ?? false),
    isTest: Boolean(raw.isTest ?? false),
    isProduction: Boolean(raw.isProduction ?? false),
  }
}

export async function fetchConnections(): Promise<DBConnection[]> {
  const list = await ListConnections()
  return list.map(toConnection)
}

export async function fetchConnection(id: number): Promise<DBConnection> {
  const raw = await GetConnection(id)
  if (!raw) {
    throw new Error(`连接不存在（id=${id}）`)
  }
  return toConnection(raw)
}

/** 保存连接，密码由后端加密 */
export function persistConnection(conn: DBConnection): Promise<number> {
  return SaveConnection(conn)
}

export function removeConnection(id: number): Promise<void> {
  return DeleteConnection(id)
}

export function testConnection(conn: DBConnection): Promise<void> {
  return TestConnection(conn)
}

export function revealPassword(encrypted: string): Promise<string> {
  return RevealPassword(encrypted)
}

/** 执行查询，未指定分页参数时按不分页处理 */
export async function executeQuery(req: ExecuteRequest): Promise<QueryResult> {
  const result = await ExecuteQuery({
    ...req,
    // 空库名由后端回落到连接默认库
    database: req.database ?? '',
    page: req.page ?? 0,
    pageSize: req.pageSize ?? 0,
    total: req.total ?? 0,
    countTotal: req.countTotal ?? false,
  })
  if (!result) {
    throw new Error('查询未返回结果')
  }
  return result
}

export async function fetchVariableOptions(
  connId: number,
  database: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const rows = await QueryVariableOptions(connId, database, query)
  return rows as Record<string, unknown>[]
}

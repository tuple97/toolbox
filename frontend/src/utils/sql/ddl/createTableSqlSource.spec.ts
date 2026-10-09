/** 建表语句来源选择的用例 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetchCreateTableSql: vi.fn() }))

vi.mock('@/api/executor', () => ({ fetchCreateTableSql: mocks.fetchCreateTableSql }))

import { resolveCreateTableSql } from '@/utils/sql/ddl/createTableSqlSource'

const GENERATED = 'CREATE TABLE `users` (\n  `id` int\n);'

function args(table: string, overrides: Partial<Parameters<typeof resolveCreateTableSql>[0]> = {}) {
  return {
    connId: 1,
    database: 'mydb',
    dbType: 'mysql',
    table,
    generated: GENERATED,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.fetchCreateTableSql.mockReset()
})

describe('建表语句来源：原生优先', () => {
  it('数据库给了 DDL 就用它，并标明来源', async () => {
    mocks.fetchCreateTableSql.mockResolvedValue('CREATE TABLE `users` (\n  `id` int,\n  PRIMARY KEY (`id`)\n);')
    const result = await resolveCreateTableSql(args('users'))
    expect(result.source).toBe('database')
    expect(result.sql).toContain('PRIMARY KEY')
  })

  it('后端返回空串时回退到本地生成', async () => {
    mocks.fetchCreateTableSql.mockResolvedValue('')
    const result = await resolveCreateTableSql(args('empty_backend'))
    expect(result).toEqual({ sql: GENERATED, source: 'generated' })
  })

  it('后端报错时回退，不把异常抛给调用方', async () => {
    mocks.fetchCreateTableSql.mockRejectedValue(new Error('connection closed'))
    const result = await resolveCreateTableSql(args('backend_error'))
    expect(result).toEqual({ sql: GENERATED, source: 'generated' })
  })

  it('PostgreSQL 直接跳过（没有 SHOW CREATE TABLE），一次往返都不花', async () => {
    const result = await resolveCreateTableSql(args('pg_table', { dbType: 'postgres' }))
    expect(result.source).toBe('generated')
    expect(mocks.fetchCreateTableSql).not.toHaveBeenCalled()
  })

  it('SQL 里的限定 schema 优先于当前库作为查询参数', async () => {
    mocks.fetchCreateTableSql.mockResolvedValue('CREATE TABLE `other`.`t` ();')
    await resolveCreateTableSql(args('t', { schema: 'other', database: 'mydb' }))
    expect(mocks.fetchCreateTableSql).toHaveBeenCalledWith(1, 'other', 't')
  })

  it('同一张表在缓存有效期内只打一次后端', async () => {
    mocks.fetchCreateTableSql.mockResolvedValue('CREATE TABLE `cached` ();')
    await resolveCreateTableSql(args('cached'))
    await resolveCreateTableSql(args('cached'))
    expect(mocks.fetchCreateTableSql).toHaveBeenCalledTimes(1)
  })

  it('没有连接时直接用本地那份（不请求后端）', async () => {
    const result = await resolveCreateTableSql(args('no_conn', { connId: 0 }))
    expect(result).toEqual({ sql: GENERATED, source: 'generated' })
    expect(mocks.fetchCreateTableSql).not.toHaveBeenCalled()
  })
})

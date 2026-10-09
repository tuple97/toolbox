/** 表结构悬停用例 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { tableHoverAt } from '@/utils/sql/hover/sqlTableHover'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'

/** 静态元数据：testdb.users(id, username, email) */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: () => ['users', 'orders'],
  columns: (_connId, _database, table) => (table === 'users'
    ? [
        { name: 'id', dataType: 'int', comment: '主键' },
        { name: 'username', dataType: 'varchar(255)', comment: '' },
        { name: 'email', dataType: 'varchar(255)', comment: '' },
      ]
    : []),
}

/** 用 `|` 标出鼠标位置 */
function hoverAt(docWithCursor: string, provider: MetadataProvider = metadata) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const runtime: CompletionRuntime = {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata: provider,
  }
  return tableHoverAt(state, pos, runtime)
}

describe('表悬停：解析', () => {
  it('停在表名上给出列（保持元数据顺序）与建表语句', () => {
    const hover = hoverAt('SELECT * FROM |users')
    expect(hover?.info.tableName).toBe('users')
    expect(hover?.info.columns.map(column => column.name)).toEqual(['id', 'username', 'email'])
    expect(hover?.info.createTableSql).toContain('CREATE TABLE `users`')
  })

  it('停在别名上解析到对应表（不是显示别名）', () => {
    expect(hoverAt('SELECT * FROM users |u')?.info.tableName).toBe('users')
    // 引用处的别名同样解析到表
    expect(hoverAt('SELECT |u.id FROM users u')?.info.tableName).toBe('users')
  })

  it('JOIN 两侧各自解析', () => {
    const provider: MetadataProvider = {
      ...metadata,
      columns: (_connId, _database, table) => (table === 'orders'
        ? [{ name: 'id', dataType: 'int', comment: '' }]
        : metadata.columns(_connId, _database, table)),
    }
    expect(hoverAt('SELECT * FROM users u JOIN |orders o ON o.id = u.id', provider)?.info.tableName)
      .toBe('orders')
    expect(hoverAt('SELECT * FROM users u JOIN orders |o ON o.id = u.id', provider)?.info.tableName)
      .toBe('orders')
  })

  it('字符串 / 注释里不提示', () => {
    expect(hoverAt("SELECT * FROM users WHERE name = '|users'")).toBeNull()
    expect(hoverAt('SELECT * FROM users -- |users')).toBeNull()
  })

  it('列元数据没到位（后台还在拉）时不提示，也不报错', () => {
    const empty: MetadataProvider = { ...metadata, columns: () => [] }
    expect(hoverAt('SELECT * FROM |users', empty)).toBeNull()
  })

  it('派生表 / CTE 也给结构（派生列），但没有建表语句、不给复制', () => {
    const derived = hoverAt('SELECT * FROM (SELECT id, username AS 名字 FROM users) |t')
    expect(derived?.info.virtual).toBe(true)
    expect(derived?.info.columns.map(column => column.name)).toEqual(['id', '名字'])
    expect(derived?.info.createTableSql).toBe('')

    const cte = hoverAt('WITH recent AS (SELECT id FROM users) SELECT * FROM |recent')
    expect(cte?.info.virtual).toBe(true)
    expect(cte?.info.columns.map(column => column.name)).toEqual(['id'])
    expect(cte?.info.createTableSql).toBe('')

    // 物理表仍然带 DDL
    expect(hoverAt('SELECT * FROM |users')?.info.virtual).toBe(false)
  })

  it('没登记连接时不提示', () => {
    const pos = 'SELECT * FROM users'.indexOf('users')
    const doc = 'SELECT * FROM users'
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    expect(tableHoverAt(state, pos, { mode: 'sql', metadata })).toBeNull()
  })
})

/**
 * JOIN 位置与多来源列候选的回归用例。
 *
 * 覆盖之前漏掉、却最容易出错的位置：
 *   `ON |` / `ON o.|` / `ON o.user_|` / `ON a = |` / `ON a = u.|` / `ON a = u.i|` / `ON a AND |`
 * 以及「多来源同名列必须同时存在」与「点号补全的替换范围只有词、前缀由候选自带」。
 *
 * 位置标记用 `§`。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { ColumnCompletion, MetadataProvider } from '@/utils/sql/sqlCompletion'

const MARK = '§'

/** users / orders 两张表，orders.user_id → users.id */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: () => ['users', 'orders'],
  columns: (_connId, _database, table) => {
    if (table === 'users') {
      return [
        { name: 'id', dataType: 'bigint', comment: '' },
        { name: 'username', dataType: 'varchar(32)', comment: '' },
        { name: 'email', dataType: 'varchar(64)', comment: '' },
        { name: 'created_at', dataType: 'datetime', comment: '创建时间' },
      ]
    }
    if (table === 'orders') {
      return [
        { name: 'id', dataType: 'bigint', comment: '' },
        { name: 'user_id', dataType: 'bigint', comment: '' },
        { name: 'order_number', dataType: 'varchar(32)', comment: '' },
        { name: 'created_at', dataType: 'datetime', comment: '创建时间' },
      ]
    }
    return []
  },
  foreignKeys: (_connId, _database, table) => (table === 'orders'
    ? [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }]
    : []),
}

/** 一次补全的全部候选项 */
function itemsOf(docWithCursor: string): ColumnCompletion[] {
  const pos = docWithCursor.indexOf(MARK)
  const doc = docWithCursor.replace(MARK, '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const bundle = collectCompletions(state, pos, {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata,
    useHistory: false,
  })
  return (bundle?.options ?? []) as ColumnCompletion[]
}

/** 候选 label 列表 */
function labelsOf(docWithCursor: string): string[] {
  return itemsOf(docWithCursor).map(item => item.label)
}

/** 某次补全给出的替换范围（补全源里的 from/to） */
function rangeOf(docWithCursor: string): { from: number, to: number } {
  const pos = docWithCursor.indexOf(MARK)
  const doc = docWithCursor.replace(MARK, '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const bundle = collectCompletions(state, pos, {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata,
    useHistory: false,
  })
  return { from: bundle?.from ?? -1, to: bundle?.to ?? -1 }
}

describe('JOIN 条件位置', () => {
  it('ON 之后还空着：给整条关联条件', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN orders o ON §')
    expect(labels).toContain('o.user_id = u.id')
  })

  it('ON 里已经有条件、又在 AND 后收起一行：不再给整条', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN orders o ON o.user_id = u.id AND o.§')
    expect(labels).toContain('user_id')
    expect(labels).not.toContain('o.user_id = u.id')
  })

  it('ON o.user_ 正在输入列名：只给列', () => {
    const labels = labelsOf(`SELECT * FROM users u JOIN orders o ON o.user_${MARK}`)
    expect(labels).toContain('user_id')
    expect(labels).not.toContain('o.user_id = u.id')
  })

  it('ON a = 之后：只给列（可以继续写右值）', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN orders o ON o.user_id = §')
    expect(labels).toContain('id')
    expect(labels).not.toContain('o.user_id = u.id')
  })

  it('ON a = u. 之后：给 u 的列（带限定符插入）', () => {
    const items = itemsOf('SELECT * FROM users u JOIN orders o ON o.user_id = u.§')
    const labels = items.map(item => item.label)
    expect(labels).toContain('id')
    expect(labels).not.toContain('o.user_id = u.id')
    // 点号补全：展示与插入都带限定符
    const id = items.find(item => item.label === 'id')
    expect(id?.displayLabel).toBe('u.id')
    expect(id?.columnInsert).toBe('u.id')
  })

  it('ON a = u.i 正在输入：同样只给列，替换范围只有词', () => {
    const doc = 'SELECT * FROM users u JOIN orders o ON o.user_id = u.i§'
    expect(labelsOf(doc)).toContain('id')
    // 替换范围只覆盖词（`i`）：左侧的 `u.` 留在文档里，由候选自带的前缀写回
    const range = rangeOf(doc)
    const wordStart = doc.replace(MARK, '').lastIndexOf('u.i') + 2
    expect(range).toEqual({ from: wordStart, to: wordStart + 1 })
  })

  it('ON … AND 之后：又能给下一条条件', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN orders o ON o.user_id = u.id AND §')
    expect(labels.length).toBeGreaterThan(0)
  })

  it('没有关联关系时不凭空造条件（products 与 users/orders 无关）', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN products p ON §')
    expect(labels.every(label => !label.includes(' = '))).toBe(true)
  })
})

describe('多来源列候选', () => {
  const multi = 'SELECT § FROM users u JOIN orders o ON o.user_id = u.id'

  it('同名列是两个候选，都带自己的限定符', () => {
    const items = itemsOf(multi)
    const createdAt = items.filter(item => item.label === 'created_at')
    expect(createdAt).toHaveLength(2)
    expect(createdAt.map(item => item.displayLabel).sort())
      .toEqual(['o.created_at', 'u.created_at'])
    expect(createdAt.map(item => item.columnInsert).sort())
      .toEqual(['o.created_at', 'u.created_at'])
  })

  it('候选身份按来源区分（勾选与去重在多表下不互相影响）', () => {
    const items = itemsOf(multi)
    const ids = items.filter(item => item.label === 'id')
    expect(ids).toHaveLength(2)
    expect(new Set(ids.map(item => item.columnKey)).size).toBe(2)
  })

  it('单来源时不啰嗦：展示与插入都是裸列名', () => {
    const items = itemsOf('SELECT § FROM users u')
    const name = items.find(item => item.label === 'username')
    expect(name?.displayLabel).toBeUndefined()
    expect(name?.columnInsert).toBe('username')
  })

  it('派生列的来源追溯到物理表（而插入仍用派生表别名）', () => {
    const items = itemsOf('SELECT § FROM (SELECT * FROM users) t1')
    const name = items.find(item => item.label === 'username')
    // 描述里点出源头表 users；插入用当前来源 t1
    expect(name?.columnDetail?.from).toBe('users')
    expect(name?.columnInsert).toBe('username')
    expect(name?.columnKey).toContain('@t1')
  })
})

describe('未知限定符不再兜底猜表', () => {
  it('`WHERE x.` 里 x 不是可见来源时不给候选', () => {
    // x 恰好是库里某张表名时，旧实现会把它当表查；现在只认作用域里的来源
    expect(labelsOf('SELECT * FROM users u WHERE x.§')).toEqual([])
  })

  it('写成 `库.表.` 这种显式形式才允许绕过作用域', () => {
    expect(labelsOf('SELECT * FROM users u WHERE testdb.users.§')).toContain('username')
  })
})

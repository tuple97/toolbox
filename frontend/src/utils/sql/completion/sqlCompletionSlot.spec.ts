/** 槽位与候选资格的 Golden Tests */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { analyzeSqlCursorText } from '@/utils/sql/sqlCursor'
import { analyzeHybridCursor } from '@/utils/sql/hybridCursor'
import { resolveCompletionSlot } from '@/utils/sql/completion/sqlCompletionSlot'
import type { SqlCompletionSlot } from '@/utils/sql/completion/sqlCompletionSlot'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'

const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: () => ['users', 'orders', 'products'],
  columns: (_c, _d, table) => (table === 'users'
    ? [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'username', dataType: 'varchar(64)', comment: '' },
        { name: 'email', dataType: 'varchar(128)', comment: '' },
        { name: 'created_at', dataType: 'datetime', comment: '' },
      ]
    : [{ name: 'id', dataType: 'int', comment: '' }, { name: 'user_id', dataType: 'int', comment: '' }]),
}

/** 光标处：槽位 + 全部候选 label */
function at(docWithCursor: string) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const runtime: CompletionRuntime = {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata,
  }
  const intent = analyzeSqlCursorText(state, pos, 'mysql')
  const bundle = collectCompletions(state, pos, runtime)
  return {
    slot: resolveCompletionSlot({
      kind: intent.kind,
      keyword: intent.clause.keyword,
      previousKeyword: intent.clause.previousKeyword,
      tail: intent.clause.tail,
      tight: intent.clause.tight,
      column: intent.column,
    }),
    // 「正在输入的词」以光标层为准
    prefix: analyzeHybridCursor(state, pos, { mode: 'sql' }).prefix,
    labels: (bundle?.options ?? []).map(option => option.label),
  }
}

const slotOf = (doc: string): SqlCompletionSlot => at(doc).slot

describe('槽位：光标 → slot（文档 §56）', () => {
  it('SELECT：新的一项 vs 已经在表达式里', () => {
    expect(slotOf('SELECT | FROM users u')).toBe('select-item-start')
    expect(slotOf('SELECT DISTINCT | FROM users u')).toBe('select-item-start')
    expect(slotOf('SELECT id | FROM users u')).toBe('select-expression')
    expect(slotOf('SELECT a + | FROM users u')).toBe('select-expression')
  })

  it('FROM：要写表名 vs 表已写完', () => {
    expect(slotOf('SELECT * FROM |')).toBe('from-source')
    expect(slotOf('SELECT * FROM users, |')).toBe('from-source')
    expect(slotOf('SELECT * FROM users |')).toBe('from-after-source')
  })

  it('WHERE / GROUP BY / ORDER BY / HAVING', () => {
    expect(slotOf('SELECT * FROM users WHERE |')).toBe('where-expression')
    expect(slotOf('SELECT * FROM users WHERE id = 1 |')).toBe('where-expression')
    expect(slotOf('SELECT * FROM users GROUP BY |')).toBe('group-by-expression')
    expect(slotOf('SELECT * FROM users ORDER BY |')).toBe('order-by-expression')
    expect(slotOf('SELECT * FROM users HAVING |')).toBe('having-expression')
  })

  it('JOIN：条件还没写 vs 条件内部；INSERT / UPDATE 各自成槽', () => {
    expect(slotOf('SELECT * FROM users u JOIN orders o ON |')).toBe('join-predicate-start')
    expect(slotOf('SELECT * FROM users u JOIN orders o ON o.user_id = u.|')).toBe('join-expression')
    expect(slotOf('INSERT INTO users (|')).toBe('insert-column')
    expect(slotOf('INSERT INTO users (id, |')).toBe('insert-column')
    expect(slotOf('UPDATE users SET |')).toBe('update-set-column')
    expect(slotOf('SELECT id AS |')).toBe('alias')
    expect(slotOf('SELECT 1 FROM users WHERE id = 1 UNION |')).not.toBe('unknown')
  })

  it('紧贴光标的关键字：`WHERE|` 就是 WHERE，不是表位置（文档 §66）', () => {
    expect(slotOf('SELECT * FROM users WHERE|')).toBe('where-expression')
    expect(slotOf('SELECT * FROM users WHERE|')).not.toBe('from-after-source')
    // `FROM or|` 里的 or 是还没写完的表名，不能当关键字（文档 §67）
    expect(slotOf('SELECT * FROM or|')).toBe('from-source')
    // `WHERE or|` 仍然要识别成条件位置，并且「正在输入的词」是 or
    const where = at('SELECT * FROM users WHERE or|')
    expect(where.slot).toBe('where-expression')
    expect(where.prefix).toBe('or')
    // `SELECT CASE|` 不能被当成「没写完的名字」而丢掉关键字语义
    expect(slotOf('SELECT CASE|')).toBe('unknown')
  })
})

describe('资格：SELECT | 不出现子句关键字（文档 §64）', () => {
  it('给列与函数，不给 WHERE / FROM / GROUP BY / ORDER BY', () => {
    const { labels } = at('SELECT | FROM users u')
    expect(labels).toContain('id')
    expect(labels).toContain('COUNT')
    expect(labels).not.toContain('WHERE')
    expect(labels).not.toContain('FROM')
    expect(labels).not.toContain('GROUP BY')
    expect(labels).not.toContain('ORDER BY')
  })

  it('表达式写完（`SELECT id |`）才给下一个子句', () => {
    const { labels } = at('SELECT id | FROM users u')
    expect(labels).toContain('FROM')
    expect(labels).toContain('WHERE')
    expect(labels).toContain('GROUP BY')
  })
})

describe('资格：FROM 与 WHERE 的边界（文档 §57 / §65）', () => {
  it('FROM users | 不再给表名，只给接下来的子句', () => {
    const { labels } = at('SELECT * FROM users |')
    expect(labels).not.toContain('users')
    expect(labels).not.toContain('orders')
    expect(labels).toContain('JOIN')
    expect(labels).toContain('WHERE')
    expect(labels).toContain('GROUP BY')
  })

  it('FROM | 只给表与库', () => {
    const { labels } = at('SELECT * FROM |')
    expect(labels).toContain('users')
    expect(labels).toContain('testdb')
    expect(labels).not.toContain('WHERE')
    expect(labels).not.toContain('email')
  })

  it('WHERE | 不给 FROM / JOIN / GROUP BY / ORDER BY', () => {
    const { labels } = at('SELECT * FROM users WHERE |')
    expect(labels).toContain('email')
    expect(labels).toContain('AND')
    expect(labels).not.toContain('FROM')
    expect(labels).not.toContain('JOIN')
    expect(labels).not.toContain('GROUP BY')
    expect(labels).not.toContain('ORDER BY')
  })

  it('ORDER BY | 给列与 ASC/DESC，不给 FROM / JOIN / WHERE', () => {
    const { labels } = at('SELECT * FROM users ORDER BY |')
    expect(labels).toContain('email')
    expect(labels).toContain('ASC')
    expect(labels).toContain('DESC')
    expect(labels).not.toContain('FROM')
    expect(labels).not.toContain('JOIN')
    expect(labels).not.toContain('WHERE')
  })

  it('GROUP BY | 给列与函数，不给 FROM / WHERE / JOIN', () => {
    const { labels } = at('SELECT * FROM users GROUP BY |')
    expect(labels).toContain('email')
    expect(labels).not.toContain('FROM')
    expect(labels).not.toContain('WHERE')
    expect(labels).not.toContain('JOIN')
  })

  it('JOIN 条件内部（`ON o.|`）只给该来源的列，不再给整条条件', () => {
    const { labels } = at('SELECT * FROM users u JOIN orders o ON o.|')
    expect(labels.every(label => ['id', 'user_id'].includes(label))).toBe(true)
  })
})

describe('资格：schema 顺序（文档 §59）', () => {
  it('空前缀时严格按元数据顺序，不被历史打乱', () => {
    const { labels } = at('SELECT u.| FROM users u')
    expect(labels.slice(0, 4)).toEqual(['id', 'username', 'email', 'created_at'])
  })
})

/**
 * 关联条件补全的用例。
 *
 * 前半是纯函数（条件生成 / 表名单数化 / 类型兼容），后半走 collectCompletions
 * 验证「只在 ON 位置出现、不污染表名位置」。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import { joinConditionItems, joinConditionsForPair, singularTableName } from '@/utils/sql/sqlCompletionJoin'
import { typeFamilyOf, typesCompatible } from '@/utils/sql/sqlTypeCompat'
import type { Completion } from '@codemirror/autocomplete'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'
import type { JoinSide } from '@/utils/sql/sqlCompletionJoin'

/** users(id int, name varchar) / orders(id int, user_id int, note text) */
const sides = {
  users: {
    table: 'users',
    alias: 'u',
    columns: [
      { name: 'id', dataType: 'int' },
      { name: 'name', dataType: 'varchar' },
    ],
  } satisfies JoinSide,
  orders: {
    table: 'orders',
    alias: 'o',
    columns: [
      { name: 'id', dataType: 'int' },
      { name: 'user_id', dataType: 'int' },
      { name: 'note', dataType: 'text' },
    ],
  } satisfies JoinSide,
}

/** 带外键的元数据：orders.user_id → users.id */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: (_connId, database) => (database === 'testdb' ? ['users', 'orders'] : []),
  columns: (_connId, _database, table) => {
    if (table === 'users') {
      return [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'name', dataType: 'varchar', comment: '' },
      ]
    }
    if (table === 'orders') {
      return [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'user_id', dataType: 'int', comment: '' },
        { name: 'note', dataType: 'text', comment: '' },
      ]
    }
    return []
  },
  foreignKeys: (_connId, _database, table) => (table === 'orders'
    ? [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }]
    : []),
}

/** 不带外键的元数据：只能靠命名启发式 */
const metadataWithoutFk: MetadataProvider = {
  databases: metadata.databases,
  tables: metadata.tables,
  columns: metadata.columns,
}

/** 用 `|` 标记光标位置，返回候选项 */
function itemsOf(docWithCursor: string, provider: MetadataProvider = metadata): Completion[] {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const runtime: CompletionRuntime = {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata: provider,
    useHistory: false,
  }
  return collectCompletions(state, pos, runtime)?.options ?? []
}

function labelsOf(docWithCursor: string, provider: MetadataProvider = metadata): string[] {
  return itemsOf(docWithCursor, provider).map(item => item.label)
}

describe('关联条件：表名单数化', () => {
  it('常见后缀按规则还原', () => {
    expect(singularTableName('orders')).toBe('order')
    expect(singularTableName('companies')).toBe('company')
    expect(singularTableName('leaves')).toBe('leaf')
    expect(singularTableName('addresses')).toBe('address')
    expect(singularTableName('status')).toBe('status')
    expect(singularTableName('children')).toBe('child')
  })

  it('不认识的词保持原样（宁可不给候选，也不猜错）', () => {
    expect(singularTableName('device')).toBe('device')
  })
})

describe('关联条件：类型兼容', () => {
  it('同大类兼容', () => {
    expect(typesCompatible('int', 'bigint')).toBe(true)
    expect(typesCompatible('varchar(64)', 'text')).toBe(true)
    expect(typesCompatible('datetime', 'timestamp')).toBe(true)
  })

  it('跨大类不兼容', () => {
    expect(typesCompatible('int', 'varchar')).toBe(false)
    expect(typesCompatible('text', 'timestamp')).toBe(false)
  })

  it('类型未知时放行（元数据缺失不该让条件消失）', () => {
    expect(typesCompatible(undefined, 'int')).toBe(true)
    expect(typesCompatible('', 'varchar')).toBe(true)
  })

  it('类型名归一到大类', () => {
    expect(typeFamilyOf('bigint(20) unsigned')).toBe('number')
    expect(typeFamilyOf('character varying(64)')).toBe('string')
    expect(typeFamilyOf('timestamp without time zone')).toBe('time')
  })
})

describe('关联条件：条件生成', () => {
  it('按命名启发式生成 o.user_id = u.id', () => {
    const items = joinConditionsForPair(sides.orders, sides.users)
    expect(items.map(item => item.label)).toContain('o.user_id = u.id')
    expect(items[0].detail).toContain('关联条件')
  })

  it('外键约束优先于命名启发式，并标注来源', () => {
    const withFk: JoinSide = {
      ...sides.orders,
      foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
    }
    const items = joinConditionsForPair(withFk, sides.users)
    expect(items[0].label).toBe('o.user_id = u.id')
    expect(items[0].detail).toContain('外键')
  })

  it('外键定义在另一侧时同样能配对', () => {
    const leftWithFk: JoinSide = {
      ...sides.users,
      foreignKeys: [{ column: 'id', referencedTable: 'orders', referencedColumn: 'user_id' }],
    }
    const items = joinConditionsForPair(leftWithFk, sides.orders)
    expect(items.map(item => item.label)).toContain('u.id = o.user_id')
  })

  it('类型不兼容的列对不生成条件', () => {
    const broken: JoinSide = {
      table: 'orders',
      alias: 'o',
      columns: [{ name: 'user_id', dataType: 'varchar' }],
    }
    const usersId = { table: 'users', alias: 'u', columns: [{ name: 'id', dataType: 'int' }] }
    expect(joinConditionsForPair(broken, usersId)).toEqual([])
  })

  it('缺少约定列（*_id / id）时不猜条件', () => {
    const weird: JoinSide = { table: 'logs', alias: 'l', columns: [{ name: 'msg', dataType: 'text' }] }
    expect(joinConditionsForPair(weird, sides.users)).toEqual([])
  })

  it('一对多张表时逐对生成并去重', () => {
    const items = joinConditionItems({
      left: sides.orders,
      others: [sides.users, { ...sides.users, alias: 'u2' }],
    })
    const labels = items.map(item => item.label)
    expect(labels).toContain('o.user_id = u.id')
    expect(labels).toContain('o.user_id = u2.id')
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('关联条件：接入位置', () => {
  it('ON 后面给出整条关联条件', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN orders o ON |')
    expect(labels).toContain('o.user_id = u.id')
  })

  it('没有外键元数据时降级为命名启发式，不报错也不空手', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN orders o ON |', metadataWithoutFk)
    expect(labels).toContain('o.user_id = u.id')
  })

  it('只有一张表时不给关联条件（没得配）', () => {
    const labels = labelsOf('SELECT * FROM orders o WHERE |')
    expect(labels).not.toContain('o.user_id = u.id')
  })

  it('表名位置不会被关联条件污染', () => {
    const labels = labelsOf('SELECT * FROM |')
    expect(labels).toEqual(['users', 'orders', 'testdb'])
  })

  it('featureFlags 可以关掉关联条件', () => {
    const pos = 'SELECT * FROM users u JOIN orders o ON |'.indexOf('|')
    const doc = 'SELECT * FROM users u JOIN orders o ON '.slice(0, pos)
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    const bundle = collectCompletions(state, pos, {
      mode: 'sql',
      sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
      metadata,
      useHistory: false,
      featureFlags: { joinSuggestions: false },
    })
    expect(bundle?.options.map(item => item.label)).not.toContain('o.user_id = u.id')
  })
})

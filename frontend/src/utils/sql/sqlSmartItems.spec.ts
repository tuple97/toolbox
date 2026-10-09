/**
 * 智能项（T3）用例：`*` 展开 / GROUP BY 非聚合列 / 比较值 / INSERT 列清单。
 *
 * 分两层：
 *  - 纯函数（sqlSmartItems）：位置判定与文本拼装，直接在 node 里跑；
 *  - 补全整体（collectCompletions）：候选是否在该位置出现、插入内容是否落在
 *    正确的文档区间（用假 view 接住 dispatch 的 changes 验证）。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'
import { BOOST_SMART_COLUMN } from '@/utils/sql/sqlCompletionKeywords'
import {
  comparisonTarget,
  containsAggregate,
  insertTargetTable,
  nonAggregateColumnsOf,
  selectListTail,
  smartValueItems,
  starAtSelectListEnd,
} from '@/utils/sql/sqlSmartItems'

/** 静态元数据：testdb.users(id, name, status)、testdb.orders(id, user_id) */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: (_connId, database) => (database === 'testdb' ? ['users', 'orders'] : []),
  columns: (_connId, _database, table) => {
    if (table === 'users') {
      return [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'name', dataType: 'varchar', comment: '名称' },
        { name: 'status', dataType: 'int', comment: '状态' },
      ]
    }
    if (table === 'orders') {
      return [
        { name: 'id', dataType: 'int', comment: '' },
        { name: 'user_id', dataType: 'int', comment: '' },
      ]
    }
    return []
  },
  // 值域（词典）：只有 status 有
  values: (_connId, _database, _table, column) => (column === 'status'
    ? [
        { value: '1', meaning: '启用', source: '词典 status' },
        { value: '0', meaning: '停用', source: '词典 status' },
      ]
    : []),
}

/** 用 `|` 标出光标位置，返回候选项 */
function itemsOf(
  docWithCursor: string,
  runtime: Partial<CompletionRuntime> = {},
): Completion[] {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })

  const bundle = collectCompletions(state, pos, {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata,
    useHistory: false,
    ...runtime,
  })
  return bundle?.options ?? []
}

/** 候选项的 label 列表 */
function labelsOf(docWithCursor: string, runtime: Partial<CompletionRuntime> = {}): string[] {
  return itemsOf(docWithCursor, runtime).map(item => item.label)
}

/**
 * 执行某个候选项的 apply，返回它替换掉的文档区间与插入文本。
 *
 * 片段型智能项自带 apply（不依赖编辑器的默认插入），这里用假 view 接住 dispatch。
 */
function applyOf(docWithCursor: string, label: string, runtime: Partial<CompletionRuntime> = {}) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const bundle = collectCompletions(state, pos, {
    mode: 'sql',
    sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
    metadata,
    useHistory: false,
    ...runtime,
  })
  const item = bundle?.options.find(candidate => candidate.label === label)
  const apply = item?.apply
  if (!item || typeof apply !== 'function') {
    return null
  }

  const captured: Array<{ from: number, to: number, insert: string }> = []
  const view = {
    dispatch: (spec: { changes: { from: number, to: number, insert: string } }) => {
      captured.push(spec.changes)
    },
  } as unknown as EditorView
  apply(view, item, pos, pos)
  return { change: captured[0] ?? null, doc }
}

describe('智能项：纯函数', () => {
  it('聚合函数识别（名字 + 左括号才算）', () => {
    expect(containsAggregate('COUNT(*)')).toBe(true)
    expect(containsAggregate('group_concat(name)')).toBe(true)
    expect(containsAggregate('SUM(amount) / COUNT(*)')).toBe(true)
    expect(containsAggregate('name')).toBe(false)
    expect(containsAggregate('counted')).toBe(false)
    expect(containsAggregate('u.amount')).toBe(false)
  })

  it('SELECT 列表里的非聚合列（跳过聚合与表达式）', () => {
    expect(nonAggregateColumnsOf('COUNT(*) AS c, name, u.status, 1 + 1 AS expr'))
      .toEqual([
        { qualifier: '', column: 'name' },
        { qualifier: 'u', column: 'status' },
      ])
  })

  it('列别名会被剥掉（AS 与跟随两种写法）', () => {
    expect(nonAggregateColumnsOf('name AS 名称, u.status st'))
      .toEqual([
        { qualifier: '', column: 'name' },
        { qualifier: 'u', column: 'status' },
      ])
  })

  it('非聚合列去重', () => {
    expect(nonAggregateColumnsOf('name, name')).toEqual([{ qualifier: '', column: 'name' }])
  })

  it('取光标所在层的 SELECT 列表（内层 SELECT 不算外层）', () => {
    // 光标在子查询里：列表文本取自内层 SELECT
    expect(selectListTail('SELECT (SELECT max(')?.text.trim()).toBe('max(')

    // 光标在子查询之外的列表里：外层括号里的 SELECT 不参与
    expect(selectListTail('SELECT a, b, (SELECT max(x) FROM t) ')?.text.trim())
      .toBe('a, b, (SELECT max(x) FROM t)')

    // 顶层 FROM 之前的内容才是列表：FROM 之后的词不算列表项
    expect(selectListTail('SELECT a, b FROM users WHERE ')?.text.trim()).toBe('a, b')
    expect(selectListTail('SELECT a, ')?.text.trim()).toBe('a,')
  })

  it('列表末尾的星号（含限定符）', () => {
    expect(starAtSelectListEnd('* ')).toEqual({ text: '*', qualifier: '', start: 0, end: 1 })
    expect(starAtSelectListEnd('u.*')).toEqual({ text: 'u.*', qualifier: 'u', start: 0, end: 3 })
    expect(starAtSelectListEnd('id, *')).toEqual({ text: '*', qualifier: '', start: 4, end: 5 })
    // 不是纯星号项：聚合里的星号、写了一半的列名
    expect(starAtSelectListEnd('COUNT(*)')).toBeNull()
    expect(starAtSelectListEnd('id, * ')).not.toBeNull()
    expect(starAtSelectListEnd('id, ')).toBeNull()
  })

  it('比较运算右侧的列（含 IN ( 与限定符）', () => {
    expect(comparisonTarget('SELECT * FROM users WHERE name = '))
      .toEqual({ qualifier: '', column: 'name' })
    expect(comparisonTarget('SELECT * FROM users u WHERE u.status <> '))
      .toEqual({ qualifier: 'u', column: 'status' })
    expect(comparisonTarget('SELECT * FROM users WHERE status IN ('))
      .toEqual({ qualifier: '', column: 'status' })
    expect(comparisonTarget('SELECT * FROM users WHERE name LIKE '))
      .toEqual({ qualifier: '', column: 'name' })
    // 不是比较运算：数字、逗号后凭空出现、已写了值
    expect(comparisonTarget('SELECT * FROM users WHERE 1 = ')).toBeNull()
    expect(comparisonTarget('SELECT * FROM users WHERE name = 1 AND ')).toBeNull()
  })

  it('INSERT 的目标表（含限定名）', () => {
    expect(insertTargetTable('INSERT INTO users (')).toEqual({ schema: '', table: 'users' })
    expect(insertTargetTable('INSERT INTO db.users (')).toEqual({ schema: 'db', table: 'users' })
    expect(insertTargetTable('SELECT * FROM users')).toBeNull()
  })

  it('比较值的字面量：数值列裸写，字符串列按方言转义', () => {
    const numeric = smartValueItems([{ value: '1' }], 'int', 'mysql')
    expect(numeric[0]?.apply).toBe('1')

    // 引号双写（两种方言一致）
    expect(smartValueItems([{ value: "it's" }], 'varchar', 'mysql')[0]?.apply).toBe("'it''s'")

    // 反斜杠：MySQL 默认当转义符，PostgreSQL 原样
    expect(smartValueItems([{ value: 'a\\b' }], 'varchar', 'mysql')[0]?.apply).toBe("'a\\\\b'")
    expect(smartValueItems([{ value: 'a\\b' }], 'varchar', 'postgres')[0]?.apply).toBe("'a\\b'")

    // 描述里带来源与释义
    const described = smartValueItems([{ value: '1', meaning: '启用', source: '词典 status' }], 'int', 'mysql')
    expect(described[0]?.detail).toBe('词典 status · 启用')
  })
})

describe('智能项：`*` 展开', () => {
  it('单表：替换星号为列清单', () => {
    const applied = applyOf('SELECT *| FROM users', '*')
    expect(applied?.change).toEqual({ from: 7, to: 8, insert: 'id, name, status' })
  })

  it('多表：每列都带来源限定符', () => {
    const applied = applyOf('SELECT *| FROM users u JOIN orders o ON 1 = 1', '*')
    expect(applied?.change?.insert).toBe('u.id, u.name, u.status, o.id, o.user_id')
  })

  it('`t.*` 连限定符一起替换', () => {
    const applied = applyOf('SELECT u.*| FROM users u', 'u.*')
    expect(applied?.change).toEqual({ from: 7, to: 10, insert: 'id, name, status' })
  })

  it('只在 SELECT 列表里出现（WHERE 位置不打扰）', () => {
    expect(labelsOf('SELECT * FROM users WHERE |')).not.toContain('*')
  })

  it('列表末尾不是星号时不给（列已写出来）', () => {
    expect(labelsOf('SELECT id, | FROM users')).not.toContain('*')
  })
})

describe('智能项：GROUP BY 非聚合列', () => {
  it('推荐 SELECT 里未聚合的列，并给出补齐入口', () => {
    const items = itemsOf('SELECT COUNT(*) AS c, name FROM users GROUP BY |')
    const labels = items.map(item => item.label)
    expect(labels).toContain('补齐非聚合列')
    expect(labels).toContain('name')
    // 聚合列不作为分组列推荐
    expect(labels).not.toContain('c')
    // 推荐列排在普通列之前（boost 更高）
    expect(items.find(item => item.label === 'name')?.boost).toBe(BOOST_SMART_COLUMN)
  })

  it('同一列不会出现两次（推荐列与普通列去重）', () => {
    const labels = labelsOf('SELECT name FROM users GROUP BY |')
    expect(labels.filter(label => label === 'name')).toHaveLength(1)
  })

  it('补齐入口一次插入全部非聚合列', () => {
    const applied = applyOf(
      'SELECT u.name, o.id FROM users u JOIN orders o ON 1 = 1 GROUP BY |',
      '补齐非聚合列',
    )
    expect(applied?.change?.insert).toBe('name, id')
  })

  it('解析不出非聚合列时只保留普通候选', () => {
    expect(labelsOf('SELECT COUNT(*) FROM users GROUP BY |')).not.toContain('补齐非聚合列')
  })
})

describe('智能项：比较值', () => {
  it('比较运算右侧给该列的值域', () => {
    const items = itemsOf('SELECT * FROM users WHERE status = |')
    const labels = items.map(item => item.label)
    expect(labels).toContain('1')
    expect(labels).toContain('0')
    expect(items.find(item => item.label === '1')?.detail).toContain('启用')
  })

  it('限定符指向的列同样命中', () => {
    expect(labelsOf('SELECT * FROM users u WHERE u.status = |')).toContain('1')
  })

  it('没有值域的列不给候选', () => {
    expect(labelsOf('SELECT * FROM users WHERE name = |')).not.toContain('1')
  })

  it('值域候选只在比较运算右侧出现（列名位置不打扰）', () => {
    expect(labelsOf('SELECT * FROM users WHERE |')).not.toContain('启用')
  })
})

describe('智能项：INSERT 列清单', () => {
  it('括号内插入列名清单', () => {
    const applied = applyOf('INSERT INTO users (|', '全部列')
    expect(applied?.change).toEqual({ from: 19, to: 19, insert: 'id, name, status' })
  })

  it('表名之后补上带括号的清单', () => {
    const applied = applyOf('INSERT INTO users |', '全部列')
    expect(applied?.change?.insert).toBe('(id, name, status)')
  })
})

describe('智能项：开关', () => {
  it('smartItems 关掉后不再出现任何智能项', () => {
    const flags = { featureFlags: { smartItems: false } }
    expect(labelsOf('SELECT *| FROM users', flags)).not.toContain('*')
    expect(labelsOf('SELECT * FROM users GROUP BY |', flags)).not.toContain('补齐非聚合列')
    expect(labelsOf('SELECT * FROM users WHERE status = |', flags)).not.toContain('1')
    expect(labelsOf('INSERT INTO users (|', flags)).not.toContain('全部列')
  })

  it('disableSnippets 只关片段型，保留分组列推荐', () => {
    const flags = { featureFlags: { disableSnippets: true } }
    const labels = labelsOf('SELECT name FROM users GROUP BY |', flags)
    expect(labels).toContain('name')
    expect(labels).not.toContain('补齐非聚合列')
    expect(labelsOf('SELECT *| FROM users', flags)).not.toContain('*')
    expect(labelsOf('INSERT INTO users (|', flags)).not.toContain('全部列')
    // 比较值不是片段（只插入一个字面量），不受 disableSnippets 影响
    expect(labelsOf('SELECT * FROM users WHERE status = |', flags)).toContain('1')
  })
})

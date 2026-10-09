/**
 * 表名自动别名（T4）用例：别名推导规则 + 补全里的落地形态。
 *
 * 前半是纯函数（推导规则），后半走 collectCompletions 验证
 * 「什么时候给带别名的候选、插入的文本是什么」。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, MetadataProvider } from '@/utils/sql/sqlCompletion'
import { aliasForTable, aliasedTableText } from '@/utils/sql/sqlTableAlias'

/** 静态元数据：testdb 下三张表 */
const metadata: MetadataProvider = {
  databases: () => ['testdb'],
  tables: (_connId, database) => (database === 'testdb'
    ? ['users', 'order_items', 't_device_info']
    : []),
  columns: () => [{ name: 'id', dataType: 'int', comment: '' }],
}

/** 用 `|` 标记光标位置，返回候选项 */
function itemsOf(docWithCursor: string, runtime: Partial<CompletionRuntime> = {}): Completion[] {
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

/** 候选项 label 列表 */
function labelsOf(docWithCursor: string, runtime: Partial<CompletionRuntime> = {}): string[] {
  return itemsOf(docWithCursor, runtime).map(item => item.label)
}

/** 打开自动别名的开关 */
const ALIAS_ON = { featureFlags: { autoTableAlias: true } }

/** 应用某个候选项，返回它写入的文本 */
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

  const changes: Array<{ from: number, to: number, insert: string }> = []
  const view = {
    state,
    dispatch: (spec: { changes: { from: number, to: number, insert: string } }) => {
      changes.push(spec.changes)
    },
  } as unknown as EditorView

  apply(view, item, pos, pos)
  return changes[0] ?? null
}

describe('自动别名：推导规则', () => {
  it('单个英文词取首字母', () => {
    expect(aliasForTable('users')).toBe('u')
    expect(aliasForTable('orders')).toBe('o')
    expect(aliasForTable('a')).toBe('a')
  })

  it('多词取各词首字母（最多 3 个）', () => {
    expect(aliasForTable('order_items')).toBe('oi')
    expect(aliasForTable('sys_device_info')).toBe('sdi')
    expect(aliasForTable('a_b_c_d_e')).toBe('abc')
  })

  it('驼峰与短横线同样能拆', () => {
    expect(aliasForTable('userProfile')).toBe('up')
    expect(aliasForTable('order-items')).toBe('oi')
  })

  it('去掉常见表前缀', () => {
    expect(aliasForTable('t_user')).toBe('u')
    expect(aliasForTable('tb_device_info')).toBe('di')
    expect(aliasForTable('tbl_order_items')).toBe('oi')
    // 表名就叫 t 时保持原样
    expect(aliasForTable('t')).toBe('t')
  })

  it('中文表名走拼音首字母（单个词取两位）', () => {
    expect(aliasForTable('设备表')).toBe('sb')
    expect(aliasForTable('设备_信息')).toBe('sx')
  })

  it('不会生成非法或需要引用符的别名', () => {
    // 多词里带数字：取首个字符（2024 → 2），整体数字开头再补 t 前缀
    expect(aliasForTable('2024_log')).toBe('t2l')
    // 撞保留字补 _t：`i_n` 的首字母缩写是 `in`（保留字）
    expect(aliasForTable('i_n')).toBe('in_t')
    // 单字母别名不可能撞保留字
    expect(aliasForTable('as')).toBe('a')
    expect(aliasForTable('')).toBe('')
  })

  it('插入文本：表名带引用符、别名不带、中间写 AS', () => {
    expect(aliasedTableText('`users`', 'u')).toBe('`users` AS u')
    // 推导不出别名时不能留下半截 ` AS `
    expect(aliasedTableText('`users`', '')).toBe('`users`')
  })
})

describe('自动别名：开关与位置', () => {
  it('默认关闭：表名原样插入', () => {
    expect(labelsOf('SELECT * FROM |')).toEqual(['users', 'order_items', 't_device_info', 'testdb'])
    expect(applyOf('SELECT * FROM |', 'users')?.insert).toBe('`users`')
  })

  it('开启后：每张表只给一条带别名的候选（不再重复一条不带的）', () => {
    const labels = labelsOf('SELECT * FROM |', ALIAS_ON)
    expect(labels).toContain('users AS u')
    expect(labels).toContain('order_items AS oi')
    expect(labels).toContain('t_device_info AS di')
    // 同一张表不该同时出现「带别名」与「不带别名」两条
    expect(labels).not.toContain('users')
    expect(labels).not.toContain('order_items')

    const items = itemsOf('SELECT * FROM |', ALIAS_ON)
    expect(items.filter(item => item.label.startsWith('users')).map(item => item.label))
      .toEqual(['users AS u'])
    expect(items.find(item => item.label === 'users AS u')?.detail).toContain('自动别名 u')
  })

  it('带别名的候选项一次插入表名、AS 与别名', () => {
    expect(applyOf('SELECT * FROM |', 'users AS u', ALIAS_ON)?.insert).toBe('`users` AS u')
    expect(applyOf('SELECT * FROM |', 'order_items AS oi', ALIAS_ON)?.insert)
      .toBe('`order_items` AS oi')
  })

  it('JOIN 之后同样给别名', () => {
    const labels = labelsOf('SELECT * FROM users u JOIN |', ALIAS_ON)
    expect(labels).toContain('order_items AS oi')
  })

  it('INSERT / UPDATE 之后不给别名（那里写别名是语法错误）', () => {
    const labels = labelsOf('INSERT INTO |', ALIAS_ON)
    expect(labels).toContain('users')
    expect(labels).not.toContain('users AS u')

    const update = labelsOf('UPDATE |', ALIAS_ON)
    expect(update).toContain('users')
    expect(update).not.toContain('users AS u')
  })

  it('列位置不受影响（表候选本来就不在列位置给）', () => {
    const labels = labelsOf('SELECT * FROM users WHERE |', ALIAS_ON)
    expect(labels).not.toContain('users AS u')
  })
})

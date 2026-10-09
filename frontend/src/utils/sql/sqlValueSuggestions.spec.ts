/**
 * 比较位置的值候选（类型感知）用例。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { MetadataProvider } from '@/utils/sql/sqlCompletion'
import { typedValueItems } from '@/utils/sql/sqlValueSuggestions'

/** 候选 label */
function labelsOf(dataType: string | undefined, dialect: 'mysql' | 'postgres' = 'mysql'): string[] {
  return typedValueItems({ column: 'col', dataType, dialect }).map(item => item.label)
}

describe('类型模板候选', () => {
  it('时间列给当前时间与今天零点', () => {
    const labels = labelsOf('datetime')
    expect(labels).toContain('CURRENT_TIMESTAMP')
    expect(labels).toContain('CURRENT_DATE')
    // 今天的零点字面量（按本地日期生成，这里只验证格式）
    expect(labels.some(label => /^\d{4}-\d{2}-\d{2} 00:00:00$/.test(label))).toBe(true)
  })

  it('布尔列按方言给真假值', () => {
    expect(labelsOf('tinyint(1)', 'mysql')).toEqual(['1', '0'])
    expect(labelsOf('boolean', 'postgres')).toEqual(['TRUE', 'FALSE'])
  })

  it('其它类型不给类型模板（不猜）', () => {
    expect(labelsOf('varchar(64)')).toEqual([])
    expect(labelsOf('json')).toEqual([])
    expect(labelsOf(undefined)).toEqual([])
  })

  it('提示里带上列名与真实类型', () => {
    const items = typedValueItems({ column: 'created_at', dataType: 'timestamp', dialect: 'mysql' })
    const current = items.find(item => item.label === 'CURRENT_TIMESTAMP')
    expect(current?.detail).toContain('created_at')
    expect(current?.detail).toContain('timestamp')
  })
})

describe('值域候选优先', () => {
  const values = [
    { value: 'active', meaning: '启用' },
    { value: 'disabled', meaning: '停用' },
  ]

  it('有值域时排在最前，类型模板随后', () => {
    const items = typedValueItems({
      column: 'status',
      dataType: 'tinyint(1)',
      dialect: 'mysql',
      values,
    })
    expect(items.map(item => item.label)).toEqual(['active', 'disabled', '1', '0'])
    // 值域候选带词典释义
    expect(items[0].detail).toContain('启用')
  })

  it('字符串列的值加引号，数值列不加', () => {
    const text = typedValueItems({
      column: 'code',
      dataType: 'varchar(32)',
      dialect: 'mysql',
      values: [{ value: 'A1' }],
    })
    expect(text[0].apply).toBe("'A1'")

    const numeric = typedValueItems({
      column: 'level',
      dataType: 'int',
      dialect: 'mysql',
      values: [{ value: '3' }],
    })
    expect(numeric[0].apply).toBe('3')
  })

  it('没有值域时只按类型给（时间列仍有候选）', () => {
    const items = typedValueItems({ column: 'created_at', dataType: 'date', dialect: 'mysql', values: [] })
    expect(items.map(item => item.label)).toContain('CURRENT_DATE')
  })
})

describe('比较位置的值候选（补全集成）', () => {
  /** events 表：时间列 / 布尔列 / 带词典值域的状态列 */
  const metadata: MetadataProvider = {
    databases: () => ['testdb'],
    tables: () => ['events'],
    columns: () => [
      { name: 'id', dataType: 'bigint', comment: '' },
      { name: 'created_at', dataType: 'datetime', comment: '创建时间' },
      { name: 'enabled', dataType: 'tinyint(1)', comment: '' },
      { name: 'status', dataType: 'varchar(16)', comment: '' },
    ],
    values: (_connId, _database, _table, column) =>
      column === 'status' ? [{ value: 'active', meaning: '启用' }] : [],
  }

  /** 用 `|` 标记光标产出候选 label */
  function labelsOf(docWithCursor: string): string[] {
    const pos = docWithCursor.indexOf('|')
    const doc = docWithCursor.replace('|', '')
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    const bundle = collectCompletions(state, pos, {
      mode: 'sql',
      sql: { connId: 1, database: 'testdb', dbType: 'mysql' },
      metadata,
    })
    return (bundle?.options ?? []).map(item => item.label)
  }

  it('时间列的比较值位置给当前时间', () => {
    const labels = labelsOf('SELECT * FROM events WHERE created_at = |')
    expect(labels).toContain('CURRENT_TIMESTAMP')
    expect(labels.some(label => /^\d{4}-\d{2}-\d{2} 00:00:00$/.test(label))).toBe(true)
  })

  it('布尔列的比较值位置给真假值', () => {
    expect(labelsOf('SELECT * FROM events WHERE enabled = |')).toContain('1')
  })

  it('带值域的列优先给值域里的值', () => {
    // 注意光标在字符串外：字符串里不补全（模板插值除外）
    const labels = labelsOf('SELECT * FROM events WHERE status = |')
    expect(labels).toContain('active')
  })
})

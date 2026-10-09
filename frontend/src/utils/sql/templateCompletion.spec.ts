/**
 * 模板 / 脚本 / 关闭三种模式的补全用例。
 *
 * 与 sqlCompletion.spec.ts 同一套测试工具（EditorState + 静态元数据），
 * 这里聚焦「光标在 `{{ … }}` 内 vs 外」的分派，以及 javascript / none 的边界。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, TemplateVariable } from '@/utils/sql/sqlCompletion'

/** 模板变量（来自模板的变量配置） */
const VARIABLES: TemplateVariable[] = [
  { name: 'device_no' },
  { name: 'start_time', label: '开始时间' },
]

/** 用 `|` 标记光标位置，返回候选 label 列表 */
function labelsOf(docWithCursor: string, runtime: Partial<CompletionRuntime> = {}): string[] {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })

  const bundle = collectCompletions(state, pos, {
    mode: 'sql-template',
    templateVariables: VARIABLES,
    ...runtime,
  })
  return (bundle?.options ?? []).map(item => item.label)
}

describe('sql-template：模板上下文', () => {
  it('引号内的 {{ }} 也走模板候选（不出 SQL 候选）', () => {
    const labels = labelsOf("SELECT * FROM t WHERE name = '{{ | }}'")
    expect(labels).toContain('device_no')
    expect(labels).toContain('quote')
    // 不是 SQL 位置，不该出现 SQL 关键字
    expect(labels).not.toContain('FROM')
  })

  it('{{if }} 等已有关键字时只给变量', () => {
    const labels = labelsOf('SELECT * FROM t WHERE {{if | }}')
    expect(labels).toContain('device_no')
    expect(labels).not.toContain('quote')
  })

  it('{{quote }} 等函数参数位置只给变量', () => {
    const labels = labelsOf('{{quote | }}')
    expect(labels).toContain('device_no')
    expect(labels).not.toContain('upper')
  })

  it('{{else}} / {{end}} 不给候选', () => {
    expect(labelsOf('{{if a}}{{else|}}')).toEqual([])
    expect(labelsOf('{{if a}}{{end|}}')).toEqual([])
  })

  it('变量候选带上展示名与插入行为', () => {
    const pos = '{{ | }}'.indexOf('|')
    const state = EditorState.create({
      doc: '{{  }}',
      extensions: [sql({ dialect: MySQL })],
    })
    const bundle = collectCompletions(state, pos, {
      mode: 'sql-template',
      templateVariables: VARIABLES,
    })
    expect(bundle).not.toBeNull()

    const startTime = bundle?.options.find(item => item.label === 'start_time')
    expect(startTime?.detail).toBe('模板变量 · 开始时间')
    // 用 variable 类型（不新增 type，靠 detail 与 SQL 别名区分）
    expect(startTime?.type).toBe('variable')
  })

  it('光标在 {{ }} 之后的普通 SQL 位置：不出模板变量', () => {
    const labels = labelsOf('SELECT * FROM t WHERE {{ device_no }} AND |')
    expect(labels).not.toContain('device_no')
  })

  it('已闭合的 {{ }} 之后不再当作模板上下文', () => {
    const labels = labelsOf('SELECT * FROM t WHERE {{ device_no }}|')
    expect(labels).not.toContain('device_no')
  })
})

describe('javascript：只给注入的全局标识符', () => {
  const globals = ['variables', 'rows', 'sqlTemplate']

  it('候选只包含注入的全局标识符，不混入 SQL 候选', () => {
    const labels = labelsOf('variables.|', {
      mode: 'javascript',
      sql: undefined,
      scriptGlobals: globals,
    })
    expect(labels).toEqual(globals)
    expect(labels).not.toContain('SELECT')
  })

  it('未登记全局标识符时不返回候选', () => {
    const labels = labelsOf('|', { mode: 'javascript', sql: undefined, scriptGlobals: [] })
    expect(labels).toEqual([])
  })
})

describe('none：完全不补全', () => {
  it('返回 null', () => {
    const doc = 'SELECT * FROM '
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    expect(collectCompletions(state, doc.length, { mode: 'none' })).toBeNull()
  })
})

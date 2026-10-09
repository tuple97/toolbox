/**
 * 模板补全加固（T8）用例：配对平衡检测、块片段、函数文档、else / end 辅助。
 *
 * 两层验证：
 *  - 纯函数（片段范围 / 块栈）：直接构造 EditorState 跑；
 *  - 插入行为：用假 view 接住 dispatch，逐条核对最终写进文档的文本与光标位置。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { CompletionRuntime, TemplateVariable } from '@/utils/sql/sqlCompletion'
import {
  inTemplateFragment,
  readTemplateContext,
  templateBlockStack,
} from '@/utils/sql/sqlTemplateCompletion'
import { shouldTriggerCompletion } from '@/utils/sql/sqlCompletionTrigger'
import type { TriggerFacts } from '@/utils/sql/sqlCompletionTrigger'

/** 模板变量（来自模板的变量配置） */
const VARIABLES: TemplateVariable[] = [
  { name: 'device_no' },
  { name: 'start_time', label: '开始时间' },
]

/** 用 `|` 标记光标位置，建一个编辑器状态 */
function stateOf(docWithCursor: string) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  return { state: EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] }), pos, doc }
}

/** 候选项（模板模式） */
function itemsOf(docWithCursor: string, runtime: Partial<CompletionRuntime> = {}): Completion[] {
  const { state, pos } = stateOf(docWithCursor)
  const bundle = collectCompletions(state, pos, {
    mode: 'sql-template',
    templateVariables: VARIABLES,
    ...runtime,
  })
  return bundle?.options ?? []
}

/** 候选项 label 列表 */
function labelsOf(docWithCursor: string, runtime: Partial<CompletionRuntime> = {}): string[] {
  return itemsOf(docWithCursor, runtime).map(item => item.label)
}

/** 应用某个候选项，返回它写入的文本与替换范围 */
function applyOf(docWithCursor: string, label: string) {
  const { state, pos } = stateOf(docWithCursor)
  const bundle = collectCompletions(state, pos, {
    mode: 'sql-template',
    templateVariables: VARIABLES,
  })
  const item = bundle?.options.find(candidate => candidate.label === label)
  const apply = item?.apply
  if (!item || typeof apply !== 'function') {
    return null
  }

  const changes: Array<{ from: number, to: number, insert: string }> = []
  let anchor = -1
  const view = {
    state,
    dispatch: (spec: {
      changes: { from: number, to: number, insert: string }
      selection: { anchor: number }
    }) => {
      changes.push(spec.changes)
      anchor = spec.selection.anchor
    },
  } as unknown as EditorView

  const word = /[A-Za-z_][\w]*$/.exec(docWithCursor.slice(0, docWithCursor.indexOf('|')))?.[0] ?? ''
  apply(view, item, pos - word.length, pos)
  return { change: changes[0] ?? null, anchor }
}

describe('模板片段：配对平衡与范围检测', () => {
  it('未闭合的片段给出范围与替换起点', () => {
    const { state, pos } = stateOf('{{ | }}')
    const context = readTemplateContext(state, pos)
    expect(context?.fragment).toBe(' ')
    expect(context?.from).toBe(pos)
    expect(context?.openAt).toBe(0)
    // 后面已经有 `}}`：插入时不必再补右括号
    expect(context?.closeAt).toBe(4)
  })

  it('片段还没写闭合括号时 closeAt 为 null', () => {
    const { state, pos } = stateOf('{{ device_no|')
    expect(readTemplateContext(state, pos)?.closeAt).toBeNull()
  })

  it('已闭合的片段之后不算模板上下文', () => {
    const { state, pos } = stateOf('{{ device_no }}|')
    expect(readTemplateContext(state, pos)).toBeNull()
    expect(inTemplateFragment(state, pos)).toBe(false)
  })

  it('长片段也能找到起点（不再受 30 字符回看限制）', () => {
    const { state, pos } = stateOf(`{{ ${'device_no'.repeat(5)}| }}`)
    const context = readTemplateContext(state, pos)
    expect(context?.openAt).toBe(0)
    expect(inTemplateFragment(state, pos)).toBe(true)
  })
})

describe('模板块栈：配对检测', () => {
  it('成对写完后栈为空', () => {
    expect(templateBlockStack('{{if a}} … {{end}}')).toEqual([])
    expect(templateBlockStack('{{range list}}{{.}}{{end}}')).toEqual([])
    expect(templateBlockStack('{{if a}}{{range b}}{{end}}{{end}}')).toEqual([])
  })

  it('未闭合的块留在栈里（栈顶最内层）', () => {
    expect(templateBlockStack('{{if a}}')).toEqual([{ kind: 'if', hasElse: false }])
    expect(templateBlockStack('{{if a}}{{range b}}'))
      .toEqual([{ kind: 'if', hasElse: false }, { kind: 'range', hasElse: false }])
    expect(templateBlockStack('{{with x}}')).toEqual([{ kind: 'with', hasElse: false }])
  })

  it('else 记在所属 if 上', () => {
    expect(templateBlockStack('{{if a}}{{else}}')).toEqual([{ kind: 'if', hasElse: true }])
  })

  it('还没写完的指令不算块（避免 end 提前出现）', () => {
    expect(templateBlockStack('{{if ')).toEqual([])
    expect(templateBlockStack('{{if a')).toEqual([])
  })

  it('多余的 end 不会把栈搞成负数', () => {
    expect(templateBlockStack('{{end}}{{end}}')).toEqual([])
  })
})

describe('模板片段内的触发策略', () => {
  /** 默认事实：打字触发、位置判定不通过（片段内不该受人肉位置判定影响） */
  function facts(overrides: Partial<TriggerFacts> = {}): TriggerFacts {
    return {
      origin: 'typing',
      hasIdentifierPrefix: false,
      qualifierTriggered: false,
      inCommentOrString: false,
      positionalEligible: false,
      ...overrides,
    }
  }

  it('敲下 {{ 的第二半就触发', () => {
    expect(shouldTriggerCompletion(
      facts({ insertedChar: '{', inTemplateFragment: true }),
      'positional',
    )).toBe(true)
  })

  it('引号内的片段同样触发（不受字符串判定影响）', () => {
    expect(shouldTriggerCompletion(
      facts({ insertedChar: 'd', hasIdentifierPrefix: true, inCommentOrString: true, inTemplateFragment: true }),
      'positional',
    )).toBe(true)
  })

  it('字符串内、但不在片段里时不触发', () => {
    expect(shouldTriggerCompletion(
      facts({ insertedChar: 'd', hasIdentifierPrefix: true, inCommentOrString: true }),
      'positional',
    )).toBe(false)
  })

  it('片段内敲空格同样触发（`{{if | }}` 正需要变量候选）', () => {
    expect(shouldTriggerCompletion(
      facts({ insertedChar: ' ', inTemplateFragment: true }),
      'positional',
    )).toBe(true)
  })

  it('片段内粘贴（多字符插入）不触发', () => {
    expect(shouldTriggerCompletion(
      facts({ inTemplateFragment: true }),
      'positional',
    )).toBe(false)
  })

  it('require-prefix 档下片段里也要先敲出字符', () => {
    expect(shouldTriggerCompletion(
      facts({ insertedChar: '{', inTemplateFragment: true }),
      'require-prefix',
    )).toBe(false)
    expect(shouldTriggerCompletion(
      facts({ insertedChar: 'd', hasIdentifierPrefix: true, inTemplateFragment: true }),
      'require-prefix',
    )).toBe(true)
  })
})

describe('块片段：一次插入成对骨架', () => {
  it('if 块：整段替换当前片段，光标落在条件处', () => {
    const applied = applyOf('{{ | }}', 'if 块')
    // 片段连同闭合括号一起被替换
    expect(applied?.change).toEqual({
      from: 0,
      to: 6,
      insert: '{{if }}\n  \n{{end}}',
    })
    // 光标停在 `{{if |}}` 的竖线位置
    expect(applied?.anchor).toBe(5)
  })

  it('骨架按当前行缩进排版', () => {
    const applied = applyOf('  {{ | }}', 'if 块')
    expect(applied?.change?.insert).toBe('{{if }}\n    \n  {{end}}')
  })

  it('range 块带 {{.}} 占位', () => {
    const applied = applyOf('{{ | }}', 'range 块')
    expect(applied?.change?.insert).toBe('{{range }}\n  {{.}}\n{{end}}')
  })

  it('if / else 块带 else 分支', () => {
    const applied = applyOf('{{ | }}', 'if / else 块')
    expect(applied?.change?.insert).toBe('{{if }}\n  \n{{else}}\n  \n{{end}}')
  })

  it('片段里已经写了内容时整段替换（含已写出的 }}）', () => {
    const applied = applyOf('{{ device_no| }}', 'range 块')
    expect(applied?.change?.from).toBe(0)
    expect(applied?.change?.to).toBe(15)
    expect(applied?.change?.insert.startsWith('{{range }}')).toBe(true)
  })
})

describe('函数文档', () => {
  it('自定义函数与内置函数都带签名与用法说明', () => {
    const items = itemsOf('{{ | }}')
    const quote = items.find(item => item.label === 'quote')
    expect(quote?.detail).toBe('quote 值')
    expect(String(quote?.info)).toContain('示例：')
    expect(String(quote?.info)).toContain('quote')

    // 内置函数也在（T8 补的文档）
    const len = items.find(item => item.label === 'len')
    expect(len?.detail).toBe('len 值')
    expect(String(len?.info)).toContain('len')
  })

  it('指令候选带 directive 说明，且不会与 else / end 收尾候选重复', () => {
    const items = itemsOf('{{ | }}')
    expect(items.find(item => item.label === 'if')?.detail).toBe('if 条件')
    // 没有未闭合块时不该出现 else / end
    expect(items.map(item => item.label)).not.toContain('end')
  })

  it('变量参数位置只给变量（连内置函数也不给）', () => {
    const labels = labelsOf('{{if | }}')
    expect(labels).toEqual(['device_no', 'start_time'])
  })
})

describe('else / end 辅助', () => {
  it('片段内：未闭合的 if 给 else 与 end', () => {
    const labels = labelsOf('{{if device_no}}\n  AND x = 1\n{{ | }}')
    expect(labels).toContain('else')
    expect(labels).toContain('end')
  })

  it('片段内：已经有 else 时只给 end', () => {
    const labels = labelsOf('{{if device_no}}{{else}}\n{{ | }}')
    expect(labels).not.toContain('else')
    expect(labels).toContain('end')
  })

  it('片段内：没有未闭合块就不给收尾关键字', () => {
    const labels = labelsOf('{{ | }}')
    expect(labels).not.toContain('end')
    expect(labels).not.toContain('else')
  })

  it('普通位置：未闭合的块给 {{end}} / {{else}} 收尾候选', () => {
    const labels = labelsOf('{{if device_no}}\n  AND x = 1\n|')
    expect(labels).toContain('{{end}}')
    expect(labels).toContain('{{else}}')
  })

  it('普通位置：没有未闭合块时不给收尾候选', () => {
    const labels = labelsOf('{{if device_no}} AND x = 1 {{end}}\n|')
    expect(labels).not.toContain('{{end}}')
  })

  it('收尾候选整条指令一次写出', () => {
    const applied = applyOf('{{if device_no}}\n  AND x = 1\n|', '{{end}}')
    expect(applied?.change).toEqual({ from: 29, to: 29, insert: '{{end}}' })
  })
})

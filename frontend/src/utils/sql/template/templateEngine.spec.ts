/**
 * 模板语言引擎用例：词法 / 语法 / 作用域 / 光标意图 / 候选矩阵。
 *
 * 这些用例覆盖「光标到底处于模板语言的哪个语义位置」的完整矩阵 ——
 * 之前靠字符串前缀猜（第一个词是不是函数名），现在由解析器给出结论。
 *
 * 光标标记用 `§`（`|` 在模板语言里是管道符，不能当标记）。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { collectCompletions } from '@/utils/sql/sqlCompletion'
import type { TemplateVariable } from '@/utils/sql/sqlCompletion'
import { lexTemplateFragment } from '@/utils/sql/template/templateLexer'
import { analyzeTemplateCursor, parseTemplateDocument } from '@/utils/sql/template/templateParser'
import { dotCandidates, scopeFromUnclosedBlocks, scopeSymbols } from '@/utils/sql/template/templateScope'
import type { TemplateBlockNode } from '@/utils/sql/template/templateParser'

const MARK = '§'

/** 用 `§` 标记光标，分析「`{{` 之后到光标」的片段（offset 取 0） */
function analyze(fragmentWithCursor: string) {
  const pos = fragmentWithCursor.indexOf(MARK)
  const fragment = fragmentWithCursor.replace(MARK, '')
  return analyzeTemplateCursor(fragment, 0, pos)
}

/** 解析整段模板文本 */
function parse(text: string) {
  return parseTemplateDocument(text)
}

describe('模板词法：token 类别', () => {
  it('识别标识符、变量、字面量、管道与点号', () => {
    const kinds = lexTemplateFragment('.name $i := "prod" | 42 (len x)', 0)
      .filter(token => token.kind !== 'space')
      .map(token => token.kind)
    expect(kinds).toEqual([
      'dot', 'ident', 'variable', 'assign', 'string', 'pipe', 'number',
      'lparen', 'ident', 'ident', 'rparen',
    ])
  })

  it('token 带上绝对偏移', () => {
    const tokens = lexTemplateFragment('dev', 100)
    expect(tokens[0]).toEqual({ kind: 'ident', text: 'dev', from: 100, to: 103 })
  })
})

describe('模板语法：块配对', () => {
  it('if / range / with 成对后栈为空', () => {
    expect(parse('{{if a}}x{{end}}').unclosedBlocks).toHaveLength(0)
    expect(parse('{{if a}}{{range b}}x{{end}}{{end}}').unclosedBlocks).toHaveLength(0)
  })

  it('未闭合的块按栈返回', () => {
    const blocks = parse('{{if a}}{{range b}}').unclosedBlocks
    expect(blocks.map(block => block.kind)).toEqual(['if', 'range'])
  })

  it('else if 记在所属 if 的分支里，而不是新块', () => {
    const blocks = parse('{{if eq env "prod"}}{{else if eq env "uat"}}').unclosedBlocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0].elseIfs).toHaveLength(1)
    expect(blocks[0].elseIfs[0].name).toBe('eq')
    expect(blocks[0].elseIfs[0].args.map(item => item.text)).toEqual(['env', '"uat"'])
  })

  it('else 标记在所属 if 上', () => {
    const blocks = parse('{{if a}}{{else}}').unclosedBlocks
    expect(blocks[0].hasElse).toBe(true)
  })

  it('range 的 $i / $v 绑定被解析出来', () => {
    const blocks = parse('{{range $i, $v := devices}}').unclosedBlocks
    expect(blocks[0].bindings).toEqual({ index: '$i', item: '$v' })
  })

  it('块的作用对象被解析出来（with 的值 / range 的数组）', () => {
    expect(parse('{{with device}}').unclosedBlocks[0].target).toBe('device')
    expect(parse('{{range device_list}}').unclosedBlocks[0].target).toBe('device_list')
    expect(parse('{{range $i, $v := device_list}}').unclosedBlocks[0].target).toBe('device_list')
  })

  it('正在写的指令不算块', () => {
    expect(parse('{{if ').unclosedBlocks).toHaveLength(0)
    expect(parse('{{if a').unclosedBlocks).toHaveLength(0)
  })
})

describe('模板语法：命令链与参数', () => {
  it('管道切成多个命令', () => {
    const expression = parse('{{ page_size | default "50" }}').expressions[0]
    expect(expression.commands.map(command => command.name)).toEqual(['page_size', 'default'])
    expect(expression.commands[1].args[0].text).toBe('"50"')
    expect(expression.commands[1].piped).toBe(true)
  })

  it('括号内的内容不切分参数', () => {
    const head = parse('{{if gt (len device_list) 0}}x{{end}}').blocks[0].head
    expect(head?.name).toBe('gt')
    expect(head?.args.map(item => item.text)).toEqual(['(len device_list)', '0'])
  })
})

describe('光标意图矩阵', () => {
  it('新表达式', () => {
    expect(analyze(` ${MARK}`).kind).toBe('expression')
  })

  it('正在输入的变量名 / 函数名', () => {
    expect(analyze(` dev${MARK}`).kind).toBe('variable')
    expect(analyze(` dev${MARK}`).prefix).toBe('dev')
  })

  it('函数参数位', () => {
    const context = analyze(` quote ${MARK}`)
    expect(context.kind).toBe('function-argument')
    expect(context.callee).toBe('quote')
  })

  it('块条件位（if / range / with）', () => {
    expect(analyze(`if ${MARK}`).kind).toBe('block-condition')
    expect(analyze(`range ${MARK}`).blockHead).toBe('range')
    expect(analyze(`with ${MARK}`).blockHead).toBe('with')
  })

  it('块条件里已经写了别的函数时仍是条件位', () => {
    const context = analyze(`if eq device_no ${MARK}`)
    expect(context.kind).toBe('block-condition')
    expect(context.activeArgument).toBe(2)
  })

  it('else if 之后是条件位，不是收尾', () => {
    const context = analyze(`else if ${MARK}`)
    expect(context.kind).toBe('block-condition')
  })

  it('else / end 写完时不再给候选', () => {
    expect(analyze(`else${MARK}`).kind).toBe('closing')
    expect(analyze(`end${MARK}`).kind).toBe('closing')
  })

  it('管道段位置', () => {
    expect(analyze(` x | ${MARK}`).kind).toBe('pipeline')
  })

  it('点号取值：当前作用域与限定符', () => {
    const dot = analyze(` .${MARK}`)
    expect(dot.kind).toBe('dot-variable')
    expect(dot.qualifier).toBe('')

    const qualified = analyze(` device.${MARK}`)
    expect(qualified.kind).toBe('dot-variable')
    expect(qualified.qualifier).toBe('device')
  })

  it('替换范围落在正在输入的词上', () => {
    const context = analyze(` device_n${MARK}`)
    expect(context.range).toEqual({ from: 1, to: 9 })
  })
})

describe('模板作用域', () => {
  const variables: TemplateVariable[] = [
    { name: 'device_no', type: 'string' },
    {
      name: 'device',
      type: 'object',
      properties: [{ name: 'name' }, { name: 'id', type: 'number' }],
    },
    { name: 'device_list', type: 'array', elementType: 'object', properties: [{ name: 'code' }] },
  ]

  /** 取未闭合块并折叠作用域 */
  function scopeOf(text: string) {
    const blocks: TemplateBlockNode[] = parse(text).unclosedBlocks
    return scopeFromUnclosedBlocks({ variables }, blocks)
  }

  it('with 让点号指向该变量，属性可枚举', () => {
    const scope = scopeOf('{{with device}}')
    expect(scope.dot?.name).toBe('device')
    expect(dotCandidates(scope, '').map(property => property.name)).toEqual(['name', 'id'])
  })

  it('range 让点号指向元素，元素属性按声明推导', () => {
    const scope = scopeOf('{{range $i, $v := device_list}}')
    expect(scope.dot?.name).toBe('$v')
    expect(dotCandidates(scope, 'device_list').map(property => property.name)).toEqual(['code'])
  })

  it('range 的局部变量只在自己的块内可见', () => {
    const inner = scopeOf('{{range $i, $v := device_list}}')
    expect(scopeSymbols(inner).map(symbol => symbol.name)).toContain('$i')
    expect(scopeSymbols(inner).map(symbol => symbol.name)).toContain('$v')

    const outer = scopeOf('{{if device_no}}')
    expect(scopeSymbols(outer).map(symbol => symbol.name)).not.toContain('$i')
  })
})

describe('模板候选矩阵（集成）', () => {
  /** 用 `§` 标记光标产出候选 label */
  function labelsOf(docWithCursor: string, variables: TemplateVariable[] = []): string[] {
    const pos = docWithCursor.indexOf(MARK)
    const doc = docWithCursor.replace(MARK, '')
    const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
    const bundle = collectCompletions(state, pos, { mode: 'sql-template', templateVariables: variables })
    return (bundle?.options ?? []).map(item => item.label)
  }

  const variables: TemplateVariable[] = [
    { name: 'device_no' },
    {
      name: 'device',
      type: 'object',
      properties: [{ name: 'name' }, { name: 'id' }],
    },
    { name: 'device_list', type: 'array' },
  ]

  it('新表达式给变量 + 函数 + 指令 + 块片段 + 点号', () => {
    const labels = labelsOf(`{{ ${MARK} }}`, variables)
    expect(labels).toContain('device_no')
    expect(labels).toContain('quote')
    expect(labels).toContain('if')
    expect(labels).toContain('if 块')
    expect(labels).toContain('.')
  })

  it('参数位只给值（变量与局部变量），不给函数名', () => {
    const labels = labelsOf(`{{ quote ${MARK} }}`, variables)
    expect(labels).toEqual(['device_no', 'device', 'device_list'])
  })

  it('块条件位给变量与局部变量', () => {
    const labels = labelsOf(`{{if ${MARK} }}`, variables)
    expect(labels).toEqual(['device_no', 'device', 'device_list'])

    const withLocal = labelsOf(`{{range $i, $v := device_list}}{{if ${MARK} }}`, variables)
    expect(withLocal).toContain('$i')
    expect(withLocal).toContain('$v')
  })

  it('点号位置给作用域里对象的字段', () => {
    const labels = labelsOf(`{{with device}}{{ .${MARK} }}`, variables)
    expect(labels).toEqual(['name', 'id'])
  })

  it('点号位置拿不到字段信息时回退给变量列表', () => {
    const labels = labelsOf(`{{with device_no}}{{ .${MARK} }}`, variables)
    expect(labels).toContain('device_no')
  })

  it('管道段给可按管道的函数', () => {
    const labels = labelsOf(`{{ page_size | ${MARK} }}`, variables)
    expect(labels).toContain('default')
    // 块指令不能接在管道右侧
    expect(labels).not.toContain('if')
  })

  it('字符串里的插值同样是模板区域', () => {
    const labels = labelsOf(`WHERE name = '{{ dev${MARK} }}'`, variables)
    expect(labels).toContain('device_no')
  })
})

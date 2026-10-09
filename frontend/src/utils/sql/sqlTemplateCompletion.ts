/**
 * 模板（`{{ … }}`）与 JavaScript 脚本两种模式的补全。
 *
 * ## 分层
 *
 * ```
 *   templateRegion   → 区域定位（`{{` / `}}` 配对，与 SQL 的字符串无关）
 *   templateLexer    → token 化
 *   templateParser   → 块配对 + 命令链 + 光标「语义意图」
 *   templateScope    → with / range / $局部变量的作用域
 *   templateFunctions→ 函数规格（参数类型 / 块要求 / 文档）
 *   本文件           → 由「意图 + 作用域」产出候选与插入行为
 * ```
 *
 * 候选不再靠「片段里第一个词是不是函数名」这类字符串猜测：
 * 光标意图由解析器给出（`TemplateCursorContext.kind`），作用域决定
 * `.` 与变量列表该有哪些内容，两者拼起来就是候选集合。
 */
import type { Completion } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { inLiteralOrComment } from '@/utils/sql/sqlSyntax'
import { BOOST_CLAUSE_KEYWORD } from './sqlCompletionKeywords'
import type { CompletionBundle, TemplateVariable } from './sqlCompletion'
import {
  TEMPLATE_FUNCTION_SPECS,
  expectedArgumentType,
  templateFunctionSpec,
} from './template/templateFunctions'
import type { TemplateFunctionSpec, TemplateValueType } from './template/templateFunctions'
import { parseTemplateDocument } from './template/templateParser'
import type { TemplateBlockNode, TemplateCursorContext } from './template/templateParser'
import { analyzeTemplateCursor } from './template/templateParser'
import { templateRegionAt } from './template/templateRegion'
import { dotCandidates, scopeFromUnclosedBlocks, scopeSymbols } from './template/templateScope'
import type { TemplateProperty, TemplateSymbol } from './template/templateScope'
import {
  normalizePlaceholderGroups,
  planTemplateInsert,
  setTemplatePlaceholders,
} from './template/templatePlaceholder'
import { SQL_SNIPPETS } from './sqlSnippets'
import type { SqlSnippet } from './sqlSnippets'

/** 光标所在的模板片段 */
export interface TemplateContext {
  /** `{{` 之后到光标之间的文本 */
  fragment: string
  /** 候选替换起点（当前正在输入的变量名/函数名的词首） */
  from: number
  /** `{{` 在文档中的下标（块片段要整段替换，需要它） */
  openAt: number
  /** 片段的闭合 `}}` 下标；为 null 表示片段还没闭合（正在写） */
  closeAt: number | null
  /** 解析出的语义意图（光标在模板语言里的位置类别） */
  cursor: TemplateCursorContext
  /** 到光标为止未闭合的块（栈顶最后） */
  unclosedBlocks: TemplateBlockNode[]
}

/**
 * 检测光标是否位于模板片段内，并解析出上下文。
 *
 * 区域判定只看 `{{` / `}}` 的先后，因此 `'{{ device_no }}'` 这种写在 SQL
 * 字符串里的插值同样是模板区域 —— 这是混合语言的结构事实，不靠调用顺序兜底。
 */
export function readTemplateContext(state: EditorState, pos: number): TemplateContext | null {
  const doc = state.doc.toString()
  const region = templateRegionAt(doc, pos)
  if (!region) {
    return null
  }

  // 片段文本只取到光标：候选前缀与替换范围都在它里面
  const fragment = doc.slice(region.bodyFrom, pos)
  const cursor = analyzeTemplateCursor(fragment, region.bodyFrom, pos)
  const unclosedBlocks = parseTemplateDocument(doc.slice(0, pos)).unclosedBlocks

  return {
    fragment,
    from: cursor.range.from,
    openAt: region.openAt,
    closeAt: region.closeAt,
    cursor,
    unclosedBlocks,
  }
}

/**
 * 光标是否处于模板片段内（触发策略要用）。
 *
 * 与补全的分派一致：`'{{ device_no }}'` 这类引号内插值是最常见的写法，
 * 不能被「字符串里不弹」的判定拦掉。
 */
export function inTemplateFragment(state: EditorState, pos: number): boolean {
  return templateRegionAt(state.doc.toString(), pos) !== null
}

// ---------------------------------------------------------------- 块栈

/** 一个未闭合的模板块 */
export interface TemplateBlock {
  kind: 'if' | 'range' | 'with'
  /** 该 if 块是否已经有 else（模板语法里 if 只能有一个 else） */
  hasElse: boolean
}

/**
 * 扫描到文本末尾为止的块栈（栈顶是最内层未闭合的块）。
 *
 * 只统计**已经写完整**的指令（形如 `{{if …}}`，必须有闭合的 `}}`）：
 * 光标处正在写的 `{{if ` 还没成为块，不该让 `end` 提前出现。
 * `{{else if …}}` 计入所属 if 的分支，不会被当成新的块。
 */
export function templateBlockStack(text: string): TemplateBlock[] {
  return parseTemplateDocument(text).unclosedBlocks.map(block => ({
    kind: block.kind,
    hasElse: block.hasElse || block.elseIfs.length > 0,
  }))
}

// ---------------------------------------------------------------- 候选

/**
 * 模板候选：按光标意图决定给什么。
 *
 * | 意图 | 候选 |
 * |---|---|
 * | `expression` / `variable` | 变量 + 局部变量 + `.` + 函数 / 指令 + 块片段 + 收尾关键字 |
 * | `block-condition` | 条件用的变量与局部变量（不给函数名，避免写进条件位） |
 * | `function-argument` | 变量与局部变量（值） |
 * | `pipeline` | 可接在管道右侧的函数 + 变量 |
 * | `dot-variable` | 当前作用域 `.` 的属性（拿不到属性时回退到变量） |
 * | `closing` | 无（`{{else}}` / `{{end}}` 已经写完） |
 */
export function templateBundle(
  context: TemplateContext,
  variables: TemplateVariable[],
  /** 兼容旧调用：未传时用 context 里解析出的块栈 */
  blocks: TemplateBlock[] = [],
): CompletionBundle | null {
  const cursor = context.cursor
  if (cursor.kind === 'closing') {
    return null
  }

  const scope = scopeFromUnclosedBlocks({ variables }, context.unclosedBlocks)
  const symbols = scopeSymbols(scope).filter(symbol => !symbol.name.startsWith('$'))
  const locals = scopeSymbols(scope).filter(symbol => symbol.name.startsWith('$'))

  let options: Completion[] = []

  switch (cursor.kind) {
    case 'dot-variable': {
      const properties = dotCandidates(scope, cursor.qualifier)
      options = properties.length
        ? propertyOptions(properties)
        // 没有属性信息时回退到变量列表：宁可给「可能相关的变量」，
        // 也不要因为元数据缺失让这个位置什么都不弹
        : variableOptions(symbols)
      break
    }
    case 'block-condition':
    case 'function-argument': {
      options = [
        ...variableOptions(symbols),
        ...variableOptions(locals, '局部变量'),
        // 已经在打字时把片段候选也带上：`{{if` / `{{quote` 打到一半正是想要那个片段，
        // 这时变量往往一个都匹配不上，不给片段列表的话整个候选会关掉
        ...snippetOptions(context),
      ]
      options = rankByExpectedType(options, cursor)
      break
    }
    case 'pipeline': {
      options = [
        ...functionOptions('pipeline'),
        ...variableOptions(symbols),
      ]
      break
    }
    default: {
      // 新表达式 / 正在打名字：变量最常用，放最前
      options = [
        ...variableOptions(symbols),
        ...variableOptions(locals, '局部变量'),
        ...dotOption(scope.dot),
        ...functionOptions('all'),
        ...blockSnippetOptions(context),
        ...snippetOptions(context),
        ...closingWordOptions(context.unclosedBlocks, blocks),
      ]
      break
    }
  }

  return options.length ? { from: context.from, options, contextKind: 'template' } : null
}

/** 变量候选项（type 用 variable，靠 detail 区分来源与类型） */
function variableOptions(symbols: TemplateSymbol[], origin = '模板变量'): Completion[] {
  return symbols.map(symbol => ({
    label: symbol.name,
    type: 'variable' as const,
    detail: `${origin}${detailSuffix(symbol)}`,
    info: symbol.label ? `${origin}：${symbol.label}` : undefined,
    apply: templateApply(symbol.name),
  }))
}

/**
 * `.` 候选：当前作用域指向的值。
 *
 * 作用域里没有具体指向时（例如表达式开头）也给：`.` 始终表示
 * 「当前数据上下文」，写法上是合法的，只是没有字段可枚举。
 */
function dotOption(dot: TemplateSymbol | null): Completion[] {
  return [{
    label: '.',
    type: 'variable' as const,
    detail: `当前作用域${dot ? detailSuffix(dot) : '取值'}`,
    info: dot?.properties?.length
      ? `可用字段：${dot.properties.map(item => item.name).join('、')}`
      : '表示当前作用域指向的值（with 的对象 / range 的元素）',
    apply: templateApply('.'),
  }]
}

/** 对象属性候选（`.字段`） */
function propertyOptions(properties: TemplateProperty[]): Completion[] {
  return properties.map(property => ({
    label: property.name,
    type: 'property' as const,
    detail: `${typeLabel(property.type)}${property.comment ? ` · ${property.comment}` : ''}`,
    info: property.comment,
    apply: templateApply(property.name),
  }))
}

/** 变量 / 属性的 detail 后缀（类型与展示名） */
function detailSuffix(symbol: TemplateSymbol): string {
  const parts = [typeLabel(symbol.type), symbol.label].filter(Boolean)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

/** 类型的中文名 */
function typeLabel(type: TemplateValueType | undefined): string {
  switch (type) {
    case 'string': return '字符串'
    case 'number': return '数字'
    case 'boolean': return '布尔'
    case 'array': return '数组'
    case 'object': return '对象'
    default: return ''
  }
}

/**
 * 按「当前参数位期望的类型」调整候选权重。
 *
 * 类型匹配的候选顶到前面（例如 `{{ len | }}` 优先数组 / 字符串），
 * 不匹配的不删除 —— 模板语言本身不严格，删掉反而会挡住用户。
 */
function rankByExpectedType(options: Completion[], cursor: TemplateCursorContext): Completion[] {
  const expected = expectedArgumentType(cursor.callee, cursor.activeArgument)
  if (expected === 'any' || expected === 'unknown') {
    return options
  }
  return [...options].sort((left, right) => {
    const leftHit = left.detail?.includes(typeLabel(expected)) ? 1 : 0
    const rightHit = right.detail?.includes(typeLabel(expected)) ? 1 : 0
    return rightHit - leftHit
  })
}

/** 函数 / 指令候选项（`pipeline` 只给适合接在管道右侧的普通函数） */
function functionOptions(mode: 'all' | 'pipeline'): Completion[] {
  return Object.values(TEMPLATE_FUNCTION_SPECS)
    .filter(spec => mode === 'all' || spec.kind === 'function')
    .map(spec => ({
      label: spec.name,
      type: spec.kind === 'directive' ? 'keyword' as const : 'function' as const,
      detail: spec.signature,
      info: functionInfo(spec),
      apply: templateApply(spec.name, spec.trailingSpace ? ' ' : ''),
    }))
}

/** 提示面板里的文档文本（编辑器用 pre-line 渲染，换行即可读） */
function functionInfo(spec: TemplateFunctionSpec): string {
  const argument = spec.args.length
    ? `参数：${spec.args.map(item => `${item.name}（${typeLabel(item.type) || '任意'}${item.optional ? '，可省略' : ''}）`).join('、')}`
    : ''
  return [spec.description, argument, `示例：${spec.example}`].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------- 块片段

/** 块片段定义：一次插入成对骨架，光标落在条件处 */
interface BlockSnippet {
  label: string
  detail: string
  /** 块头（`if` / `range` / `with`） */
  open: string
  /** 块体首行内容 */
  body: string
  /** 是否带 else 分支 */
  withElse: boolean
}

const BLOCK_SNIPPETS: BlockSnippet[] = [
  { label: 'if 块', detail: '插入 {{if}} … {{end}} 骨架', open: 'if', body: '', withElse: false },
  { label: 'if / else 块', detail: '插入带 {{else}} 分支的条件块', open: 'if', body: '', withElse: true },
  { label: 'range 块', detail: '插入 {{range}} … {{end}} 骨架（块内 {{.}} 为当前元素）', open: 'range', body: '{{.}}', withElse: false },
  { label: 'with 块', detail: '插入 {{with}} … {{end}} 骨架（块内可直接用 {{.字段}}）', open: 'with', body: '', withElse: false },
]

/**
 * 整段替换型候选：替换的是**整个** `{{ … }}`，与「正在输入的名字」无关。
 *
 * 因此它不参与「已输入前缀」的过滤（见 sqlCompletion 的 finalizeBundle）——
 * 用户已经在片段里写了内容（`{{ 设备号| }}`）时，整段替换的入口不该整批消失。
 */
export interface FragmentActionCompletion extends Completion {
  /** 忽略「已输入前缀」的过滤，始终留在候选里 */
  alwaysOffered?: true
}

/**
 * 块片段候选：整段替换当前 `{{ … }}`，插入可用的成对骨架。
 *
 * 光标停在块头条件处，接着输入第一个字符就会拿到该块作用域内的变量候选
 * （触发与普通补全走同一条路，不额外制造时序耦合）。
 */
function blockSnippetOptions(context: TemplateContext): FragmentActionCompletion[] {
  return BLOCK_SNIPPETS.map(snippet => ({
    label: snippet.label,
    type: 'text' as const,
    detail: snippet.detail,
    info: `用法示例：${snippet.open === 'if'
      ? '{{if 变量}} AND 条件 = {{变量}} {{end}}'
      : `{{${snippet.open} 变量}} … {{end}}`}`,
    apply: blockApply(context, snippet),
    alwaysOffered: true,
  }))
}

/** 当前行的缩进（含它所在的换行符之后的空白） */
function indentAt(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos)
  return /^[\t ]*/.exec(line.text)?.[0] ?? ''
}

/**
 * 块片段的插入：把整个 `{{ … }}`（含已写出的闭合括号）换成成对骨架。
 *
 * 骨架按当前行缩进排版，光标落在块头条件处（`{{if |}}`），
 * 并把「条件位 → 块体行首」登记成占位链：按 Tab 就能依次跳过，
 * 不必用鼠标点回去（占位随编辑漂移，见 templatePlaceholder）。
 */
function blockApply(context: TemplateContext, snippet: BlockSnippet) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const state = view.state
    const indent = indentAt(state, context.openAt)
    // 片段里已经写了内容（如 `{{if x}}` 再改成 `range 块`）时，整段替换
    const start = context.openAt
    const end = context.closeAt === null ? to : context.closeAt + 2

    const head = `{{${snippet.open} }}`
    const lines: string[] = [head, `${indent}  ${snippet.body}`]
    if (snippet.withElse) {
      lines.push(`${indent}{{else}}`, `${indent}  `)
    }
    lines.push(`${indent}{{end}}`)

    const insert = lines.join('\n')
    // 光标停在块头条件处（`{{if |}}` 的竖线位置，也就是 head 里 `}}` 之前）
    const caret = start + head.length - 2
    // 块体行首（`head` + 换行 + 缩进 + 两格）
    const bodyCaret = start + head.length + 1 + indent.length + 2

    view.dispatch({
      changes: { from: start, to: end, insert },
      selection: { anchor: caret },
      // 条件位与块体行首都是「空位置」：没有名字，只作为 Tab / 回车的跳转目标
      effects: setTemplatePlaceholders.of(normalizePlaceholderGroups([
        { name: '', ranges: [{ from: caret, to: caret }] },
        { name: '', ranges: [{ from: bodyCaret, to: bodyCaret }] },
      ])),
    })
  }
}

// ---------------------------------------------------------------- 片段库候选

/**
 * 片段库候选（`SQL_SNIPPETS`）。
 *
 * 只在**已经开始打字**（prefix 非空）时给：空前缀下把整个片段库倒进列表会淹没
 * 变量与函数候选。片段名本来就以触发词开头（`if 条件拼接`、`quote 安全加引号`），
 * `{{if` / `{{quote` 会自然命中，因此不需要再维护一份「触发词」表 ——
 * 片段库加一条，这里自动多一条候选。
 */
function snippetOptions(context: TemplateContext): Completion[] {
  if (!context.cursor.prefix) {
    return []
  }
  return SQL_SNIPPETS.map(snippet => ({
    label: snippet.name,
    type: 'text' as const,
    detail: `片段 · ${snippet.category}`,
    info: `${snippet.description}\n用法示例：${snippet.example}`,
    apply: snippetApply(context, snippet),
  }))
}

/**
 * 片段插入：把光标所在的整个 `{{ … }}` 换成片段内容（片段自带 `{{ }}`），
 * 并把片段里的占位变量做成多选、登记成占位链 —— 插入后直接改名，回车跳下一个变量。
 */
function snippetApply(context: TemplateContext, snippet: SqlSnippet) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const start = context.openAt
    const end = context.closeAt === null ? to : context.closeAt + 2
    const plan = planTemplateInsert(snippet.code, start, end)
    view.dispatch({
      changes: plan.changes,
      selection: plan.selection,
      effects: plan.effects,
      scrollIntoView: true,
    })
  }
}

/**
 * 片段内的收尾关键字：`else` / `end`。
 *
 * 按未闭合块栈决定：最内层是 if 且还没有 else / else-if 才给 `else`；
 * 有未闭合块才给 `end`。
 */
function closingWordOptions(
  unclosed: TemplateBlockNode[],
  blocks: TemplateBlock[] = [],
): Completion[] {
  // blocks 参数是旧调用留下的兼容入口（未传 unclosed 时用它的层数）
  const depth = unclosed.length || blocks.length
  if (!depth) {
    return []
  }

  const top = unclosed.length
    ? { kind: unclosed[unclosed.length - 1].kind, hasElse: unclosed[unclosed.length - 1].hasElse || unclosed[unclosed.length - 1].elseIfs.length > 0 }
    : blocks[blocks.length - 1]

  const options: Completion[] = []
  if (top.kind === 'if' && !top.hasElse) {
    options.push({
      label: 'else',
      type: 'keyword',
      detail: `否则分支（闭合第 ${depth} 层 if）`,
      info: '用法：{{if 条件}} … {{else}} … {{end}}',
      apply: templateApply('else'),
    })
    // `else if` 是同一层 if 的另一个条件分支，比 else 更常用，单独给一条
    options.push({
      label: 'else if',
      type: 'keyword',
      detail: `同级条件分支（第 ${depth} 层 if）`,
      info: '用法：{{if 条件A}} … {{else if 条件B}} … {{else}} … {{end}}',
      apply: templateApply('else if', ' '),
    })
  }
  options.push({
    label: 'end',
    type: 'keyword',
    detail: `闭合第 ${depth} 层 ${top.kind} 块`,
    info: '用法：与最近的 {{if}} / {{range}} / {{with}} 配对',
    apply: templateApply('end'),
  })
  return options
}

/**
 * 普通位置（不在片段内）的收尾候选：直接给 `{{else}}` / `{{end}}`。
 *
 * 光标所在行的缩进已经写在光标左边，这里只补指令本身，
 * 所以插到空行上会自然对齐。
 */
export function templateClosingItems(state: EditorState, pos: number): Completion[] {
  const before = state.doc.sliceString(0, pos)
  const stack = parseTemplateDocument(before).unclosedBlocks
  if (!stack.length) {
    return []
  }

  const top = stack[stack.length - 1]
  const items: Completion[] = []
  const hasElseBranch = top.hasElse || top.elseIfs.length > 0
  if (top.kind === 'if' && !hasElseBranch) {
    items.push(closingItem('{{else}}', '{{else}}',
      '补上否则分支', '用法：{{if 条件}} … {{else}} … {{end}}'))
  }
  items.push(closingItem('{{end}}', '{{end}}',
    `闭合最近的 ${top.kind} 块（还有 ${stack.length} 层未闭合）`,
    '用法：与最近的 {{if}} / {{range}} / {{with}} 配对'))
  return items
}

/** 普通位置的收尾候选（整条指令一次性写出） */
function closingItem(label: string, insert: string, detail: string, info: string): Completion {
  return {
    label,
    type: 'keyword',
    // 低于子句关键字：模板里的 SQL 候选仍然优先，收尾是顺手一用
    boost: BOOST_CLAUSE_KEYWORD - 5,
    detail,
    info,
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      })
    },
  }
}

/**
 * 模板候选的插入行为：
 *  - 光标后已有 `}}`（允许中间有空白）→ 只插名字，不重复补闭合；
 *  - 否则补上 ` }}`，光标停在 `}}` 之前，方便继续输入。
 */
function templateApply(name: string, suffix = '') {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const doc = view.state.doc
    const after = doc.sliceString(to, Math.min(to + 3, doc.length))
    const closed = /^\s*\}\}/.test(after)
    // 片段已经闭合就只插名字；否则顺手补上右括号（片段正在写）
    const insert = closed ? `${name}${suffix}` : `${name}${suffix}}}`

    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + name.length + suffix.length },
    })
  }
}

/**
 * 脚本模式：注入的全局标识符（variables / rows / sqlTemplate …）。
 */
export function scriptBundle(
  state: EditorState,
  pos: number,
  globals: string[],
): CompletionBundle | null {
  // 字符串 / 注释里不打扰（lang-javascript 的节点名与 SQL 一致）
  if (inLiteralOrComment(state, pos)) {
    return null
  }
  if (!globals.length) {
    return null
  }

  const line = state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0] ?? ''

  return {
    from: pos - word.length,
    options: globals.map(name => ({
      label: name,
      type: 'variable',
      detail: '脚本变量',
    })),
    contextKind: 'script',
  }
}

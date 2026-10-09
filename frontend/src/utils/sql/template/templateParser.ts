/**
 * 模板片段的语法分析。
 *
 * 两件事：
 *  1. **文档级**：配对全部 `{{if}} / {{range}} / {{with}} / {{else if}} / {{else}} / {{end}}`，
 *     得到块树与「到某处为止仍未闭合的块栈」；
 *  2. **光标级**：把光标所在的片段切成「命令链 + 参数」，给出它在模板语言里的**语义意图**
 *     （新表达式 / 变量名 / 参数位 / 块条件 / 管道段 / 点号取值 / 收尾关键字）。
 *
 * 有了意图，候选生成就不用再靠「第一个词是不是函数名」这种字符串猜测。
 */
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { lexTemplateFragment, wordBefore } from './templateLexer'
import type { TemplateToken } from './templateLexer'
import { templateFunctionSpec } from './templateFunctions'
import { scanTemplateRegions } from './templateRegion'

// ---------------------------------------------------------------- 结构模型

/**
 * 收尾关键字：不出现在函数规格表里，但同样是模板语言的关键字。
 *
 * 单独列在这里是为了让「哪些词是关键字」只有一处定义 —— 解析、收尾候选、
 * 占位符提取（`else` / `end` 不是占位变量）都读它。
 */
export const TEMPLATE_CLOSING_KEYWORDS: ReadonlySet<string> = new Set(['else', 'end'])

/** 该名字是不是模板语言的关键字（收尾词或函数 / 指令表中的名字） */
export function isTemplateKeyword(name: string): boolean {
  const lower = name.toLowerCase()
  return TEMPLATE_CLOSING_KEYWORDS.has(lower) || templateFunctionSpec(lower) !== undefined
}

/** 一个参数（顶层空格分隔；括号内的整体算一个） */
export interface TemplateArgument {
  text: string
  from: number
  to: number
  /** 在命令里的序号（从 0 开始） */
  index: number
}

/** 一个命令（表达式本体或管道中的一段） */
export interface TemplateCommand {
  /** 命令名（首个标识符；点号取值 / 字面量开头时为空串） */
  name: string
  nameFrom: number
  nameTo: number
  args: TemplateArgument[]
  from: number
  to: number
  /** 是否位于管道右侧（`|` 之后） */
  piped: boolean
}

/** 一段表达式（一个区域内按 `|` 切分出的命令链） */
export interface TemplateExpression {
  from: number
  to: number
  commands: TemplateCommand[]
}

/** 一个块节点 */
export interface TemplateBlockNode {
  kind: 'if' | 'range' | 'with'
  from: number
  to: number
  /** 块头命令（`{{if 条件}}` 里的「条件」部分） */
  head: TemplateCommand | null
  /**
   * 块的作用对象（with 的值 / range 的数组）。
   *
   * 作用域据此推导 `.` 指向谁：`{{with device}}` → device，
   * `{{range $i, $v := device_list}}` → device_list。
   */
  target: string
  /** 是否已经有 else 分支 */
  hasElse: boolean
  /** `{{else if 条件}}` 的分支条件 */
  elseIfs: TemplateCommand[]
  /** range 的变量绑定（`{{range $i, $v := 数组}}`） */
  bindings: { index?: string, item?: string }
  closed: boolean
}

/** 整个文档的解析结果 */
export interface TemplateDocument {
  expressions: TemplateExpression[]
  blocks: TemplateBlockNode[]
  /** 到文档末尾仍未闭合的块（栈顶最后） */
  unclosedBlocks: TemplateBlockNode[]
}

// ---------------------------------------------------------------- 光标意图

/** 光标在模板语言里的语义意图 */
export type TemplateCursorKind =
  /** 新表达式的开头（`{{ | }}`）：变量 / 函数 / 指令 / 块片段都能给 */
  | 'expression'
  /** 正在输入的变量名或函数名（`{{ dev| }}`） */
  | 'variable'
  /** 函数参数位（`{{ quote | }}`）：只给变量 / 值 */
  | 'function-argument'
  /** 块条件位（`{{if | }}`、`{{else if | }}`） */
  | 'block-condition'
  /** 管道段位置（`{{ 变量 | | }}`）：给可接在管道右侧的函数 */
  | 'pipeline'
  /** 点号取值（`{{ .| }}`、`{{ device.| }}`） */
  | 'dot-variable'
  /** 收尾关键字（`{{else}}` / `{{end}}`）已写完 */
  | 'closing'
  /** 判不出 */
  | 'unknown'

/** 光标处的模板语义上下文 */
export interface TemplateCursorContext {
  kind: TemplateCursorKind
  /** 正在输入的词（没有则为空串） */
  prefix: string
  /** 统一替换范围（永远是词的范围，取不到就是光标位置） */
  range: TextRange
  /** 片段文本（`{{` 之后到光标） */
  fragment: string
  openAt: number
  closeAt: number | null
  /** 命令链（下标 0 是表达式本体，之后是管道段） */
  commands: TemplateCommand[]
  /** 光标所在命令在命令链中的下标 */
  activeCommand: number
  /** 光标所在命令里已写出的参数个数 */
  activeArgument: number
  /** 光标所在命令的名字（if / quote / 空） */
  callee: string
  /** 点号取值时的限定符链（`device.` → device；`.` → 空串） */
  qualifier: string
  /** 是否处于点号取值位 */
  dot: boolean
  /** 块头指令名（处于块条件位时是 if / range / with，否则空串） */
  blockHead: string
}

// ---------------------------------------------------------------- 文档解析

/**
 * 解析整段模板文本。
 *
 * @param text   模板文本（也可以是包含模板的整段 SQL）
 * @param offset 文本在文档中的起始下标（默认 0）
 */
export function parseTemplateDocument(text: string, offset = 0): TemplateDocument {
  const document: TemplateDocument = { expressions: [], blocks: [], unclosedBlocks: [] }
  const stack: TemplateBlockNode[] = []

  for (const region of scanTemplateRegions(text, 0, text.length)) {
    const bodyFrom = region.bodyFrom - offset
    const bodyTo = (region.closeAt === null ? text.length : region.closeAt) - offset
    const body = text.slice(bodyFrom, bodyTo)
    const tokens = lexTemplateFragment(body, offset + bodyFrom)
    /*
     * 空白 token 必须留着：参数是按顶层空格切分的，提前滤掉会让
     * `gt (len a) 0` 这类指令粘成一团。`words` 只用于判断头部关键字。
     */
    const spaced = tokens.filter(token => token.kind !== 'unknown')
    const words = spaced.filter(token => token.kind !== 'space')
    const head = words[0]
    /** 取头部关键字之后的全部 token（含空白） */
    const after = (token: TemplateToken) => spaced.filter(item => item.from >= token.to)

    /*
     * 未闭合的区域（`{{if ` 正在写）：它还不是一条完整指令，
     * 不参与块配对 —— 否则 `end` 会在条件都还没写完时提前出现。
     */
    if (region.closeAt === null) {
      continue
    }

    const name = head?.kind === 'ident' ? head.text.toLowerCase() : ''

    if (name === 'end') {
      const open = stack.pop()
      if (open) {
        open.closed = true
        open.to = region.to
      }
      continue
    }

    if (TEMPLATE_CLOSING_KEYWORDS.has(name)) {
      const current = stack[stack.length - 1]
      if (!current) {
        continue
      }
      // `{{else if 条件}}` 是与 else 同级的条件分支，不是普通内容
      const second = words[1]
      if (second?.kind === 'ident' && second.text.toLowerCase() === 'if') {
        const condition = commandOf(after(second))
        if (condition) {
          current.elseIfs.push(condition)
        }
        continue
      }
      current.hasElse = true
      continue
    }

    const spec = templateFunctionSpec(name)
    if (spec?.kind === 'directive' && (name === 'if' || name === 'range' || name === 'with')) {
      const head = commandOf(after(words[0]))
      const block: TemplateBlockNode = {
        kind: name,
        from: region.from,
        to: region.to,
        head,
        target: blockTargetOf(name, head, words),
        hasElse: false,
        elseIfs: [],
        bindings: {},
        closed: false,
      }
      if (name === 'range') {
        block.bindings = rangeBindingsOf(words)
      }
      stack.push(block)
      document.blocks.push(block)
      continue
    }

    const expression = expressionOf(spaced)
    if (expression) {
      document.expressions.push(expression)
    }
  }

  document.unclosedBlocks = stack.slice()
  return document
}

/**
 * 取块的作用对象（`with` 的值 / `range` 的数组）。
 *
 * - `{{with device}}` / `{{with device.name}}` → 取块头表达式的首个标识符；
 * - `{{range device_list}}` → 数组名；
 * - `{{range $i, $v := device_list}}` → 赋值号之后的数组名。
 */
function blockTargetOf(
  kind: 'if' | 'range' | 'with',
  head: TemplateCommand | null,
  words: TemplateToken[],
): string {
  if (kind === 'range') {
    const assignIndex = words.findIndex(token => token.kind === 'assign')
    if (assignIndex >= 0) {
      const source = words.slice(assignIndex + 1).find(token =>
        token.kind === 'ident' || token.kind === 'variable' || token.kind === 'dot')
      return source?.text ?? ''
    }
  }
  const first = head?.args[0]?.text
  return (first ?? head?.name ?? '').trim()
}

/** 取 `{{range $i, $v := 数组}}` 里的局部变量名 */
function rangeBindingsOf(words: TemplateToken[]): { index?: string, item?: string } {
  const variables = words
    .filter(token => token.kind === 'variable')
    .filter((token) => {
      // 赋值号之后的部分是数组表达式，其中的字段访问不算绑定
      const assign = words.find(item => item.kind === 'assign')
      return !assign || token.from < assign.from
    })

  if (!variables.length) {
    return {}
  }
  if (variables.length === 1) {
    return { item: variables[0].text }
  }
  return { index: variables[0].text, item: variables[1].text }
}

// ---------------------------------------------------------------- 命令链

/** 把一串 token 切成命令链并取首个命令（表达式本体 / 块头条件） */
function commandOf(tokens: TemplateToken[]): TemplateCommand | null {
  const chain = commandChainOf(tokens)
  return chain.length ? chain[0] : null
}

function expressionOf(words: TemplateToken[]): TemplateExpression | null {
  const chain = commandChainOf(words)
  if (!chain.length) {
    return null
  }
  return { from: chain[0].from, to: chain[chain.length - 1].to, commands: chain }
}

/**
 * 切分命令链（按顶层 `|` 分段）。
 *
 * `piped` 标记管道段，`args` 只统计顶层（括号深度 0）空格分隔的参数，
 * 因此 `gt (len device_list) 0` 的第 2 个参数是 `0`、第 1 个是整段括号。
 */
function commandChainOf(words: TemplateToken[]): TemplateCommand[] {
  const chain: TemplateCommand[] = []
  let current: TemplateToken[] = []
  let depth = 0
  let piped = false

  const flush = () => {
    const command = buildCommand(current, piped)
    if (command) {
      chain.push(command)
    }
    current = []
    piped = true
  }

  for (const token of words) {
    if (token.kind === 'lparen') {
      depth++
    } else if (token.kind === 'rparen') {
      depth = Math.max(0, depth - 1)
    }
    if (token.kind === 'pipe' && depth === 0) {
      flush()
      continue
    }
    current.push(token)
  }
  flush()

  return chain
}

/** 由一组 token 组装命令：首个非空白词为名字，其余按空格切成参数 */
function buildCommand(tokens: TemplateToken[], piped: boolean): TemplateCommand | null {
  const head = tokens.find(token => token.kind !== 'space')
  if (!head) {
    return null
  }
  const name = head.kind === 'ident' || head.kind === 'variable' ? head.text : ''
  // 参数只从「名字之后」开始切；没有名字（括号表达式 / 字面量开头）时整段都是参数
  const rest = tokens.filter(token => token.from >= (name ? head.to : head.from))

  return {
    name,
    nameFrom: head.from,
    nameTo: head.to,
    args: argumentsOf(rest),
    from: head.from,
    to: tokens[tokens.length - 1].to,
    piped,
  }
}

/**
 * 把 token 列表按「顶层空格 / 逗号」切成参数。
 *
 * 括号内的内容不切分（`(len a)` 是一个参数），逗号也算分隔（`$i, $v := arr`）。
 * 参数文本由组内 token 拼接，因此 `(len device_list)` 会连括号一起保留。
 */
function argumentsOf(tokens: TemplateToken[]): TemplateArgument[] {
  const args: TemplateArgument[] = []
  let depth = 0
  let captured: TemplateToken[] = []

  const flush = () => {
    if (!captured.length) {
      return
    }
    args.push({
      text: captured.map(token => token.text).join(''),
      from: captured[0].from,
      to: captured[captured.length - 1].to,
      index: args.length,
    })
    captured = []
  }

  for (const token of tokens) {
    if (depth === 0 && (token.kind === 'space' || token.kind === 'comma')) {
      flush()
      continue
    }
    if (token.kind === 'lparen') {
      depth++
    }
    if (token.kind === 'rparen') {
      depth = Math.max(0, depth - 1)
    }
    captured.push(token)
  }
  flush()

  return args
}

// ---------------------------------------------------------------- 光标分析

/**
 * 分析光标在模板片段里的语义意图。
 *
 * @param fragment 片段文本（`{{` 之后到片段末尾）
 * @param offset   片段在文档中的绝对起始下标
 * @param cursor   光标的绝对位置
 */
export function analyzeTemplateCursor(
  fragment: string,
  offset: number,
  cursor: number,
): TemplateCursorContext {
  const tokens = lexTemplateFragment(fragment, offset)
  const relative = cursor - offset
  const word = wordBefore(tokens, cursor)
  const prefix = word?.text ?? ''
  const range: TextRange = word ? { from: word.from, to: word.to } : { from: cursor, to: cursor }

  const before = fragment.slice(0, Math.max(0, relative))
  const trimmed = before.trim()
  const chain = commandChainUpTo(tokens, cursor)
  const activeCommand = chain.length ? chain.length - 1 : 0
  const current = chain[activeCommand] ?? null

  const callee = current?.name ?? ''
  const activeArgument = current
    ? current.args.filter(argument => argument.to <= cursor).length
    : 0

  /*
   * 收尾关键字：整段就是 `else` / `end`（写完就不再给候选）。
   * `{{else if }}` 不在此列 —— 它后面还等着写条件，应当给条件候选。
   */
  if (/^(else|end)$/i.test(trimmed)) {
    return {
      kind: 'closing',
      prefix,
      range,
      fragment,
      openAt: offset - 2,
      closeAt: null,
      commands: chain,
      activeCommand,
      activeArgument,
      callee,
      qualifier: '',
      dot: false,
      blockHead: '',
    }
  }

  const dotInfo = dotContextOf(tokens, cursor, prefix)

  /*
   * 意图判定顺序（从「结构性」到「位置性」）：
   *   点号取值 → 管道段 → 还没有命令名（新表达式）→ 正在打名字
   *   → 块条件位 → 普通函数的参数位。
   * 顺序不能换：`{{if de|}}` 既是「在打名字」也是「块条件」，
   * 但后者才决定候选（条件用变量，而不是函数名）。
   */
  let kind: TemplateCursorKind = 'unknown'
  if (dotInfo.dot) {
    kind = 'dot-variable'
  } else if (isAfterPipe(tokens, cursor)) {
    kind = 'pipeline'
  } else if (!callee) {
    kind = 'expression'
  } else if (isDirective(callee) || callee === 'else') {
    // `else` 后面跟的是 `if 条件`（或已是 else 分支的内容），同属条件位
    kind = 'block-condition'
  } else if (word && callee === prefix) {
    // 还在打第一个词：变量名 / 函数名都可能
    kind = 'variable'
  } else {
    kind = 'function-argument'
  }

  return {
    kind,
    prefix,
    range,
    fragment,
    openAt: offset - 2,
    closeAt: null,
    commands: chain,
    activeCommand,
    activeArgument,
    callee,
    qualifier: dotInfo.qualifier,
    dot: dotInfo.dot,
    blockHead: isDirective(callee) ? callee : '',
  }
}

/** 命令名是否是块指令 */
function isDirective(name: string): boolean {
  return templateFunctionSpec(name)?.kind === 'directive'
}

/** 光标是否紧跟在顶层 `|` 之后（管道段等待函数名） */
function isAfterPipe(tokens: TemplateToken[], cursor: number): boolean {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token.kind === 'space') {
      continue
    }
    if (token.to > cursor) {
      continue
    }
    return token.kind === 'pipe'
  }
  return false
}

/**
 * 光标之前的命令链（按顶层 `|` 分段，含正在写的那一段）。
 *
 * 空白 token 要保留：参数是靠顶层空格切分的，先滤掉它们就没法判断
 * 「已经写了几个参数」了。
 */
function commandChainUpTo(tokens: TemplateToken[], cursor: number): TemplateCommand[] {
  return commandChainOf(tokens.filter(token => token.to <= cursor))
}

/**
 * 判断光标是否处于点号取值位。
 *
 * `{{ .name| }}` → dot=true、qualifier=''
 * `{{ device.name| }}` → dot=true、qualifier='device'
 */
function dotContextOf(
  tokens: TemplateToken[],
  cursor: number,
  prefix: string,
): { dot: boolean, qualifier: string } {
  const upto = tokens.filter(token => token.kind !== 'space' && token.to <= cursor - prefix.length)
  const last = upto[upto.length - 1]
  if (!last || last.kind !== 'dot') {
    return { dot: false, qualifier: '' }
  }

  const parts: string[] = []
  for (let index = upto.length - 2; index >= 0; index -= 1) {
    const token = upto[index]
    if (token.kind === 'dot') {
      continue
    }
    if (token.kind === 'ident' || token.kind === 'variable') {
      parts.unshift(token.text)
      continue
    }
    break
  }
  return { dot: true, qualifier: parts.join('.') }
}

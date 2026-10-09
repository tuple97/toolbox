/**
 * 模板片段的词法分析。
 *
 * 把 `{{ … }}` 内部的一段文本切成 token（标识符 / 变量 / 字面量 / 管道符 /
 * 括号 / 赋值号…），供语法分析器定位「光标处在第几个命令的第几个参数」。
 *
 * 只做词法，不做语义：所有 token 都带绝对偏移，插入与替换范围直接取 token 范围。
 */

/** token 类别 */
export type TemplateTokenKind =
  /** 空白 */
  | 'space'
  /** 标识符 / 函数名 / 关键字 */
  | 'ident'
  /** `$x` 形式的局部变量 */
  | 'variable'
  /** 数字字面量 */
  | 'number'
  /** 字符串字面量（双引号或反引号） */
  | 'string'
  /** `.`（当前作用域指向的值） */
  | 'dot'
  /** `|` 管道分隔符 */
  | 'pipe'
  /** `(` */
  | 'lparen'
  /** `)` */
  | 'rparen'
  /** `,` */
  | 'comma'
  /** `:=` */
  | 'assign'
  /** 无法归类 */
  | 'unknown'

/** 一个 token（含绝对偏移） */
export interface TemplateToken {
  kind: TemplateTokenKind
  text: string
  from: number
  to: number
}

/** 标识符起始字符 */
const IDENT_START = /[A-Za-z_]/

/** 标识符后续字符（含数字） */
const IDENT_PART = /[\w]/

/**
 * 把片段文本切成 token。
 *
 * @param fragment 片段内容（`{{` 与 `}}` 之间的文本）
 * @param offset   片段在文档中的绝对起始下标（token 的 from/to 会带上它）
 */
export function lexTemplateFragment(fragment: string, offset: number): TemplateToken[] {
  const tokens: TemplateToken[] = []
  let index = 0

  /** 追加一个 token */
  const push = (kind: TemplateTokenKind, start: number, end: number) => {
    tokens.push({ kind, text: fragment.slice(start, end), from: offset + start, to: offset + end })
  }

  while (index < fragment.length) {
    const char = fragment[index]

    // 空白
    if (/\s/.test(char)) {
      const start = index
      while (index < fragment.length && /\s/.test(fragment[index])) {
        index++
      }
      push('space', start, index)
      continue
    }

    // 字符串字面量：双引号或反引号（内部支持反斜杠转义）
    if (char === '"' || char === '`') {
      const start = index
      const quote = char
      index++
      while (index < fragment.length) {
        if (fragment[index] === '\\') {
          index += 2
          continue
        }
        if (fragment[index] === quote) {
          index++
          break
        }
        index++
      }
      push('string', start, index)
      continue
    }

    // 局部变量：$name
    if (char === '$') {
      const start = index
      index++
      while (index < fragment.length && IDENT_PART.test(fragment[index])) {
        index++
      }
      push('variable', start, index)
      continue
    }

    // 标识符 / 关键字
    if (IDENT_START.test(char)) {
      const start = index
      while (index < fragment.length && IDENT_PART.test(fragment[index])) {
        index++
      }
      push('ident', start, index)
      continue
    }

    // 数字
    if (/[0-9]/.test(char)) {
      const start = index
      while (index < fragment.length && /[0-9._]/.test(fragment[index])) {
        index++
      }
      push('number', start, index)
      continue
    }

    // 赋值号 :=
    if (char === ':' && fragment[index + 1] === '=') {
      push('assign', index, index + 2)
      index += 2
      continue
    }

    const single: Record<string, TemplateTokenKind> = {
      '.': 'dot',
      '|': 'pipe',
      '(': 'lparen',
      ')': 'rparen',
      ',': 'comma',
    }
    const kind = single[char]
    if (kind) {
      push(kind, index, index + 1)
      index++
      continue
    }

    push('unknown', index, index + 1)
    index++
  }

  return tokens
}

/** 过滤掉空白 token */
export function withoutSpace(tokens: TemplateToken[]): TemplateToken[] {
  return tokens.filter(token => token.kind !== 'space')
}

/** 某个位置之前最后一个非空白 token */
export function tokenBefore(tokens: TemplateToken[], pos: number): TemplateToken | null {
  let found: TemplateToken | null = null
  for (const token of tokens) {
    if (token.kind === 'space') {
      continue
    }
    if (token.to <= pos) {
      found = token
      continue
    }
    break
  }
  return found
}

/** 光标正处于其中的 token（词内），没有则返回 null */
export function tokenAt(tokens: TemplateToken[], pos: number): TemplateToken | null {
  for (const token of tokens) {
    if (token.from < pos && pos <= token.to) {
      return token
    }
  }
  return null
}

/** 光标左侧紧邻的词（标识符 / 变量 / 数字），用于前缀替换范围 */
export function wordBefore(tokens: TemplateToken[], pos: number): TemplateToken | null {
  for (const token of tokens) {
    if (token.to === pos && (token.kind === 'ident' || token.kind === 'variable' || token.kind === 'number')) {
      return token
    }
  }
  return null
}

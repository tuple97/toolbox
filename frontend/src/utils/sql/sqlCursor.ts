/** SQL 光标的语义分析（文本层） */
import type { EditorState } from '@codemirror/state'
import { normalizeSqlScanDialect, splitSqlStatements } from '@/utils/sql/sqlStatementRanges'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { KEYWORD_WORDS } from './sqlCompletionKeywords'
import { IDENT_BODY_SOURCE, IDENT_SOURCE } from './sqlLexemes'
import { readAlias, readIdentifier, readQualifiedName, skipQuoted } from './sqlSchema'

/** 补全所处位置的候选类型 */
export type CompletionContextKind =
  /** 表名位置：FROM / JOIN / INTO / UPDATE 之后 */
  | 'table'
  /** 表达式位置：SELECT 列表 / WHERE / ON / SET / BY 等 */
  | 'column'
  /** 语句头（语句开头或判不出位置） */
  | 'statement-start'
  /** 子句关键字位置（表来源写完之后） */
  | 'keyword'
  /** 别名位置（AS 之后），此处不给候选 */
  | 'alias'
  /** 关联条件位置（`JOIN … ON |`：这里该写整条条件） */
  | 'join-on'
  /** JOIN 条件表达式内部（`ON o.user_id = u.|`：只给列，不再给整条条件） */
  | 'join-expression'
  /** 分组位置（GROUP BY 之后） */
  | 'group-by'
  /** INSERT 列清单内 */
  | 'insert'
  /** 模板片段 `{{ … }}` 内 */
  | 'template'
  /** 脚本编辑器 */
  | 'script'
  /** 无（日志等不补全的编辑器） */
  | 'none'

/** 补全所处位置的候选类型（子句视角） */
export type ClauseKind = 'source' | 'afterSource' | 'column' | 'alias' | 'any'

/** 「后面接表」的子句关键字 */
const TABLE_CLAUSE_KEYWORDS = new Set([
  'from', 'join', 'into', 'update', 'table', 'truncate', 'describe',
  'use', 'database', 'schema', 'rename', 'analyze', 'optimize', 'repair',
])

/** 「后面接列 / 表达式」的子句关键字 */
const COLUMN_CLAUSE_KEYWORDS = new Set([
  'select', 'where', 'on', 'and', 'or', 'set', 'by', 'having', 'using',
  'when', 'then', 'else', 'case', 'like', 'in', 'between', 'is', 'not',
  'distinct', 'returning', 'values', 'as', 'order', 'group',
])

/** 反向扫描出的子句结论 */
export interface ClauseScan {
  kind: ClauseKind
  /** 命中的关键字（小写）；未命中为空串 */
  keyword: string
  /** 命中关键字左边的那个词（如 `GROUP BY` 的 group、`o.user_id` 的 o） */
  previousKeyword: string
  /** 命中关键字之后、到光标之间的文本（已 trim） */
  tail: string
  /** 光标是否**紧贴刚读到的那个词**（`FROM|` 对 `FROM |`） */
  tight: TightKind
}

/** 「紧贴」的三种情形 */
export type TightKind = 'none' | 'keyword' | 'name'

/** 判断光标处属于哪个子句 */
export function readClauseKind(prefix: string): ClauseKind {
  return scanClause(prefix).kind
}

/** 反向扫描子句上下文（readClauseKind 的实现，额外透出命中的关键字） */
export function scanClause(prefix: string): ClauseScan {
  let index = prefix.length
  let depth = 0
  /** 反向扫描时是否跨过了一个左括号 */
  let enteredParen = false
  /** 是否让过了一个紧贴光标的词（`FROM or|` 的 `or`）—— 位置结论来自它左边的关键字 */
  let skippedName = false
  /** 那个被让过的词的起点：tail 要从这里截断，不能把它算成「已写好的内容」 */
  let skippedNameStart = prefix.length
  /** 已读过的上一个词（用于区分 GROUP BY / ORDER BY 这类两词结构） */
  let previousKeyword = ''

  const result = (kind: ClauseKind, keyword = '', at = index, tight: TightKind = 'none'): ClauseScan => ({
    kind,
    keyword,
    previousKeyword,
    tail: prefix.slice(at).trim(),
    // 让过名字的情形优先级最低：显式判定为紧贴关键字时以它为准
    tight: tight === 'none' && skippedName ? 'name' : tight,
  })

  while (index > 0) {
    const ch = prefix[index - 1] ?? ''

    if (/\s/.test(ch)) {
      index--
      continue
    }

    if (ch === ')') {
      depth++
      index--
      continue
    }

    if (ch === '(') {
      enteredParen = true
      depth = Math.max(0, depth - 1)
      index--
      continue
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      index = skipQuotedBackward(prefix, index - 1)
      continue
    }

    // 行注释：跳到行首；块注释：跳到 /* 之前
    if (ch === '-' && prefix[index - 2] === '-') {
      const lineStart = prefix.lastIndexOf('\n', index - 1)
      index = lineStart < 0 ? 0 : lineStart
      continue
    }
    if (ch === '/' && prefix[index - 2] === '*') {
      const blockStart = prefix.lastIndexOf('/*', index - 3)
      index = blockStart < 0 ? 0 : blockStart
      continue
    }

    const word = readWordBackward(prefix, index)
    if (word) {
      const lower = word.text.toLowerCase()
      if (depth === 0) {
        /* 紧贴光标的词，左边紧邻点号 ⇒ 它一定是限定名的一部分 */
        if (index === prefix.length && prefix[index - 1] === '.') {
          skippedName = true
          skippedNameStart = word.start
          previousKeyword = lower
          index = word.start
          continue
        }
        // 括号里的列清单：INSERT INTO t (a, |) / CREATE TABLE t (a |)
        if (enteredParen && (lower === 'into' || lower === 'update' || lower === 'table')) {
          return result('column', lower)
        }
        /* `AS` 之后就是别名本身（表别名 / 列别名）： 光标还在 `AS |` 时不该弹任何候选 */
        if (lower === 'as') {
          // `AS|` 紧贴：这个词还没写完，位置也没进入别名之后
          return result(
            prefix.slice(index).trim() ? 'afterSource' : 'alias',
            lower,
            index,
            index === prefix.length ? 'keyword' : 'none',
          )
        }
        /* BY 是两词结构的后半截（GROUP BY / ORDER BY） */
        if (lower === 'by') {
          let head = word.start
          while (head > 0 && /\s/.test(prefix[head - 1] ?? '')) {
            head--
          }
          const previous = readWordBackward(prefix, head)
          if (previous) {
            previousKeyword = previous.text.toLowerCase()
          }
          // `GROUP BY|` / `ORDER BY|` 紧贴：BY 本身还在写
          return result('column', lower, index, index === prefix.length ? 'keyword' : 'none')
        }
        if (TABLE_CLAUSE_KEYWORDS.has(lower)) {
          /* 表位置再细分：关键字到光标之间有没有内容，决定了「表还没写」还是「已写了表」 */
          /* tail 要排除「正在输入的那个词」：`FROM or|` 里 `or` 是没写完的表名， 它不是「已写好的来源」 */
          const tail = prefix.slice(index, skippedName ? skippedNameStart : prefix.length).trim()
          /* `FROM|`（紧贴，还没敲空格）与 `FROM |` 位置不同： 前者还在写这个词，表 / 库都不该给 */
          const tight: TightKind = index === prefix.length ? 'keyword' : 'none'
          /* 还在写来源的三种情形：什么都没写、刚敲了逗号（接着写下一个来源）、 以及**限定名写到一半**（`FROM mysql. */
          if (!tail || tail.endsWith(',') || tail.endsWith('.')) {
            return result('source', lower, index, tight)
          }
          if (tail.includes('(') || tail.includes(')')) {
            return result('any', lower, index, tight)
          }
          return result('afterSource', lower, index, tight)
        }
        if (COLUMN_CLAUSE_KEYWORDS.has(lower)) {
          /* 贴住光标的词，只有「左边明确是名字位置」时才当作**还没写完的名字**： SELECT * FROM or| → 左边是 */
          if (index === prefix.length && previousIsTableClauseKeyword(prefix, word.start)) {
            skippedName = true
            skippedNameStart = word.start
            previousKeyword = lower
            index = word.start
            continue
          }
          return result('column', lower)
        }
        /* 走到这里只可能是一种情况：这个词**不在关键字词表里** */
        if (index === prefix.length && !KEYWORD_WORDS.has(lower)) {
          skippedName = true
          skippedNameStart = word.start
          previousKeyword = lower
          index = word.start
          continue
        }
      }
      previousKeyword = lower
      index = word.start
      continue
    }

    index--
  }

  // 进了括号又判断不出关键字：按表达式位置处理（函数参数、子查询列清单等）
  return result(enteredParen ? 'column' : 'any')
}

/** 紧贴光标的关键字，左边是不是「表位置关键字」（from / join / into / update…） */
function previousIsTableClauseKeyword(prefix: string, before: number): boolean {
  let head = before
  while (head > 0 && /\s/.test(prefix[head - 1] ?? '')) {
    head--
  }
  const previous = readWordBackward(prefix, head)
  return Boolean(previous && TABLE_CLAUSE_KEYWORDS.has(previous.text.toLowerCase()))
}

/** 从 index 向左读一个词，返回词与起始下标 */
function readWordBackward(text: string, index: number): { text: string, start: number } | null {
  let i = index
  while (i > 0 && /[\w$]/.test(text[i - 1] ?? '')) {
    i--
  }
  if (i === index || !/[A-Za-z_$]/.test(text[i] ?? '')) {
    return null
  }
  return { text: text.slice(i, index), start: i }
}

/** 从 index（引号字符）向左找到配对的开引号，返回开引号之前的下标 */
export function skipQuotedBackward(text: string, index: number): number {
  const quote = text[index] ?? ''
  let i = index - 1
  while (i >= 0) {
    if (text[i] === quote) {
      // 双写（''）或反斜杠转义：继续往左找
      if (text[i - 1] === quote || text[i - 1] === '\\') {
        i -= 2
        continue
      }
      return i
    }
    i--
  }
  return 0
}

/** 光标所在（可能还没写完）语句中，光标之前的文本 */
export function currentClausePrefix(doc: string, pos: number, range: TextRange | null): string {
  if (!range) {
    return ''
  }
  return doc.slice(Math.max(0, range.from), pos)
}

/** 补全口径的语句边界类别 */
export type SqlStatementBoundary =
  /** 光标落在语句文本里 */
  | 'inside-statement'
  /** 光标在语句之后的普通空白里（换行 / 缩进）—— 仍属于这条语句 */
  | 'trailing-whitespace'
  /** 光标在一个**完整空行**之后 —— 新语句（不必写分号） */
  | 'blank-line'
  /** 没有语句覆盖光标（文件开头、分号之后）—— 本身就是新语句 */
  | 'new-statement'

/** 补全口径的语句上下文：解析范围 + 边界类别 */
export interface CompletionStatementContext {
  /** 当前语句的解析范围（`clause` / 作用域都基于它） */
  range: TextRange
  boundary: SqlStatementBoundary
}

/** 补全口径的语句上下文 */
export function completionStatementContext(
  doc: string,
  pos: number,
  dbType = '',
): CompletionStatementContext | null {
  const statements = splitSqlStatements(doc, dbType)

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]

    if (pos >= statement.from && pos <= statement.to) {
      /* 光标在语句文本里，但这段文本内部可能夹着空行 */
      const start = findCompletionBlankLineBoundary(doc, statement.from, pos, dbType)
      if (start !== null) {
        return { range: { from: start, to: statement.to }, boundary: 'blank-line' }
      }
      return {
        range: { from: statement.from, to: statement.to },
        boundary: 'inside-statement',
      }
    }

    const next = statements[index + 1]
    if (pos <= statement.to || (next && pos >= next.from)) {
      continue
    }

    const gap = doc.slice(statement.to, pos)
    if (gap.trim() !== '') {
      continue
    }

    // 语句之后的空白：普通换行仍是这条语句，完整空行才起新语句
    if (hasBlankLineBoundary(gap)) {
      return { range: { from: lineStartOf(doc, pos), to: pos }, boundary: 'blank-line' }
    }
    return {
      range: { from: statement.from, to: statement.to },
      boundary: 'trailing-whitespace',
    }
  }

  return { range: { from: lineStartOf(doc, pos), to: pos }, boundary: 'new-statement' }
}

/** 只取解析范围的兼容入口（**仅补全**） */
export function completionStatementRange(doc: string, pos: number, dbType = ''): TextRange | null {
  return completionStatementContext(doc, pos, dbType)?.range ?? null
}

/** 文本里是否出现**完整空行**（一整行只有空白）——单个换行不算 */
export function hasBlankLineBoundary(text: string): boolean {
  return /\r?\n[ \t]*\r?\n/.test(text)
}

/** 光标所在行的行首 */
function lineStartOf(doc: string, pos: number): number {
  return doc.lastIndexOf('\n', pos - 1) + 1
}

/** 当前补全语句里「空行边界」的候选起点（空行之后的行首），没有则返回 null */
function findCompletionBlankLineBoundary(
  doc: string,
  from: number,
  to: number,
  dbType = '',
): number | null {
  const dialect = normalizeSqlScanDialect(dbType)
  let i = from
  let depth = 0
  let boundary = -1
  /** 最近一个「有内容的字符」（注释与引号内的内容不算） */
  let contentEnd = -1
  /** 最近一个词（小写）：判断它是不是续写词 */
  let lastWord = ''

  while (i < to) {
    const ch = doc[i]

    // 标识符：整块读掉，顺便记下最后一个词
    // （词首不认 `$`：那是 PostgreSQL dollar quote 的起始，不能当标识符吃掉）
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < to && /[\w$]/.test(doc[j] ?? '')) {
        j += 1
      }
      lastWord = doc.slice(i, j).toLowerCase()
      contentEnd = j - 1
      i = j
      continue
    }

    // 字符串 / 引号标识符：反引号只在 MySQL 家族里是引用符
    if (ch === '\'' || ch === '"' || (ch === '`' && dialect === 'mysql')) {
      const next = skipQuoted(doc, i)
      if (next > to) {
        return null
      }
      contentEnd = next - 1
      i = next
      continue
    }

    // PostgreSQL dollar quote：`$$ … $$`（可跨行）里的空行不是语句边界
    if (dialect === 'postgres' && ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(doc.slice(i, i + 64))
      if (tag) {
        const close = doc.indexOf(tag[0], i + tag[0].length)
        if (close < 0 || close + tag[0].length > to) {
          return null
        }
        contentEnd = close + tag[0].length - 1
        i = close + tag[0].length
        continue
      }
    }

    // 行注释：`--` 通用；`#` 只有 MySQL 家族（PostgreSQL / 标准 SQL 里 # 是普通字符）
    if ((ch === '-' && doc[i + 1] === '-') || (dialect === 'mysql' && ch === '#')) {
      const newline = doc.indexOf('\n', i)
      i = newline === -1 || newline > to ? to : newline
      continue
    }

    if (ch === '/' && doc[i + 1] === '*') {
      const close = doc.indexOf('*/', i + 2)
      if (close === -1 || close + 2 > to) {
        return null
      }
      i = close + 2
      continue
    }

    if (ch === '(') {
      depth += 1
    }
    else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    }
    else if (ch === '\n') {
      // 空行 = 换行之后只有空白，紧跟又一个换行
      let j = i + 1
      while (j < to && (doc[j] === ' ' || doc[j] === '\t' || doc[j] === '\r')) {
        j += 1
      }
      if (
        j < to
        && doc[j] === '\n'
        && depth === 0
        && !endsWithContinuation(doc, contentEnd)
        && !isContinuationWord(lastWord)
      ) {
        // 空行之后的行首即是新语句起点（后面若还有注释行，一并算进去）
        const start = lineStartOf(doc, j + 1)
        if (!isContinuationWord(firstMeaningfulWordAt(doc, start, to, dbType))) {
          boundary = start
        }
      }
      i = j > i + 1 ? j : i + 1
      continue
    }
    else if (!/\s/.test(ch)) {
      contentEnd = i
      lastWord = ''
    }
    i += 1
  }

  return boundary >= 0 ? boundary : null
}

/** 从 lineStart 起第一个**有意义的**词（跳过空白、行注释、块注释）；没有则返回空串 */
function firstMeaningfulWordAt(doc: string, lineStart: number, to: number, dbType = ''): string {
  const dialect = normalizeSqlScanDialect(dbType)
  let i = lineStart

  while (i < to) {
    const ch = doc[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if ((ch === '-' && doc[i + 1] === '-') || (dialect === 'mysql' && ch === '#')) {
      const newline = doc.indexOf('\n', i)
      if (newline < 0 || newline >= to) {
        return ''
      }
      i = newline + 1
      continue
    }
    if (ch === '/' && doc[i + 1] === '*') {
      const close = doc.indexOf('*/', i + 2)
      if (close < 0 || close + 2 >= to) {
        return ''
      }
      i = close + 2
      continue
    }
    break
  }

  const match = /^[A-Za-z_][\w$]*/.exec(doc.slice(i, to))
  return match ? match[0].toLowerCase() : ''
}

/** 结尾字符是否**必须**继续写（逗号 / 括号 / 赋值与比较运算符） */
function endsWithContinuation(doc: string, contentEnd: number): boolean {
  if (contentEnd < 0) {
    return true
  }
  return /[,.(=+\-<>:&|!?]/.test(doc[contentEnd] ?? '')
}

/** 续写提示词 —— **只用来消除「明显续写」的误切，不是 SQL grammar** */
const CONTINUATION_CLAUSE_WORDS = new Set([
  'select', 'distinct', 'all', 'from', 'join', 'left', 'right', 'inner', 'outer',
  'full', 'cross', 'on', 'using', 'where', 'group', 'order', 'by', 'having',
  'set', 'values', 'into', 'as', 'union', 'intersect', 'except', 'limit', 'offset',
  'with', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate',
  'add', 'returning', 'over', 'partition', 'window',
])

/** 表达式内部的连接词：出现在空行前后都说明还在写同一个表达式 */
const CONTINUATION_OPERATOR_WORDS = new Set([
  'and', 'or', 'not', 'between', 'like', 'is', 'in', 'when', 'then', 'else', 'case',
])

/** 这个词是否表示「还要接着写」 */
function isContinuationWord(word: string): boolean {
  return CONTINUATION_CLAUSE_WORDS.has(word) || CONTINUATION_OPERATOR_WORDS.has(word)
}

/** 由子句扫描结论细化为位置类别 */
export function sqlContextKindOf(scan: ClauseScan, statementText: string): CompletionContextKind {
  switch (scan.kind) {
    case 'alias':
      return 'alias'
    case 'source':
      return 'table'
    case 'afterSource':
      return 'keyword'
    case 'column':
      /* 关联条件：ON 且同一条语句里出现过 JOIN（ON 也会出现在 CREATE INDEX 等语句里） */
      if (scan.keyword === 'on' && /\bjoin\b/i.test(statementText)) {
        return scan.tail ? 'join-expression' : 'join-on'
      }
      // `ON … AND |`：还在同一个 ON 子句里，可以再给一条条件
      if ((scan.keyword === 'and' || scan.keyword === 'or') && !scan.tail && isInsideJoinClause(statementText)) {
        return 'join-on'
      }
      // 分组：GROUP BY（previousKeyword 是同一个扫描里读出来的 group）
      if (scan.keyword === 'by' && scan.previousKeyword === 'group') {
        return 'group-by'
      }
      // INSERT 的列清单：INTO 之后还没闭合的括号内
      if (scan.keyword === 'into') {
        return 'insert'
      }
      return 'column'
    default:
      return 'statement-start'
  }
}

/** 光标处是否还在 ON 子句里（最近的 ON 晚于最近的 WHERE / HAVING） */
function isInsideJoinClause(statementText: string): boolean {
  const lower = statementText.toLowerCase()
  const on = lower.lastIndexOf(' on ')
  if (on < 0) {
    return false
  }
  return on > lower.lastIndexOf(' where ') && on > lower.lastIndexOf(' having ')
}

// ---------------------------------------------------------------- 列补全意图

/** 列补全模式 */
export type ColumnCompletionMode = 'single' | 'multi'

/** 光标前那一个输出项是什么（决定 `,|` 与 `, |` 的差别） */
export type PreviousItemKind = 'column' | 'expression' | 'function' | 'unknown'

/** 光标处的列补全意图 */
export interface SqlColumnIntent {
  /** 是否处于 SELECT 列表的列位置（其它子句的列位置不算） */
  isColumnList: boolean
  /** 左侧点号限定符（`t.` 的 t）；没有为空串 */
  qualifier: string
  /** 正在输入的词 */
  prefix: string
  /** 光标左侧是否处于「逗号之后的新输出项」 */
  afterComma: boolean
  /** 逗号之后是否已经落了空白（`,|` 与 `, |` 的分界） */
  commaFollowedBySpace: boolean
  /** 上一个输出项的类型 */
  previousItemKind: PreviousItemKind
  /** 上一个输出项用的限定符（多选时新列沿用它的 `t.`）；没有为空串 */
  previousQualifier: string
  /** 当前输出项原文（保留空白；判定槽位要区分「新的一项」与「已写了表达式」） */
  itemText: string
  /** 当前输出项还没写任何表达式：`SELECT |` / `SELECT t.` 为真，`SELECT id |` 为假 */
  itemEmpty: boolean
  /** 列选择模式 */
  mode: ColumnCompletionMode
}

/** 不在列位置时的默认意图（单选、无限定符） */
function emptyColumnIntent(): SqlColumnIntent {
  return {
    isColumnList: false,
    qualifier: '',
    prefix: '',
    afterComma: false,
    commaFollowedBySpace: false,
    previousItemKind: 'unknown',
    previousQualifier: '',
    itemText: '',
    itemEmpty: false,
    mode: 'single',
  }
}

/** 单独写一个关键字也算「还没开始写表达式」（`SELECT DISTINCT |`） */
const ITEM_ONLY_KEYWORDS = new Set(['distinct', 'all'])

/** 该输出项是否还没写表达式内容 */
function isEmptyItem(itemText: string, qualifier: string, prefix: string): boolean {
  // `SELECT DISTINCT |` 里的 DISTINCT 只是列表开头的修饰，不影响「这一项还没开始写」
  if (prefix && !ITEM_ONLY_KEYWORDS.has(prefix.toLowerCase())) {
    return false
  }
  let head = itemText.trim()
  if (qualifier && head.endsWith('.')) {
    head = head.slice(0, -1)
  }
  if (qualifier) {
    head = head.slice(0, Math.max(0, head.length - qualifier.length))
  }
  const trimmed = head.trim()
  return trimmed === '' || ITEM_ONLY_KEYWORDS.has(trimmed.toLowerCase())
}

/** 忽略引号后的括号深度（> 0 表示在函数参数 / 子查询括号里） */
function parenDepthOf(text: string): number {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth--
    }
    i++
  }
  return depth
}

/** 光标所在输出项：原文 + 它的起点是逗号还是 SELECT */
interface OutputItemTail {
  /** 从上一个同层逗号 / SELECT 关键字之后到光标的原文（**保留空白**） */
  text: string
  /** 起点是不是逗号（即「光标落在逗号之后的新一项」） */
  afterComma: boolean
}

/** 光标所在**输出项**的原文 + 起点类型 */
function itemTailOf(prefix: string): OutputItemTail {
  let depth = 0
  let boundary = 0
  let afterComma = false
  let i = 0

  while (i < prefix.length) {
    const ch = prefix[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(prefix, i)
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (ch === ',' && depth === 0) {
      boundary = i + 1
      afterComma = true
      i++
      continue
    }
    const ident = readIdentifier(prefix, i)
    if (ident) {
      if (depth === 0 && ident.name.toLowerCase() === 'select') {
        boundary = ident.end
        afterComma = false
      }
      i = ident.end
      continue
    }
    i++
  }

  return { text: prefix.slice(boundary), afterComma }
}

/** 上一个输出项的原文（最后一个同层逗号**之前那一项**的内容，不含 SELECT 等前导） */
function previousItemText(prefix: string): string {
  let depth = 0
  let boundary = 0
  let prevBoundary = 0
  let lastComma = -1
  let i = 0

  while (i < prefix.length) {
    const ch = prefix[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(prefix, i)
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (ch === ',' && depth === 0) {
      prevBoundary = boundary
      boundary = i + 1
      lastComma = i
      i++
      continue
    }
    const ident = readIdentifier(prefix, i)
    if (ident) {
      if (depth === 0 && ident.name.toLowerCase() === 'select') {
        boundary = ident.end
      }
      i = ident.end
      continue
    }
    i++
  }

  return lastComma < 0 ? '' : prefix.slice(prevBoundary, lastComma)
}

/** 输出项的类型：完整列引用 / 函数调用 / 其它表达式 / 空 */
function itemKindOf(item: string): PreviousItemKind {
  const trimmed = item.trim()
  if (!trimmed) {
    return 'unknown'
  }
  const bare = new RegExp(`^${IDENT_SOURCE}$`)
  const qualified = new RegExp(`^${IDENT_SOURCE}\\s*\\.\\s*(${IDENT_SOURCE}|\\*)$`)
  if (bare.test(trimmed) || qualified.test(trimmed)) {
    return 'column'
  }
  return trimmed.endsWith(')') ? 'function' : 'expression'
}

/** 从「语句内光标之前的文本」推导列补全意图 */
export function readColumnIntent(prefix: string): SqlColumnIntent {
  const scan = scanClause(prefix)
  const intent = emptyColumnIntent()
  /* INPUT：`SELECT` 列表（含 `SELECT DISTINCT` —— DISTINCT 是列表开头的修饰 */
  const inSelectList = scan.keyword === 'select'
    || scan.keyword === 'distinct'
    || scan.keyword === 'all'
  if (scan.kind !== 'column' || !inSelectList) {
    return intent
  }

  /* tail 是「当前输出项」的原文（光标前最后一个同层逗号 / SELECT 之后的全部文本， **保留空白**）：` */
  const item = itemTailOf(prefix)
  if (parenDepthOf(item.text) !== 0) {
    return intent
  }

  const afterComma = item.afterComma
  const itemText = item.text
  const commaFollowedBySpace = afterComma && /^\s/.test(itemText)
  const previousText = afterComma ? previousItemText(prefix) : ''

  const { qualifier, prefix: word } = qualifierAndPrefix(itemText)
  // `DISTINCT` / `ALL` 只是列表开头的修饰，不算「已经在输入词」
  const typedWord = ITEM_ONLY_KEYWORDS.has(word.toLowerCase()) ? '' : word
  const mode: ColumnCompletionMode = (() => {
    // 逗号紧跟光标：继续写下一列的单选状态
    if (afterComma && !commaFollowedBySpace) {
      return 'single'
    }
    // 逗号后落空白 / 限定符后空前缀 / 列表刚开：都是「新的一项还没开始输入」
    if (!typedWord) {
      return 'multi'
    }
    return 'single'
  })()

  return {
    isColumnList: true,
    qualifier,
    prefix: word,
    afterComma,
    commaFollowedBySpace,
    previousItemKind: itemKindOf(previousText),
    previousQualifier: previousQualifierOf(previousText),
    itemText: itemText.trim(),
    itemEmpty: isEmptyItem(itemText, qualifier, word),
    mode,
  }
}

/** 输出项里的「词 + 左侧限定符」 */
function qualifierAndPrefix(itemText: string): { qualifier: string, prefix: string } {
  const trimmed = itemText.trimEnd()
  const word = new RegExp(`${IDENT_BODY_SOURCE}$`).exec(trimmed)?.[0] ?? ''
  const before = trimmed.slice(0, trimmed.length - word.length)
  const dot = /\.\s*$/.exec(before)
  if (!dot) {
    return { qualifier: '', prefix: word }
  }
  const head = before.slice(0, dot.index).trimEnd()
  const qualifier = new RegExp(`(${IDENT_SOURCE})$`).exec(head)?.[1] ?? ''
  return { qualifier, prefix: word }
}

/** 上一个输出项用的限定符（`t.user_id` → `t`；没有则空串） */
function previousQualifierOf(itemText: string): string {
  const trail = new RegExp(`(${IDENT_SOURCE})\\s*\\.\\s*${IDENT_SOURCE}\\s*$`).exec(itemText.trim())
  return trail?.[1] ?? ''
}

// ---------------------------------------------------------------- 光标语义

/** SQL 光标语义（文本层） */
export interface SqlCursorText {
  /** 光标所在语句 */
  statement: TextRange | null
  /** 语句边界：光标是「仍在语句里 / 语句后的空白」还是「已进入新语句」 */
  statementBoundary: SqlStatementBoundary
  /** 语句内光标之前的文本（子句扫描的输入） */
  clausePrefix: string
  /** 上面这段文本在文档中的起点 */
  prefixStart: number
  /** 子句扫描结论（含命中的关键字与它左边那个词） */
  clause: ClauseScan
  /** 位置类别（触发策略与候选生成共用） */
  kind: CompletionContextKind
  /** 列补全意图（列模式 / 限定符 / 逗号状态；复选框与空格都据此判断） */
  column: SqlColumnIntent
  /** 语句的主关键字（select / update / insert / delete…），判不出为空串 */
  command: string
  /** 当前 JOIN 的源（最近一个 `JOIN` 后面的表与别名） */
  joinTarget: { table: string, alias: string } | null
}

/** 分析光标（只做文本扫描，不查元数据，可在每次按键时廉价调用） */
export function analyzeSqlCursorText(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlCursorText {
  const doc = state.doc.toString()
  const context = completionStatementContext(doc, pos, dbType)
  const clausePrefix = currentClausePrefix(doc, pos, context?.range ?? null)
  const clause = scanClause(clausePrefix)

  return {
    statement: context?.range ?? null,
    statementBoundary: context?.boundary ?? 'new-statement',
    clausePrefix,
    prefixStart: pos - clausePrefix.length,
    clause,
    kind: sqlContextKindOf(clause, clausePrefix),
    column: readColumnIntent(clausePrefix),
    command: mainCommandOf(clausePrefix),
    joinTarget: joinTargetOf(clausePrefix),
  }
}

/** 取最近一个 `JOIN` 后面的表与别名 */
function joinTargetOf(clausePrefix: string): { table: string, alias: string } | null {
  let end = -1
  for (const match of clausePrefix.matchAll(/\bjoin\b/gi)) {
    end = (match.index ?? 0) + match[0].length
  }
  if (end < 0) {
    return null
  }

  const rest = clausePrefix.slice(end)
  const parsed = readQualifiedName(rest, 0)
  if (!parsed?.parts.length) {
    return null
  }

  const table = parsed.parts[parsed.parts.length - 1]
  const alias = readAlias(rest, parsed.end)?.alias ?? table
  return { table, alias }
}

/** 语句的主关键字：跳过前导空白与注释后的第一个词（select / with / update…） */
function mainCommandOf(clausePrefix: string): string {
  let index = 0
  while (index < clausePrefix.length) {
    const ch = clausePrefix[index]
    if (/\s/.test(ch)) {
      index++
      continue
    }
    if ((ch === '-' && clausePrefix[index + 1] === '-') || ch === '#') {
      const lineEnd = clausePrefix.indexOf('\n', index)
      index = lineEnd < 0 ? clausePrefix.length : lineEnd + 1
      continue
    }
    if (ch === '/' && clausePrefix[index + 1] === '*') {
      const blockEnd = clausePrefix.indexOf('*/', index + 2)
      index = blockEnd < 0 ? clausePrefix.length : blockEnd + 2
      continue
    }
    break
  }

  const match = /^[A-Za-z_]+/.exec(clausePrefix.slice(index))
  return match ? match[0].toLowerCase() : ''
}

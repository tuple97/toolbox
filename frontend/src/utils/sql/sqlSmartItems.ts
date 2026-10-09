/**
 * 智能项候选：`*` 展开 / GROUP BY 非聚合列 / 比较值 / INSERT 列清单。
 *
 * 与普通候选的区别在于「插入的不只是光标前那个词」：
 *  - `*` 展开会**替换**文档里已经写下的 `*`（`u.*` 连限定符一起换掉）；
 *  - 列清单一次插入多个列名（GROUP BY 补齐、INSERT 列片段）。
 * 因此这些候选项各自带自定义 apply，本模块只做**纯文本解析与拼装**
 * （不依赖 EditorState / DOM），可以直接在单测里验证。
 *
 * 位置判定（是不是 SELECT 列表里、是不是比较运算右边）在这里完成，
 * 「从哪张表取列、值域从哪来」由宿主（sqlCompletion）以回调注入。
 */
import type { Completion } from '@codemirror/autocomplete'
import { BOOST_SMART_ITEM } from './sqlCompletionKeywords'
import { formatSqlValue } from './rowSql'
import type { SqlDialect } from './rowSql'
import {
  IDENT_OR_QUOTED_SOURCE,
  IDENT_SOURCE,
  isIdentBody,
  isIdentStart,
} from './sqlLexemes'

/** 参与智能项的列 */
export interface SmartColumn {
  name: string
  /** 字段类型：决定比较值要不要加引号 */
  dataType?: string
  /** 字段注释（候选描述里展示） */
  comment?: string
}

/** 比较值候选（来自词典等值域数据） */
export interface SmartCompareValue {
  /** 值本身（原始文本，如 prod / 1） */
  value: string
  /** 展示用释义（词典释义） */
  meaning?: string
  /** 值域来源说明（如「词典 状态」），作为候选描述前缀 */
  source?: string
}

/** 文档里要被替换的区间 */
export interface SmartRange {
  from: number
  to: number
}

// ---------------------------------------------------------------- 聚合判定

/**
 * 聚合函数名（GROUP BY 判定用）。
 *
 * 命中「名字 + 左括号」即认为这一项是聚合表达式，不再作为分组列推荐；
 * 覆盖常见方言的聚合函数，各库独有的（如 percentile_cont）也一并列入。
 */
const AGGREGATE_FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max',
  'group_concat', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'json_object_agg',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'bit_and', 'bit_or', 'bit_xor', 'bool_and', 'bool_or', 'every', 'any_value',
  'median', 'mode', 'percentile_cont', 'percentile_disc',
]

const AGGREGATE_RE = new RegExp(`\\b(?:${AGGREGATE_FUNCTIONS.join('|')})\\s*\\(`, 'i')

/** 表达式里是否含聚合函数调用 */
export function containsAggregate(expression: string): boolean {
  return AGGREGATE_RE.test(expression)
}

// ---------------------------------------------------------------- 文本工具

/** 跳过引号包裹的文本（含转义与双写），返回结束引号之后的下标 */
function skipQuoted(text: string, start: number): number {
  const quote = text[start] ?? ''
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index++
  }
  return text.length
}

/** 从 index 起读一个词（字母 / 下划线 / $ / 中文开头），读不到返回 null */
function readWordAt(text: string, index: number): { text: string, end: number } | null {
  if (!isIdentStart(text[index] ?? '')) {
    return null
  }
  let end = index + 1
  while (end < text.length && isIdentBody(text[end] ?? '')) {
    end++
  }
  return { text: text.slice(index, end), end }
}

/** 按顶层逗号切分（括号与引号内的逗号不算） */
export function splitTopLevelList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let last = 0
  let index = 0
  while (index < text.length) {
    const ch = text[index] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      index = skipQuoted(text, index)
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    }
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(last, index))
      last = index + 1
    }
    index++
  }
  parts.push(text.slice(last))
  return parts
}

/**
 * 标识符片段（正则字符串）：ASCII 标识符 + CJK。
 *
 * 中文表名 / 列名在本项目里是常见写法（补全还支持拼音首字母命中），
 * 这里必须认得它们 —— 否则「中文列名 AS 别名」会被当成表达式丢掉。
 */
const IDENT = IDENT_SOURCE
/** 一个标识符（裸写或带引号） */
const IDENT_OR_QUOTED = IDENT_OR_QUOTED_SOURCE

const IDENT_RE = new RegExp(`^${IDENT}$`)
const AS_ALIAS_RE = new RegExp(`\\s+as\\s+(?:${IDENT_OR_QUOTED})\\s*$`, 'i')
const TRAILING_ALIAS_RE = new RegExp(`\\s+(?:${IDENT_OR_QUOTED})\\s*$`)

/** 去掉标识符的包裹引号 */
function unquote(name: string): string {
  const trimmed = name.trim()
  if (/^`[^`]*`$/.test(trimmed) || /^"[^"]*"$/.test(trimmed) || /^\[[^\]]*\]$/.test(trimmed)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 是否是一个合法标识符 */
function isIdentifier(name: string): boolean {
  return IDENT_RE.test(name)
}

/** 识别整段文本是不是列引用（`col` / `t.col` / `` `db`.`t` ``），不是则返回 null */
export function readColumnRef(text: string): { qualifier: string, column: string } | null {
  const parts = text.trim().split('.')
  if (parts.length === 1) {
    const column = unquote(parts[0])
    return isIdentifier(column) ? { qualifier: '', column } : null
  }
  if (parts.length === 2) {
    const qualifier = unquote(parts[0])
    const column = unquote(parts[1])
    return isIdentifier(qualifier) && isIdentifier(column) ? { qualifier, column } : null
  }
  return null
}

/**
 * 去掉 SELECT 列表项末尾的别名：`COUNT(*) AS c` → `COUNT(*)`、`u.name n` → `u.name`。
 *
 * 别名跟随时要求前面有空白且上一个非空白字符是标识符 / 右括号 / 引号，
 * 与派生表输出列解析同一套容错规则（`a + b` 这类不会被误剥）。
 */
export function stripAlias(item: string): string {
  const asMatch = AS_ALIAS_RE.exec(item)
  if (asMatch) {
    return item.slice(0, asMatch.index).trim()
  }

  const tail = TRAILING_ALIAS_RE.exec(item)
  if (!tail) {
    return item.trim()
  }
  const before = item.slice(0, tail.index).trimEnd()
  if (!/[\w$\u4e00-\u9fa5)\]`"]$/.test(before)) {
    return item.trim()
  }
  return before.trim()
}

// ---------------------------------------------------------------- SELECT 列表

/**
 * SELECT 列表里出现的非聚合列（GROUP BY 推荐用）。
 *
 * 只认能静态确定成列引用的项：`COUNT(*) AS c`（聚合）与 `1 + 1`（表达式）都会跳过，
 * 保证推荐出来的都是「按规范确实该出现在 GROUP BY 里」的列。
 */
export function nonAggregateColumnsOf(selectList: string): Array<{ qualifier: string, column: string }> {
  const columns: Array<{ qualifier: string, column: string }> = []
  const seen = new Set<string>()

  for (const raw of splitTopLevelList(selectList)) {
    const expression = stripAlias(raw.trim())
    if (!expression || containsAggregate(expression)) {
      continue
    }
    const ref = readColumnRef(expression)
    if (!ref) {
      continue
    }
    const key = `${ref.qualifier.toLowerCase()}.${ref.column.toLowerCase()}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    columns.push(ref)
  }

  return columns
}

/**
 * 光标所在层（同一括号深度）最后一个 SELECT 的列表文本。
 *
 * 「同一层」很关键：`SELECT (SELECT max(x) FROM t) |` 里最后一个 SELECT 在更内层，
 * 直接取文本上最后一个会把内层列表当成外层列表。
 * 列表文本在**顶层 FROM 处截断**（不截的话后面 FROM / WHERE 里的词会被当成列表项）。
 */
export function selectListTail(prefix: string): { text: string, start: number } | null {
  let depth = 0
  const selects: Array<{ depth: number, end: number }> = []

  let index = 0
  while (index < prefix.length) {
    const ch = prefix[index] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      index = skipQuoted(prefix, index)
      continue
    }
    if (ch === '-' && prefix[index + 1] === '-') {
      const lineEnd = prefix.indexOf('\n', index)
      index = lineEnd < 0 ? prefix.length : lineEnd + 1
      continue
    }
    if (ch === '/' && prefix[index + 1] === '*') {
      const blockEnd = prefix.indexOf('*/', index + 2)
      index = blockEnd < 0 ? prefix.length : blockEnd + 2
      continue
    }
    if (ch === '(') {
      depth++
      index++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      index++
      continue
    }

    const word = readWordAt(prefix, index)
    if (!word) {
      index++
      continue
    }
    if (word.text.toLowerCase() === 'select') {
      selects.push({ depth, end: word.end })
    }
    index = word.end
  }

  /*
   * 「光标所在层」= 深度不超过光标当前深度的最后一个 SELECT。
   *
   * 不能用「深度恰好相等」：光标正打在函数括号里（`SELECT (SELECT max(|`）时，
   * 当前深度比所在 SELECT 深一层，但那个 SELECT 仍是「正在写的列表」；
   * 反过来 `SELECT (SELECT 1) |` 光标已经出了括号，更深的那个 SELECT 就不该入选。
   */
  const last = selects.filter(item => item.depth <= depth).pop()
  if (!last) {
    return null
  }

  const cut = firstTopLevelFrom(prefix, last.end)
  return { text: prefix.slice(last.end, cut < 0 ? prefix.length : cut), start: last.end }
}

/** start 之后第一个顶层的 FROM 关键字下标；没有返回 -1 */
function firstTopLevelFrom(text: string, start: number): number {
  let depth = 0
  let index = start
  while (index < text.length) {
    const ch = text[index] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      index = skipQuoted(text, index)
      continue
    }
    if (ch === '(') {
      depth++
      index++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      index++
      continue
    }

    const word = readWordAt(text, index)
    if (!word) {
      index++
      continue
    }
    if (depth === 0 && word.text.toLowerCase() === 'from') {
      return index
    }
    index = word.end
  }
  return -1
}

/** 纯星号项：`*` 或 `限定符.*` */
const STAR_ITEM_RE = new RegExp(`^(?:(${IDENT})\\.)?\\*$`)

/**
 * 列表末尾的 `*` / `u.*`：返回它在文本里的范围与限定符。
 *
 * 只在「最后一项就是星号本身」时命中：用户正打在星号后面，
 * 展开（替换星号）才是他想要的；星号出现在列表中间时不打扰。
 * `COUNT(*)` 这类写在括号里的星号不会被命中（整项不是纯星号）。
 */
export function starAtSelectListEnd(listText: string): { text: string, qualifier: string, start: number, end: number } | null {
  const items = splitTopLevelList(listText)
  const raw = items[items.length - 1] ?? ''
  const leading = raw.length - raw.trimStart().length
  const trimmed = raw.trim()
  const match = STAR_ITEM_RE.exec(trimmed)
  if (!match) {
    return null
  }

  const itemStart = listText.length - raw.length + leading
  return {
    text: trimmed,
    qualifier: match[1] ?? '',
    start: itemStart,
    end: itemStart + trimmed.length,
  }
}

// ---------------------------------------------------------------- 其它位置判定

/** 比较运算符后面（含 `IN (`）的列引用：`col = |`、`t.col <> |`、`col LIKE |` */
const COMPARISON_RE = new RegExp(
  '(?:^|[\\s(,])'
  + `(?:(${IDENT})\\s*\\.\\s*)?`
  + `(${IDENT_OR_QUOTED})`
  + '\\s*(?:=|<>|!=|>=|<=|>|<|\\blike\\b|\\bilike\\b|\\bin\\s*\\()'
  + '\\s*$',
  'i',
)

/**
 * 光标前是不是「列 + 比较运算符」。
 *
 * 命中说明此刻要写的是**值**而不是列名，于是可以给比较值候选（词典值域）。
 */
export function comparisonTarget(prefix: string): { qualifier: string, column: string } | null {
  const match = COMPARISON_RE.exec(prefix)
  if (!match) {
    return null
  }
  const column = unquote(match[2] ?? '')
  if (!isIdentifier(column)) {
    return null
  }
  return { qualifier: match[1] ? unquote(match[1]) : '', column }
}

/** INSERT 的目标表：`INSERT INTO db.users (` → { schema: 'db', table: 'users' } */
const INSERT_TARGET_RE = new RegExp(
  `\\binsert\\s+(?:ignore\\s+)?into\\s+((?:${IDENT_OR_QUOTED})(?:\\s*\\.\\s*(?:${IDENT_OR_QUOTED}))?)`,
  'i',
)

/** INSERT 的目标表：`INSERT INTO db.users (` → { schema: 'db', table: 'users' } */
export function insertTargetTable(prefix: string): { schema: string, table: string } | null {
  const match = INSERT_TARGET_RE.exec(prefix)
  if (!match) {
    return null
  }
  const parts = (match[1] ?? '').split('.').map(part => unquote(part))
  if (!parts.length || !isIdentifier(parts[parts.length - 1])) {
    return null
  }
  return {
    schema: parts.length > 1 ? parts[parts.length - 2] : '',
    table: parts[parts.length - 1],
  }
}

// ---------------------------------------------------------------- 候选项构造

/**
 * 片段型候选项：插入内容由 `insert` 决定，`range` 是要替换的文档区间
 * （`from === to` 就是纯插入）。
 *
 * label 仅用于展示与匹配：`*` 展开的 label 就是文档里那个 `*`（或 `u.*`），
 * 这样编辑器按已输入内容过滤时它恰好命中。
 */
export function smartFragmentItem(
  label: string,
  detail: string,
  insert: string,
  range: SmartRange,
): Completion {
  return {
    label,
    type: 'text',
    detail,
    boost: BOOST_SMART_ITEM,
    apply: (view, _completion, _from, _to) => {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert },
        selection: { anchor: range.from + insert.length },
      })
    },
  }
}

/** 数值类型（比较值直接写字面量，不加引号） */
function isNumericType(dataType: string | undefined): boolean {
  return Boolean(dataType)
    && /^(?:tiny|small|medium|big)?int|^integer|^decimal|^numeric|^float|^double|^real|^serial|^bigserial|^money|^bool/i.test(dataType ?? '')
}

/**
 * 比较值候选：值本身作为 label（按已输入内容过滤），插入的是 SQL 字面量。
 *
 * 数值列且值看起来是数字时直接写数字，其余一律交给字面量转义
 * （字符串按方言处理引号与反斜杠）。
 */
export function smartValueItems(
  values: SmartCompareValue[],
  dataType: string | undefined,
  dialect: SqlDialect,
): Completion[] {
  const items: Completion[] = []
  const seen = new Set<string>()

  for (const item of values) {
    const value = item.value
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    const numeric = isNumericType(dataType)
    const literal = numeric && /^-?\d+(?:\.\d+)?$/.test(value)
      ? value
      : formatSqlValue(value, dialect)

    items.push({
      label: value,
      type: 'text',
      detail: [item.source, item.meaning].filter(Boolean).join(' · '),
      boost: BOOST_SMART_ITEM,
      apply: literal,
    })
  }

  return items
}

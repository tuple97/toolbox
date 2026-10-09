/**
 * SQL 结构解析：表引用、派生表、CTE 的输出列。
 *
 * 从补全主模块拆出：这一层是**纯文本解析** —— 需要元数据的地方（`SELECT *` 展开、
 * 派生列的来源与类型）通过 `TableRefOptions` 注入，因此既不依赖编辑器，
 * 也不依赖候选生成，可以单独测。
 *
 * 为什么不用语法树：补全时语句通常还没写完（正打到 `where u.`），
 * 而这套容错扫描对半成品语句更宽容，也能给出「别名 → 表」这类语义。
 */
import type { TextRange } from '@/utils/sql/sqlSyntax'
import {
  IDENT_OR_QUOTED_SOURCE,
  IDENT_SOURCE,
  isIdentBody,
  isIdentStart,
} from './sqlLexemes'

// ---------------------------------------------------------------- 语句解析

/*
 * 本模块用到的复合正则：标识符片段一律取自 sqlLexemes，
 * 于是「别名 / 列名 / 限定名 / 输出列」对中文与带引号写法的认识完全一致。
 */
/** `*` 或 `t.*` */
const STAR_ITEM_RE = new RegExp(`^(?:(${IDENT_SOURCE})\\.)?\\*$`)
/** `expr AS 别名` */
const AS_ALIAS_RE = new RegExp(`\\bas\\s+(${IDENT_OR_QUOTED_SOURCE})\\s*$`, 'i')
/** 输出项末尾的标识符（裸列名或「表达式 别名」的别名） */
const TAIL_IDENT_RE = new RegExp(`(${IDENT_OR_QUOTED_SOURCE})\\s*$`)

/**
 * 派生表 / CTE 的静态输出列。
 *
 * 除了名字，尽量带上来源表与类型：这类列以前在候选里只能显示「派生列」，
 * 看不出它到底来自哪张表、什么类型。
 */
export interface VirtualColumn {
  name: string
  /** 来源表名（物理表 / 上游派生表 / CTE）；静态推不出来时为空 */
  from?: string
  /** 字段类型（来自元数据）；未知为空 */
  dataType?: string
  /** 字段注释（来自元数据） */
  comment?: string
}

/** 表引用：库/模式名（空表示未限定）、表名、别名（空表示无别名） */
export interface TableRef {
  schema: string
  table: string
  alias: string
  /** 派生表 / CTE 静态解析出的输出列；物理表为 undefined，走元数据查询 */
  virtualColumns?: VirtualColumn[]
  /**
   * 表名（`库.表` 整体）与别名声明在**被扫描文本**里的范围。
   *
   * 只对「文本里真写出来的引用」有意义：把无别名 CTE 补登记成来源、
   * 派生表的合成引用都没有位置。补全不关心它们，
   * 而位置敏感的能力（表别名重命名、表结构悬停）必须用它定位 ——
   * 有了范围才能区分「别名声明」与「别名引用」，而不是满文档替换字符串。
   */
  tableRange?: TextRange
  /** 别名声明（`FROM users u` 里的 `u`，含引号）的范围 */
  aliasRange?: TextRange
}

/** 别名位置不能出现的关键字（命中即认为这张表没有别名） */
export const NON_ALIAS_KEYWORDS = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'join',
  'left', 'right', 'inner', 'outer', 'cross', 'full', 'on', 'using', 'set',
  'values', 'as', 'and', 'or', 'when', 'then', 'else', 'end', 'for', 'lock',
  'window', 'qualify', 'into', 'from', 'select', 'with', 'asc', 'desc', 'is',
  'not', 'null', 'in', 'exists', 'straight_join', 'force', 'use', 'ignore',
])

/**
 * 每个字符的括号深度（引号与注释里的括号不算）。
 *
 * 用于「只看本层来源」：深度 > 0 的关键字属于嵌套层，由那一层自己解析。
 */
function parenDepths(text: string): Int8Array {
  const depths = new Int8Array(text.length)
  let depth = 0
  let index = 0

  while (index < text.length) {
    const ch = text[index]

    // 引号 / 注释整体跳过
    if (ch === '\'' || ch === '"' || ch === '`') {
      const end = skipQuoted(text, index)
      depths.fill(depth, index, end)
      index = end
      continue
    }
    if (ch === '-' && text[index + 1] === '-') {
      const lineEnd = text.indexOf('\n', index)
      const end = lineEnd < 0 ? text.length : lineEnd
      depths.fill(depth, index, end)
      index = end
      continue
    }
    if (ch === '/' && text[index + 1] === '*') {
      const blockEnd = text.indexOf('*/', index + 2)
      const end = blockEnd < 0 ? text.length : blockEnd + 2
      depths.fill(depth, index, end)
      index = end
      continue
    }

    if (ch === '(') {
      depths[index] = depth
      depth++
      index++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      depths[index] = depth
      index++
      continue
    }

    depths[index] = depth
    index++
  }

  return depths
}

/** 跳过空白 */
export function skipSpaces(text: string, index: number): number {
  let i = index
  while (i < text.length && /\s/.test(text[i] ?? '')) {
    i++
  }
  return i
}

/**
 * 读取一个标识符，支持裸名字与 `` `x` `` / `"x"` / `[x]` 三种引用
 * （重复引号按转义处理）。读不到时返回 null。
 */
export function readIdentifier(text: string, index: number): { name: string, end: number } | null {
  const quote = text[index]
  if (quote === '`' || quote === '"' || quote === '[') {
    const close = quote === '[' ? ']' : quote
    let i = index + 1
    let name = ''
    while (i < text.length) {
      if (text[i] === close) {
        if (text[i + 1] === close) {
          name += close
          i += 2
          continue
        }
        return { name, end: i + 1 }
      }
      name += text[i]
      i++
    }
    return null
  }

  if (!isIdentStart(text[index] ?? '')) {
    return null
  }
  let i = index + 1
  while (i < text.length && isIdentBody(text[i] ?? '')) {
    i++
  }
  return { name: text.slice(index, i), end: i }
}

/** 读取限定名（最多三段，点号分隔），如 `mydb`.`user` */
export function readQualifiedName(text: string, start: number): { parts: string[], end: number } | null {
  let index = skipSpaces(text, start)
  const first = readIdentifier(text, index)
  if (!first) {
    return null
  }

  const parts = [first.name]
  index = first.end
  for (let i = 0; i < 2; i++) {
    const dot = skipSpaces(text, index)
    if (text[dot] !== '.') {
      break
    }
    const next = readIdentifier(text, skipSpaces(text, dot + 1))
    if (!next) {
      break
    }
    parts.push(next.name)
    index = next.end
  }
  return { parts, end: index }
}

/**
 * 读取别名：`AS x` 或紧跟的裸标识符（关键字不算别名）。
 *
 * `start` / `end` 是别名 token 在文本里的范围（含引号）——
 * 重命名要精确替换声明处，`end` 单独一个不够用。
 */
export function readAlias(
  text: string,
  start: number,
): { alias: string, start: number, end: number } | null {
  const index = skipSpaces(text, start)

  if (/^as\b/i.test(text.slice(index, index + 3))) {
    const from = skipSpaces(text, index + 2)
    const ident = readIdentifier(text, from)
    return ident ? { alias: ident.name, start: from, end: ident.end } : null
  }

  const ident = readIdentifier(text, index)
  if (!ident || NON_ALIAS_KEYWORDS.has(ident.name.toLowerCase())) {
    return null
  }
  return { alias: ident.name, start: index, end: ident.end }
}

/** 表引用解析的可选依赖（由调用方按当前连接提供） */
export interface TableRefOptions {
  /**
   * 只看**本层**的来源（跳过括号里的 FROM / JOIN）。
   *
   * 作用域链已经把嵌套层单独拆出来了：`FROM users u JOIN (SELECT … FROM logs) t`
   * 在这一层只有 `users` 与 `t` 两个来源，`logs` 属于派生表自己那层。
   * 不跳的话本层来源会被算多 —— 「是否多来源」的判断（要不要给列加限定符）
   * 与关联条件配对都会跟着错。
   */
  topLevelOnly?: boolean
  /** 光标所在定义体的 CTE：不作为可见来源（递归自引用） */
  excludeCte?: (name: string) => boolean
  /**
   * 查询物理表的列，用于展开派生表 / CTE 里的 `SELECT *`。
   * 实现方应「同步返回缓存 + 后台补齐」，绝不阻塞输入。
   */
  resolveStarColumns?: (ref: TableRef) => VirtualColumn[] | null
  /**
   * 查询某张表某列的类型 / 注释，用于给派生列附上来源信息。
   * 同样必须同步返回（查不到就返回 null）。
   */
  resolveColumnMeta?: (ref: TableRef, column: string) => { dataType: string, comment: string } | null
  /** 查询 CTE 的输出列（跨层可见的 CTE 由调用方提供） */
  resolveCteColumns?: (name: string) => VirtualColumn[] | null
}

/**
 * 收集语句中的表引用（含别名）。
 *
 * 扫描 FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM 之后的限定名，
 * FROM 后面的逗号多表也支持；`(SELECT …) 别名` 派生表会静态解析出输出列
 * （`SELECT *` 用 resolveStarColumns 展开），WITH 定义的 CTE 按名字登记
 * （`FROM cte`、`FROM cte x` 都能命中）。
 */
export function collectTableRefs(
  statement: string,
  options: TableRefOptions = {},
): TableRef[] {
  const refs: TableRef[] = []

  /*
   * CTE 先解析：派生表内部可能引用同层 CTE（`FROM (SELECT * FROM cte) x`），
   * 而 CTE 的列又要用 `*` 展开，所以这份映射必须在扫描表引用之前就绪。
   * 这里只解析**本层**文本能看到的定义；跨层可见性由 buildScopes 用
   * visibleCtes 回填（子查询能引用外层的 CTE）。
   */
  const ctes = new Map<string, VirtualColumn[] | null>()
  for (const def of collectCteDefs(statement, 0, () => null, options)) {
    // 光标所在的定义体（递归 CTE 自引用）由调用方排除，避免拿自己当可见来源
    if (options.excludeCte?.(def.name)) {
      continue
    }
    const key = def.name.toLowerCase()
    if (!ctes.has(key)) {
      ctes.set(key, def.columns)
    }
  }

  /** 展开 `*` 时查列：先 CTE，再物理表元数据 */
  const lookupColumns = (name: string): VirtualColumn[] | null => {
    const columns = ctes.get(name.toLowerCase())
    return columns ?? options.resolveStarColumns?.({ schema: '', table: name, alias: '' }) ?? null
  }

  /** 按名字取 CTE 输出列：本层定义优先，其次交给调用方（跨层可见的 CTE） */
  const cteColumnsOf = (name: string): VirtualColumn[] | null =>
    ctes.get(name.toLowerCase()) ?? options.resolveCteColumns?.(name) ?? null

  const intro = /\b(?:from|join|update|insert\s+into|delete\s+from)\b/gi

  /** 只看本层来源时，用括号深度表过滤掉嵌套层的关键字 */
  const depths = options.topLevelOnly ? parenDepths(statement) : null

  for (const match of statement.matchAll(intro)) {
    const at = match.index ?? 0
    if (depths && depths[at] > 0) {
      continue
    }

    let index = at + match[0].length
    // FROM / JOIN 后面可以是逗号分隔的多张表
    for (;;) {
      const probe = skipSpaces(statement, index)

      // 派生表：(SELECT …) 别名
      if (statement[probe] === '(') {
        const bodyStart = skipSpaces(statement, probe + 1)
        if (!/^select\b/i.test(statement.slice(bodyStart, bodyStart + 7))) {
          break
        }
        const close = matchParen(statement, probe)
        if (close < 0) {
          break
        }
        const alias = readAlias(statement, skipSpaces(statement, close + 1))
        if (alias) {
          const body = statement.slice(probe + 1, close)
          // 内层表引用：把输出列溯源到具体来源表（限定符匹配 / 单表归属）
          const innerRefs = collectTableRefs(body, {
            resolveStarColumns: options.resolveStarColumns,
            resolveColumnMeta: options.resolveColumnMeta,
            resolveCteColumns: options.resolveCteColumns,
          })
          refs.push({
            schema: '',
            table: alias.alias,
            alias: alias.alias,
            // `SELECT *` 用内层来源表的列展开；展不开时按「列未知」处理
            virtualColumns: parseSelectOutputColumns(
              body,
              qualifier => starColumnsOf(body, lookupColumns, qualifier),
              (qualifier, column) => resolveColumnOf(innerRefs, qualifier, column, options),
            ) ?? undefined,
            // 派生表没有「表名」，别名就是它的名字：两者指向同一段文本
            tableRange: { from: alias.start, to: alias.end },
            aliasRange: { from: alias.start, to: alias.end },
          })
        }
        index = alias ? alias.end : close + 1

        const next = skipSpaces(statement, index)
        if (statement[next] === ',') {
          index = next + 1
          continue
        }
        break
      }

      const nameStart = skipSpaces(statement, index)
      const name = readQualifiedName(statement, nameStart)
      if (!name) {
        break
      }
      const alias = readAlias(statement, name.end)
      const ref = toTableRef(name.parts, alias?.alias ?? '')
      // 位置只对「文本里真写出来的引用」记录（合成来源不带）
      ref.tableRange = { from: nameStart, to: name.end }
      if (alias) {
        ref.aliasRange = { from: alias.start, to: alias.end }
      }
      refs.push(ref)
      index = alias?.end ?? name.end

      const next = skipSpaces(statement, index)
      if (statement[next] !== ',') {
        break
      }
      index = next + 1
    }
  }

  // CTE 的物理引用（FROM cte x）升级为虚拟表，并补登记无别名引用的 CTE 名
  const named: TableRef[] = []
  for (const ref of refs) {
    if (ref.schema) {
      continue
    }
    const columns = cteColumnsOf(ref.table)
    if (!columns) {
      continue
    }
    ref.virtualColumns ??= columns
    if (ref.alias && ref.alias.toLowerCase() !== ref.table.toLowerCase()) {
      named.push({ schema: '', table: ref.table, alias: '', virtualColumns: ref.virtualColumns })
    }
  }
  refs.push(...named)
  for (const [name, columns] of ctes) {
    const exists = refs.some(ref =>
      ref.table.toLowerCase() === name || ref.alias.toLowerCase() === name)
    if (!exists) {
      refs.push({ schema: '', table: name, alias: '', virtualColumns: columns ?? undefined })
    }
  }

  return refs
}

/**
 * 把派生表里的一个列引用溯源到来源表。
 *
 *  - 带限定符（`u.name`）：在该层的表引用里按别名 / 表名匹配；
 *  - 不带限定符：只有该层恰好只有一个来源时才敢归属（多表时归属谁都是猜）；
 *  - 来源本身是派生表 / CTE 时直接继承它已解析出的列（连带来源与类型）。
 */
export function resolveColumnOf(
  refs: TableRef[],
  qualifier: string,
  column: string,
  options: TableRefOptions,
): VirtualColumn | null {
  const wanted = qualifier.toLowerCase()
  const source = wanted
    ? refs.find(ref => ref.alias.toLowerCase() === wanted || ref.table.toLowerCase() === wanted)
    : refs.length === 1
      ? refs[0]
      : undefined
  if (!source) {
    return null
  }

  const inherited = source.virtualColumns?.find(
    item => item.name.toLowerCase() === column.toLowerCase(),
  )
  if (inherited) {
    return inherited
  }

  const meta = options.resolveColumnMeta?.(source, column)
  return meta
    ? { name: column, from: source.table, dataType: meta.dataType, comment: meta.comment }
    : { name: column, from: source.table }
}

// ---------------------------------------------------------------- 列别名

/** SELECT 列表里声明的列别名（位置敏感：列别名重命名用） */
export interface OutputAlias {
  /** 别名（已去引号） */
  name: string
  /** 别名 token 的范围（含引号） */
  nameRange: TextRange
}

/** 顶层（括号与字符串之外）SELECT 关键字的位置；没有返回 -1 */
function findTopLevelSelect(text: string): number {
  for (const match of text.matchAll(/\bselect\b/gi)) {
    const index = match.index ?? 0
    if (isTopLevel(text, 0, index)) {
      return index
    }
  }
  return -1
}

/**
 * 收集**顶层 SELECT 列表**里的列别名声明。
 *
 * 只认真正写了别名的输出项（`a AS b` / 表达式后的 `b`），因为重命名要动的是
 * 这个标识符；裸列名（`SELECT name`）与 `*` / `t.*` 一律不算 ——
 * 把「列名」当成「别名」改掉是最糟的错，宁可不提供。
 *
 * `offset` 是这段文本在文档里的起点，返回的是**文档坐标**。
 */
export function collectOutputAliases(statement: string, offset: number): OutputAlias[] {
  const selectAt = findTopLevelSelect(statement)
  if (selectAt < 0) {
    return []
  }
  const listStart = selectAt + 'select'.length
  const fromAt = findTopLevelFrom(statement, listStart)
  const listEnd = fromAt < 0 ? statement.length : fromAt

  const aliases: OutputAlias[] = []
  for (const item of splitTopLevelRanges(statement, listStart, listEnd)) {
    const parsed = outputAliasOf(statement.slice(item.from, item.to))
    if (!parsed) {
      continue
    }
    aliases.push({
      name: parsed.name,
      nameRange: {
        from: offset + item.from + parsed.at,
        to: offset + item.from + parsed.end,
      },
    })
  }
  return aliases
}

/** 按顶层逗号切分并**保留位置**（`splitTopLevel` 只给字符串，重命名需要坐标） */
function splitTopLevelRanges(text: string, from: number, to: number): TextRange[] {
  const ranges: TextRange[] = []
  let start = from
  let depth = 0
  let i = from
  while (i < to) {
    const ch = text[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    }
    else if (ch === ',' && depth === 0) {
      ranges.push({ from: start, to: i })
      start = i + 1
    }
    i++
  }
  ranges.push({ from: start, to })
  return ranges
}

const BARE_IDENT_RE = new RegExp(`^${IDENT_SOURCE}$`)
const QUALIFIED_IDENT_RE = new RegExp(`^${IDENT_SOURCE}\\s*\\.\\s*${IDENT_SOURCE}$`)

/**
 * 一个输出项里声明的别名（偏移相对该输出项）；没有别名返回 null。
 *
 * 显式 `AS` 优先；隐式别名要求「标识符前面确实还有表达式」，
 * 且末尾标识符不在关键字黑名单里（`CASE … END` 的 END 不是别名）。
 */
function outputAliasOf(item: string): { name: string, at: number, end: number } | null {
  const trimmed = item.trim()
  if (!trimmed || STAR_ITEM_RE.test(trimmed)) {
    return null
  }

  const asMatch = AS_ALIAS_RE.exec(item)
  if (asMatch) {
    const raw = asMatch[1]
    const at = (asMatch.index ?? 0) + asMatch[0].lastIndexOf(raw)
    return { name: unquoteIdent(raw), at, end: at + raw.length }
  }

  // 裸列名 / 限定列名：本来就没有别名
  if (BARE_IDENT_RE.test(trimmed) || QUALIFIED_IDENT_RE.test(trimmed)) {
    return null
  }

  const tail = TAIL_IDENT_RE.exec(item)
  if (!tail) {
    return null
  }
  const raw = tail[1]
  const name = unquoteIdent(raw)
  if (NON_ALIAS_KEYWORDS.has(name.toLowerCase())) {
    return null
  }
  if (!item.slice(0, tail.index).trim()) {
    return null
  }
  const at = (tail.index ?? 0) + tail[0].lastIndexOf(raw)
  return { name, at, end: at + raw.length }
}

/** 限定名各段 → 表引用；三段及以上时取最后两段（库/模式 + 表） */
export function toTableRef(parts: string[], alias: string): TableRef {
  const table = parts.length ? parts[parts.length - 1] : ''
  const schema = parts.length > 1 ? parts[parts.length - 2] : ''
  return { schema, table, alias }
}

// ------------------------------------------------- 派生表 / CTE 的输出列解析

/** 跳过引号包裹的字符串/标识符，返回结束引号之后的下标（未闭合则返回文本长度） */
export function skipQuoted(text: string, start: number): number {
  const quote = text[start] ?? ''
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return text.length
}

/** 找到与 start 处 `(` 配对的 `)` 下标；找不到返回 -1 */
export function matchParen(text: string, start: number): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === `'` || ch === `"` || ch === '`') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        return i
      }
    }
    i++
  }
  return -1
}

/** 判断 [start, end) 之间的括号是否全部闭合（即 end 处于顶层） */
export function isTopLevel(text: string, start: number, end: number): boolean {
  let depth = 0
  let i = start
  while (i < end) {
    const ch = text[i] ?? ''
    if (ch === `'` || ch === `"` || ch === '`') {
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
  return depth === 0
}

/** 从 start 起找第一个顶层（括号与字符串之外）的 FROM 关键字；没有返回 -1 */
export function findTopLevelFrom(text: string, start: number): number {
  for (const match of text.slice(start).matchAll(/\bfrom\b/gi)) {
    const index = start + (match.index ?? 0)
    if (isTopLevel(text, start, index)) {
      return index
    }
  }
  return -1
}

/** 按顶层逗号切分（括号与字符串内的逗号不算） */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let last = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === `'` || ch === `"` || ch === '`') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth--
    }
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(last, i))
      last = i + 1
    }
    i++
  }
  parts.push(text.slice(last))
  return parts
}

/** 去掉标识符的包裹引号 */
export function unquoteIdent(name: string): string {
  return name.replace(/^[`"[]/, '').replace(/[`"\]]$/, '')
}

/** 一处 CTE 定义：名字、输出列（解析不出为 null）与定义体在文档中的范围 */
export interface CteDef {
  name: string
  /**
   * CTE 名字本身的范围（文档坐标，**含引号**）。
   *
   * 位置敏感的能力（CTE 重命名、将来跳转定义）用它定位声明：
   * 只能声明处与引用处都精确命中才动，不做字符串替换。
   */
  nameRange: TextRange
  columns: VirtualColumn[] | null
  /** 定义体 `( … )` 的起始位置（文档坐标，含括号内第一个字符） */
  bodyFrom: number
  /** 定义体 `( … )` 的结束位置（文档坐标，指向 `)`） */
  bodyTo: number
}

/**
 * 解析一段文本里的 CTE 定义：`WITH [RECURSIVE] name [(列, …)] AS (SELECT …), …`。
 *
 * 相比最初的实现，这里补齐了三件事：
 *  - **多处 WITH 都处理**（原来是拿到一处就 break），且只认顶层的 WITH，
 *    子查询里的 WITH 属于更内层的作用域，由那一层自己解析；
 *  - **递归 CTE**：显式列清单先入表，再解析定义体，于是体内 `FROM t` 有列可用；
 *    无列清单时用 SELECT 输出列预注册（可能不准，允许退化）；
 *  - **依赖链**：按声明顺序解析，`WITH a AS (…), b AS (SELECT * FROM a)`
 *    里 `b` 的 `*` 会用 `a` 的输出列展开。
 *
 * @param offset       该段文本在文档中的起点，用于把定义体范围换算成文档坐标
 * @param resolveKnown 查询「本层之外」已可见的 CTE 列（跨层广播用）
 */
export function collectCteDefs(
  statement: string,
  offset: number,
  resolveKnown: (name: string) => VirtualColumn[] | null,
  options: TableRefOptions = {},
): CteDef[] {
  const defs: CteDef[] = []
  /** 本层已解析出的 CTE（声明顺序），供依赖链与递归引用 */
  const known = new Map<string, VirtualColumn[] | null>()

  /**
   * CTE 定义体里 `SELECT *` 的列来源：
   * 本层已解析的 CTE → 外部（跨层）已知 CTE → 物理表元数据。
   */
  const lookupColumns = (name: string): VirtualColumn[] | null =>
    known.get(name.toLowerCase())
    ?? resolveKnown(name)
    ?? options.resolveStarColumns?.({ schema: '', table: name, alias: '' })
    ?? null

  for (const match of statement.matchAll(/\bwith\b/gi)) {
    const start = match.index ?? 0
    // 只处理顶层 WITH：括号内的 WITH 属于更内层作用域
    if (!isTopLevel(statement, 0, start)) {
      continue
    }

    let index = skipSpaces(statement, start + match[0].length)
    const recursive = /^recursive\b/i.test(statement.slice(index, index + 10))
    if (recursive) {
      index = skipSpaces(statement, index + 9)
    }

    for (;;) {
      // readIdentifier 只回 end：名字起点就是传进去的 index（已跳空白）
      const nameStart = index
      const name = readIdentifier(statement, index)
      if (!name || NON_ALIAS_KEYWORDS.has(name.name.toLowerCase())) {
        break
      }
      index = skipSpaces(statement, name.end)

      // 显式列清单：WITH n(a, b) AS (…) —— 只有名字，没有来源与类型
      let declared: VirtualColumn[] | null = null
      if (statement[index] === '(') {
        const close = matchParen(statement, index)
        if (close < 0) {
          break
        }
        declared = splitTopLevel(statement.slice(index + 1, close))
          .map(part => unquoteIdent(part.trim()))
          .filter(Boolean)
          .map(name => ({ name }))
        index = skipSpaces(statement, close + 1)
      }

      if (!/^as\b/i.test(statement.slice(index, index + 3))) {
        break
      }
      index = skipSpaces(statement, index + 2)
      if (statement[index] !== '(') {
        break
      }
      const bodyStart = index + 1
      const bodyEnd = matchParen(statement, index)
      if (bodyEnd < 0) {
        break
      }
      const body = statement.slice(bodyStart, bodyEnd)

      // 递归 / 有显式列清单：先把自己入表，体内 `FROM t` 才有列可用
      if (recursive || declared) {
        known.set(name.name.toLowerCase(), declared)
      }
      // 定义体内部的表引用：把输出列溯源到来源表（CTE 走 lookup，物理表查元数据）
      const bodyRefs = collectTableRefs(body, {
        resolveColumnMeta: options.resolveColumnMeta,
        resolveCteColumns: name => lookupColumns(name),
      })
      const columns = declared ?? parseSelectOutputColumns(
        body,
        qualifier => starColumnsOf(body, lookupColumns, qualifier),
        (qualifier, column) => resolveColumnOf(bodyRefs, qualifier, column, options),
      )
      known.set(name.name.toLowerCase(), columns)

      defs.push({
        name: name.name,
        nameRange: { from: offset + nameStart, to: offset + name.end },
        columns,
        bodyFrom: offset + bodyStart,
        bodyTo: offset + bodyEnd,
      })

      index = skipSpaces(statement, bodyEnd + 1)
      if (statement[index] === ',') {
        index = skipSpaces(statement, index + 1)
        continue
      }
      break
    }
  }

  return defs
}

/**
 * `SELECT *` / `t.*` 的展开来源：从 FROM 引用的表里找已解析出列的表（CTE 或物理表）。
 *
 * `qualifier` 非空时（`t.*` 写法）优先精确匹配该别名 / 表名；
 * 都找不到就返回 null（列未知），由调用方按「不猜」处理。
 */
export function starColumnsOf(
  selectText: string,
  lookup: (name: string) => VirtualColumn[] | null,
  qualifier = '',
): VirtualColumn[] | null {
  const fromIndex = findTopLevelFrom(selectText, 0)
  if (fromIndex < 0) {
    return null
  }

  const refs = collectTableRefs(selectText.slice(fromIndex), {
    topLevelOnly: true,
    // 嵌套派生表（`SELECT * FROM (SELECT * FROM t) x`）的展开也要能查到元数据
    resolveStarColumns: ref => lookup(ref.table),
  })
  const wanted = qualifier.toLowerCase()
  const ordered = wanted
    ? [
        ...refs.filter(ref =>
          ref.alias.toLowerCase() === wanted || ref.table.toLowerCase() === wanted),
        ...refs,
      ]
    : refs

  for (const ref of ordered) {
    /*
     * 派生表 / CTE 在 collectTableRefs 里已经解析出自己的列（ref.virtualColumns），
     * 直接用；物理表才走 lookup 查元数据。只查 lookup 的话，
     * `SELECT * FROM (SELECT * FROM t) x` 这类嵌套派生会在这里断掉。
     */
    const columns = ref.virtualColumns ?? lookup(ref.table)
    if (columns) {
      return columns
    }
  }
  return null
}

/** SELECT 输出项：列名 + 可能的列引用（用于溯源到来源表） */
export interface OutputItem {
  /** 输出列名（有别名时取别名） */
  name: string
  /** 列引用里的限定符（`t.col` 的 t）；不是列引用时为空 */
  qualifier: string
  /** 列引用里的列名；不是列引用时为空 */
  column: string
}

/**
 * 解析一段 SELECT 的输出列（用于派生表 / CTE）。
 *
 * 名字只接受可静态确定的形式：`expr AS 别名`、`t.col`、别名跟随、裸列名；
 * `*` / `t.*` 交给 `resolveStar` 展开（参数是限定符，空串表示裸 `*`）；
 * 其它无法命名的表达式（如不带别名的 `COUNT(*)`）返回 null，按「列未知」处理。
 *
 * `resolveColumn` 用于把列引用溯源到来源表与字段类型：
 * 单表来源、或列上写了限定符时才敢归属。
 */
export function parseSelectOutputColumns(
  selectText: string,
  resolveStar?: (qualifier: string) => VirtualColumn[] | null,
  resolveColumn?: (qualifier: string, column: string) => VirtualColumn | null,
): VirtualColumn[] | null {
  const selectMatch = /\bselect\b/i.exec(selectText)
  if (!selectMatch) {
    return null
  }

  const listStart = selectMatch.index + selectMatch[0].length
  const listEnd = findTopLevelFrom(selectText, listStart)
  const rawList = selectText.slice(listStart, listEnd < 0 ? selectText.length : listEnd).trim()
  const distinct = /^(distinct|all)\b/i.exec(rawList)
  const list = (distinct ? rawList.slice(distinct[0].length) : rawList).trim()
  if (!list) {
    return null
  }

  const columns: VirtualColumn[] = []
  for (const item of splitTopLevel(list)) {
    const trimmed = item.trim()
    // `*` / `t.*`：能展开就展开（限定符交给回调定位来源表），展不开视为列未知（绝不猜）
    const star = STAR_ITEM_RE.exec(trimmed)
    if (star) {
      const expanded = resolveStar?.(star[1] ?? '')
      if (!expanded) {
        return null
      }
      columns.push(...expanded)
      continue
    }

    const output = readOutputItem(trimmed)
    if (!output) {
      return null
    }
    // 只有列引用才溯源；`COUNT(*) AS c` 这类表达式只有名字
    const traced = output.column
      ? resolveColumn?.(output.qualifier, output.column)
      : null
    columns.push(traced ? { ...traced, name: output.name } : { name: output.name })
  }
  return columns
}

/**
 * 读取 SELECT 输出项；无法静态确定名字时返回 null。
 *
 * 支持 `expr AS 别名`、`t.col`（取最后一段）、`表达式 别名`（别名跟随）、裸列名，
 * 并尽量识别出其中的「列引用」，供上层溯源来源表与类型。
 */
export function readOutputItem(item: string): OutputItem | null {
  const asMatch = AS_ALIAS_RE.exec(item)
  if (asMatch) {
    const name = unquoteIdent(asMatch[1])
    const ref = readColumnRef(item.slice(0, asMatch.index))
    return { name, qualifier: ref?.qualifier ?? '', column: ref?.column ?? '' }
  }

  const tail = TAIL_IDENT_RE.exec(item)
  if (!tail) {
    return null
  }
  const token = tail[1]
  const before = item.slice(0, tail.index).trimEnd()

  // t.col / db.t.col：最后一段就是列名
  if (before.endsWith('.')) {
    const ref = readColumnRef(item)
    return ref ? { name: ref.column, qualifier: ref.qualifier, column: ref.column } : null
  }

  // 整项就是一列（可能带引号）
  if (!before) {
    const name = unquoteIdent(token)
    return { name, qualifier: '', column: name }
  }

  // 别名跟随：要求前一个非空白字符是标识符/右括号/引号，
  // 排除 `a + b` 这类以运算符收尾的表达式；`CASE … END` 等关键字不算
  const prevChar = before.slice(-1)
  if (
    /\s$/.test(item.slice(0, tail.index))
    && /[\w$)\]`"]/.test(prevChar)
    && !NON_ALIAS_KEYWORDS.has(token.toLowerCase())
  ) {
    const ref = readColumnRef(before)
    return { name: unquoteIdent(token), qualifier: ref?.qualifier ?? '', column: ref?.column ?? '' }
  }

  return null
}

/**
 * 把一段文本识别成列引用（`col` / `t.col` / `db.t.col`）。
 * 不是纯粹的限定名（含函数、运算符、字面量等）时返回 null。
 */
export function readColumnRef(text: string): { qualifier: string, column: string } | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  const parsed = readQualifiedName(trimmed, 0)
  if (!parsed || parsed.end !== trimmed.length || !parsed.parts.length) {
    return null
  }
  const parts = parsed.parts
  return {
    column: parts[parts.length - 1],
    qualifier: parts.length >= 2 ? parts[parts.length - 2] : '',
  }
}

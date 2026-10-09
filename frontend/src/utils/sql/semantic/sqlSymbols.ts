/**
 * SQL 语义符号：位置 → 符号（表 / 表别名）→ 引用集合。
 *
 * 这是 Rename / Table Hover（将来还有跳转定义、Ctrl+点击）共用的**唯一**别名解析入口：
 * 补全、重命名、悬停都消费它，不再各写一套「扫 alias 的正则」。
 *
 * 全部建立在既有的两套基础设施之上：
 *  - 结构扫描 `sqlSchema.collectTableRefs`（FROM / JOIN / INSERT INTO … 的表与别名，
 *    现在带**声明位置**）；
 *  - 作用域链 `sqlSyntax.scopeRanges`（内层子查询 → 外层语句）。
 * 因此天然满足：内层作用域优先（同名别名遮蔽）、字符串 / 注释不算引用、
 * 相关子查询里外层别名可见。
 *
 * 原则：**拿不准就返回 null** —— 调用方据此不提供功能，而不是猜着改 SQL。
 */
import type { EditorState } from '@codemirror/state'
import { inLiteralOrComment, scopeRanges } from '@/utils/sql/sqlSyntax'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { collectCteDefs, collectOutputAliases, collectTableRefs, readIdentifier } from '../sqlSchema'
import type { CteDef, OutputAlias, TableRef } from '../sqlSchema'
import { scanClause } from '../sqlCursor'
import { statementAtCursor } from '../sqlStatementRanges'

/** 一个作用域里的表引用（内 → 外排列，范围已换算成文档绝对坐标） */
export interface SqlScopeSources {
  /** 作用域范围（子查询体或整条语句） */
  range: TextRange
  /** 该层的表引用 */
  refs: TableRef[]
}

/** 表别名声明的符号 */
export interface SqlTableAliasSymbol {
  kind: 'table-alias'
  /** 稳定身份：用声明位置生成，**不用显示文本**（同名别名到处都是） */
  id: string
  /** 别名（已去引号） */
  name: string
  /** 别名指向的表 */
  tableName: string
  schema: string
  /** 别名声明范围（`FROM users u` 里的 `u`） */
  declarationRange: TextRange
  /** 表名范围（派生表时与声明范围相同） */
  nameRange: TextRange
  /** 声明所在的作用域 */
  scopeRange: TextRange
  /** 声明所在的语句 */
  statementRange: TextRange
  /**
   * 别名指向的来源是不是**派生表 / CTE**（没有物理定义）。
   *
   * 悬停要据此决定给不给「复制建表语句」，所以这个标记必须跟着符号走：
   * `FROM (SELECT …) t` 的 `t` 与 `FROM users t` 的 `t` 长得一样，
   * 只有解析结果能区分。
   */
  virtual: boolean
}

/** 物理表符号（写在 SQL 里的表名本身） */
export interface SqlTableSymbol {
  kind: 'table'
  id: string
  tableName: string
  schema: string
  /** 表名范围（通过别名解析出来时是别名声明的范围） */
  nameRange: TextRange
  statementRange: TextRange
  /** 该来源是否只有静态解析出的列（派生表 / CTE）：悬停第一版不处理 */
  virtual: boolean
}

/** CTE 名字符号（`WITH recent AS (…)` 里的 recent） */
export interface SqlCteSymbol {
  kind: 'cte'
  /** 稳定身份：用声明位置生成 */
  id: string
  /** CTE 名（已去引号） */
  name: string
  /** 声明范围（`WITH` 后面的名字，含引号） */
  declarationRange: TextRange
  /** 声明所在的语句 */
  statementRange: TextRange
}

/** 列别名符号（`SELECT u.name AS 姓名` 里的 姓名） */
export interface SqlColumnAliasSymbol {
  kind: 'column-alias'
  /** 稳定身份：用声明位置生成 */
  id: string
  /** 别名（已去引号） */
  name: string
  /** 声明范围（含引号） */
  declarationRange: TextRange
  /** 别名所在的那条语句 */
  statementRange: TextRange
}

export type SqlSymbol = SqlTableAliasSymbol | SqlTableSymbol | SqlCteSymbol | SqlColumnAliasSymbol

/** 范围是否包含另一个范围（用于「光标在这个词上」判定） */
function containsRange(outer: TextRange, inner: TextRange): boolean {
  return inner.from >= outer.from && inner.to <= outer.to
}

/** 把结构扫描得到的相对范围换算成文档绝对范围 */
function shiftRef(ref: TableRef, offset: number): TableRef {
  return {
    ...ref,
    tableRange: ref.tableRange && { from: ref.tableRange.from + offset, to: ref.tableRange.to + offset },
    aliasRange: ref.aliasRange && { from: ref.aliasRange.from + offset, to: ref.aliasRange.to + offset },
  }
}

/**
 * 位置处的作用域链（内 → 外），每层带上该层的表引用（含绝对位置）。
 *
 * 不查元数据：`SELECT *` 不展开、派生列不溯源 —— 位置敏感的能力
 * （重命名、悬停定位）只需要「哪个别名在哪、属于哪张表」。
 */
export function scopesAt(state: EditorState, pos: number, dbType = ''): SqlScopeSources[] {
  const doc = state.doc.toString()
  /*
   * 语义层用**真实语句**（`statementAtCursor`），不掺补全的编辑器意图：
   * 补全为了「空行后接着写新 SQL」会把范围前移，那是 completion 的产品规则；
   * 重命名 / 悬停 / 定位必须停在真实 SQL statement 上。
   */
  const statement = statementAtCursor(doc, pos, dbType)
  return scopeRanges(state, pos, doc, dbType, statement).map(range => ({
    range,
    refs: collectTableRefs(doc.slice(range.from, range.to)).map(ref => shiftRef(ref, range.from)),
  }))
}

/**
 * 在作用域链里按限定符找可见来源：**内层优先**（同名别名遮蔽外层）。
 *
 * 与补全的点号解析同一套语义，区别是这里明确「跨层查找」——
 * 相关子查询里 `u.id` 的 `u` 可能声明在外层，只看最内层会漏。
 */
export function resolveVisibleSource(
  scopes: SqlScopeSources[],
  qualifier: string,
): TableRef | null {
  const wanted = qualifier.toLowerCase()
  if (!wanted) {
    return null
  }
  for (const scope of scopes) {
    const hit = scope.refs.find(ref =>
      ref.alias.toLowerCase() === wanted || ref.table.toLowerCase() === wanted)
    if (hit) {
      return hit
    }
  }
  return null
}

/** 由「带位置的表引用」组装别名符号 */
function aliasSymbolOf(
  ref: TableRef,
  declaration: TextRange,
  scopeRange: TextRange,
  statementRange: TextRange,
): SqlTableAliasSymbol {
  return {
    kind: 'table-alias',
    id: `alias:${declaration.from}-${declaration.to}`,
    name: ref.alias,
    tableName: ref.table,
    schema: ref.schema,
    declarationRange: declaration,
    nameRange: ref.tableRange ?? declaration,
    scopeRange,
    statementRange,
    virtual: Boolean(ref.virtualColumns),
  }
}

/** 派生表的「表名」与别名是同一段文本（`(SELECT …) t` 里的 t） */
function isDerivedShorthand(ref: TableRef): boolean {
  return Boolean(
    ref.tableRange && ref.aliasRange
    && ref.tableRange.from === ref.aliasRange.from
    && ref.tableRange.to === ref.aliasRange.to,
  )
}

/**
 * 解析位置上的**表别名**符号。
 *
 * 两条路径，都必须精确命中：
 *  1. 光标落在某个别名声明上（`FROM users u` 的 `u`）；
 *  2. 光标落在「别名 + 点号」的限定符上（`SELECT u.id` 的 `u`），
 *     用可见来源解析回它的声明 —— 顺带保证同名遮蔽不会串到别的表。
 * 其余情况返回 null：列别名（`AS u`）、字符串、注释、表名都不是表别名。
 */
export function resolveTableAliasAtPosition(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlTableAliasSymbol | null {
  const word = state.wordAt(pos)
  if (!word) {
    return null
  }
  if (inLiteralOrComment(state, pos)) {
    return null
  }

  const doc = state.doc.toString()
  const scopes = scopesAt(state, pos, dbType)
  const statementRange = scopes[scopes.length - 1]?.range
  if (!statementRange) {
    return null
  }

  // 1) 声明处
  for (const scope of scopes) {
    const ref = scope.refs.find(item => item.aliasRange && containsRange(item.aliasRange, word))
    if (ref?.aliasRange) {
      return aliasSymbolOf(ref, ref.aliasRange, scope.range, statementRange)
    }
  }

  // 2) 引用处（限定符）：右边必须紧跟点号，否则可能是列别名 / 普通标识符
  if (doc.slice(word.to, word.to + 1) !== '.') {
    return null
  }
  const visible = resolveVisibleSource(scopes, doc.slice(word.from, word.to))
  if (!visible?.aliasRange) {
    return null
  }
  // 声明所在的那一层（可能就是外层作用域）
  const declaring = scopes.find(scope => scope.refs.includes(visible)) ?? scopes[0]
  return aliasSymbolOf(visible, visible.aliasRange, declaring.range, statementRange)
}

/** 解析位置上的**物理表**符号（表名本身，或别名指向的表） */
export function resolveTableAtPosition(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlTableSymbol | null {
  const word = state.wordAt(pos)
  if (!word || inLiteralOrComment(state, pos)) {
    return null
  }

  const scopes = scopesAt(state, pos, dbType)
  const statementRange = scopes[scopes.length - 1]?.range
  if (!statementRange) {
    return null
  }

  // 1) 表名（派生表的「表名」就是别名，交给别名分支处理）
  for (const scope of scopes) {
    const ref = scope.refs.find(item =>
      item.tableRange && containsRange(item.tableRange, word) && !isDerivedShorthand(item))
    if (ref?.tableRange) {
      return {
        kind: 'table',
        id: `table:${ref.schema ? `${ref.schema}.` : ''}${ref.table}`,
        tableName: ref.table,
        schema: ref.schema,
        nameRange: ref.tableRange,
        statementRange,
        virtual: Boolean(ref.virtualColumns),
      }
    }
  }

  // 2) 别名 → 它指向的表（悬停 `u` 要看到 users 的结构）
  const alias = resolveTableAliasAtPosition(state, pos, dbType)
  if (!alias) {
    return null
  }
  return {
    kind: 'table',
    id: `table:${alias.schema ? `${alias.schema}.` : ''}${alias.tableName}`,
    tableName: alias.tableName,
    schema: alias.schema,
    nameRange: alias.declarationRange,
    statementRange: alias.statementRange,
    // 派生表 / CTE 的别名同样没有物理定义
    virtual: alias.virtual,
  }
}

/** 统一入口：位置上的符号（别名 → CTE → 列别名 → 物理表，具体优先于泛化） */
export function resolveSymbolAtPosition(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlSymbol | null {
  return resolveTableAliasAtPosition(state, pos, dbType)
    ?? resolveCteAtPosition(state, pos, dbType)
    ?? resolveColumnAliasAtPosition(state, pos, dbType)
    ?? resolveTableAtPosition(state, pos, dbType)
}

/**
 * 位置是否在 ORDER BY / GROUP BY 子句里。
 *
 * 复用光标层的反向子句扫描（`scanClause`），不另写一套子句切分 ——
 * 两处对「BY 子句」的认识必须一致，否则补全与重命名会打架。
 */
export function isInsideByClause(doc: string, statementRange: TextRange, pos: number): boolean {
  const scan = scanClause(doc.slice(statementRange.from, pos))
  if (scan.keyword !== 'by') {
    return false
  }
  return scan.previousKeyword === 'group' || scan.previousKeyword === 'order'
}

/** 由输出别名组装列别名符号 */
function columnAliasSymbolOf(
  alias: OutputAlias,
  statementRange: TextRange,
): SqlColumnAliasSymbol {
  return {
    kind: 'column-alias',
    id: `column:${alias.nameRange.from}-${alias.nameRange.to}`,
    name: alias.name,
    declarationRange: alias.nameRange,
    statementRange,
  }
}

/**
 * 解析位置上的**列别名**符号。
 *
 * 两个位置：声明处（`SELECT x AS n` 的 `n`）与引用处（`ORDER BY n` 的 `n`）。
 *
 * 只认 ORDER BY / GROUP BY 里的裸引用：`WHERE n = 1` 里的 `n` 根本不是这个别名
 * （SQL 不允许在 WHERE 里用输出别名），`t.n` 则明确属于某张表。
 * 另外**只处理顶层 SELECT 列表** —— 嵌套子查询自己的别名由它那一层说了算。
 */
export function resolveColumnAliasAtPosition(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlColumnAliasSymbol | null {
  const word = state.wordAt(pos)
  if (!word || inLiteralOrComment(state, pos)) {
    return null
  }

  const scopes = scopesAt(state, pos, dbType)
  const statementRange = scopes[scopes.length - 1]?.range
  if (!statementRange) {
    return null
  }

  const doc = state.doc.toString()
  const wanted = doc.slice(word.from, word.to).toLowerCase()
  const aliases = collectOutputAliases(doc.slice(statementRange.from, statementRange.to), statementRange.from)
  const hit = aliases.find(alias => alias.name.toLowerCase() === wanted)
  if (!hit) {
    return null
  }

  // 1) 声明处
  if (containsRange(hit.nameRange, word)) {
    return columnAliasSymbolOf(hit, statementRange)
  }

  // 2) 引用处：必须是 ORDER BY / GROUP BY 里的裸名字
  if (!isInsideByClause(doc, statementRange, pos)) {
    return null
  }
  return isQualified(doc, word.from, word.to) ? null : columnAliasSymbolOf(hit, statementRange)
}

/** 该标识符是否带限定符（`t.n` 形式，两边任一侧贴着点号） */
function isQualified(doc: string, from: number, to: number): boolean {
  return doc.slice(from - 1, from) === '.' || doc.slice(to, to + 1) === '.'
}

/**
 * 收集列别名的全部引用（不含声明）。
 *
 * 与表别名 / CTE 一样逐 token 扫描，然后用三条判定确认「这里确实是这个别名」：
 * 名字相同、不带限定符、所在子句是 ORDER BY / GROUP BY。
 */
export function getColumnAliasReferences(
  state: EditorState,
  symbol: SqlColumnAliasSymbol,
  dbType = '',
): TextRange[] {
  const doc = state.doc.toString()
  const text = doc.slice(symbol.statementRange.from, symbol.statementRange.to)
  const wanted = symbol.name.toLowerCase()
  const references: TextRange[] = []

  let index = 0
  while (index < text.length) {
    const token = readIdentifier(text, index)
    if (!token) {
      index += 1
      continue
    }
    const from = symbol.statementRange.from + index
    const to = symbol.statementRange.from + token.end
    index = token.end

    if (token.name.toLowerCase() !== wanted || from === symbol.declarationRange.from) {
      continue
    }
    if (inLiteralOrComment(state, from) || isQualified(doc, from, to)) {
      continue
    }
    if (!isInsideByClause(doc, symbol.statementRange, from)) {
      continue
    }
    references.push({ from, to })
  }

  return references
}

/** 由 CTE 定义组装符号 */
function cteSymbolOf(def: CteDef, statementRange: TextRange): SqlCteSymbol {
  return {
    kind: 'cte',
    id: `cte:${def.nameRange.from}-${def.nameRange.to}`,
    name: def.name,
    declarationRange: def.nameRange,
    statementRange,
  }
}

/**
 * 解析位置上的 **CTE 名字**符号。
 *
 * 三个位置都算，且都要精确命中：
 *  1. 声明处（`WITH recent AS`）；
 *  2. 结构位置 —— `FROM recent` / `JOIN recent` 里那个名字；
 *  3. 限定符位置 —— CTE 没起别名时直接写 `recent.id`。
 * `FROM recent r` 之后的 `r.id` 解析到的是**别名** `r`（resolveTableAliasAtPosition 先手
 * 命中），因此重命名 CTE 不会动到别名引用，反之亦然。
 */
export function resolveCteAtPosition(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlCteSymbol | null {
  const word = state.wordAt(pos)
  if (!word || inLiteralOrComment(state, pos)) {
    return null
  }

  const scopes = scopesAt(state, pos, dbType)
  const statementRange = scopes[scopes.length - 1]?.range
  if (!statementRange) {
    return null
  }

  const doc = state.doc.toString()
  const text = doc.slice(word.from, word.to)
  const defs = collectCteDefs(
    doc.slice(statementRange.from, statementRange.to),
    statementRange.from,
    () => null,
  )
  const def = defs.find(item => item.name.toLowerCase() === text.toLowerCase())
  if (!def) {
    return null
  }

  // 1) 声明处
  if (containsRange(def.nameRange, word)) {
    return cteSymbolOf(def, statementRange)
  }

  // 2) FROM / JOIN 里的名字（限定名 `库.表` 是物理表，不算）
  for (const scope of scopes) {
    const hit = scope.refs.find(ref =>
      ref.tableRange
      && containsRange(ref.tableRange, word)
      && !ref.schema
      && ref.table.toLowerCase() === def.name.toLowerCase())
    if (hit) {
      return cteSymbolOf(def, statementRange)
    }
  }

  // 3) 限定符：右边必须是点号，且可见来源就是这个 CTE 本身（没有被别名遮蔽）
  if (doc.slice(word.to, word.to + 1) !== '.') {
    return null
  }
  const visible = resolveVisibleSource(scopes, text)
  if (!visible || visible.schema || visible.alias) {
    return null
  }
  return visible.table.toLowerCase() === def.name.toLowerCase()
    ? cteSymbolOf(def, statementRange)
    : null
}

/**
 * 收集某个表别名符号的全部**引用**（不含声明）。
 *
 * 只认「别名 + 点号」这种限定符引用，因此天然不会碰到：
 *  - 列别名（`username AS u`）、字符串、注释（另有 inLiteralOrComment 兜底）；
 *  - 另一个作用域里的同名别名（用可见来源的**身份**比对，
 *    而不是文本相等 —— 这就是「Symbol Identity」的落点）；
 *  - 其它语句（只在符号所在语句范围内扫描）。
 *
 * 相关子查询里的外层别名引用会被收进来：位置在内层时可见来源仍然解析到
 * 同一个声明，身份比对通过。
 *
 * 复杂度是「引用数 × 单次作用域解析」：重命名只在右键与提交时调用，
 * 不是每次按键，这个代价可以接受。
 */
/**
 * 收集 **CTE 名字**的全部引用（不含声明）。
 *
 * 做法是「文本扫描 + 结构校验」：候选来自与名字相同的标识符出现处，
 * 但必须在该位置**结构上确实是这个 CTE** 才算数 ——
 * 物理表同名（`库.recent` 这种限定名不算）、被别名遮蔽（`FROM recent r` 后的 `r.id`）、
 * 字符串 / 注释都会被挡掉。与别名引用收集共用同一套作用域解析。
 */
export function getCteReferences(
  state: EditorState,
  symbol: SqlCteSymbol,
  dbType = '',
): TextRange[] {
  const doc = state.doc.toString()
  const text = doc.slice(symbol.statementRange.from, symbol.statementRange.to)
  const wanted = symbol.name.toLowerCase()
  const references: TextRange[] = []

  /*
   * 逐 token 扫标识符：复用结构层的 readIdentifier，于是
   *  - 带引号的写法（`` `recent` `` / `"recent"` / `[recent]`）也**整段**命中 ——
   *    引用必须整段替换，只改引号里面那截会把 SQL 写坏；
   *  - 「重命名能看到什么」与「结构层能解析什么」始终是同一套词法，不会跑偏。
   */
  let index = 0
  while (index < text.length) {
    const token = readIdentifier(text, index)
    if (!token) {
      index += 1
      continue
    }
    const from = symbol.statementRange.from + index
    const to = symbol.statementRange.from + token.end
    index = token.end

    if (token.name.toLowerCase() !== wanted || from === symbol.declarationRange.from) {
      // 名字不同，或就是声明自己
      continue
    }
    if (inLiteralOrComment(state, from)) {
      continue
    }
    if (isCteUseAt(state, from, to, token.name, dbType)) {
      references.push({ from, to })
    }
  }

  return references
}

/** 某段标识符在结构上是否就是「这个名字的 CTE」 */
function isCteUseAt(
  state: EditorState,
  from: number,
  to: number,
  name: string,
  dbType: string,
): boolean {
  const scopes = scopesAt(state, from, dbType)
  const wanted = name.toLowerCase()

  // ① 表位置：该层某个来源的表名范围正好是这一段，且没写限定名
  for (const scope of scopes) {
    const hit = scope.refs.some(ref =>
      ref.tableRange?.from === from
      && ref.tableRange.to === to
      && !ref.schema
      && ref.table.toLowerCase() === wanted)
    if (hit) {
      return true
    }
  }

  // ② 限定符：后面紧跟点号，且可见来源就是这个 CTE 本身
  if (state.doc.sliceString(to, to + 1) !== '.') {
    return false
  }
  const visible = resolveVisibleSource(scopes, name)
  return Boolean(visible && !visible.schema && !visible.alias
    && visible.table.toLowerCase() === wanted)
}

export function getTableAliasReferences(
  state: EditorState,
  symbol: SqlTableAliasSymbol,
  dbType = '',
): TextRange[] {
  const doc = state.doc.toString()
  const text = doc.slice(symbol.statementRange.from, symbol.statementRange.to)
  const references: TextRange[] = []

  /*
   * 与 CTE 引用同款的「逐 token 扫描」：复用结构层的 readIdentifier，
   * 于是中文别名（`FROM users 用户` 的 `用户`）与带引号的写法都认，
   * 且不会把 `a用户.` 里的 `用户` 当成限定符（正则的边界守卫做不到这一点）。
   */
  let index = 0
  while (index < text.length) {
    const token = readIdentifier(text, index)
    if (!token) {
      index += 1
      continue
    }
    const from = symbol.statementRange.from + index
    const to = symbol.statementRange.from + token.end
    index = token.end

    if (token.name.toLowerCase() !== symbol.name.toLowerCase()) {
      continue
    }
    // 限定符引用：右边（允许空格）必须紧跟点号
    if (!dotFollows(doc, to)) {
      continue
    }
    if (from === symbol.declarationRange.from || inLiteralOrComment(state, from)) {
      continue
    }

    // 身份比对：该位置的可见来源必须就是同一个声明
    const scopes = scopesAt(state, to, dbType)
    const visible = resolveVisibleSource(scopes, token.name)
    if (!visible?.aliasRange || visible.aliasRange.from !== symbol.declarationRange.from) {
      continue
    }
    references.push({ from, to })
  }

  return references
}

/** 该位置之后（跳过空白）是否紧跟点号 */
function dotFollows(doc: string, pos: number): boolean {
  let i = pos
  while (i < doc.length && /\s/.test(doc[i] ?? '')) {
    i++
  }
  return doc[i] === '.'
}

/**
 * 符号的全部引用（三类符号各有自己的收集器）。
 *
 * 集中在这里是为了让「重命名 / 跳转定义 / 引用高亮」永远消费同一份引用集合 ——
 * 谁也别再各自扫一遍 SQL，否则三处给出的范围迟早会不一致。
 */
export function symbolReferencesOf(
  state: EditorState,
  symbol: SqlSymbol,
  dbType = '',
): TextRange[] {
  switch (symbol.kind) {
    case 'cte':
      return getCteReferences(state, symbol, dbType)
    case 'column-alias':
      return getColumnAliasReferences(state, symbol, dbType)
    case 'table-alias':
      return getTableAliasReferences(state, symbol, dbType)
    default:
      // 物理表：名字本身没有「引用」概念（改它等于改 DDL），调用方不会走到这里
      return []
  }
}

/** 光标处符号的全部出现位置（声明 + 引用） */
export interface SymbolOccurrences {
  kind: SqlSymbol['kind']
  declaration: TextRange
  references: TextRange[]
}

/**
 * 光标处符号的「所有出现位置」，供引用高亮使用。
 *
 * 只有光标确实落在声明或其引用上时才返回 —— 解析器本身就是这个语义，
 * 于是不会出现「在无关位置点亮别处代码」的情况。
 */
export function symbolOccurrencesAt(
  state: EditorState,
  pos: number,
  dbType = '',
): SymbolOccurrences | null {
  const symbol = resolveSymbolAtPosition(state, pos, dbType)
  if (!symbol || symbol.kind === 'table') {
    return null
  }
  return {
    kind: symbol.kind,
    declaration: symbol.declarationRange,
    references: symbolReferencesOf(state, symbol, dbType),
  }
}

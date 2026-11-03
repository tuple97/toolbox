/** SQL completion candidates: clause-aware suggestions */
import { startCompletion } from '@codemirror/autocomplete'
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { CompletionFeatureFlags, MetadataProvider } from './sqlCompletion'
import type { ClauseKind, ClauseScan, CompletionContextKind, SqlCursorText } from './sqlCursor'
import {
  BOOST_ALIAS,
  BOOST_CLAUSE_KEYWORD,
  BOOST_EXPRESSION_KEYWORD,
  BOOST_FUNCTION,
  BOOST_NAMESPACE,
  BOOST_SMART_COLUMN,
  BOOST_STATEMENT_KEYWORD,
  BOOST_TABLE,
  CLAUSE_KEYWORDS,
  EXPRESSION_KEYWORDS,
  JOIN_KEYWORDS,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  STATEMENT_KEYWORD_SET,
} from './sqlCompletionKeywords'
import {
  columnItem,
  openingQuoteBefore,
  quotedIdentApply,
  renderIdent,
} from './sqlCompletionInsert'
import type { ColumnCompletion } from './sqlCompletionInsert'
import { pooledColumnItems } from './sqlCompletionColumnPool'
import type { PoolColumn, PoolSource } from './sqlCompletionColumnPool'
import { aliasForTable, aliasedTableText } from './sqlTableAlias'
import { joinConditionItems } from './sqlCompletionJoin'
import type { JoinSide } from './sqlCompletionJoin'
import {
  comparisonTarget,
  insertTargetTable,
  nonAggregateColumnsOf,
  selectListTail,
  smartFragmentItem,
  starAtSelectListEnd,
} from './sqlSmartItems'
import type { SmartColumn } from './sqlSmartItems'
import { typedValueItems } from './sqlValueSuggestions'
import { quoteIdent } from './rowSql'
import type { SqlDialect } from './rowSql'
import type { TableRef, VirtualColumn } from './sqlSchema'
import { isCandidateAllowed, keywordsForSlot } from './completion/sqlCompletionEligibility'
import { resolveCompletionSlot } from './completion/sqlCompletionSlot'
import { filterDatabaseInfos, filterDatabases } from './sqlVisibility'
import type { SqlCompletionSlot } from './completion/sqlCompletionSlot'

export function staticOptions(flags: CompletionFeatureFlags = {}): Completion[] {
  const options: Completion[] = SQL_KEYWORDS.map(label => ({ label, type: 'keyword' as const }))
  if (!flags.disableFunctions) {
    options.push(...Object.entries(SQL_FUNCTIONS).map(([label, detail]) => ({
      label,
      type: 'function' as const,
      detail,
      apply: `${label}()`,
    })))
  }
  return options
}

export function columnsOfRef(ref: TableRef, deps: SqlSuggestDeps): SmartColumn[] {
  const { connId, database, metadata } = deps
  return ref.virtualColumns
    ? ref.virtualColumns.map(column => ({
        name: column.name,
        dataType: column.dataType,
        comment: column.comment,
      }))
    : metadata.columns(connId, ref.schema || database, ref.table)
        .map(column => ({
          name: column.name,
          dataType: column.dataType,
          comment: column.comment,
        }))
}

/** 按限定符定位列来源 */
export function sourceRefOf(
  scopes: TableRef[][],
  qualifier: string,
  column: string,
  columnsOf: (ref: TableRef) => SmartColumn[],
): TableRef | null {
  const refs = scopes[0] ?? []
  if (qualifier) {
    const wanted = qualifier.toLowerCase()
    return refs.find(ref => (ref.alias || ref.table).toLowerCase() === wanted) ?? null
  }
  if (refs.length === 1) {
    return refs[0]
  }
  const hit = refs.filter(ref =>
    columnsOf(ref).some(item => item.name.toLowerCase() === column.toLowerCase()))
  return hit.length === 1 ? hit[0] : null
}

/** GROUP BY 位置的智能项：推荐 SELECT 里**未聚合**的列 */
export function groupByPromotion(
  prefix: string,
  pos: number,
  scopes: TableRef[][],
  columnsOf: (ref: TableRef) => SmartColumn[],
  /** 片段型智能项是否可用（disableSnippets 会关掉「一次补齐」这一项） */
  fragments: boolean,
  deps: SqlSuggestDeps,
): { items: Completion[], skip: Set<string> } {
  const { dialect } = deps
  const skip = new Set<string>()
  const tail = selectListTail(prefix)
  if (!tail) {
    return { items: [], skip }
  }

  const items: Completion[] = []
  const seen = new Set<string>()
  for (const column of nonAggregateColumnsOf(tail.text)) {
    const key = column.column.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    skip.add(key)

    const ref = sourceRefOf(scopes, column.qualifier, column.column, columnsOf)
    const meta = ref
      ? columnsOf(ref).find(item => item.name.toLowerCase() === key)
      : undefined
    // SELECT 里写过的限定符优先（`u.created_at` 的推荐项也带 u.），与普通列候选保持一致
    const source = column.qualifier || ref?.alias || ref?.table || ''
    const ident = renderIdent(column.column, dialect)
    items.push({
      ...columnItem({
        name: column.column,
        displayName: source ? `${source}.${column.column}` : undefined,
        insertText: source ? `${source}.${ident}` : ident,
        prefix: source ? `${source}.` : undefined,
        columnId: {
          schema: ref?.schema,
          table: ref?.table ?? source,
          source,
          column: column.column,
        },
        detail: {
          dataType: meta?.dataType,
          // 与普通列候选同一个口径：来源列给血缘源头表名（别名在展示名里已经有了）
          from: ref ? (ref.schema ? `${ref.schema}.${ref.table}` : ref.table) : undefined,
          comment: meta?.comment,
        },
        dialect,
      }),
      boost: BOOST_SMART_COLUMN,
    })
  }

  if (fragments && items.length) {
    items.unshift(smartFragmentItem(
      '补齐非聚合列',
      `插入 SELECT 中未聚合的 ${items.length} 列`,
      items.map(item => renderIdent(item.label, dialect)).join(', '),
      { from: pos, to: pos },
    ))
  }

  return { items, skip }
}

/** 候选生成共用的依赖（一次补全内不变） */
export interface SqlSuggestDeps {
  connId: number
  database: string
  /** 方言（引号 / 字面量转义） */
  dialect: SqlDialect
  metadata: MetadataProvider
}

/** 子句候选（非点号场景）的输入 */
export interface GeneralSuggestArgs {
  /** SQL 光标语义（位置类别与子句结论） */
  intent: Pick<SqlCursorText, 'kind' | 'clause' | 'clausePrefix' | 'prefixStart'>
  /** 作用域链（内 → 外） */
  scopes: TableRef[][]
  deps: SqlSuggestDeps
  flags?: CompletionFeatureFlags
  /** 已由智能项推荐过的列（小写列名）：不再重复出现一次 */
  skipColumns?: Set<string>
  /** 光标前正在输入的词（只有超宽表的候选取舍会用到） */
  prefix?: string
  /** 表名是否带自动别名（设置项开启 **且** 当前位置是 FROM / JOIN 之后） */
  autoAlias?: boolean
  /** 上一个输出项用的限定符（`SELECT t.user_id, |` 的 `t`） */
  preferredQualifier?: string
  /** 补全槽位（由 sqlBundle 算出并传入） */
  slot?: SqlCompletionSlot
}

export interface SmartItemArgs {
  /** SQL 光标语义（子句 / 位置类别 / 光标前的文本） */
  intent: Pick<SqlCursorText, 'clause' | 'clausePrefix' | 'prefixStart' | 'kind'>
  /** 光标位置（文档坐标） */
  pos: number
  scopes: TableRef[][]
  deps: SqlSuggestDeps
  columnsOf: (ref: TableRef) => SmartColumn[]
  /** 片段型智能项是否可用（disableSnippets 会关掉） */
  fragments: boolean
}

/** 就地追加的智能项：`*` 展开、比较值、INSERT 列清单 */
export function smartSuggestions(args: SmartItemArgs): Completion[] {
  const items: Completion[] = []
  const refs = args.scopes[0] ?? []

  // ① `*` 展开：只在 SELECT 列表里，且列表末尾就是星号本身（`COUNT(*)` 不算）
  if (args.fragments && args.intent.clause.kind === 'column' && args.intent.clause.keyword === 'select') {
    const tail = selectListTail(args.intent.clausePrefix)
    const star = tail ? starAtSelectListEnd(tail.text) : null
    if (tail && star) {
      const picked = star.qualifier
        ? refs.filter(ref => (ref.alias || ref.table).toLowerCase() === star.qualifier.toLowerCase())
        : refs
      const names: string[] = []
      for (const ref of picked) {
        // 多来源必须带限定符：两张表都有 id 时，展开成裸 id 含义不清
        const scope = picked.length > 1 ? `${ref.alias || ref.table}.` : ''
        for (const column of args.columnsOf(ref)) {
          // 保留字 / 含特殊字符的列名同样要带引用符，否则展开出来的 SQL 跑不通
          names.push(scope + renderIdent(column.name, args.deps.dialect))
        }
      }
      if (names.length) {
        const listStart = args.intent.prefixStart + tail.start
        items.push(smartFragmentItem(
          star.text,
          `展开为 ${names.length} 列：${previewColumns(names)}`,
          names.join(', '),
          { from: listStart + star.start, to: listStart + star.end },
        ))
      }
    }
  }

  /* ② 比较值：`col = |` / `col IN (|` */
  const target = comparisonTarget(args.intent.clausePrefix)
  if (target) {
    const ref = sourceRefOf(args.scopes, target.qualifier, target.column, args.columnsOf)
    const meta = ref
      ? args.columnsOf(ref).find(item => item.name.toLowerCase() === target.column.toLowerCase())
      : undefined
    const values = args.deps.metadata.values
      ? args.deps.metadata.values(
          args.deps.connId,
          ref ? ref.schema || args.deps.database : args.deps.database,
          ref ? ref.table : '',
          target.column,
        )
      : []
    items.push(...typedValueItems({
      column: target.column,
      dataType: meta?.dataType,
      dialect: args.deps.dialect,
      values,
    }))
  }

  // ③ INSERT 列清单：括号内给列名清单，表名之后补上带括号的清单
  if (args.fragments && args.intent.clause.keyword === 'into') {
    const table = insertTargetTable(args.intent.clausePrefix)
    const insideList = args.intent.kind === 'insert'
    if (table && (insideList || args.intent.clause.kind === 'afterSource')) {
      const ref = refs.find(item => item.table.toLowerCase() === table.table.toLowerCase())
      const columns = ref
        ? args.columnsOf(ref)
        : args.deps.metadata.columns(args.deps.connId, table.schema || args.deps.database, table.table)
      if (columns.length) {
        const list = columns.map(column => renderIdent(column.name, args.deps.dialect)).join(', ')
        items.push(smartFragmentItem(
          '全部列',
          `${insideList ? '插入' : '补上'} ${table.table} 的 ${columns.length} 个列名`,
          insideList ? list : `(${list})`,
          { from: args.pos, to: args.pos },
        ))
      }
    }
  }

  return items
}

export function previewColumns(names: string[]): string {
  const text = names.join(', ')
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

export function joinSideOf(ref: TableRef, deps: SqlSuggestDeps): JoinSide {
  const schema = ref.schema || deps.database
  const columns = ref.virtualColumns
    ? ref.virtualColumns.map(column => ({ name: column.name, dataType: column.dataType }))
    : deps.metadata.columns(deps.connId, schema, ref.table)
        .map(column => ({ name: column.name, dataType: column.dataType }))
  return {
    table: ref.table,
    alias: ref.alias || ref.table,
    columns,
    // 外键只存在于物理表；元数据提供者未实现该能力时为空数组（走命名启发式）
    foreignKeys: ref.virtualColumns
      ? []
      : (deps.metadata.foreignKeys?.(deps.connId, schema, ref.table) ?? []),
  }
}

/** ON 位置的关联条件候选 */
export function joinConditionSuggestions(
  scopes: TableRef[][],
  deps: SqlSuggestDeps,
  joinTarget?: { table: string, alias: string } | null,
): Completion[] {
  const refs = scopes[0] ?? []
  if (refs.length < 2) {
    return []
  }

  const sides = refs.map(ref => joinSideOf(ref, deps))
  const index = joinTarget ? indexOfJoinTarget(sides, joinTarget) : -1
  const active = index >= 0 ? index : sides.length - 1

  return joinConditionItems({
    left: sides[active],
    others: sides.filter((_, position) => position !== active),
  })
}

/** 在已解析的来源里定位「当前 JOIN 的源」（别名优先，其次表名） */
function indexOfJoinTarget(sides: JoinSide[], target: { table: string, alias: string }): number {
  const alias = target.alias.toLowerCase()
  const table = target.table.toLowerCase()
  return sides.findIndex(side =>
    side.alias.toLowerCase() === alias || side.table.toLowerCase() === table)
}

/** 限定符文本（含末尾点号）→ 各段名字（已去引号）；不以点号结尾返回 null */
export function qualifierSegments(raw: string): string[] | null {
  if (!raw.endsWith('.')) {
    return null
  }
  const segments = raw
    .slice(0, -1)
    .split('.')
    .map(part => part.trim().replace(/^[`"[]/, '').replace(/[`"\]]$/, ''))
    .filter(Boolean)
  return segments.length ? segments : null
}

/** 解析一行里光标前紧邻点号的限定符（保留给「只有一行文本」的调用方与用例） */
export function readQualifierBeforeCursor(lineBefore: string): string[] | null {
  let index = lineBefore.length
  // 允许字母数字、_、$、点号与三种引号
  while (index > 0 && /[A-Za-z0-9_$."`[\]]/.test(lineBefore[index - 1] ?? '')) {
    index--
  }
  return qualifierSegments(lineBefore.slice(index))
}

/** 点号后的补全：按「逐层别名 > 逐层无别名 CTE 名 > 显式 `库.表.` > 当前库表名 > 库名」 解析限定符 */
export function resolveAfterDot(
  segments: string[],
  scopes: TableRef[][],
  deps: SqlSuggestDeps,
  prefix = '',
  options?: {
    /** 跳过「别名 → 列」这一步（来源位置的 `库.` 要的是库里的表，见函数内注释） */
    skipAlias?: boolean
  },
): Completion[] {
  const { connId, database, metadata } = deps
  const last = segments[segments.length - 1]
  const qualifier = last.toLowerCase()

  /* 1) 逐层找别名（派生表 / CTE 的列来自静态解析，物理表走元数据） */
  if (!options?.skipAlias) {
    for (const refs of scopes) {
      const matchedRef = refs.find(ref => (ref.alias || ref.table).toLowerCase() === qualifier)
      if (matchedRef) {
        return sourceColumnSuggestions(matchedRef, deps, prefix)
      }
    }
  }

  // 2) 逐层找无别名的 CTE 名（FROM cte → cte.）
  for (const refs of scopes) {
    const cteRef = refs.find(
      ref => !ref.alias && ref.table.toLowerCase() === qualifier && ref.virtualColumns,
    )
    if (cteRef?.virtualColumns) {
      return virtualColumnSuggestions(
        cteRef.virtualColumns,
        { schema: cteRef.schema, table: cteRef.table, alias: cteRef.table },
        deps.dialect,
        prefix,
        true,
      )
    }
  }

  /* 3) 显式两段（mydb.user.）：倒数第二段是库 / 模式名 */
  if (segments.length > 1) {
    const schema = segments[segments.length - 2]
    return columnSuggestions(
      metadata.columns(connId, schema, last),
      { schema, table: last, alias: last },
      deps.dialect,
      prefix,
      true,
    )
  }

  // 4) 当前库里的表名（`users.` 这种写法在库内同样常见）
  if (metadata.tables(connId, database).some(name => name.toLowerCase() === qualifier)) {
    return columnSuggestions(
      metadata.columns(connId, database, last),
      { schema: database, table: last, alias: last },
      deps.dialect,
      prefix,
      true,
    )
  }

  // 5) 库名 → 该库的表
  if (metadata.databases(connId).some(name => name.toLowerCase() === qualifier)) {
    return tableSuggestions(connId, last, deps.dialect, metadata)
  }

  /* 作用域里没有这个来源，也不再「按当前库的同名表猜一次」： 那会让 `WHERE x.|` 突然冒出一张跟当前语句无关的表 */
  return []
}

/** 某个作用域来源的列候选：一律带限定符（文档里的 `u.` 会被替换掉，插入时要写回去） */
function sourceColumnSuggestions(
  ref: TableRef,
  deps: SqlSuggestDeps,
  prefix: string,
): ColumnCompletion[] {
  const source = { schema: ref.schema, table: ref.table, alias: ref.alias || ref.table }
  return ref.virtualColumns
    ? virtualColumnSuggestions(ref.virtualColumns, source, deps.dialect, prefix, true)
    : columnSuggestions(
        deps.metadata.columns(deps.connId, ref.schema || deps.database, ref.table),
        source,
        deps.dialect,
        prefix,
        true,
      )
}

/** 一组列的候选（走候选池：按来源缓存，超宽表按前缀取舍） */
export function columnSuggestions(
  columns: readonly PoolColumn[],
  source: PoolSource,
  dialect: SqlDialect,
  prefix = '',
  qualified = false,
): ColumnCompletion[] {
  return pooledColumnItems(columns, source, dialect, prefix, qualified)
}

/** 派生表 / CTE 的输出列候选（同样走候选池） */
export function virtualColumnSuggestions(
  columns: VirtualColumn[],
  source: PoolSource,
  dialect: SqlDialect,
  prefix = '',
  qualified = false,
): ColumnCompletion[] {
  return pooledColumnItems(columns, source, dialect, prefix, qualified)
}

export function derivedSourceDetail(columns: VirtualColumn[]): string {
  const sources = [...new Set(columns.map(column => column.from).filter(Boolean))]
  const from = sources.length === 1 ? ` · ${sources[0]}` : ''
  return `派生表${from}（${columns.length} 列）`
}

/** 表补全项（表名一律带引用符，插入时吃掉用户已经敲下的开引号） */
export function tableSuggestions(
  connId: number,
  database: string,
  dialect: SqlDialect,
  metadata: MetadataProvider,
  autoAlias = false,
): Completion[] {
  return metadata.tables(connId, database).map((table) => {
    const quoted = quoteIdent(table, dialect)
    const plain: Completion = {
      label: table,
      type: 'class',
      detail: '表 / 视图',
      boost: BOOST_TABLE,
      apply: quotedIdentApply(quoted),
    }
    if (!autoAlias) {
      return plain
    }

    // 推导不出别名（表名为空）时退回原样，不能给一条「表名 AS 空」
    const alias = aliasForTable(table)
    if (!alias) {
      return plain
    }
    return {
      ...plain,
      label: aliasedTableText(table, alias),
      detail: `表 / 视图 · 自动别名 ${alias}`,
      apply: quotedIdentApply(aliasedTableText(quoted, alias)),
    }
  })
}

/** 位置 → 关键字集合 */
export function keywordsFor(kind: ClauseKind): string[] {
  switch (kind) {
    case 'any':
      return SQL_KEYWORDS
    case 'afterSource':
      return ['AS', ...JOIN_KEYWORDS, ...CLAUSE_KEYWORDS]
    case 'column':
      return [...EXPRESSION_KEYWORDS, ...JOIN_KEYWORDS, ...CLAUSE_KEYWORDS]
    default:
      return []
  }
}

/** 关键字权重：语句 → 表达式 → 子句，三层依次降低（层间距见 sqlCompletionKeywords） */
export function keywordBoost(keyword: string): number {
  if (STATEMENT_KEYWORD_SET.has(keyword)) {
    return BOOST_STATEMENT_KEYWORD
  }
  return EXPRESSION_KEYWORD_SET.has(keyword) ? BOOST_EXPRESSION_KEYWORD : BOOST_CLAUSE_KEYWORD
}

export const EXPRESSION_KEYWORD_SET = new Set(EXPRESSION_KEYWORDS)

/** 插入文本后自动触发下一轮补全 */
export function applyAndTrigger(insertText: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: insertText },
      selection: { anchor: from + insertText.length },
    })
    setTimeout(() => startCompletion(view), 0)
  }
}

/* ------------------------------------------------------------ */

/** 一次补全摊平后的上下文：每个候选族只读它，不各自去翻 args */
export interface SuggestionContext {
  /** 位置大类（源表 / 表之后 / 表达式 / 别名 / 任意） */
  kind: ClauseKind
  /** 子句槽位（关键字集合与表库资格都按它算，见 completion/ 两个模块） */
  slot: SqlCompletionSlot
  /** 光标前的紧贴情形：`'keyword'`（还在写 `FROM` 这个词）时表与库都不给 */
  tight: SqlCursorText['clause']['tight']
  /** 光标前正在输入的词 */
  prefix: string
  /** 光标语义（候选族要读子句、关键字、tail 等） */
  intent: GeneralSuggestArgs['intent']
  /** 作用域链（内 → 外） */
  scopes: TableRef[][]
  deps: SqlSuggestDeps
  flags: CompletionFeatureFlags
  /** 表名是否带自动别名（设置项开启 **且** 位置在 FROM / JOIN 之后） */
  autoAlias: boolean
  /** 已由智能项推荐过的列（小写）：不再重复出现一次 */
  skipColumns?: Set<string>
  /** 多选列时沿用上一个输出项的限定符（小写） */
  preferredQualifier: string
}

/** 一个候选族 */
export interface SuggestionProvider {
  /** 身份（调试与用例定位用，不给用户看） */
  id: string
  supports: (ctx: SuggestionContext) => boolean
  provide: (ctx: SuggestionContext) => Completion[]
}

/** 把入参摊平成上下文：默认值与槽位兜底只在这一处 */
export function suggestionContextOf(args: GeneralSuggestArgs): SuggestionContext {
  return {
    kind: args.intent.clause.kind,
    /* 槽位：关键字集合与「表 / 库能不能出现」都按它算（见 completion/ 两个模块） */
    slot: args.slot ?? resolveCompletionSlot({
      kind: args.intent.kind,
      keyword: args.intent.clause.keyword,
      previousKeyword: args.intent.clause.previousKeyword,
      tail: args.intent.clause.tail,
      tight: args.intent.clause.tight,
    }),
    tight: args.intent.clause.tight,
    prefix: args.intent.clausePrefix ?? '',
    intent: args.intent,
    scopes: args.scopes,
    deps: args.deps,
    flags: args.flags ?? {},
    autoAlias: args.autoAlias ?? false,
    skipColumns: args.skipColumns,
    preferredQualifier: (args.preferredQualifier ?? '').toLowerCase(),
  }
}

/** 列 + 别名（表达式位置的主力） */
function columnCandidates(ctx: SuggestionContext): Completion[] {
  const { scopes, deps, skipColumns, preferredQualifier: preferred } = ctx
  const { connId, database, dialect, metadata } = deps
  const suggestions: Completion[] = []
  const seenAliases = new Set<string>()
  const seenColumns = new Set<string>()
  const aliasSuggestions: Completion[] = []

  for (const refs of scopes) {
    for (const ref of refs) {
      const source = ref.alias || ref.table
      const sourceKey = source.toLowerCase()
      // 内层已出现同名来源：外层同名的不再贡献列（作用域遮蔽）
      if (seenAliases.has(sourceKey)) {
        continue
      }
      seenAliases.add(sourceKey)

      /* 列候选走候选池（按来源缓存 + 超宽表按前缀取舍）： 派生表用静态解析出的列，物理表用元数据 */
      // 该来源的列是否带限定符：多来源一律带；多选列时前一项用的那个来源也带
      const qualified = (scopes[0] ?? []).length > 1
        || (preferred !== '' && source.toLowerCase() === preferred)
      const pool = ref.virtualColumns
        ? virtualColumnSuggestions(
            ref.virtualColumns,
            { schema: ref.schema, table: ref.table, alias: source },
            dialect,
            ctx.prefix,
            qualified,
          )
        : pooledColumnItems(
            metadata.columns(connId, ref.schema || database, ref.table),
            { schema: ref.schema, table: ref.table, alias: source },
            dialect,
            ctx.prefix,
            qualified,
          )
      for (const item of pool) {
        // 去重按「候选身份」：不同来源的同名列是两个候选，不能只留一个
        const key = item.columnKey ?? item.label.toLowerCase()
        if (seenColumns.has(key) || skipColumns?.has(item.label.toLowerCase())) {
          continue
        }
        seenColumns.add(key)
        suggestions.push(item)
      }

      // 语句里已定义的别名 / 无别名的 CTE：选它自动补上点号并继续弹字段
      const name = ref.alias || (ref.virtualColumns ? ref.table : '')
      if (!name) {
        continue
      }
      aliasSuggestions.push({
        label: name,
        type: 'variable',
        boost: BOOST_ALIAS,
        detail: ref.virtualColumns
          ? derivedSourceDetail(ref.virtualColumns)
          : ref.schema
            ? `别名 → ${ref.schema}.${ref.table}`
            : `别名 → ${ref.table}`,
        apply: applyAndTrigger(`${name}.`),
      })
    }
  }

  suggestions.push(...aliasSuggestions)
  return suggestions
}

/** 表名候选 */
function tableCandidates(ctx: SuggestionContext): Completion[] {
  const { connId, database, dialect, metadata } = ctx.deps
  return tableSuggestions(connId, database, dialect, metadata, ctx.autoAlias)
}

/** 库名候选 */
function namespaceCandidates(ctx: SuggestionContext): Completion[] {
  const { connId, dialect, metadata } = ctx.deps
  // 系统库是否出现由设置项决定（默认显示），判定统一走 sqlVisibility
  return namespaceSuggestions(connId, dialect, metadata, ctx.flags.showSystemDatabases !== false)
}

/** 关键字候选：按**槽位**过滤（而不是位置大类） */
function keywordCandidates(ctx: SuggestionContext): Completion[] {
  return keywordsForSlot({
    slot: ctx.slot,
    keyword: ctx.intent.clause.keyword,
    hasTail: Boolean(ctx.intent.clause.tail),
  }).map(keyword => ({
    label: keyword,
    type: 'keyword' as const,
    boost: keywordBoost(keyword),
  }))
}

/** 函数候选：只在表达式位置给，且可由 featureFlags 关掉 */
function functionCandidates(): Completion[] {
  return Object.entries(SQL_FUNCTIONS).map(([name, signature]) => ({
    label: name,
    type: 'function' as const,
    detail: signature,
    boost: BOOST_FUNCTION,
    apply: `${name}()`,
  }))
}

/** 表名与库名的**共同资格** */
function supportsTableOrNamespace(ctx: SuggestionContext): boolean {
  return ctx.kind !== 'column' && ctx.kind !== 'alias' && ctx.tight !== 'keyword'
}

/** 列 + 别名：只在表达式位置 */
const columnProvider: SuggestionProvider = {
  id: 'columns',
  supports: ctx => ctx.kind === 'column',
  provide: columnCandidates,
}

/** 表名：表名位置的唯一来源 */
const tableProvider: SuggestionProvider = {
  id: 'tables',
  supports: supportsTableOrNamespace,
  provide: tableCandidates,
}

/** 库名：与表名同一条资格判据（时机本来就相同） */
const namespaceProvider: SuggestionProvider = {
  id: 'namespaces',
  supports: supportsTableOrNamespace,
  provide: namespaceCandidates,
}

/** 关键字：除了「表名还没写」（source）与「只能写别名」（alias），其它位置都给 */
const keywordProvider: SuggestionProvider = {
  id: 'keywords',
  supports: ctx => ctx.kind !== 'source' && ctx.kind !== 'alias',
  provide: keywordCandidates,
}

/** 函数：与列同进退（表名位置用不到函数） */
const functionProvider: SuggestionProvider = {
  id: 'functions',
  supports: ctx => ctx.kind === 'column' && !ctx.flags.disableFunctions,
  provide: functionCandidates,
}

/** 默认注册表 */
export const DEFAULT_SUGGESTION_PROVIDERS: SuggestionProvider[] = [
  columnProvider,
  tableProvider,
  namespaceProvider,
  keywordProvider,
  functionProvider,
]

/** 跑一遍注册表：`supports` 通过就取它的候选，按注册顺序拼起来 */
export function runSuggestionProviders(
  ctx: SuggestionContext,
  providers: SuggestionProvider[] = DEFAULT_SUGGESTION_PROVIDERS,
): Completion[] {
  const out: Completion[] = []
  for (const provider of providers) {
    if (provider.supports(ctx)) {
      out.push(...provider.provide(ctx))
    }
  }
  return out
}

/** 非点号场景（Ctrl+Space / 输入中）按位置给候选： - `source`：**只给表与库**——表名还没写 */
export function generalSuggestions(args: GeneralSuggestArgs): Completion[] {
  return runSuggestionProviders(suggestionContextOf(args))
}

/** 库名候选的插入：吃掉用户已经敲下的开引号，插入 `` `db` */
export function namespaceApply(identifier: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const open = openingQuoteBefore(view.state.doc.toString(), from)
    const start = open ? open.start : from
    view.dispatch({
      changes: { from: start, to, insert: identifier },
      selection: { anchor: start + identifier.length },
    })
    setTimeout(() => startCompletion(view), 0)
  }
}

export function namespaceSuggestions(
  connId: number,
  dialect: SqlDialect,
  metadata: MetadataProvider,
  showSystemDatabases = true,
): Completion[] {
  /* 系统库按设置过滤（设置项关闭时不再主动列出） */
  const infos = metadata.databaseInfos?.(connId)
  const visible = infos
    ? filterDatabaseInfos(infos, dialect, showSystemDatabases)
    : filterDatabases(metadata.databases(connId), dialect, showSystemDatabases)
      .map(name => ({ name }))

  return visible.map(info => ({
    label: info.name,
    type: 'namespace' as const,
    detail: '数据库',
    boost: BOOST_NAMESPACE,
    apply: namespaceApply(`${quoteIdent(info.name, dialect)}.`),
  }))
}

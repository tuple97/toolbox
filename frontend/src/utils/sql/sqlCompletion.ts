/** 分层智能补全（CodeMirror 6）：按编辑器用途分派到 SQL / 模板 / 脚本三条路径 */
import { insertCompletionText, startCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { matchRanges, matchesPrefix, recordCompletionSelection, sortByRank } from './sqlCompletionRank'
import { joinConditionItems } from './sqlCompletionJoin'
import type { ForeignKeyInfo, JoinSide } from './sqlCompletionJoin'
import {
  comparisonTarget,
  insertTargetTable,
  nonAggregateColumnsOf,
  selectListTail,
  smartFragmentItem,
  starAtSelectListEnd,
} from './sqlSmartItems'
import { typedValueItems } from './sqlValueSuggestions'
import type { SmartColumn, SmartCompareValue } from './sqlSmartItems'
import { analyzeSqlCursorText } from './sqlCursor'
import type { ClauseKind, ClauseScan, CompletionContextKind } from './sqlCursor'
import type { DatabaseInfo } from '@/types'
import { useDictStore } from '@/stores/dictStore'
import { isCandidateAllowed } from './completion/sqlCompletionEligibility'
import { resolveCompletionSlot } from './completion/sqlCompletionSlot'
import { useMetadataStore } from '@/stores/metadataStore'
import { scopeRanges } from '@/utils/sql/sqlSyntax'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { dialectOf, quoteIdent } from '@/utils/sql/rowSql'
import type { SqlDialect } from '@/utils/sql/rowSql'
import type { ExecutorColumn } from '@/types'
import {
  BOOST_ALIAS,
  BOOST_CLAUSE_KEYWORD,
  BOOST_EXPRESSION_KEYWORD,
  BOOST_FUNCTION,
  BOOST_NAMESPACE,
  BOOST_SMART_COLUMN,
  BOOST_TABLE,
  CLAUSE_KEYWORDS,
  EXPRESSION_KEYWORDS,
  JOIN_KEYWORDS,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
} from './sqlCompletionKeywords'
import {
  clearColumnMarks,
  columnItem,
  openingQuoteBefore,
  qualifierBeforeCursor,
  quotedIdentApply,
  renderIdent,
} from './sqlCompletionInsert'
import { MAX_OPTIONS, pooledColumnItems } from './sqlCompletionColumnPool'
import {
  readTemplateContext,
  scriptBundle,
  templateBundle,
  templateClosingItems,
} from './sqlTemplateCompletion'
import type { FragmentActionCompletion } from './sqlTemplateCompletion'
import type { ColumnCompletion } from './sqlCompletionInsert'
import { analyzeHybridCursor } from './hybridCursor'
import type { HybridCursor } from './hybridCursor'
import type { TemplateProperty } from './template/templateScope'
import type { TemplateValueType } from './template/templateFunctions'

// 拆分模块的对外 API 在此统一再导出：调用方（组件 / 测试）仍从 '@/utils/sql/sqlCompletion' 导入
export { columnHoverAt } from './sqlCompletionHover'
export type { SqlColumnInfo, SqlColumnHover } from './sqlCompletionHover'
export {
  clearColumnMarks,
  columnsMarked,
  isColumnMarked,
  shouldConsumeSpaceForColumn,
  toggleColumnMark,
  qualifierBeforeCursor,
  type ColumnCompletion,
  type ColumnDetail,
} from './sqlCompletionInsert'

/** 补全模式：由编辑器用途决定 */
export type CompletionMode = 'sql' | 'sql-template' | 'javascript' | 'none'

/** SQL 侧上下文：连接 / 生效库 / 方言（getter 由编辑器登记，切换连接自动生效） */
export interface SqlContext {
  connId: number
  database: string
  dbType: string
}

/** 模板变量（来自模板的 VariableConfig[]） */
export interface TemplateVariable {
  /** 变量名，与模板中 {{ 名字 }} 一致 */
  name: string
  /** 展示名（有则作为 detail 提示） */
  label?: string
  /** 值类型 */
  type?: TemplateValueType
  /** 对象字段 */
  properties?: TemplateProperty[]
  /** 数组元素类型：`{{range 变量}}` 里 `.` 的类型 */
  elementType?: TemplateValueType
}

/** 元数据提供者：默认走 metadataStore，测试可注入静态数据 */
export interface MetadataProvider {
  databases(connId: number): string[]
  /** 库列表（含「是否系统库」标记，可选） */
  databaseInfos?: (connId: number) => DatabaseInfo[]
  tables(connId: number, database: string): string[]
  columns(connId: number, database: string, table: string): ExecutorColumn[]
  /** 外键约束（可选） */
  foreignKeys?: (connId: number, database: string, table: string) => ForeignKeyInfo[]
  /** 某列的可选值（可选），用于「比较值」智能项 */
  values?: (
    connId: number,
    database: string,
    table: string,
    column: string,
  ) => SmartCompareValue[]
}

/* 位置类别（CompletionContextKind）与子句结论（ClauseKind / ClauseScan）定义在 */
export type { ClauseKind, ClauseScan, CompletionContextKind, SqlCursorText } from './sqlCursor'

/** 定向扩展的开关：轻量场景（如只想要变量的输入框）可以把用不上的候选关掉 */
export interface CompletionFeatureFlags {
  /** 关掉函数候选（只留变量与关键字的场景） */
  disableFunctions?: boolean
  /** 关掉语句片段候选（T3 的智能项与片段类候选） */
  disableSnippets?: boolean
  /** 关联条件建议（默认开） */
  joinSuggestions?: boolean
  /** 智能项（`*` 展开 / GROUP BY / 比较值 / INSERT 列清单，默认开） */
  smartItems?: boolean
  /** 表名补全后自动补别名（设置项 `sql_completion_alias`） */
  autoTableAlias?: boolean
  /** 是否在候选里展示系统库（设置项 `sql_show_system_databases`，默认展示） */
  showSystemDatabases?: boolean
}

/** 一次补全所需的运行期上下文 */
export interface CompletionRuntime {
  mode: CompletionMode
  /** SQL 侧上下文；未登记（如模板编辑器未绑定连接）时退化为关键字 + 函数 */
  sql?: SqlContext | (() => SqlContext | undefined)
  /** 模板变量（sql-template 模式） */
  templateVariables?: TemplateVariable[] | (() => TemplateVariable[])
  /** 脚本注入的全局标识符（javascript 模式） */
  scriptGlobals?: string[] | (() => string[])
  /** 元数据来源；缺省用 metadataStore */
  metadata?: MetadataProvider
  /** 定向扩展开关 */
  featureFlags?: CompletionFeatureFlags
  /** 是否用「历史选中」加权排序（默认开；用例里可关掉以获得确定顺序） */
  useHistory?: boolean
}

/** 补全结果（内部统一形态，供补全源与测试共用） */
export interface CompletionBundle {
  from: number
  /** 替换范围的结束位置（缺省表示到光标） */
  to?: number
  options: Completion[]
  /** 本次命中的位置类别（触发策略与新候选共用） */
  contextKind: CompletionContextKind
  /** 是否交给编辑器过滤候选 */
  filter?: boolean
}

/** 单个编辑器登记的上下文（按需扩展，避免替换原来的 getter 机制） */
interface CompletionRegistration {
  getSql?: () => SqlContext
  getTemplateVariables?: () => TemplateVariable[]
  getScriptGlobals?: () => string[]
}

// ---------------------------------------------------------------- 运行期上下文

/** getter 求值后的运行期上下文（内部使用） */
interface ResolvedRuntime {
  mode: CompletionMode
  sql?: SqlContext
  templateVariables: TemplateVariable[]
  scriptGlobals: string[]
  metadata: MetadataProvider
  featureFlags: CompletionFeatureFlags
  useHistory: boolean
}

/** 求值一个「值或取值函数」字段 */
function resolveField<T>(value: T | (() => T | undefined) | undefined): T | undefined {
  if (typeof value === 'function') {
    return (value as () => T | undefined)()
  }
  return value
}

/** 读运行期上下文里的 SQL 侧信息（兼容「值」与「getter」两种写法） */
export function sqlContextFromRuntime(runtime: CompletionRuntime): SqlContext | undefined {
  return resolveField(runtime.sql)
}

/** 把运行期上下文归一化：getter 求值、缺省项补齐（每次查询都重新求值） */
function resolveRuntime(runtime: CompletionRuntime): ResolvedRuntime {
  return {
    mode: runtime.mode,
    sql: resolveField(runtime.sql),
    templateVariables: resolveField(runtime.templateVariables) ?? [],
    scriptGlobals: resolveField(runtime.scriptGlobals) ?? [],
    metadata: runtime.metadata ?? defaultMetadataProvider,
    featureFlags: runtime.featureFlags ?? {},
    useHistory: runtime.useHistory !== false,
  }
}

/** 收尾：排序、必要时自行过滤、给候选项挂上「选中即记历史」的包装 */
function finalizeBundle(
  state: EditorState,
  pos: number,
  bundle: CompletionBundle,
  runtime: ResolvedRuntime,
): CompletionBundle {
  if (!bundle.options.length) {
    return bundle
  }
  const prefix = state.sliceDoc(Math.min(bundle.from, pos), pos)

  /* 有输入时必须由本模块同时过滤和排序 */
  const customFilter = Boolean(prefix)
  const matched = customFilter
    ? bundle.options.filter(option =>
        matchesPrefix(option.label, prefix) || isOfferedRegardlessOfPrefix(option))
    : bundle.options

  /* 排序之后再截断：留下的都是分数最高（前缀命中 / 高频 / 该位置该出现）的那些 */
  const sorted = sortByRank(matched, prefix)
  const capped = sorted.length > MAX_OPTIONS ? sorted.slice(0, MAX_OPTIONS) : sorted
  return {
    ...bundle,
    options: runtime.useHistory ? withHistoryRecording(capped) : capped,
    filter: customFilter ? false : bundle.filter,
  }
}

/** 整段替换型候选（块片段）：替换整个 `{{ … }}`，过滤时不看已输入的前缀 */
function isOfferedRegardlessOfPrefix(option: Completion): boolean {
  return (option as FragmentActionCompletion).alwaysOffered === true
}

/** 给候选项包一层「选中即记历史」 */
function withHistoryRecording(options: Completion[]): Completion[] {
  return options.map((option) => {
    const rawApply = option.apply
    return {
      ...option,
      apply: (view: EditorView, completion: Completion, from: number, to: number) => {
        recordCompletionSelection(completion.label)
        if (typeof rawApply === 'function') {
          return rawApply(view, completion, from, to)
        }
        if (typeof rawApply === 'string') {
          view.dispatch(insertCompletionText(view.state, rawApply, from, to))
          return true
        }
        view.dispatch(insertCompletionText(view.state, completion.label, from, to))
        return true
      },
    }
  })
}

// ---------------------------------------------------------------- 位置类别

/** 该位置是否属于「合理弹窗位」（打字触发的 position 档据此判定） */
export function isPositionalEligible(kind: CompletionContextKind): boolean {
  switch (kind) {
    case 'table':
    case 'column':
    case 'statement-start':
    case 'keyword':
    case 'join-on':
    case 'join-expression':
    case 'group-by':
    case 'insert':
      return true
    default:
      return false
  }
}

/** 当前位置的类别（触发策略与页面按需调用） */
export function contextKindAt(
  state: EditorState,
  pos: number,
  dbType = '',
  mode: CompletionMode = 'sql',
): CompletionContextKind {
  const cursor = analyzeHybridCursor(state, pos, { mode })
  if (cursor.language === 'template') {
    return 'template'
  }
  if (cursor.language === 'script') {
    return 'script'
  }
  if (cursor.language !== 'sql') {
    return 'none'
  }

  // 语言确定后交给 SQL 光标语义（与候选生成共用同一份分析）
  return analyzeSqlCursorText(state, pos, dbType).kind
}

/** 编辑器实例 → 补全上下文 */
const viewContexts = new WeakMap<EditorView, CompletionRegistration>()

/** 取（或初始化）某个编辑器的登记项 */
function registrationOf(view: EditorView): CompletionRegistration {
  let item = viewContexts.get(view)
  if (!item) {
    item = {}
    viewContexts.set(view, item)
  }
  return item
}

/** 为某个编辑器登记 SQL 上下文（命令执行器挂载时调用） */
export function registerCompletionContext(view: EditorView, getContext: () => SqlContext) {
  registrationOf(view).getSql = getContext
}

/** 为某个编辑器登记模板变量（SQL 模板编辑器挂载时调用） */
export function registerTemplateContext(view: EditorView, getVariables: () => TemplateVariable[]) {
  registrationOf(view).getTemplateVariables = getVariables
}

/** 为某个编辑器登记脚本可用的全局标识符（脚本编辑器挂载时调用） */
export function registerScriptGlobals(view: EditorView, getGlobals: () => string[]) {
  registrationOf(view).getScriptGlobals = getGlobals
}

/** 编辑器销毁时注销 */
export function unregisterCompletionContext(view: EditorView | null) {
  if (view) {
    viewContexts.delete(view)
  }
}

/** 创建补全源 */
export function createSqlCompletion(
  getView: () => EditorView | null,
  mode: CompletionMode = 'sql',
  metadata: MetadataProvider = defaultMetadataProvider,
  getContext?: () => Partial<CompletionRuntime> | undefined,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    if (mode === 'none') {
      return null
    }
    const view = getView()
    if (!view) {
      return null
    }
    // 每次重新查询都重置勾选（勾选只属于这一次筛选）
    clearColumnMarks(view)

    const registration = viewContexts.get(view) ?? {}
    // 页面注入的动态上下文每次查询都重新求值，模板 / 连接变化后即时生效
    const extra = getContext?.() ?? {}
    const bundle = collectCompletions(
      context.state,
      context.pos,
      createRuntime(mode, registration, metadata, extra),
    )

    if (!bundle || !bundle.options.length) {
      // 返回 null 让已打开的补全弹层正常关闭（列未知时不报错）
      return null
    }

    /* 自行过滤（拼音首字母命中）时不能给 validFor： 编辑器只在「自己过滤」的路径上使用 validFor */
    if (bundle.filter === false) {
      const prefix = context.state.sliceDoc(Math.min(bundle.from, context.pos), context.pos)
      return {
        from: bundle.from,
        to: bundle.to,
        options: bundle.options,
        filter: false,
        /* 关掉 filter 后编辑器不会自己算命中区间，必须由这里补上： 少了它 */
        getMatch: option => matchRanges(option.label, prefix),
      }
    }

    return {
      from: bundle.from,
      to: bundle.to,
      options: bundle.options,
      // 继续输入标识符时在本地过滤，避免每次都重新查询元数据
      validFor: /^[\w$]*$/,
    }
  }
}

/** 组装运行期上下文 */
function createRuntime(
  mode: CompletionMode,
  registration: CompletionRegistration,
  metadata: MetadataProvider,
  extra?: Partial<CompletionRuntime>,
): CompletionRuntime {
  return {
    mode,
    sql: extra?.sql ?? registration.getSql?.() ?? undefined,
    templateVariables: extra?.templateVariables ?? registration.getTemplateVariables?.() ?? [],
    scriptGlobals: extra?.scriptGlobals ?? registration.getScriptGlobals?.() ?? [],
    metadata: extra?.metadata ?? metadata,
    featureFlags: extra?.featureFlags,
    useHistory: extra?.useHistory,
  }
}

/** 按模式产出候选（补全源与测试共用） */
export function collectCompletions(
  state: EditorState,
  pos: number,
  runtime: CompletionRuntime,
): CompletionBundle | null {
  if (runtime.mode === 'none') {
    return null
  }

  // getter 在这里统一求值：页面上的模板 / 连接变化后，下一次查询就会拿到新上下文
  const resolved = resolveRuntime(runtime)

  /* 第一步永远是「光标在哪门语言里」：模板区域 / 字符串注释 / SQL 主体各自分流 */
  const cursor = analyzeHybridCursor(state, pos, { mode: resolved.mode })

  // JavaScript：只给注入的全局标识符（关键字/片段由 lang-javascript 自带源负责）
  if (cursor.language === 'script') {
    const scripted = scriptBundle(state, pos, resolved.scriptGlobals)
    return scripted ? finalizeBundle(state, pos, scripted, resolved) : null
  }

  /* 模板区域优先于字符串判定：`'{{ device_no }}'` 这种引号内插值是最常见的写法 */
  if (cursor.language === 'template') {
    const template = readTemplateContext(state, pos)
    if (!template) {
      return null
    }
    const bundle = templateBundle(template, resolved.templateVariables)
    return bundle ? finalizeBundle(state, pos, bundle, resolved) : null
  }

  /* 字符串 / 注释（以及不补全的模式）到此为止：否则在 `-- 写点什么` 或 `'abc'` 里打字会一直冒表名与列名 */
  if (cursor.language !== 'sql') {
    return null
  }

  const bundle = sqlBundle(state, pos, resolved, cursor)
  if (!bundle) {
    return null
  }

  /* 模板编辑器的普通 SQL 位置：光标还落在未闭合的块里时 */
  if (resolved.mode === 'sql-template') {
    bundle.options.push(...templateClosingItems(state, pos))
  }
  return finalizeBundle(state, pos, bundle, resolved)
}

// ---------------------------------------------------------------- 静态补全

/** 无连接上下文时的静态补全：SQL 关键字 + 常用函数 */

// ---------------------------------------------------------------- SQL 路径

/** SQL 逻辑：解析作用域 → 点号 / 子句上下文 → 候选 */
function sqlBundle(
  state: EditorState,
  pos: number,
  runtime: ResolvedRuntime,
  cursor: HybridCursor,
): CompletionBundle | null {
  const metadata = runtime.metadata
  const doc = state.doc.toString()

  const word = cursor.prefix
  /* 替换范围 = 词范围（不含左侧的点号限定符） */
  const range = cursor.wordRange

  // 没有登记连接上下文（模板编辑器未绑定连接）：退化为关键字 + 函数
  if (!runtime.sql || !runtime.sql.connId) {
    return {
      from: range.from,
      to: range.to,
      options: staticOptions(runtime.featureFlags),
      contextKind: 'statement-start',
    }
  }

  const { connId, database, dbType } = runtime.sql
  const dialect = dialectOf(dbType)

  /* SQL 光标语义：语句范围 / 子句 / 位置类别 / 主关键字一次算清（纯文本层） */
  const intent = analyzeSqlCursorText(state, pos, dbType)
  const scopes = buildScopes(state, pos, doc, dbType, intent.statement, connId, database, metadata)

  const statement = intent.statement
  const clausePrefix = intent.clausePrefix
  const prefixStart = intent.prefixStart
  const scan = intent.clause
  const contextKind = intent.kind

  /* 智能项总开关（默认开）；片段型（会替换既有文本 / 一次插入多列） 另受 disableSnippets 控制：只要变量 */
  const smart = runtime.featureFlags.smartItems !== false
  const fragments = smart && runtime.featureFlags.disableSnippets !== true

  /* 候选生成的共用依赖：连接 / 库 / 方言 / 元数据一次组装， 之后所有候选函数都只吃「语义对象 + 依赖」两个入参 */
  const deps: SqlSuggestDeps = { connId, database, dialect, metadata }

  /** 表引用 → 列清单（派生表用静态列，物理表查元数据） */
  const columnsOf = (ref: TableRef) => columnsOfRef(ref, deps)

  /* GROUP BY 位置：先算出「SELECT 里未聚合的列」——它们既作为推荐列提前， 也从普通列候选里去掉同名项 */
  const promoted = smart && contextKind === 'group-by'
    ? groupByPromotion(clausePrefix, pos, scopes, columnsOf, fragments, deps)
    : { items: [] as Completion[], skip: new Set<string>() }

  /* 自动别名只在「写了别名也合法」的位置生效：FROM / JOIN 之后的表名 */
  const autoAlias = runtime.featureFlags.autoTableAlias === true
    && (scan.keyword === 'from' || scan.keyword === 'join')

  /* 列补全意图由光标层给出（`readColumnIntent`）：`t.|` 与 `t.user_id, |` 是多选 */
  const columnIntent = intent.column
  const multiColumn = columnIntent.mode === 'multi'
  const preferredQualifier = multiColumn ? columnIntent.previousQualifier : ''

  /* 槽位：光标处「允许出现什么」的语义结论（见 completion/sqlCompletionSlot.ts） */
  const slot = resolveCompletionSlot({
    kind: contextKind,
    keyword: scan.keyword,
    previousKeyword: scan.previousKeyword,
    tail: scan.tail,
    tight: scan.tight,
    column: columnIntent,
  })
  const eligibility = { slot, keyword: scan.keyword, hasTail: Boolean(scan.tail) }

  /* 限定符取光标分析层的结果（按「词首」回看，含点号）—— 这样 `` `test`.u `` 也能解析出 `['test' */
  const qualifier = qualifierSegments(cursor.qualifier)

  /* 候选族注册表（见 completion/sqlBundleProviders.ts）： 点号路径 / 通用 / 关联条件 */
  const options = runBundleProviders({
    state,
    pos,
    doc,
    word,
    qualifier,
    intent,
    scopes,
    deps,
    flags: runtime.featureFlags,
    slot,
    contextKind,
    smart,
    fragments,
    autoAlias,
    preferredQualifier,
    promoted,
    columnsOf,
  })

  /* 资格过滤先于排序（文档 §26）：不该出现在这个槽位的候选**直接删掉** */
  const eligible = options.filter(option => isCandidateAllowed(option, eligibility))

  /* 给列候选打上本次的列模式：复选框渲染与空格键都只认这个标记 */
  const stamped = multiColumn
    ? eligible.map(option =>
        (option.type === 'field' ? { ...option, columnMode: 'multi' as const } : option))
    : eligible

  return { from: range.from, to: range.to, options: stamped, contextKind }
}

// ---------------------------------------------------------------- 悬停提示
//
// 列悬停的实现（columnHoverAt 等）拆到了 ./sqlCompletionHover.ts，
// 与补全共用本文件的 buildScopes / completionStatementRange。
// 这里只保留登记上下文的读取入口（悬停与补成都要用）。

/** 读某个编辑器登记的 SQL 上下文（未登记返回 null） */
export function sqlContextOf(view: EditorView | null): SqlContext | null {
  return (view && viewContexts.get(view)?.getSql?.()) ?? null
}

/** 构建作用域链（内 → 外）：每层解析表引用，并把 CTE 定义沿链广播 */
export function buildScopes(
  state: EditorState,
  pos: number,
  doc: string,
  dbType: string,
  statement: TextRange | null,
  connId: number,
  database: string,
  metadata: MetadataProvider,
): TableRef[][] {
  /** 原始作用域链（内 → 外），是否被下面的定义体规则截断见后文 */
  const allScopes = scopeRanges(state, pos, doc, dbType, statement)
    .map(range => ({ range, text: doc.slice(range.from, range.to) }))

  /** `SELECT *` 的物理表来源：查元数据缓存（缺失时由 provider 后台补齐， 本次解析先按「列未知」处理 */
  const resolveStarColumns = (ref: TableRef): VirtualColumn[] | null => {
    const columns = metadata.columns(connId, ref.schema || database, ref.table)
      .map(column => ({
        name: column.name,
        from: ref.table,
        dataType: column.dataType,
        comment: column.comment,
      }))
    return columns.length ? columns : null
  }

  /** 某张表某列的类型 / 注释：给「显式列清单」的派生列补出来源信息 */
  const resolveColumnMeta = (ref: TableRef, column: string) => {
    const found = metadata.columns(connId, ref.schema || database, ref.table)
      .find(item => item.name.toLowerCase() === column.toLowerCase())
    return found ? { dataType: found.dataType, comment: found.comment } : null
  }

  // 1) 从内到外收集 CTE（内层同名先注册，外层不覆盖）
  const visibleCtes = new Map<string, VirtualColumn[] | null>()
  /** 光标所在定义体的 CTE：对本次补全不可见（递归自引用） */
  const hiddenCtes = new Set<string>()
  /** 光标是否落在某个 CTE 定义体内 */
  let insideCteBody = false

  /** 跨层可见的 CTE 输出列（内层子查询能引用外层定义的 CTE） */
  const resolveCteColumns = (name: string): VirtualColumn[] | null =>
    visibleCtes.get(name.toLowerCase()) ?? null

  for (const scope of allScopes) {
    const defs = collectCteDefs(
      scope.text,
      scope.range.from,
      name => visibleCtes.get(name) ?? null,
      { resolveStarColumns, resolveColumnMeta, resolveCteColumns },
    )
    for (const def of defs) {
      const key = def.name.toLowerCase()
      // 光标在定义体内：不注册，避免自引用
      if (pos >= def.bodyFrom && pos <= def.bodyTo) {
        hiddenCtes.add(key)
        insideCteBody = true
        continue
      }
      if (visibleCtes.has(key)) {
        continue
      }
      visibleCtes.set(key, def.columns)
    }
  }

  /* 光标在定义体里时截断到最内层：定义体（CTE 的 AS (…)、FROM/JOIN 后的派生表） 在求值时先于同一 FR */
  const inDefinitionBody = insideCteBody
    || (allScopes.length > 1 && isDerivedTableBody(doc, allScopes[0].range))
  const scopes = inDefinitionBody ? allScopes.slice(0, 1) : allScopes

  // 2) 每层解析表引用，并用可见 CTE 回填派生列
  //
  // `*` 的展开来源在这一步额外叠加「可见 CTE」：`FROM (SELECT * FROM a) t`
  // 里的 `a` 若是 CTE，静态解析同样要拿到它的输出列（收集 CTE 那一轮只有元数据可用）。
  const resolveStarWithCtes = (ref: TableRef): VirtualColumn[] | null =>
    visibleCtes.get(ref.table.toLowerCase()) ?? resolveStarColumns(ref)

  return scopes.map((scope) => {
    const refs = collectTableRefs(scope.text, {
      // 只看本层来源：嵌套层由作用域链上更内层的那一层负责
      topLevelOnly: true,
      excludeCte: name => hiddenCtes.has(name),
      resolveStarColumns: resolveStarWithCtes,
      resolveColumnMeta,
      resolveCteColumns,
    })
    for (const ref of refs) {
      if (ref.virtualColumns) {
        continue
      }
      const columns = visibleCtes.get(ref.table.toLowerCase())
      if (columns) {
        ref.virtualColumns = columns
      }
    }
    return refs
  })
}

/** 括号范围是不是「派生表体」：`FROM (…)` / `JOIN (…)` 里的子查询 */
function isDerivedTableBody(doc: string, range: TextRange): boolean {
  if (doc[range.from - 1] !== '(') {
    return false
  }

  let index = range.from - 2
  while (index >= 0 && /\s/.test(doc[index] ?? '')) {
    index--
  }
  const end = index + 1
  while (index >= 0 && /[\w$]/.test(doc[index] ?? '')) {
    index--
  }
  const word = doc.slice(index + 1, end).toLowerCase()
  return word === 'from' || word === 'join' || word === 'into' || word === 'update'
}

// ---------------------------------------------------------------- 模板 / 脚本路径
//
// 模板（{{ … }}）与 JavaScript 两种模式的补全拆到了 ./sqlTemplateCompletion.ts，
// collectCompletions 按光标是否在未闭合的 {{ … }} 内分派。

// ---------------------------------------------------------------- 点号补全



// ColumnDetail / ColumnCompletion / columnItem 见 ./sqlCompleti


/** 派生表 / CTE 的字段补全（列名与类型来自静态解析 + 元数据） */

/** 派生表 / CTE 别名候选的提示：所有列来源一致时点出源头表 */


// ---------------------------------------------------------------- 普通补全


/** 关键字权重：表达式关键字排在子句关键字之前 */

/** 表达式关键字的集合版，用于决定候选权重 */


// ---------------------------------------------------------------- 子句上下文（决定候选类型）
// ---------------------------------------------------------------- 子句上下文 / 语句范围
//
// 子句扫描、语句范围与位置类别的实现都在 ./sqlCursor.ts（SQL 光标语义）；
// 本文件只消费它的结论，候选生成与触发策略不会出现两套判定。



/** 库名候选：选中后自动补点号并再弹一次（接着就能选该库的表） */

// ---------------------------------------------------------------- 元数据（统一走 metadataStore）

/** 默认元数据来源：`stores/metadataStore.ts`（与连接管理页共用同一份缓存 */
export const defaultMetadataProvider: MetadataProvider = {
  databases: connId => metadata().ensureDatabases(connId),
  // 带系统库标记的库列表：库名候选按后端标记过滤，前端不再自己认方言
  databaseInfos: connId => metadata().ensureDatabaseInfos(connId),
  tables: (connId, database) => metadata().ensureTables(connId, database),
  columns: (connId, database, table) => metadata().ensureColumns(connId, database, table),
  values: (_connId, _database, _table, column) => dictionaryValues(column),
  // 外键：有关联关系时优先给出「外键推导的条件」，没有/拿不到就退化为命名启发式
  foreignKeys: (connId, database, table) => metadata().ensureForeignKeys(connId, database, table),
}

/** 比较值的默认来源：**同名词典** */
function dictionaryValues(column: string): SmartCompareValue[] {
  const dict = dictionaryStore()
  const target = dict.dictionaries.find(item => item.name.toLowerCase() === column.toLowerCase())
  if (!target) {
    return []
  }
  return (dict.items[target.id] ?? []).map(item => ({
    value: item.value,
    meaning: item.meaning,
    source: `词典 ${target.name}`,
  }))
}

/** 延迟解析词典 store 实例（与 metadata() 同理）： 这些函数都在补全回调里执行 */
let dictionaryStoreCache: ReturnType<typeof useDictStore> | null = null
function dictionaryStore(): ReturnType<typeof useDictStore> {
  dictionaryStoreCache ??= useDictStore()
  return dictionaryStoreCache
}

/** 延迟解析 store 实例 */
let metadataStore: ReturnType<typeof useMetadataStore> | null = null
function metadata(): ReturnType<typeof useMetadataStore> {
  metadataStore ??= useMetadataStore()
  return metadataStore
}

// ---------------------------------------------------------------- SQL 结构解析
//
// 表引用 / 派生表 / CTE 输出列的解析都在 ./sqlSchema.ts：
// 纯文本解析，元数据查询由 TableRefOptions 注入；这里只消费它的结果。
import { VirtualColumn, TableRef, collectTableRefs, collectCteDefs } from './sqlSchema'
export type { TableRef, VirtualColumn } from './sqlSchema'
// ---------------------------------------------------------------- 候选生成
//
// 子句候选 / 点号补全 / 智能项 / 关联条件 / 库名补全都在 ./sqlSuggestions.ts：
// 每个入口都只吃「语义对象 + 依赖」，本文件只做入口、装配与再导出。
import {
  columnsOfRef,
  groupByPromotion,
  qualifierSegments,
  staticOptions,
} from './sqlSuggestions'
import { runBundleProviders } from './completion/sqlBundleProviders'
import type { SqlSuggestDeps } from './sqlSuggestions'

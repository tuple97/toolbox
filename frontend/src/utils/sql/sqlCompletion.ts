/**
 * 分层智能补全（CodeMirror 6）：按编辑器用途分派到 SQL / 模板 / 脚本三条路径。
 *
 * ## 补全模式（completionMode，由编辑器用途决定，不靠 language 猜）
 *
 *  | 模式 | 使用位置 | 候选来源 |
 *  |---|---|---|
 *  | `sql` | 命令执行器 | 元数据表/列/库 + SQL 关键字 + 函数 |
 *  | `sql-template` | SQL 模板编辑器 | `sql` 全部 + `{{ 变量 }}` + 模板函数 |
 *  | `javascript` | 前置 / 后置脚本 | 注入的全局标识符（语言自带源由编辑器追加） |
 *  | `none` | 执行日志 | 不补全 |
 *
 * ## 分层（先定语言，再定语义，最后定候选与插入）
 *
 *  1. `analyzeHybridCursor`（hybridCursor.ts）先回答「光标在哪门语言里」：
 *     模板区域 `{{ … }}`（含写在字符串里的插值）→ 模板；字符串 / 注释 → 不补全；
 *     其余 → SQL。它同时给出**统一的替换范围**（正在输入的词 + 点号限定符），
 *     后续各条路径都沿用它，不再各自算一套 from / to；
 *  2. 模板语言由 `template/` 目录解析：词法（templateLexer）→ 语法与块配对
 *     （templateParser）→ 作用域（templateScope）→ 光标意图 → 候选
 *     （sqlTemplateCompletion）；
 *  3. SQL 语义分两层：`analyzeSqlCursorText`（sqlCursor.ts：语句 / 子句 / 位置类别）
 *     与结构解析（sqlSchema.ts：表引用 / 派生表 / CTE 输出列）；本文件负责把
 *     这两层组装成 `SqlCursorIntent`（含作用域链）并产出候选。
 *
 * 语言区域是**结构判定**：`'{{ device_no }}'` 归模板管，是因为 `{{ … }}`
 * 本身就是一段内嵌语言，而不是因为它恰好写在引号里、更不靠调用顺序兜底。
 *
 * ## SQL 逻辑要点
 *
 *  - **按位置给候选**（`readClauseKind` 反向扫描出最近的同级子句关键字）：
 *    `FROM |` → 只给表与库；`FROM t |` → 表 + 库 + 关键字；`SELECT |` → 列 + 别名 + 函数。
 *    子句判定用容错扫描而不是语法树：补全时语句往往没写完，扫描比半成品语法树稳。
 *  - **作用域按子查询分层**：靠 `sqlSyntax.scopeRanges` 拿到嵌套括号节点，
 *    「最内层子查询 → … → 外层语句」逐层解析表引用；内层别名遮蔽外层同名别名，
 *    支持相关子查询（内层可用外层表的字段）。
 *  - **CTE 沿作用域链广播**：CTE 只定义在某一层，但内层子查询也能引用它，
 *    因此从内到外合并出一份可见 CTE，再回填到各层的表引用上；同名时内层优先；
 *    光标落在某 CTE 定义体内时把它剔除，避免递归 CTE 自引用误补。
 *  - **依赖链**：`WITH a AS (…), b AS (SELECT * FROM a)` 按声明顺序解析，
 *    `b` 里的 `*` 会用 `a` 的输出列展开；解析不出时按「列未知」处理（不猜）。
 *  - 点号补全按「逐层别名 > 逐层无别名 CTE 名 > 显式 `库.表.` > 当前库表名 > 库名」解析。
 *  - 元数据统一由 `stores/metadataStore.ts` 缓存（TTL 5 分钟），缺失时后台异步补齐，
 *    本次补全立即返回已有数据，绝不阻塞输入；测试可用 `MetadataProvider` 注入假数据。
 *  - 别名 / 派生表 / CTE 这些**语义**用容错扫描（`collectTableRefs`）而不是语法树：
 *    补全时语句通常还没写完（正打到 `where u.`），语法树没有别名语义，
 *    而这套扫描对半成品语句更宽容。
 */
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
  /**
   * 值类型。
   *
   * 用于「参数位该优先给什么」与点号取值的判断（`{{ len | }}` 优先数组 / 字符串，
   * `{{ .| }}` 只在对象上有意义）；不填按未知处理，候选照样给。
   */
  type?: TemplateValueType
  /**
   * 对象字段。
   *
   * `{{with 变量}}` / `{{range 变量}}` 里 `.字段` 的候选来源；
   * 不填时点号位置回退给变量列表（宁可给可能相关的，也不空着）。
   */
  properties?: TemplateProperty[]
  /** 数组元素类型：`{{range 变量}}` 里 `.` 的类型 */
  elementType?: TemplateValueType
}

/** 元数据提供者：默认走 metadataStore，测试可注入静态数据 */
export interface MetadataProvider {
  databases(connId: number): string[]
  /**
   * 库列表（含「是否系统库」标记，可选）。
   *
   * 有它时，库名候选的系统库过滤按**后端标记**判断（适配层知道自己的方言有
   * 哪些自带对象）；没有就退回「名字 + 方言表」（见 utils/sql/sqlVisibility.ts）。
   * 之所以做成可选：轻量场景（模板变量的输入框）只需要名字。
   */
  databaseInfos?: (connId: number) => DatabaseInfo[]
  tables(connId: number, database: string): string[]
  columns(connId: number, database: string, table: string): ExecutorColumn[]
  /**
   * 外键约束（可选）。
   *
   * 关联条件补全优先用它生成 `ON a.x = b.y`；不实现（或查询失败 / 无权限）时
   * 退化为命名启发式（`{单数表名}_id = 对方.id`），功能不缺席。
   */
  foreignKeys?: (connId: number, database: string, table: string) => ForeignKeyInfo[]
  /**
   * 某列的可选值（可选），用于「比较值」智能项。
   *
   * 默认实现按「词典名与列名同名」从词典取值；不实现（或该列没有值域数据）时
   * 不提供比较值候选，其余补全不受影响。
   */
  values?: (
    connId: number,
    database: string,
    table: string,
    column: string,
  ) => SmartCompareValue[]
}

/*
 * 位置类别（CompletionContextKind）与子句结论（ClauseKind / ClauseScan）定义在
 * ./sqlCursor.ts —— 它们是 SQL 光标语义的一部分，与「哪条语句 / 哪个子句」同源。
 * 这里只做再导出，调用方（组件 / 触发策略 / 测试）的导入路径不变。
 */
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
  /**
   * 表名补全后自动补别名（设置项 `sql_completion_alias`）。
   *
   * 由编辑器封装层统一注入（页面不必各自读设置），
   * 因此设置改完**下一次补全**就生效，不用重建编辑器。
   */
  autoTableAlias?: boolean
  /**
   * 是否在候选里展示系统库（设置项 `sql_show_system_databases`，默认展示）。
   *
   * 只影响**候选生成**：显式写下 `mysql.user` 时仍然照常解析 ——
   * 隐藏不等于非法（见 utils/sql/sqlVisibility.ts）。
   */
  showSystemDatabases?: boolean
}

/**
 * 一次补全所需的运行期上下文。
 *
 * `sql` / `templateVariables` / `scriptGlobals` 允许传**取值函数**：
 * 每次查询都重新求值，因此页面上的模板配置、当前连接变化后，
 * 引用它的编辑器无需重建即可拿到新上下文。
 */
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
  /**
   * 替换范围的结束位置（缺省表示到光标）。
   *
   * 光标停在词中间时（`u.na|me`），候选应当替换**整个**词而不是只替换
   * 光标左边那半截，否则会留下 `namen` 这样的残尾。
   */
  to?: number
  options: Completion[]
  /** 本次命中的位置类别（触发策略与新候选共用） */
  contextKind: CompletionContextKind
  /**
   * 是否交给编辑器过滤候选。
   * 本模块自行完成匹配（例如中文表名用拼音首字母命中）时置 false——
   * 此时候选项已按本模块的打分排好序，编辑器不再插手。
   */
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

/**
 * 读运行期上下文里的 SQL 侧信息（兼容「值」与「getter」两种写法）。
 * 悬停提示等旁路功能也用它，口径与补全保持一致。
 */
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

/**
 * 收尾：排序、必要时自行过滤、给候选项挂上「选中即记历史」的包装。
 *
 * 排序只做稳定重排，等于同分时保留原有插入顺序，
 * 因此「列在前、关键字在后」这类既有分类顺序不会被打破。
 */
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

  /*
   * 有输入时必须由本模块同时过滤和排序。若仍交给 CodeMirror 的 filter，
   * 它会按自身的模糊匹配分数再次重排，覆盖「完整/前缀命中优先」的规则。
   * 这也顺便覆盖拼音命中；匹配口径统一为 matchesPrefix。
   *
   * 例外：整段替换型候选（块片段）与前缀无关 —— 它替换整个 `{{ … }}`，
   * 用户已经在片段里写了内容时仍然要能选中（见 isOfferedRegardlessOfPrefix）。
   */
  const customFilter = Boolean(prefix)
  const matched = customFilter
    ? bundle.options.filter(option =>
        matchesPrefix(option.label, prefix) || isOfferedRegardlessOfPrefix(option))
    : bundle.options

  /*
   * 排序之后再截断：留下的都是分数最高（前缀命中 / 高频 / 该位置该出现）的那些，
   * 超宽表 + 多表 JOIN 也不会把上千个候选一路带进弹层。
   */
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

/**
 * 给候选项包一层「选中即记历史」。
 *
 * 只包装 apply，不改变任何插入行为：
 *  - 候选项自带函数 apply（列勾选、点号追加、模板闭合等）→ 原样调用；
 *  - 自带字符串 apply（函数补 `()`）→ 按字符串插入；
 *  - 都没有 → 插入 label 本身（与编辑器默认行为一致）。
 */
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

/**
 * 该位置是否属于「合理弹窗位」（打字触发的 position 档据此判定）。
 *
 * 排除别名位：那里只能写别名，弹出来也是空列表；
 * 模板 / 脚本 / 无补全的编辑器不走这条路径。
 */
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

/**
 * 当前位置的类别（触发策略与页面按需调用）。
 *
 * 只做文本扫描，不查元数据，因此可以在每次按键时廉价调用；
 * 语言区域走与补全同一套光标分析（`analyzeHybridCursor`），
 * 之后的子句判定与补全共用 scanClause / currentClausePrefix ——
 * 触发策略与补全不会出现两套口径。
 */
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

/**
 * 编辑器实例 → 补全上下文。
 *
 * 键必须是 EditorView 而不是 EditorState：CM6 里任何 dispatch（含 Compartment
 * 重配置主题）都会产生新的 EditorState，用 state 做键会在切换主题后丢上下文。
 */
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

/**
 * 创建补全源。
 *
 * CompletionSource 拿不到 EditorView，因此由编辑器封装层（CodeEditor.vue）
 * 以闭包形式把 view 传进来，再回查上面登记上下文。
 */
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

    /*
     * 自行过滤（拼音首字母命中）时不能给 validFor：
     * 编辑器只在「自己过滤」的路径上使用 validFor。
     */
    if (bundle.filter === false) {
      const prefix = context.state.sliceDoc(Math.min(bundle.from, context.pos), context.pos)
      return {
        from: bundle.from,
        to: bundle.to,
        options: bundle.options,
        filter: false,
        /*
         * 关掉 filter 后编辑器不会自己算命中区间，必须由这里补上：
         * 少了它，打字触发的重查会把上一次画出的加粗擦掉（「粗体一闪就没了」）。
         */
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

/**
 * 组装运行期上下文。
 *
 * 与寄存上下文（registerCompletionContext 等）的区别：这里是**按编辑器用途**
 * 给出的默认上下文，页面还可以通过 CodeEditor 的 completionContext 注入
 * 动态内容（同一编辑器换模板 / 换连接后即时生效）。
 */
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

/**
 * 按模式产出候选（补全源与测试共用）。
 * 只依赖 EditorState，不依赖 EditorView / DOM，因此可以在单测里直接调用。
 */
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

  /*
   * 第一步永远是「光标在哪门语言里」：模板区域 / 字符串注释 / SQL 主体各自分流，
   * 同时拿到统一的替换范围（词 + 点号限定符），后面各条路径都沿用它，
   * 不再各自算一套 from / to。
   */
  const cursor = analyzeHybridCursor(state, pos, { mode: resolved.mode })

  // JavaScript：只给注入的全局标识符（关键字/片段由 lang-javascript 自带源负责）
  if (cursor.language === 'script') {
    const scripted = scriptBundle(state, pos, resolved.scriptGlobals)
    return scripted ? finalizeBundle(state, pos, scripted, resolved) : null
  }

  /*
   * 模板区域优先于字符串判定：`'{{ device_no }}'` 这种引号内插值是最常见的写法。
   * 依据是结构（`{{ … }}` 就是一段内嵌语言），而不是调用顺序。
   */
  if (cursor.language === 'template') {
    const template = readTemplateContext(state, pos)
    if (!template) {
      return null
    }
    const bundle = templateBundle(template, resolved.templateVariables)
    return bundle ? finalizeBundle(state, pos, bundle, resolved) : null
  }

  /*
   * 字符串 / 注释（以及不补全的模式）到此为止：否则在 `-- 写点什么`
   * 或 `'abc'` 里打字会一直冒表名与列名。
   */
  if (cursor.language !== 'sql') {
    return null
  }

  const bundle = sqlBundle(state, pos, resolved, cursor)
  if (!bundle) {
    return null
  }

  /*
   * 模板编辑器的普通 SQL 位置：光标还落在未闭合的块里时，把 {{else}} / {{end}}
   * 追加在 SQL 候选之后（boost 低于子句关键字）——收尾方便，但不抢 SQL 候选的位置。
   */
  if (resolved.mode === 'sql-template') {
    bundle.options.push(...templateClosingItems(state, pos))
  }
  return finalizeBundle(state, pos, bundle, resolved)
}

// ---------------------------------------------------------------- 静态补全

/** 无连接上下文时的静态补全：SQL 关键字 + 常用函数 */

// ---------------------------------------------------------------- SQL 路径

/**
 * SQL 逻辑：解析作用域 → 点号 / 子句上下文 → 候选。
 *
 * 「正在输入的词」与替换范围由光标分析（`HybridCursor`）给出，
 * 本函数不再自己扫一遍行首 —— 两条路径的口径必须一致。
 */
function sqlBundle(
  state: EditorState,
  pos: number,
  runtime: ResolvedRuntime,
  cursor: HybridCursor,
): CompletionBundle | null {
  const metadata = runtime.metadata
  const doc = state.doc.toString()

  const word = cursor.prefix
  /*
   * 替换范围 = 词范围（不含左侧的点号限定符）。
   *
   * 编辑器会把 from..to 的文本当作候选项的匹配输入：`u.` 算进来后
   * pattern 就成了 `u.`，而列候选的搜索名是裸列名 —— 全被过滤掉，列表是空的。
   * 限定符由候选自带的前缀写回（见 sqlCompletionInsert 的 `columnPrefix`）。
   */
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

  /*
   * SQL 光标语义：语句范围 / 子句 / 位置类别 / 主关键字一次算清（纯文本层）。
   * 作用域链则要在它给出的语句范围上解析 —— 由内到外：内层子查询 → 外层语句，
   * 整段脚本里其它语句的别名不会出现在链上，所以不会互相污染。
   */
  const intent = analyzeSqlCursorText(state, pos, dbType)
  const scopes = buildScopes(state, pos, doc, dbType, intent.statement, connId, database, metadata)

  const statement = intent.statement
  const clausePrefix = intent.clausePrefix
  const prefixStart = intent.prefixStart
  const scan = intent.clause
  const contextKind = intent.kind

  /*
   * 智能项总开关（默认开）；片段型（会替换既有文本 / 一次插入多列）
   * 另受 disableSnippets 控制：只要变量的轻量场景可以关掉它们。
   */
  const smart = runtime.featureFlags.smartItems !== false
  const fragments = smart && runtime.featureFlags.disableSnippets !== true

  /*
   * 候选生成的共用依赖：连接 / 库 / 方言 / 元数据一次组装，
   * 之后所有候选函数都只吃「语义对象 + 依赖」两个入参。
   */
  const deps: SqlSuggestDeps = { connId, database, dialect, metadata }

  /** 表引用 → 列清单（派生表用静态列，物理表查元数据） */
  const columnsOf = (ref: TableRef) => columnsOfRef(ref, deps)

  /*
   * GROUP BY 位置：先算出「SELECT 里未聚合的列」——它们既作为推荐列提前，
   * 也从普通列候选里去掉同名项，避免同一列在列表里出现两次。
   */
  const promoted = smart && contextKind === 'group-by'
    ? groupByPromotion(clausePrefix, pos, scopes, columnsOf, fragments, deps)
    : { items: [] as Completion[], skip: new Set<string>() }

  /*
   * 自动别名只在「写了别名也合法」的位置生效：FROM / JOIN 之后的表名。
   * INSERT INTO / UPDATE / TRUNCATE 后面加别名是语法错误，绝不能顺手带上。
   */
  const autoAlias = runtime.featureFlags.autoTableAlias === true
    && (scan.keyword === 'from' || scan.keyword === 'join')

  /*
   * 列补全意图由光标层给出（`readColumnIntent`）：`t.|` 与 `t.user_id, |` 是多选，
   * `t.user_id,|` 与 `t.em|` 是单选。多选时新列要沿用前一项的限定符 ——
   * 用户写了 `t.user_id, ` 之后勾出来的列必须还是 `t.*`。
   */
  const columnIntent = intent.column
  const multiColumn = columnIntent.mode === 'multi'
  const preferredQualifier = multiColumn ? columnIntent.previousQualifier : ''

  /*
   * 槽位：光标处「允许出现什么」的语义结论（见 completion/sqlCompletionSlot.ts）。
   * 资格过滤（下一段）与关键字集合都按它算 —— `SELECT |` 是 select-item-start，
   * 于是 FROM / WHERE / GROUP BY / ORDER BY 根本不会生成。
   */
  const slot = resolveCompletionSlot({
    kind: contextKind,
    keyword: scan.keyword,
    previousKeyword: scan.previousKeyword,
    tail: scan.tail,
    tight: scan.tight,
    column: columnIntent,
  })
  const eligibility = { slot, keyword: scan.keyword, hasTail: Boolean(scan.tail) }

  /*
   * 限定符取光标分析层的结果（按「词首」回看，含点号）——
   * 这样 `` `test`.u `` 也能解析出 `['test']`，走 after-dot 路径补 test 库的表；
   * 只看「光标紧邻点号」的 readQualifierBeforeCursor 在这里会返回 null，
   * 库名被丢掉后退化成「当前库的表」，于是 `u` 匹配不到 test.user。
   */
  const qualifier = qualifierSegments(cursor.qualifier)

  /*
   * 候选族注册表（见 completion/sqlBundleProviders.ts）：
   * 点号路径 / 通用 / 关联条件 / GROUP BY 推荐 / 智能项各自声明「什么时候轮到我」，
   * 顺序由注册表决定 —— 与改造前这里的书写顺序逐条对应。
   */
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

  /*
   * 资格过滤先于排序（文档 §26）：不该出现在这个槽位的候选**直接删掉**，
   * 而不是靠 boost 把它们压到后面（`WHERE.boost -= 1000` 那套）。
   */
  const eligible = options.filter(option => isCandidateAllowed(option, eligibility))

  /*
   * 给列候选打上本次的列模式：复选框渲染与空格键都只认这个标记。
   * 这里复制成新对象，候选池里共享的那份保持干净。
   */
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

/**
 * 构建作用域链（内 → 外）：每层解析表引用，并把 CTE 定义沿链广播。
 *
 * 为什么需要广播：CTE 通常写在外层语句，但内层子查询同样能引用它；
 * 单看某一层的文本是解析不出这些列的。
 *
 *  - 同名 CTE 内层优先（内层遮蔽外层）；
 *  - 光标落在某个 CTE 定义体内时剔除该 CTE，否则递归 CTE
 *    （`WITH RECURSIVE t AS (… FROM t)`）会拿到自己而误补；
 *  - 派生表里的 `SELECT *`（如 `(SELECT * FROM users) t1`）用元数据展开，
 *    否则 `t1.` 会因为「列未知」而没有任何候选；
 *  - 光标位于「定义体」（CTE 定义体，或 FROM / JOIN 后面的派生表体）时只保留这一层：
 *    定义体求值先于同一 FROM 里的其它表，标准 SQL 不允许引用它们（那要写 LATERAL），
 *    否则 `FROM (SELECT | FROM users) t1` 会在内层冒出外层别名 t1。
 */
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

  /**
   * `SELECT *` 的物理表来源：查元数据缓存（缺失时由 provider 后台补齐，
   * 本次解析先按「列未知」处理，绝不阻塞输入）。
   *
   * 结果里带上 from / dataType，派生列在候选列表中就能显示来源表与字段类型。
   */
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

  /*
   * 光标在定义体里时截断到最内层：定义体（CTE 的 AS (…)、FROM/JOIN 后的派生表）
   * 在求值时先于同一 FROM 里的其它表，引用它们属于非法 SQL（LATERAL 例外，暂不支持），
   * 因此更外层不贡献任何表引用。
   */
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

/**
 * 括号范围是不是「派生表体」：`FROM (…)` / `JOIN (…)` 里的子查询。
 *
 * 只看括号左侧的关键字（范围两端都不含括号本身），
 * 于是 `WHERE EXISTS (…)`、`IN (…)` 这类表达式位置的子查询会返回 false。
 */
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



// ColumnDetail / ColumnCompletion / columnItem 见 ./sqlCompletionInsert.ts


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

/**
 * 默认元数据来源：`stores/metadataStore.ts`（与连接管理页共用同一份缓存，
 * 那边刷新后这里立刻用到新数据）。
 *
 * 三个方法都保持「同步返回缓存 + 后台补齐」的语义：补全候选必须立刻返回，
 * 绝不等待网络。测试可通过 `MetadataProvider` 注入静态数据替换它。
 */
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

/**
 * 比较值的默认来源：**同名词典**。
 *
 * 词典与结果列的绑定关系存在模板的字段映射里，而编辑器拿不到「当前语句对应哪个
 * 结果列」，因此这里按「词典名与列名同名」匹配（忽略大小写）——一个字段一个词典
 * 正是本项目里词典的主要用法。
 * 词典未加载、或没有同名词典时返回空数组（不提供比较值候选，不算错误）。
 */
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

/**
 * 延迟解析词典 store 实例（与 metadata() 同理）：
 * 这些函数都在补全回调里执行，此时 pinia 已激活；模块加载期不能调用。
 */
let dictionaryStoreCache: ReturnType<typeof useDictStore> | null = null
function dictionaryStore(): ReturnType<typeof useDictStore> {
  dictionaryStoreCache ??= useDictStore()
  return dictionaryStoreCache
}

/**
 * 延迟解析 store 实例。
 *
 * 这些函数都在补全回调（用户输入）里执行，此时 pinia 已激活；
 * 但模块加载期不能调用 useMetadataStore()，因此这里惰性获取并缓存。
 */
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

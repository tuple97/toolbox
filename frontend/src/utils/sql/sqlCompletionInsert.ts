/**
 * 列候选的「身份、勾选多选与插入」。
 *
 * 三条约定（都是踩过坑换来的）：
 *
 *  1. **身份不是列名**：`users u` 与 `orders o` 都有 `created_at`，它们是两个候选。
 *     因此候选项带 `columnKey`（`schema.table@source.column`）—— 去重、勾选、渲染缓存
 *     全部按它走；裸列名只作为「搜索名」（label）用于前缀匹配。
 *  2. **展示名与插入文本由候选给出**：多来源时展示 `u.created_at`、插入也带限定符；
 *     单来源时就是裸列名。展示走 CM6 的 `displayLabel`。
 *  3. **替换范围只覆盖词**：编辑器会把替换范围里的文本当作匹配输入，
 *     把 `u.` 算进去会让所有列候选（搜索名是裸列名）匹配失败。限定符因此
 *     由候选自带（`columnPrefix`）写回 —— apply 不解析 SQL，只在
 *     「文档里已经写着这个前缀」时不再重复插入。
 */
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { ColumnCompletionMode } from './sqlCursor'
import { BOOST_COLUMN, RESERVED_WORDS } from './sqlCompletionKeywords'
import { quoteIdent } from './rowSql'
import type { SqlDialect } from './rowSql'
import {
  ASCII_IDENT_RE,
  IDENT_OR_QUOTED_SOURCE,
  isIdentBody,
} from './sqlLexemes'

// ---------------------------------------------------------------- 标识符引用

/**
 * 该标识符不加引用符就会出错：不是 ASCII 纯标识符写法（含空格 / 短横线 / 中文等），
 * 或命中保留字（`order`、`key`、`user` 这类列名很常见）。
 */
export function needsQuoting(name: string): boolean {
  return !ASCII_IDENT_RE.test(name) || RESERVED_WORDS.has(name.toLowerCase())
}

/**
 * 标识符的落地写法。
 *
 * `quote` 是用户自己敲下的引号（`` ` `` / `"` / `[`）：敲了就用他的样式并配对着闭合，
 * 没敲则只在必要时（保留字 / 非纯标识符）才加引用符，保持 SQL 干净。
 */
export function renderIdent(name: string, dialect: SqlDialect, quote?: string): string {
  if (quote) {
    const close = quote === '[' ? ']' : quote
    return `${quote}${name.split(quote).join(quote + quote)}${close}`
  }
  return needsQuoting(name) ? quoteIdent(name, dialect) : name
}

/** 光标左侧紧邻的开引号（含它自己的起止位置） */
export interface OpeningQuote {
  /** 开引号字符 */
  quote: string
  /** 配对的闭引号 */
  close: string
  /** 开引号在文档中的下标 */
  start: number
}

/**
 * 光标左侧是不是一个**开引号**。
 *
 * 用户常先敲引号再打名字（`` `na ``）：插入时要把这个引号一起替换掉、
 * 并补上右引号，否则文档里会留下 `` `name `` 这种没闭合的写法。
 *
 * 判断「开」而不是「闭」的依据：引号左边紧邻的是标识符字符时（`` `name` `` 的第二个引号），
 * 那是收尾用的闭引号，不属于本次替换范围。
 */
export function openingQuoteBefore(text: string, from: number): OpeningQuote | null {
  const quote = text[from - 1]
  if (quote !== '`' && quote !== '"' && quote !== '[') {
    return null
  }
  const before = text[from - 2] ?? ''
  if (isIdentBody(before)) {
    return null
  }
  return { quote, close: quote === '[' ? ']' : quote, start: from - 1 }
}

/**
 * 「总是带引号」的候选（表名 / 库名）的插入：吃掉用户已经敲下的开引号。
 *
 * 不处理的话，用户敲 `` `us `` 选中 users 会得到 `` ``users` ``（两个引号）。
 */
export function quotedIdentApply(identifier: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const open = openingQuoteBefore(view.state.doc.toString(), from)
    const start = open ? open.start : from
    view.dispatch({
      changes: { from: start, to, insert: identifier },
      selection: { anchor: start + identifier.length },
    })
  }
}

/** 限定符回看长度：别名不会离光标太远，避免全文扫描 */
const QUALIFIER_LOOKBACK = 128

/** 光标左侧的限定符：`t1.`、`` `db`.`t`. ``、`用户.` 等，允许点号前有多段 */
const QUALIFIER_BEFORE = new RegExp(`(?:(?:${IDENT_OR_QUOTED_SOURCE})\\.)+$`)

/**
 * 读出替换起点左侧紧邻的限定符（含点号），没有则返回空串。
 *
 * 由光标分析层使用（`hybridCursor`）：它把「词 + 限定符」算成统一替换范围，
 * apply 阶段不再调用它。
 */
export function qualifierBeforeCursor(text: string, from: number): string {
  const start = Math.max(0, from - QUALIFIER_LOOKBACK)
  return QUALIFIER_BEFORE.exec(text.slice(start, from))?.[0] ?? ''
}

// ---------------------------------------------------------------- 列候选

/** 列候选的「身份」：同一张表的同一列，在不同来源（别名）下是两个候选 */
export interface ColumnCandidateId {
  /** 库 / 模式名（未限定时为空） */
  schema?: string
  /** 物理表名（派生表 / CTE 则是它自己的名字） */
  table: string
  /** 来源限定符：别名；无别名时等于表名 */
  source: string
  /** 列名 */
  column: string
}

/**
 * 身份键：去重、勾选与渲染缓存都用它。
 *
 * 形如 `testdb.users@u.created_at`（一律小写，数据库标识符大小写不敏感）。
 */
export function columnCandidateKey(id: ColumnCandidateId): string {
  return `${id.schema ?? ''}.${id.table}@${id.source}.${id.column}`.toLowerCase()
}

/** 列候选项的描述片段：提示栏里分段渲染并配图标（见 CodeEditor.vue 的 renderColumnDetail） */
export interface ColumnDetail {
  /** 完整类型（varchar(32)） */
  dataType?: string
  /** 来源表 / 别名 */
  from?: string
  /** 字段注释 */
  comment?: string
}

/** 带列描述与身份的补全项：CM6 会把同一个对象交给渲染回调，附加字段可安全携带 */
export interface ColumnCompletion extends Completion {
  columnDetail?: ColumnDetail
  /** 候选身份键（多选状态与渲染缓存用它，而不是裸列名） */
  columnKey?: string
  /** 该候选实际插入的文本（可能带限定符：`u.created_at`） */
  columnInsert?: string
  /**
   * 插入文本里的限定符部分（`u.`，无则空）。
   *
   * 只用于判断「文档里是不是已经写着了」：点号补全（`u.|`）的替换范围只有词，
   * 左侧的 `u.` 本来就在文档里，插入时不该再来一遍（否则 `u.u.id`）。
   */
  columnPrefix?: string
  /**
   * 这次补全的列模式（单选 / 多选）。
   *
   * 由补全引擎按**光标意图**（`readColumnIntent`）在候选上打标：
   * 复选框与空格键都只认它，不再自己判断上下文 —— 于是「是否显示复选框」
   * 是意图的语义结果，而不是「候选恰好是列」的自然结果。
   */
  columnMode?: ColumnCompletionMode
}

/** 构造列候选的输入 */
export interface ColumnItemArgs {
  /** 列名：label / 搜索名（保持裸列名，前缀匹配才能命中） */
  name: string
  /** 展示文本（多来源时 `u.created_at`；与 name 相同则省略） */
  displayName?: string
  /** 插入文本（多来源 / 点号补全时带限定符） */
  insertText: string
  /** 插入文本里的限定符部分（`u.`；无则省略） */
  prefix?: string
  /** 身份 */
  columnId: ColumnCandidateId
  detail?: ColumnDetail
  dialect: SqlDialect
}

/**
 * 列名候选项（**所有列名都必须经由这里构造**）。
 *
 * - `label` 是搜索名（裸列名）：编辑器与自有排序都按它做前缀匹配；
 * - `displayLabel` 是展示名（多来源时带别名），列表里一眼能看出列来自哪张表；
 * - `columnKey` 是身份（多选与去重）；
 * - `apply` 只做替换 + 插入 `insertText`，不再解析 SQL（见文件头约定 3）。
 */
export function columnItem(args: ColumnItemArgs): ColumnCompletion {
  const key = columnCandidateKey(args.columnId)
  return {
    label: args.name,
    displayLabel: args.displayName && args.displayName !== args.name ? args.displayName : undefined,
    type: 'field',
    boost: BOOST_COLUMN,
    columnDetail: args.detail,
    columnKey: key,
    columnInsert: args.insertText,
    columnPrefix: args.prefix || undefined,
    apply: columnApply(key, args.insertText),
  }
}

/**
 * 列名的「勾选多选」状态。
 *
 * CM6 原生不支持补全多选（`acceptCompletion` 一次只应用一项），这里自己维护一份
 * 勾选状态，配合编辑器封装层实现：
 *  - 候选项左侧的复选框：CodeEditor.vue 通过 autocompletion 的 `addToOptions` 渲染；
 *  - 空格切换勾选：CodeEditor.vue 的键位；
 *  - 回车生成：勾选项由 `columnApply` 一次性插入，用 ", " 连接。
 *
 * 键是**候选身份**（`columnKey`）而不是裸列名 —— 否则 `u.id` 与 `o.id`
 * 会互相影响；值是该候选自己的插入文本（一次插入多列时要各带各的别名）。
 */
const markedColumns = new WeakMap<EditorView, Map<string, string>>()
/** 上一次插入结束的光标位置，用于判断是否要补 ", " */
const insertSessions = new WeakMap<EditorView, { head: number }>()

/** 已勾选的列（按勾选顺序；只读，勿直接修改） */
export function markedColumnsOf(view: EditorView): Array<{ key: string, insertText: string }> {
  const marked = markedColumns.get(view)
  return marked ? [...marked].map(([key, insertText]) => ({ key, insertText })) : []
}

/** 已勾选的候选身份（按勾选顺序） */
export function columnsMarked(view: EditorView): string[] {
  return markedColumnsOf(view).map(item => item.key)
}

/** 某个候选是否已勾选 */
export function isColumnMarked(view: EditorView, key: string): boolean {
  return markedColumns.get(view)?.has(key) ?? false
}

/** 切换勾选，返回切换后的状态 */
export function toggleColumnMark(view: EditorView, key: string, insertText: string): boolean {
  let marked = markedColumns.get(view)
  if (!marked) {
    marked = new Map()
    markedColumns.set(view, marked)
  }

  if (marked.has(key)) {
    marked.delete(key)
    return false
  }
  marked.set(key, insertText)
  return true
}

/** 清空勾选（插入完成后调用） */
export function clearColumnMarks(view: EditorView) {
  markedColumns.delete(view)
}

/**
 * 空格键是否该被「勾选列名」消费。
 *
 * 只在**多选列模式**消费：单选场景（`SELECT t.user_id,|`、`t.em|`）里空格必须
 * 原样插入 —— 用户按空格是想分隔，不是想勾选。判定完全来自候选身上的
 * `columnMode`（引擎按光标意图打的标），不看位置、不看文本。
 */
export function shouldConsumeSpaceForColumn(
  status: string | null,
  completion: Completion | null | undefined,
): boolean {
  if (status !== 'active' || !completion || completion.type !== 'field') {
    return false
  }
  return (completion as ColumnCompletion).columnMode === 'multi'
}

/**
 * 列名插入逻辑。
 *
 * 勾选了多项就一次插入全部（", " 连接）；没勾选只插入当前项。
 * 紧接在上一次插入之后（中间没有手动输入）时自动补一个 ", "，
 * 所以连续挑列不会粘在一起。
 *
 * `from` / `to` 由补全引擎给出（已含点号限定符），这里不再解析文档内容；
 * 只额外看一眼光标左侧有没有用户敲下的开引号，需要时把它一起替换掉。
 */
function columnApply(key: string, insertText: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    /*
     * 只有**多选列**的候选才消费勾选集合。
     *
     * 单选场景里勾选状态一律无效：同一个弹层里可能从多选切到单选
     * （勾了几列后又继续打字过滤，`validFor` 让列表没有重建），
     * 此时回车只该插入当前这一项，而不是把之前勾的整批塞进去。
     */
    const multi = (completion as ColumnCompletion).columnMode === 'multi'
    const marked = multi ? markedColumnsOf(view) : []
    const items = marked.length ? marked.map(item => item.insertText) : [insertText]
    const session = insertSessions.get(view)
    const continued = Boolean(session) && session?.head === from

    // 用户可能先敲了开引号（`` `na ``）：把引号一并纳入替换
    const doc = view.state.doc
    const open = openingQuoteBefore(doc.toString(), from)
    const start = open ? open.start : from

    /*
     * 落在替换范围内的那一项要检查文档里是否已经写着限定符：
     * 点号补全（`u.|`）的替换范围只有词，左侧的 `u.` 本来就在文档里，
     * 再插一次会得到 `u.u.id`。多选 / 连续插入的后续项都在新位置，照常带前缀。
     */
    const prefix = (completion as ColumnCompletion).columnPrefix ?? ''
    const written = prefix !== ''
      && doc.sliceString(Math.max(0, start - prefix.length), start) === prefix
    const first = written && !continued && items[0].startsWith(prefix)
      ? items[0].slice(prefix.length)
      : items[0]

    const insert = `${continued ? ', ' : ''}${[first, ...items.slice(1)].join(', ')}`
    const head = start + insert.length

    view.dispatch({
      changes: { from: start, to, insert },
      selection: { anchor: head },
    })

    insertSessions.set(view, { head })
    clearColumnMarks(view)
  }
}

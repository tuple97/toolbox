<script setup lang="ts">
/** CodeMirror 6 编辑器封装：全应用唯一的代码编辑器组件 */
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  showTooltip,
} from '@codemirror/view'
import type { Tooltip } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  autocompletion,
  closeBrackets,
  CompletionContext,
  closeBracketsKeymap,
  completeAnyWord,
  completeFromList,
  completionStatus,
  selectedCompletion,
} from '@codemirror/autocomplete'
import type { Completion, CompletionSource } from '@codemirror/autocomplete'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { MySQL, PostgreSQL, sql } from '@codemirror/lang-sql'
import type { SQLDialect } from '@codemirror/lang-sql'
import { javascript, localCompletionSource, snippets } from '@codemirror/lang-javascript'
import { useConfigStore } from '@/stores/configStore'
import {
  columnHoverAt,
  contextKindAt,
  createSqlCompletion,
  defaultMetadataProvider,
  isColumnMarked,
  isPositionalEligible,
  shouldConsumeSpaceForColumn,
  sqlContextOf,
  toggleColumnMark,
} from '@/utils/sql/sqlCompletion'
import type {
  ColumnCompletion,
  CompletionFeatureFlags,
  CompletionMode,
  CompletionRuntime,
} from '@/utils/sql/sqlCompletion'
import { parseSqlTriggerMode, sqlCompletionTrigger } from '@/utils/sql/sqlCompletionTrigger'
import { parseShowSystemDatabases } from '@/utils/sql/sqlVisibility'
import { inTemplateFragment } from '@/utils/sql/sqlTemplateCompletion'
import {
  isPlaceholderEditing,
  jumpToNextPlaceholder,
  parsePlaceholderTabJump,
  planTemplateInsert,
  templatePlaceholderExtension,
} from '@/utils/sql/template/templatePlaceholder'
import { analyzeHybridCursor } from '@/utils/sql/hybridCursor'
import { createStatementBoxExtension } from '@/utils/sql/sqlStatementBox'
import { sqlStatementRunGutter, type RunnableStatement } from '@/utils/sql/sqlRunGutter'
import {
  LOG_LANGUAGE_ID,
  editorThemeExtensions,
  editorThemeNameOf,
  logLanguage,
} from '@/utils/logLanguage'
import { editorErrorField, errorRangeOf, setEditorErrors } from '@/utils/editorErrors'
import type { EditorError, ErrorPosition } from '@/utils/editorErrors'
import { editorSearchExtensions, openEditorSearch } from '@/utils/editorSearch'
import { notify } from '@/utils/notify'
import { copyText } from '@/utils/clipboard'
import {
  isRenaming,
  renameTargetAt as renameTargetAtSql,
  sqlRenameExtension,
  startRenameAt,
} from '@/utils/sql/rename/sqlRenameView'
import type { RenameTargetKind } from '@/utils/sql/rename/sqlRenameView'
import type { SqlRenameViewOptions } from '@/utils/sql/rename/sqlRenameView'
import { createTableSqlAt, tableHoverAt } from '@/utils/sql/hover/sqlTableHover'
import { buildColumnHoverCard, COMMENT_ICON, TABLE_ICON } from '@/utils/sql/columnHoverCard'
import {
  openTableCardPopup,
  renderTableCardInto,
} from '@/utils/sql/hover/tableCard'
import type { TableCardModel } from '@/utils/sql/hover/tableCard'
import { resolveCreateTableSql } from '@/utils/sql/ddl/createTableSqlSource'
import type { CreateTableSqlResult } from '@/utils/sql/ddl/createTableSqlSource'
import { createTableModelOf, generateCreateTableSql } from '@/utils/sql/ddl/sqlCreateTable'
import { dialectOf, fetchPrimaryKeys } from '@/utils/sql/rowSql'
import { fetchTableIndexes } from '@/utils/sql/tableIndexes'
import { parameterInfoAt } from '@/utils/sql/sqlParameterInfo'
import { useMetadataStore } from '@/stores/metadataStore'
import { resolveTableAtPosition } from '@/utils/sql/semantic/sqlSymbols'
import {
  definitionNavigationExtension,
  definitionTargetAt,
  goToDefinition,
} from '@/utils/sql/semantic/sqlDefinition'
import { symbolHighlightExtension } from '@/utils/sql/semantic/sqlSymbolHighlight'
import type { SqlTableHover } from '@/utils/sql/hover/sqlTableHover'

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'change', value: string): void
  /** 编辑器实例就绪 */
  (e: 'mount', view: EditorView): void
  /** 光标 / 选区变化（无载荷，调用方重新读自己的状态） */
  (e: 'selection'): void
  /** 点击语句左侧的运行按钮 */
  (e: 'run-statement', statement: RunnableStatement): void
}>()

const props = withDefaults(defineProps<{
  /** 编辑内容（v-model） */
  modelValue: string
  /** 语言：sql / javascript / toolbox-log（执行记录） */
  language?: string
  /** 数据库类型（mysql / postgres…），决定 SQL 方言 */
  dbType?: string
  /** 主题名（应用主题键，如 toolbox-dark）；留空时跟随全局配置 */
  theme?: string
  /** 是否只读 */
  readonly?: boolean
  /** 编辑器高度 */
  height?: string
  /** 是否显示行号 */
  showLineNumbers?: boolean
  /** 是否关闭智能提示（日志展示场景） */
  disableSuggestions?: boolean
  /** 补全模式：sql / sql-template / javascript / none；不传时按 language 推导 */
  completionMode?: '' | CompletionMode
  /** 是否给识别出的每条 SQL 套边框（仅 sql 语言） */
  showStatementFrames?: boolean
  /** 是否显示行号左侧的「执行这条语句」按钮（仅 sql 语言） */
  showRunButtons?: boolean
  /** 页面注入的动态补全上下文（覆盖实例级登记值，每次查询重新求值） */
  completionContext?: () => Partial<CompletionRuntime> | undefined
  /** 定向扩展开关（关掉函数候选、只留变量等轻量场景） */
  featureFlags?: CompletionFeatureFlags
}>(), {
  language: 'sql',
  theme: '',
  readonly: false,
  height: '260px',
  showLineNumbers: true,
  disableSuggestions: false,
  completionMode: '',
  showStatementFrames: false,
  showRunButtons: false,
})

const configStore = useConfigStore()
/** 元数据缓存：表结构卡片补主外键用 */
const metadataStore = useMetadataStore()

/** 编辑器实例（必须 shallowRef） */
const viewRef = shallowRef<EditorView | null>(null)
const host = shallowRef<HTMLDivElement | null>(null)

/** 各维度独立 Compartment，便于运行时重配置 */
const languageCompartment = new Compartment()
const themeCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const fontCompartment = new Compartment()

// ---------------------------------------------------------------- 各层扩展

/** 连接类型 → SQL 方言；未知类型返回 undefined（用标准 SQL） */
function sqlDialectOf(dbType: string): SQLDialect | undefined {
  switch (dbType.toLowerCase()) {
    case 'mysql':
      return MySQL
    case 'postgres':
    case 'postgresql':
      return PostgreSQL
    default:
      return undefined
  }
}

/** 语言扩展：SQL / JavaScript / 日志（未知语言按纯文本处理） */
function languageExtension(): Extension {
  switch (props.language) {
    case 'sql':
      return sql({ dialect: sqlDialectOf(props.dbType ?? '') })
    case 'javascript':
      return javascript()
    case LOG_LANGUAGE_ID:
      return logLanguage()
    default:
      return []
  }
}

/** 当前生效的编辑器主题名：显式传入优先，否则跟随全局主题 */
function themeName(): string {
  if (props.theme) {
    return props.theme
  }
  return editorThemeNameOf(configStore.theme)
}

/** 字体与字号跟随「设置 → 编辑器字体 / 编辑器字号」 */
function fontExtension(): Extension {
  const fontFamily = configStore.editorFontStack
  return EditorView.theme({
    // 字号 = 编辑器字号 × 缩放比例（缩放比例是 CSS 变量，改设置不必重建编辑器）
    '&': { fontSize: `calc(${configStore.editorFontSize}px * var(--app-scale, 1))` },
    '.cm-scroller': {
      fontFamily,
      lineHeight: '1.6',
    },
    // 浮层不在 .cm-scroller 内，需单独指定字体
    '.cm-tooltip': {
      fontFamily,
    },
  })
}

/** 只读：同时禁编辑与禁光标输入行为 */
function readOnlyExtension(): Extension {
  return props.readonly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : []
}

/** 生效的补全模式：显式传入优先，否则按 language 推导 */
function resolvedCompletionMode(): CompletionMode {
  if (props.completionMode) {
    return props.completionMode
  }
  if (props.language === 'sql') {
    return 'sql'
  }
  if (props.language === 'javascript') {
    return 'javascript'
  }
  return 'none'
}

/** 补全源组装；override 会替换语言自带的补全源，需要的必须显式列出 */
function completionSources(): CompletionSource[] {
  const sources: CompletionSource[] = []
  const mode = resolvedCompletionMode()

  if (mode === 'sql' || mode === 'sql-template') {
    sources.push(createSqlCompletion(() => viewRef.value, mode, defaultMetadataProvider, pageContext))
  }

  if (mode === 'javascript') {
    sources.push(createSqlCompletion(() => viewRef.value, 'javascript', defaultMetadataProvider, pageContext))
    sources.push(completeFromList([...snippets]))
    sources.push(localCompletionSource)
    sources.push(completeAnyWord)
  }

  // 重命名 / 片段占位改编期间不给候选
  return sources.map(source => (context: CompletionContext) =>
    ((isRenaming(context.state) || isPlaceholderEditing(context.state)) ? null : source(context)))
}

/** 页面级动态上下文：prop 内容每次查询重新求值（featureFlags 以页面为准） */
function pageContext(): Partial<CompletionRuntime> {
  const page = props.completionContext?.() ?? {}
  return {
    ...page,
    featureFlags: {
      ...props.featureFlags,
      // 表名补全后自动补别名
      autoTableAlias: configStore.values.sql_completion_alias === 'true',
      // 候选里是否展示系统库
      showSystemDatabases: parseShowSystemDatabases(configStore.values.sql_show_system_databases),
      ...page.featureFlags,
    },
  }
}

/** 打字触发（仅 SQL / SQL 模板；按触发策略显式打开） */
function triggerExtension(): Extension {
  const mode = resolvedCompletionMode()
  if (props.disableSuggestions || (mode !== 'sql' && mode !== 'sql-template')) {
    return []
  }
  // 模板片段优先于「字符串 / 注释」与位置判定
  const templateMode = mode === 'sql-template'
  return sqlCompletionTrigger({
    getMode: () => parseSqlTriggerMode(configStore.values.sql_completion_trigger),
    getPositionalEligible: (state) => {
      const pos = state.selection.main.head
      if (templateMode && inTemplateFragment(state, pos)) {
        return true
      }
      // 位置类别与补全共用同一套语言区域分析
      return isPositionalEligible(contextKindAt(state, pos, props.dbType ?? '', mode))
    },
    getInLiteralOrComment: (state) => {
      const pos = state.selection.main.head
      // 模板片段不算「字符串 / 注释」
      return analyzeHybridCursor(state, pos, { mode }).inLiteral
    },
  })
}

/** 智能提示（日志等只读场景可用 disableSuggestions 关闭；none 模式一律不装） */
function completionExtension(): Extension {
  if (props.disableSuggestions || resolvedCompletionMode() === 'none') {
    return []
  }
  const sources = completionSources()
  if (!sources.length) {
    return []
  }
  const mode = resolvedCompletionMode()
  return autocompletion({
    override: sources,
    maxRenderedOptions: 50,
    // SQL 的「打字自动弹」由 triggerExtension 接管
    activateOnTyping: mode !== 'sql' && mode !== 'sql-template',
    // 打开列表即高亮第一项，否则回车会落到换行
    selectOnOpen: true,
    // 关掉 defaultKeymap 会让 Enter 被换行抢走
    defaultKeymap: true,
    // 关掉 CM6 默认的类型图标（c / f / λ 之类）
    icons: false,
    // 候选项左侧排布：勾选框(10) → 类型图标(20) → 列名(50) → 描述区(80)
    addToOptions: [
      { render: renderColumnCheckbox, position: 10 },
      { render: renderTypeIcon, position: 20 },
      { render: renderColumnDetail, position: 80 },
    ],
  })
}

// ---------------------------------------------------------------- 列悬停提示

/** 列悬停提示：停在列名上显示「类型 · 注释 · 来源表」（仅 SQL / 模板） */
function columnHoverExtension(): Extension {
  const mode = resolvedCompletionMode()
  if (mode !== 'sql' && mode !== 'sql-template') {
    return []
  }

  return hoverTooltip((view, pos) => {
    const hover = columnHoverAt(view.state, pos, {
      mode,
      sql: sqlContextOf(view) ?? undefined,
    })
    if (!hover) {
      return null
    }

    return {
      pos: hover.from,
      end: hover.to,
      above: true,
      // 卡片拼装在 utils/sql/columnHoverCard.ts
      create: () => ({ dom: buildColumnHoverCard(hover.info) }),
    }
  })
}

/** 表结构悬停：停在表名 / 表别名上展示列清单（仅 SQL / 模板） */
function tableHoverExtension(): Extension {
  const mode = resolvedCompletionMode()
  if (mode !== 'sql' && mode !== 'sql-template') {
    return []
  }

  return hoverTooltip((view, pos) => {
    if (analyzeHybridCursor(view.state, pos, { mode }).language !== 'sql') {
      return null
    }
    const hover = tableHoverAt(view.state, pos, sqlRuntimeFor(view, mode))
    if (!hover) {
      return null
    }
    return {
      pos: hover.from,
      end: hover.to,
      above: true,
      create: () => ({
        dom: renderTableHover(view, hover.info, async () => {
          // 与右键菜单同一来源策略：原生 DDL 优先
          const resolved = await resolveDdl(view, {
            tableName: hover.info.tableName,
            schema: hover.info.schemaName,
            sql: hover.info.createTableSql,
          })
          await copyText(resolved.sql)
        }),
      }),
    }
  })
}

/** 悬停 / 重命名共用的运行期上下文（每次现读，切连接后立即生效） */
function sqlRuntimeFor(view: EditorView, mode: CompletionMode): CompletionRuntime {
  return {
    mode,
    sql: sqlContextOf(view) ?? undefined,
    // 与补全同一份元数据提供者：重命名的列别名准入判断要按它查来源表的列
    metadata: defaultMetadataProvider,
  }
}

/** 重命名会话的选项（扩展与右键入口共用同一份反馈出口） */
function renameOptions(): SqlRenameViewOptions {
  return {
    runtime: view => sqlRuntimeFor(view, resolvedCompletionMode()),
    notify: (notice) => {
      if (notice.type === 'success') {
        notify.success(notice.message)
      }
      else {
        notify.warning(notice.message)
      }
    },
  }
}

/** 表别名重命名：Enter 提交、Esc 取消、光标移出自动取消 */
function renameExtension(): Extension {
  const mode = resolvedCompletionMode()
  if (props.readonly || (mode !== 'sql' && mode !== 'sql-template')) {
    return []
  }
  return sqlRenameExtension(renameOptions())
}

/** 供父组件调用：在指定位置开始重命名；返回是否已进入 */
function renameSymbolAt(pos: number): boolean {
  const view = viewRef.value
  return view ? startRenameAt(view, pos, renameOptions()) : false
}

/** 供父组件调用：该位置可重命名的对象类型；null 表示没有可用动作 */
function renameTargetAt(pos: number): RenameTargetKind | null {
  const view = viewRef.value
  return view ? renameTargetAtSql(view, pos, renameOptions()) : null
}

/** 供父组件调用：打开查找 / 替换面板 */
function openSearch(): boolean {
  const view = viewRef.value
  return view ? openEditorSearch(view) : false
}

/** 供父组件调用：该位置是否有可复制建表语句的物理表 */
function canCopyCreateTableAt(pos: number): boolean {
  const view = viewRef.value
  if (!view) {
    return false
  }
  const table = resolveTableAtPosition(view.state, pos, props.dbType ?? '')
  return Boolean(table && !table.virtual)
}

/** 供父组件调用：该位置是否有可跳转的定义（右键菜单项用） */
function canGoToDefinitionAt(pos: number): boolean {
  const view = viewRef.value
  return view ? definitionTargetAt(view.state, pos, props.dbType ?? '') !== null : false
}

/** 供父组件调用：跳到定义（光标在声明上则跳到第一处引用） */
function goToDefinitionAt(pos: number): boolean {
  const view = viewRef.value
  if (!view) {
    return false
  }
  return goToDefinition(view, pos, { runtime: v => sqlRuntimeFor(v, resolvedCompletionMode()) })
}

/** 跳转到定义（Ctrl/Cmd + 左键、F12） */
function definitionNavExtension(): Extension {
  const mode = resolvedCompletionMode()
  if (props.readonly || (mode !== 'sql' && mode !== 'sql-template')) {
    return []
  }
  return definitionNavigationExtension({ runtime: view => sqlRuntimeFor(view, mode) })
}

/** 光标处符号的引用高亮（只读编辑器同样有用，故不排除 readonly） */
function symbolHighlight(): Extension {
  const mode = resolvedCompletionMode()
  if (mode !== 'sql' && mode !== 'sql-template') {
    return []
  }
  return symbolHighlightExtension({ runtime: view => sqlRuntimeFor(view, mode) })
}

/** 供父组件调用：复制该位置对应表的 CREATE TABLE */
async function copyCreateTableAt(pos: number): Promise<boolean> {
  const view = viewRef.value
  if (!view) {
    return false
  }
  const result = createTableSqlAt(view.state, pos, sqlRuntimeFor(view, resolvedCompletionMode()))
  if (!result) {
    notify.warning('未识别到可建表的物理表')
    return false
  }
  try {
    // 优先数据库原生 DDL，拿不到才用按元数据生成的那份
    const resolved = await resolveDdl(view, result)
    await copyText(resolved.sql)
    notify.success(
      `已复制 ${result.tableName} 的建表语句（${resolved.source === 'database' ? '来自数据库' : '按元数据生成'}）`,
    )
    return true
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
    return false
  }
}

/** 建表语句的最终来源：数据库原生 DDL 优先，回退本地生成 */
async function resolveDdl(
  view: EditorView,
  args: { tableName: string, schema: string, sql: string },
): Promise<CreateTableSqlResult> {
  const sql = sqlContextOf(view)
  if (!sql?.connId) {
    return { sql: args.sql, source: 'generated' }
  }
  return resolveCreateTableSql({
    connId: sql.connId,
    database: sql.database,
    dbType: sql.dbType,
    schema: args.schema,
    table: args.tableName,
    generated: args.sql,
  })
}

/** 表结构卡片：把 SqlTableHover 转成 model 后挂出，并异步补主外键与索引 */
function renderTableHover(view: EditorView, info: SqlTableHover, copyDdl: () => Promise<void>): HTMLElement {
  const host = document.createElement('div')
  const model: TableCardModel = {
    tableName: info.tableName,
    schemaName: info.schemaName || undefined,
    columns: info.columns,
    virtual: info.virtual,
    createTableSql: info.createTableSql || undefined,
    onCopyDdl: copyDdl,
  }
  renderTableCardInto(host, model)

  const sql = sqlContextOf(view)
  if (sql?.connId && !info.virtual) {
    void enrichTableCard(host, model, {
      connId: sql.connId,
      database: sql.database,
      dbType: sql.dbType,
      schema: info.schemaName,
      table: info.tableName,
    })
  }
  return host
}

/** 异步补齐一张表的主外键与索引后重画卡片 */
async function enrichTableCard(
  host: HTMLElement,
  model: TableCardModel,
  source: { connId: number, database: string, dbType: string, schema: string, table: string },
): Promise<void> {
  const [primaryKeys, foreignKeys, indexes] = await Promise.all([
    fetchPrimaryKeys(
      { connId: source.connId, database: source.database, dbType: source.dbType, sql: '' },
      { schema: source.schema, table: source.table },
      dialectOf(source.dbType),
    ),
    Promise.resolve(metadataStore.loadForeignKeys(source.connId, source.schema || source.database, source.table)),
    fetchTableIndexes(source.connId, source.schema || source.database, source.table, source.dbType),
  ])
  // 悬停可能已结束：不在文档里就不画
  if (!host.isConnected) {
    return
  }
  renderTableCardInto(host, {
    ...model,
    primaryKeys,
    foreignKeys: foreignKeys.map(fk => ({
      column: fk.column,
      referencedTable: fk.referencedTable,
      referencedColumn: fk.referencedColumn,
    })),
    indexes,
  })
}

/** 补全候选里点击来源表名弹出的表结构浮层 */
function openTableCardFromDetail(view: EditorView, source: string, rect: DOMRect): void {
  const sql = sqlContextOf(view)
  if (!sql?.connId) {
    return
  }
  // source 形如 库.表 或裸表名
  const segments = source.split('.')
  const schema = segments.length > 1 ? segments[0]! : ''
  const tableName = segments[segments.length - 1]!
  const columns = defaultMetadataProvider
    .columns(sql.connId, schema || sql.database, tableName)
    .map(column => ({ name: column.name, dataType: column.dataType, comment: column.comment || '' }))
  if (!columns.length) {
    notify.warning(`暂无 ${source} 的结构信息`)
    return
  }

  const dialect = dialectOf(sql.dbType)
  const ddl = generateCreateTableSql(
    createTableModelOf({ schema: schema || undefined, tableName, columns }),
    dialect,
  )
  const model: TableCardModel = {
    tableName,
    schemaName: schema || undefined,
    columns,
    createTableSql: ddl || undefined,
    onCopyDdl: async () => {
      const resolved = await resolveDdl(view, { tableName, schema, sql: ddl })
      await copyText(resolved.sql)
    },
  }
  openTableCardPopup({
    model,
    anchor: { x: rect.left, y: rect.bottom },
    loadExtras: () => enrichTableModel({
      connId: sql.connId,
      database: sql.database,
      dbType: sql.dbType,
      schema,
      table: tableName,
    }),
  })
}

/** 拉一张表的主外键与索引（浮层版，与 enrichTableCard 同源） */
async function enrichTableModel(source: {
  connId: number
  database: string
  dbType: string
  schema: string
  table: string
}): Promise<Partial<TableCardModel>> {
  const [primaryKeys, foreignKeys, indexes] = await Promise.all([
    fetchPrimaryKeys(
      { connId: source.connId, database: source.database, dbType: source.dbType, sql: '' },
      { schema: source.schema, table: source.table },
      dialectOf(source.dbType),
    ),
    Promise.resolve(metadataStore.loadForeignKeys(source.connId, source.schema || source.database, source.table)),
    fetchTableIndexes(source.connId, source.schema || source.database, source.table, source.dbType),
  ])
  return {
    primaryKeys,
    foreignKeys: foreignKeys.map(fk => ({
      column: fk.column,
      referencedTable: fk.referencedTable,
      referencedColumn: fk.referencedColumn,
    })),
    indexes,
  }
}

// ---------------------------------------------------------------- 函数参数提示（Ctrl+P）

/** 开 / 关参数提示浮层的效果（值即 CM 的 Tooltip 描述，null 表示关闭） */
const setParameterTip = StateEffect.define<Tooltip | null>()

/** 参数提示状态字段：光标移动时跟随重新解析，走出参数列表自动关闭 */
const parameterTipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    const explicit = tr.effects.find(effect => effect.is(setParameterTip))
    if (explicit) {
      return explicit.value
    }
    if (!value) {
      return null
    }
    return parameterTipSpecOf(tr.state)
  },
  provide: field => showTooltip.computeN([field], (state) => {
    const tooltip = state.field(field)
    return tooltip ? [tooltip] : []
  }),
})

/** 由光标位置构造参数提示 tooltip；不在参数列表里返回 null */
function parameterTipSpecOf(state: EditorState): Tooltip | null {
  const info = parameterInfoAt(state.doc.toString(), state.selection.main.head)
  if (!info) {
    return null
  }
  return {
    pos: info.openParen,
    above: true,
    create: () => ({ dom: buildParameterTipCard(info) }),
  }
}

/** Ctrl+P：显示参数提示；无命中时也吞掉按键（否则浏览器会弹打印） */
function showParameterInfo(view: EditorView): boolean {
  view.dispatch({ effects: setParameterTip.of(parameterTipSpecOf(view.state)) })
  return true
}

/** Esc 关闭（补全开着时 Esc 先归补全，它的键位注册在更高优先级） */
function closeParameterTip(view: EditorView): boolean {
  if (!view.state.field(parameterTipField, false)) {
    return false
  }
  view.dispatch({ effects: setParameterTip.of(null) })
  return true
}

/** 参数提示卡片：签名（当前参数高亮）+ 描述 + 返回类型 */
function buildParameterTipCard(info: ReturnType<typeof parameterInfoAt>): HTMLElement {
  const root = document.createElement('div')
  root.className = 'param-tip'
  if (!info) {
    return root
  }

  const signature = document.createElement('div')
  signature.className = 'param-tip__signature'
  const name = document.createElement('span')
  name.className = 'param-tip__name'
  name.textContent = info.doc.name
  signature.appendChild(name)
  signature.appendChild(document.createTextNode('('))

  const lastParamIndex = Math.max(0, info.doc.params.length - 1)
  info.doc.params.forEach((param, index) => {
    if (index > 0) {
      signature.appendChild(document.createTextNode(', '))
    }
    const arg = document.createElement('span')
    arg.className = `param-tip__arg${index === Math.min(info.argIndex, lastParamIndex) ? ' is-active' : ''}`
    arg.textContent = param.optional ? `${param.name}?` : param.name
    signature.appendChild(arg)
  })
  if (info.doc.variadic) {
    signature.appendChild(document.createTextNode(', …'))
  }
  signature.appendChild(document.createTextNode(')'))
  root.appendChild(signature)

  const description = document.createElement('div')
  description.className = 'param-tip__description'
  description.textContent = info.doc.description
  root.appendChild(description)

  if (info.doc.returns) {
    const returns = document.createElement('div')
    returns.className = 'param-tip__returns'
    returns.textContent = `返回 ${info.doc.returns}`
    root.appendChild(returns)
  }
  return root
}

/** 仅 SQL / SQL 模板模式挂载：脚本与日志里没有受支持的函数上下文 */
function parameterInfoExtension(): Extension {
  const mode = resolvedCompletionMode()
  if (mode !== 'sql' && mode !== 'sql-template') {
    return []
  }
  return parameterTipField
}

/** 列候选的描述区：按「类型 · 来源 · 注释」分段渲染 */
function renderColumnDetail(
  completion: Completion,
  _state: EditorState,
  view: EditorView,
): Node | null {
  const detail = (completion as ColumnCompletion).columnDetail
  if (!detail) {
    // 非列候选的说明走字符串 detail
    return null
  }

  const doc = view.dom.ownerDocument
  const root = doc.createElement('span')
  root.className = 'cm-column-detail'

  if (detail.dataType) {
    const type = doc.createElement('span')
    type.className = 'cm-column-detail__part cm-column-detail__type'
    type.textContent = detail.dataType
    root.appendChild(type)
  }
  if (detail.from) {
    const source = detailPart(doc, 'source', TABLE_ICON, detail.from)
    // 来源表可点击：打开该表的结构卡片
    source.classList.add('cm-column-detail__part--link')
    source.title = '点击查看表结构'
    source.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      openTableCardFromDetail(view, detail.from ?? '', rect)
    })
    root.appendChild(source)
  }
  if (detail.comment) {
    root.appendChild(detailPart(doc, 'comment', COMMENT_ICON, detail.comment))
  }

  return root.childNodes.length ? root : null
}

/** 描述区里带图标的一段；kind 决定图标颜色 */
function detailPart(
  doc: Document,
  kind: 'source' | 'comment',
  icon: string,
  text: string,
): HTMLElement {
  const part = doc.createElement('span')
  part.className = `cm-column-detail__part cm-column-detail__part--${kind}`

  const glyph = doc.createElement('span')
  glyph.className = 'cm-column-detail__icon'
  // 固定字符串，不含用户输入
  glyph.innerHTML = icon
  part.appendChild(glyph)

  const value = doc.createElement('span')
  // 文字单独一层：变淡只作用文字，图标保色
  value.className = 'cm-column-detail__value'
  value.textContent = text
  part.appendChild(value)

  return part
}

// ---------------------------------------------------------------- 类型图标

/** 候选类型图标：键为候选的 type；没登记的类型不给图标 */
const TYPE_ICONS: Record<string, string> = {
  // 列
  field: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3.2 4.4h9.6M3.2 8h6.4M3.2 11.6h8"/></svg>',
  // 表
  class: TABLE_ICON,
  // 别名 / 变量
  variable: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8.8 2.8h4.4v4.4l-5.8 5.8-4.4-4.4z"/><circle cx="11" cy="5" r="0.9"/></svg>',
  // 库
  namespace: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><ellipse cx="8" cy="4.2" rx="4.6" ry="1.9"/><path d="M3.4 4.2v7.6c0 1.05 2.05 1.9 4.6 1.9s4.6-.85 4.6-1.9V4.2"/><path d="M3.4 8c0 1.05 2.05 1.9 4.6 1.9S12.6 9.05 12.6 8"/></svg>',
  // 关键字
  keyword: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><circle cx="5.6" cy="10.4" r="2.6"/><path d="M7.6 8.4 13.2 2.8M10.6 5.4l1.5 1.5"/></svg>',
  // 函数
  function: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M6.2 2.8C4.7 5.2 4.7 10.8 6.2 13.2M9.8 2.8c1.5 2.4 1.5 8 0 10.4"/><circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>',
  // 模板属性
  property: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M5.6 3.2H3.6v9.6h2M10.4 3.2h2v9.6h-2"/><circle cx="8" cy="8" r="1.3"/></svg>',
  // 片段 / 智能项
  text: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2.4 9.2 6.8 13.6 8 9.2 9.2 8 13.6 6.8 9.2 2.4 8 6.8 6.8z"/></svg>',
}

/** 候选左侧的类型图标（position 20） */
function renderTypeIcon(
  completion: Completion,
  _state: EditorState,
  view: EditorView,
): Node | null {
  // CM6 的 type 允许是多个类名（空格分隔），取第一个当类型
  const kind = (completion.type ?? '').split(/\s+/)[0]
  const icon = TYPE_ICONS[kind]
  if (!icon) {
    return null
  }

  const span = view.dom.ownerDocument.createElement('span')
  span.className = `cm-type-icon cm-type-icon--${kind}`
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = icon
  return span
}

// ---------------------------------------------------------------- 列名勾选

/** 勾选框 DOM 缓存（候选键 → 元素），空格切换时直接改它的 data 属性 */
const checkNodes = new WeakMap<EditorView, Map<string, HTMLElement>>()

function setCheckState(el: HTMLElement, checked: boolean) {
  el.dataset.checked = checked ? 'true' : 'false'
}

/** 列候选的身份键（多表 JOIN 下同名列才分得开） */
function columnKeyOf(completion: Completion): string {
  return (completion as ColumnCompletion).columnKey ?? completion.label
}

/** 在列名候选最左侧渲染勾选框（position 10，其它类型不渲染） */
function renderColumnCheckbox(
  completion: Completion,
  _state: EditorState,
  view: EditorView,
): Node | null {
  const mode = resolvedCompletionMode()
  if ((mode !== 'sql' && mode !== 'sql-template') || completion.type !== 'field') {
    return null
  }

  // 只有「多选列」意图才给复选框（判断来自候选的 columnMode）
  if ((completion as ColumnCompletion).columnMode !== 'multi') {
    return null
  }

  const key = columnKeyOf(completion)
  const box = view.dom.ownerDocument.createElement('span')
  box.className = 'cm-sqlcheck'
  box.setAttribute('aria-hidden', 'true')
  setCheckState(box, isColumnMarked(view, key))

  let nodes = checkNodes.get(view)
  if (!nodes) {
    nodes = new Map()
    checkNodes.set(view, nodes)
  }
  nodes.set(key, box)
  return box
}

/** 空格：勾选 / 取消当前高亮的列名（仅多选列模式消费） */
function toggleCheckedColumn(view: EditorView): boolean {
  const completion = selectedCompletion(view.state)
  if (!completion || !shouldConsumeSpaceForColumn(completionStatus(view.state), completion)) {
    return false
  }

  // 勾选按候选身份记录，并带上各自的插入文本
  const key = columnKeyOf(completion)
  const insertText = (completion as ColumnCompletion).columnInsert ?? completion.label
  const checked = toggleColumnMark(view, key, insertText)

  const box = checkNodes.get(view)?.get(key)
  if (box) {
    setCheckState(box, checked)
  }
  return true
}

/** 片段占位跳转（Tab / 回车共用，仅在占位组内消费按键） */
function jumpTemplatePlaceholder(view: EditorView): boolean {
  if (!isPlaceholderEditing(view.state)) {
    return false
  }
  if (!parsePlaceholderTabJump(configStore.values.template_placeholder_tab)) {
    return false
  }
  return jumpToNextPlaceholder(view)
}

/** 与编辑器无关的基础能力（行号、历史、括号、快捷键等） */
function baseExtensions(): Extension[] {
  const extensions: Extension[] = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    // 超长行自动折行，长 SQL 不横向滚动
    EditorView.lineWrapping,
    // 查找 / 替换 + 选中词同名高亮 + 官方快捷键（见 utils/editorSearch.ts）
    ...editorSearchExtensions(),
    /*
     * tabindex 必须显式给：CM6 在只读（editable=false）时会把 .cm-content 设成
     * contentEditable="false"，浏览器就不会因为点击而聚焦它 —— 于是按键（Ctrl+A 全选、
     * Ctrl+C 复制）落不到编辑器上，只有鼠标划选能用（那是 CM 自己实现的）。
     * 加上 tabindex 后只读编辑器也能获得焦点，CM 自带的 Mod-a / 复制与我们的快捷键才生效。
     */
    EditorView.contentAttributes.of({ spellcheck: 'false', tabindex: '0' }),
    // 补全快捷键由 autocompletion 自己以 Prec.highest 注册（见 completionExtension），
    // 这里不要再重复绑定 completionKeymap；只补一个它没有的「空格勾选列名」
    keymap.of([
      /*
       * 回车 / Tab 先走「片段占位跳转」：插入片段后，片段里的变量与空位置排成一条链，
       * 依次跳过去，走完自动释放；没有占位、光标不在占位上、或开关关掉时返回 false，
       * 回车落回换行、Tab 落回缩进。
       *
       * 必须排在 defaultKeymap 之前，否则回车会被 insertNewlineAndIndent 吃掉。
       * 补全打开时回车仍归补全（CM 以 Prec.highest 注册它的键位）。
       */
      { key: 'Enter', run: jumpTemplatePlaceholder },
      { key: 'Tab', run: jumpTemplatePlaceholder },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      // Ctrl+P：函数参数提示
      { key: 'Ctrl-p', mac: 'Mod-p', run: showParameterInfo },
      // Esc：关参数提示
      { key: 'Escape', run: closeParameterTip },
      { key: 'Space', run: toggleCheckedColumn },
      indentWithTab,
    ]),
    EditorView.updateListener.of(handleUpdate),
    // 错误波浪线的装饰位
    editorErrorField,
    // 模板占位链的位置存储
    templatePlaceholderExtension(),
  ]

  // 语句运行按钮：每条语句左侧一个 ▶（须排在行号 gutter 之前）
  if (props.showRunButtons && props.language === 'sql') {
    extensions.push(sqlStatementRunGutter({
      dbType: () => props.dbType ?? '',
      onRun: statement => emit('run-statement', statement),
    }))
  }

  if (props.showLineNumbers) {
    extensions.push(lineNumbers(), highlightActiveLineGutter())
  }

  // 语句边框：光标所在语句的一个整框（见 utils/sqlStatementBox.ts）
  if (props.showStatementFrames && props.language === 'sql') {
    extensions.push(createStatementBoxExtension(() => props.dbType ?? ''))
  }

  return extensions
}

/** 文档变化 → 回抛 v-model（程序化写入不回抛） */
function handleUpdate(update: ViewUpdate) {
  // 先播报光标 / 选区变化
  if (update.selectionSet || update.docChanged) {
    emit('selection')
  }
  if (!update.docChanged || props.readonly) {
    return
  }
  const value = update.state.doc.toString()
  if (value === props.modelValue) {
    return
  }
  emit('update:modelValue', value)
  emit('change', value)
}

// ---------------------------------------------------------------- 生命周期

onMounted(() => {
  const parent = host.value
  if (!parent) {
    return
  }

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      ...baseExtensions(),
      completionExtension(),
      triggerExtension(),
      // 表悬停排在列悬停之前：表名位置优先出表结构
      tableHoverExtension(),
      columnHoverExtension(),
      // Ctrl+P 函数参数提示（仅在 SQL / SQL 模板模式挂载）
      parameterInfoExtension(),
      // 重命名会话（状态 + 装饰 + Enter/Esc + 光标守护）
      renameExtension(),
      // 跳转到定义（Ctrl/Cmd + 左键、F12）
      definitionNavExtension(),
      // 光标处符号的引用高亮
      symbolHighlight(),
      languageCompartment.of(languageExtension()),
      themeCompartment.of(editorThemeExtensions(themeName())),
      readOnlyCompartment.of(readOnlyExtension()),
      fontCompartment.of(fontExtension()),
    ],
  })

  const view = new EditorView({ state, parent })
  viewRef.value = view
  emit('mount', view)
})

onBeforeUnmount(() => {
  // 重量级实例必须显式销毁
  viewRef.value?.destroy()
  viewRef.value = null
})

// ---------------------------------------------------------------- 响应式同步

/** 外部写入（父组件 setValue / 切换标签恢复内容） */
watch(() => props.modelValue, (value) => {
  const view = viewRef.value
  if (!view || value === view.state.doc.toString()) {
    return
  }
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
  })
})

watch([() => props.language, () => props.dbType], () => {
  viewRef.value?.dispatch({
    effects: languageCompartment.reconfigure(languageExtension()),
  })
})

watch([() => props.theme, () => configStore.theme], () => {
  viewRef.value?.dispatch({
    effects: themeCompartment.reconfigure(editorThemeExtensions(themeName())),
  })
})

watch(() => props.readonly, () => {
  viewRef.value?.dispatch({
    effects: readOnlyCompartment.reconfigure(readOnlyExtension()),
  })
})

watch([() => configStore.editorFontSize, () => configStore.editorFontStack], () => {
  viewRef.value?.dispatch({
    effects: fontCompartment.reconfigure(fontExtension()),
  })
})

/** 在当前光标（或选区）处插入模板片段；@returns 是否插入成功 */
function insertTemplateText(text: string): boolean {
  const view = viewRef.value
  if (!text || !view) {
    return false
  }

  try {
    const selection = view.state.selection.main
    const plan = planTemplateInsert(text, selection.from, selection.to)

    view.dispatch({
      changes: plan.changes,
      selection: plan.selection,
      effects: plan.effects,
      scrollIntoView: true,
    })
    view.focus()
    return true
  }
  catch (e) {
    // 插入失败时明确告知
    console.error('[CodeEditor] insertTemplateText failed', e)
    return false
  }
}

/**
 * 标记 / 清除编辑器里的错误（底部红色波浪线）
 * @param positions 错误位置（行号从 1 起）；传空数组即清空
 * @param options.reveal 是否滚动到第一个错误并聚焦
 */
function setErrors(positions: ErrorPosition[], options: { reveal?: boolean } = {}): void {
  const view = viewRef.value
  if (!view) {
    return
  }

  const errors = positions
    .map(position => errorRangeOf(view.state, position))
    .filter((error): error is EditorError => error !== null)
  view.dispatch({ effects: setEditorErrors.of(errors) })

  if (options.reveal && errors.length) {
    view.dispatch({
      selection: { anchor: errors[0].from },
      effects: EditorView.scrollIntoView(errors[0].from, { y: 'center' }),
    })
    view.focus()
  }
}

/** 供父组件调用：只暴露必要的编辑器能力 */
defineExpose({
  insertTemplateText,
  setErrors,
  renameSymbolAt,
  renameTargetAt,
  copyCreateTableAt,
  canCopyCreateTableAt,
  goToDefinitionAt,
  canGoToDefinitionAt,
  openSearch,
})
</script>

<template>
  <div ref="host" class="code-editor" :style="{ height }" />
</template>

<style scoped>
/* 容器只负责尺寸；编辑器配色在 utils/logLanguage.ts 的主题里 */
.code-editor {
  overflow: hidden;
}

.code-editor :deep(.cm-editor) {
  height: 100%;
}

.code-editor :deep(.cm-editor.cm-focused) {
  outline: none;
}

.code-editor :deep(.cm-scroller) {
  overflow: auto;
}

/* 补全弹层的高度 / 内边距 / 圆角由 utils/logLanguage.ts 的主题统一给出 */

/* 列悬停与表结构卡片的样式在 styles/global.css（被别处复用，不能放 scoped 里） */

/* 函数参数提示（Ctrl+P，DOM 由 buildParameterTipCard 拼装） */
.code-editor :deep(.param-tip) {
  min-width: 180px;
  max-width: 420px;
  padding: 8px 10px;
  font-size: var(--app-font-size-xs);
  line-height: 1.5;
  user-select: text;
}

.code-editor :deep(.param-tip__signature) {
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.code-editor :deep(.param-tip__name) {
  color: var(--text-color);
  font-weight: 600;
}

.code-editor :deep(.param-tip__arg.is-active) {
  color: var(--brand-color);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.code-editor :deep(.param-tip__description) {
  margin-top: 6px;
  color: var(--text-color);
}

.code-editor :deep(.param-tip__returns) {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
}

/* 重命名中的别名 */
.code-editor :deep(.cm-rename-active) {
  border-radius: 3px;
  background: var(--primary-color-soft, rgba(64, 158, 255, 0.18));
  box-shadow: inset 0 -1px 0 var(--primary-color, #409eff);
}

/* 符号出现位置：声明底色稍重，引用轻一档 */
.code-editor :deep(.cm-symbol-declaration) {
  border-radius: 3px;
  background: var(--primary-color-soft, rgba(64, 158, 255, 0.22));
}

.code-editor :deep(.cm-symbol-reference) {
  border-radius: 3px;
  background: var(--primary-color-soft, rgba(64, 158, 255, 0.12));
}
</style>

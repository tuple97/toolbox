/** 表结构悬停（鼠标停在表名 / 表别名上） */
import type { EditorState } from '@codemirror/state'
import { inLiteralOrComment } from '@/utils/sql/sqlSyntax'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { createTableModelOf, generateCreateTableSql } from '../ddl/sqlCreateTable'
import { dialectOf } from '../rowSql'
import { defaultMetadataProvider, sqlContextFromRuntime } from '../sqlCompletion'
import type { CompletionRuntime, MetadataProvider } from '../sqlCompletion'
import type { SqlColumnInfo } from '../sqlCompletionHover'
import { resolveTableAtPosition, scopesAt } from '../semantic/sqlSymbols'
import type { VirtualColumn } from '../sqlSchema'

/** 一次表悬停的模型 */
export interface SqlTableHover {
  /** 稳定身份 */
  sourceId: string
  tableName: string
  /** 库 / schema，未限定时为空 */
  schemaName: string
  /** 列信息，保持元数据 / 解析结果的顺序 */
  columns: SqlColumnInfo[]
  /** 复制按钮用的建表语句；派生表 / CTE 为空串 */
  createTableSql: string
  /** 来源是否为派生表 / CTE */
  virtual: boolean
}

/** 命中结果：悬停的词范围 + 表结构 */
export interface SqlTableHoverResult {
  from: number
  to: number
  info: SqlTableHover
}

/** 取某个位置上的表结构，供悬停提示使用；from / to 是光标下的词范围 */
export function tableHoverAt(
  state: EditorState,
  pos: number,
  runtime: CompletionRuntime,
): SqlTableHoverResult | null {
  const base = resolveHoverSource(state, pos, runtime)
  const word = state.wordAt(pos)
  if (!base || !word) {
    return null
  }
  if (!base.columns.length) {
    // 列还没到位：这次不提示
    return null
  }

  return {
    from: word.from,
    to: word.to,
    info: {
      sourceId: base.symbol.id,
      tableName: base.symbol.tableName,
      schemaName: base.symbol.schema,
      columns: base.columns.map(column => ({
        name: column.name,
        table: base.symbol.tableName,
        dataType: column.dataType,
        comment: column.comment || undefined,
      })),
      createTableSql: base.model ? generateCreateTableSql(base.model, base.dialect) : '',
      virtual: base.virtual,
    },
  }
}

/** 右键菜单「复制建表语句」用：只解析物理表 + 生成 DDL，不要求列已就绪 */
export function createTableSqlAt(
  state: EditorState,
  pos: number,
  runtime: CompletionRuntime,
): { tableName: string, schema: string, sql: string } | null {
  const base = resolveHoverSource(state, pos, runtime)
  if (!base?.model) {
    return null
  }
  const sql = generateCreateTableSql(base.model, base.dialect)
  return sql
    ? { tableName: base.symbol.tableName, schema: base.symbol.schema, sql }
    : null
}

/** 悬停与「复制建表语句」共用的解析结果 */
interface HoverSource {
  symbol: { id: string, tableName: string, schema: string }
  /** 派生表 / CTE：列为静态解析结果 */
  virtual: boolean
  columns: VirtualColumn[]
  /** 物理表的建表模型；派生来源为 null */
  model: ReturnType<typeof createTableModelOf> | null
  dialect: ReturnType<typeof dialectOf>
}

/** 位置 → 表 / 派生来源 + 列（拿不准返回 null） */
function resolveHoverSource(
  state: EditorState,
  pos: number,
  runtime: CompletionRuntime,
): HoverSource | null {
  const sql = sqlContextFromRuntime(runtime)
  if (!sql || !state.wordAt(pos) || inLiteralOrComment(state, pos)) {
    return null
  }

  const dialect = dialectOf(sql.dbType)
  const symbol = resolveTableAtPosition(state, pos, sql.dbType)
  if (!symbol) {
    return null
  }

  if (symbol.virtual) {
    // 派生表 / CTE：结构层已解析出输出列，不需要查元数据，也没有建表语句
    const virtualColumns = virtualColumnsAt(state, pos, sql.dbType)
    if (!virtualColumns?.length) {
      return null
    }
    return { symbol, virtual: true, columns: virtualColumns, model: null, dialect }
  }

  if (!sql.connId) {
    return null
  }
  const metadata: MetadataProvider = runtime.metadata ?? defaultMetadataProvider
  const columns = metadata.columns(sql.connId, symbol.schema || sql.database, symbol.tableName)
  return {
    symbol,
    virtual: false,
    columns,
    model: createTableModelOf({
      schema: symbol.schema || undefined,
      tableName: symbol.tableName,
      columns,
    }),
    dialect,
  }
}

/** 位置上的派生来源（派生表 / CTE）的输出列 */
function virtualColumnsAt(state: EditorState, pos: number, dbType: string): VirtualColumn[] | null {
  const word = state.wordAt(pos)
  if (!word) {
    return null
  }
  for (const scope of scopesAt(state, pos, dbType)) {
    const hit = scope.refs.find(ref => ref.virtualColumns
      && (containsRange(ref.aliasRange, word) || containsRange(ref.tableRange, word)))
    if (hit?.virtualColumns) {
      return hit.virtualColumns
    }
  }
  return null
}

/** 范围是否覆盖一个词 */
function containsRange(range: TextRange | undefined, word: TextRange): boolean {
  return Boolean(range && word.from >= range.from && word.to <= range.to)
}

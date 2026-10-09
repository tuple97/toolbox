/** 列悬停提示（鼠标停在列名上显示「来源表 · 类型 · 注释」），与补全共用作用域解析 */
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { inLiteralOrComment } from '@/utils/sql/sqlSyntax'
import {
  buildScopes,
  defaultMetadataProvider,
  qualifierBeforeCursor,
  sqlContextFromRuntime,
  sqlContextOf,
} from './sqlCompletion'
import type { CompletionRuntime, MetadataProvider, SqlContext } from './sqlCompletion'
import { unquoteIdent } from './sqlSchema'
import type { TableRef } from './sqlSchema'
import { statementAtCursor } from './sqlStatementRanges'

/** 悬停提示里展示的列信息 */
export interface SqlColumnInfo {
  /** 列名 */
  name: string
  /** 来源表名；派生表会尽量溯源到物理表 */
  table?: string
  /** 字段类型 */
  dataType?: string
  /** 字段注释 */
  comment?: string
  /** 该列来自派生表 / CTE 的静态解析 */
  derived?: boolean
}

/** 一次列悬停的命中结果：命中的词范围 + 列信息 */
export interface SqlColumnHover {
  from: number
  to: number
  info: SqlColumnInfo
}

/** 取某个位置上的「列」信息，供悬停提示使用 */
export function columnHoverAt(
  state: EditorState,
  pos: number,
  runtime: CompletionRuntime,
): SqlColumnHover | null {
  // 运行期上下文允许写 getter（页面动态注入），这里先求值
  const sql = sqlContextFromRuntime(runtime)
  const word = state.wordAt(pos)
  if (!sql || !sql.connId || !word) {
    return null
  }
  // `t1.` 里的 t1 是限定符不是列；字符串 / 注释里也不该提示
  if (state.doc.sliceString(word.to, word.to + 1) === '.') {
    return null
  }
  if (inLiteralOrComment(state, pos)) {
    return null
  }

  const metadata = runtime.metadata ?? defaultMetadataProvider
  const doc = state.doc.toString()
  // 悬停是「看已写下的 SQL」：用真实语句，不用补全的空行边界
  const statement = statementAtCursor(doc, pos, sql.dbType)
  const scopes = buildScopes(
    state,
    word.from,
    doc,
    sql.dbType,
    statement,
    sql.connId,
    sql.database,
    metadata,
  )
  const qualifier = qualifierNameBefore(doc, word.from)
  const name = state.sliceDoc(word.from, word.to)

  for (const refs of scopes) {
    for (const ref of refs) {
      if (qualifier && !matchesQualifier(ref, qualifier)) {
        continue
      }
      const info = columnInfoOf(ref, name, sql.connId, sql.database, metadata)
      if (info) {
        return { from: word.from, to: word.to, info }
      }
    }
  }
  return null
}

/** 光标左侧限定符的最后一段（`db`.`t`. → t） */
function qualifierNameBefore(doc: string, from: number): string {
  const raw = qualifierBeforeCursor(doc, from).replace(/\.\s*$/, '')
  if (!raw) {
    return ''
  }
  return unquoteIdent(raw.split('.').pop()?.trim() ?? '')
}

/** 表引用是否匹配限定符（别名或表名，大小写不敏感） */
function matchesQualifier(ref: TableRef, qualifier: string): boolean {
  const wanted = qualifier.toLowerCase()
  return ref.alias.toLowerCase() === wanted || ref.table.toLowerCase() === wanted
}

/** 从表引用里取某列的信息：静态派生列优先，其次查元数据 */
function columnInfoOf(
  ref: TableRef,
  name: string,
  connId: number,
  database: string,
  metadata: MetadataProvider,
): SqlColumnInfo | null {
  const wanted = name.toLowerCase()

  const derived = ref.virtualColumns?.find(item => item.name.toLowerCase() === wanted)
  if (derived) {
    return {
      name: derived.name,
      table: derived.from,
      dataType: derived.dataType,
      comment: derived.comment,
      derived: true,
    }
  }

  const meta = metadata
    .columns(connId, ref.schema || database, ref.table)
    .find(item => item.name.toLowerCase() === wanted)
  if (!meta) {
    return null
  }
  return { name: meta.name, table: ref.table, dataType: meta.dataType, comment: meta.comment }
}

// re-export：CodeEditor.vue 只从这里拿悬停 API
export { sqlContextOf }
export type { SqlContext }

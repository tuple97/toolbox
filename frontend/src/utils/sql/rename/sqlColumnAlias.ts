/** 列别名重命名的**准入判断** */
import type { EditorState } from '@codemirror/state'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import type { TableRef } from '../sqlSchema'
import {
  getColumnAliasReferences,
  resolveColumnAliasAtPosition,
  scopesAt,
} from '../semantic/sqlSymbols'
import type { SqlColumnAliasSymbol } from '../semantic/sqlSymbols'

/** 放行时的结果：符号 + 全部引用 */
export interface ColumnAliasRenamePlan {
  symbol: SqlColumnAliasSymbol
  references: TextRange[]
}

/** 拒绝并说明原因（界面直接展示这句话） */
export interface ColumnAliasRenameRejection {
  reason: string
}

export interface ColumnAliasRenameArgs {
  state: EditorState
  pos: number
  dbType: string
  /** 查某张表的列（宿主注入元数据缓存） */
  columnsOf: (ref: TableRef) => { name: string }[]
}

/** 规划一次列别名重命名 */
export function planColumnAliasRename(
  args: ColumnAliasRenameArgs,
): ColumnAliasRenamePlan | ColumnAliasRenameRejection | null {
  const symbol = resolveColumnAliasAtPosition(args.state, args.pos, args.dbType)
  if (!symbol) {
    return null
  }

  const conflict = conflictingSource(symbol, args)
  if (conflict) {
    return {
      reason: `列别名「${symbol.name}」与 ${conflict} 的列同名，ORDER BY / GROUP BY 里会有歧义（各方言的归属规则不同），已取消重命名`,
    }
  }

  return { symbol, references: getColumnAliasReferences(args.state, symbol, args.dbType) }
}

/** 别名与哪个来源的列重名（没有则 null） */
function conflictingSource(
  symbol: SqlColumnAliasSymbol,
  args: ColumnAliasRenameArgs,
): string | null {
  const scopes = scopesAt(args.state, symbol.declarationRange.from, args.dbType)
  const wanted = symbol.name.toLowerCase()
  for (const ref of scopes[0]?.refs ?? []) {
    if (args.columnsOf(ref).some(column => column.name.toLowerCase() === wanted)) {
      return ref.alias || ref.table
    }
  }
  return null
}

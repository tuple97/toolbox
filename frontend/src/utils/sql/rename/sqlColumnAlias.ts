/**
 * 列别名重命名的**准入判断**。
 *
 * 列别名比表别名危险得多：`ORDER BY n` 里的 `n` 到底指「输出别名」还是
 * 「来源表的列」，MySQL 与 PostgreSQL 的规则恰好相反 ——
 * ORDER BY 偏向输出别名，GROUP BY 偏向输入列。同一个名字，两边含义不同。
 *
 * 因此这里的规则是：**只有别名与作用域内所有来源表的列都不重名时才放行**。
 * 一旦重名，ORDER BY / GROUP BY 的归属就说不清了，于是拒绝并说明原因 ——
 * 这正是「拿不准就不提供功能」，而不是猜一个方言然后改错 SQL。
 *
 * 元数据由宿主注入（与补全同一份缓存）：本模块不直接认识 store，
 * 于是可以在单测里喂假的列清单。
 */
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

/**
 * 规划一次列别名重命名。
 *
 * 返回 `null` 表示「这里不是列别名」（调用方按「没有可做的动作」处理），
 * 返回拒绝对象表示「是列别名，但不能改」，两者的界面表现不同。
 */
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

/**
 * 别名与哪个来源的列重名（没有则 null）。
 *
 * 只看**声明所在那一层**的来源：外层子查询的列不会出现在本层的 ORDER BY 里。
 */
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

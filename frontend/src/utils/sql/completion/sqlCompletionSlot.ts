/** 补全槽位：光标处「允许出现什么」的语义结论 */
import type { CompletionContextKind, SqlColumnIntent } from '../sqlCursor'

/** 补全槽位 */
export type SqlCompletionSlot =
  /** 语句开头 / 判不出位置 */
  | 'statement-start'
  /** SELECT 列表里新的一项刚开头 */
  | 'select-item-start'
  /** SELECT 列表里已经在表达式内 */
  | 'select-expression'
  /** FROM / JOIN / INTO 之后要写表名 */
  | 'from-source'
  /** 表来源已写完 */
  | 'from-after-source'
  /** WHERE（含条件内部的 AND / OR） */
  | 'where-expression'
  /** JOIN … ON 之后、条件还没开始写 */
  | 'join-predicate-start'
  /** JOIN 条件表达式内部 */
  | 'join-expression'
  /** GROUP BY */
  | 'group-by-expression'
  /** ORDER BY */
  | 'order-by-expression'
  /** HAVING */
  | 'having-expression'
  /** INSERT 列清单内 / UPDATE SET 的列位置 / VALUES */
  | 'insert-column'
  | 'insert-value'
  | 'update-set-column'
  /** `AS` 之后（只能写别名） */
  | 'alias'
  /** 其余位置：宽松处理 */
  | 'unknown'

/** 槽位判定的输入 */
export interface SlotInput {
  kind: CompletionContextKind
  /** 命中的子句关键字（小写） */
  keyword: string
  /** 命中关键字左边那个词（`GROUP BY` 的 group） */
  previousKeyword: string
  /** 命中关键字之后到光标的内容（trim 过） */
  tail: string
  /** 光标是否紧贴刚读到的那个词 */
  tight: 'none' | 'keyword' | 'name'
  /** 列补全意图；可选，缺省时 `SELECT |` 按 select-expression 处理 */
  column?: SqlColumnIntent
}

/** 光标 → 槽位 */
export function resolveCompletionSlot(input: SlotInput): SqlCompletionSlot {
  switch (input.kind) {
    case 'statement-start':
      return 'statement-start'
    case 'table':
      return 'from-source'
    case 'keyword':
      return 'from-after-source'
    case 'alias':
      return 'alias'
    case 'insert':
      return 'insert-column'
    case 'group-by':
      return 'group-by-expression'
    case 'join-on':
      return 'join-predicate-start'
    case 'join-expression':
      return 'join-expression'
    case 'column': {
      switch (input.keyword) {
        case 'select':
        // DISTINCT 只是列表开头的修饰，位置仍是新的一项
        case 'distinct':
        case 'all':
          return input.column?.itemEmpty ? 'select-item-start' : 'select-expression'
        case 'where':
        case 'and':
        case 'or':
          return 'where-expression'
        case 'having':
          return 'having-expression'
        case 'by':
          if (input.previousKeyword === 'group') {
            return 'group-by-expression'
          }
          if (input.previousKeyword === 'order') {
            return 'order-by-expression'
          }
          return 'unknown'
        case 'set':
          return 'update-set-column'
        case 'values':
          return 'insert-value'
        case 'into':
          return 'insert-column'
        case 'on':
          return 'join-expression'
        default:
          // CASE / WHEN / USING / RETURNING …：不细分
          return 'unknown'
      }
    }
    default:
      return 'unknown'
  }
}

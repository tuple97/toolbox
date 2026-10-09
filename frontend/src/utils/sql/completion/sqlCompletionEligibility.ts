/** 候选资格：这个候选有没有资格出现（与排序无关） */
import {
  CLAUSE_KEYWORDS,
  EXPRESSION_KEYWORDS,
  JOIN_KEYWORDS,
  SQL_KEYWORDS,
  STATEMENT_KEYWORDS,
} from '../sqlCompletionKeywords'
import type { SqlCompletionSlot } from './sqlCompletionSlot'

/** 资格判定用的候选种类（由 CM 候选项的 type 映射而来） */
export type SqlCandidateKind =
  | 'column'
  | 'table'
  | 'alias'
  | 'function'
  | 'keyword'
  | 'namespace'
  | 'other'

/** CM 候选项 type → 资格判定用的种类 */
export function candidateKindOf(option: { type?: string }): SqlCandidateKind {
  switch (option.type) {
    case 'field':
      return 'column'
    case 'variable':
      return 'alias'
    case 'function':
      return 'function'
    case 'keyword':
      return 'keyword'
    case 'namespace':
      return 'namespace'
    case 'table':
    // 表 / 视图候选用的是 CM 的 'class' 图标类型（见 tableSuggestions）
    case 'class':
      return 'table'
    default:
      return 'other'
  }
}

/** 资格判定的上下文（槽位 + 该槽位内的细分状态） */
export interface EligibilityContext {
  slot: SqlCompletionSlot
  /** 命中的子句关键字 */
  keyword: string
  /** 命中关键字之后是否已经有内容 */
  hasTail: boolean
}

/** SELECT 列表刚开头允许的关键字 */
const ITEM_START_KEYWORDS = ['DISTINCT', 'ALL', 'CASE', 'EXISTS']

/** 表达式之后「下一个子句」的关键字 */
const FOLLOWING_CLAUSE_KEYWORDS = CLAUSE_KEYWORDS.filter(keyword =>
  ['GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL'].includes(keyword))

/** 只写名字 / 值的位置：关键字一律不给 */
const NAME_ONLY_SLOTS: SqlCompletionSlot[] = [
  'from-source',
  'insert-column',
  'insert-value',
  'update-set-column',
  'alias',
]

/** 语句开头允许的关键字：语句级起始关键字 + SET */
const STATEMENT_START_KEYWORDS = [...STATEMENT_KEYWORDS, 'SET']

/** 该槽位允许出现的关键字（顺序即候选顺序） */
export function keywordsForSlot(ctx: EligibilityContext): string[] {
  if (NAME_ONLY_SLOTS.includes(ctx.slot)) {
    return []
  }

  switch (ctx.slot) {
    case 'from-after-source':
      return ['AS', ...JOIN_KEYWORDS, ...CLAUSE_KEYWORDS]
    case 'select-item-start':
      return ITEM_START_KEYWORDS
    case 'select-expression':
      return [...EXPRESSION_KEYWORDS, ...JOIN_KEYWORDS, ...CLAUSE_KEYWORDS]
    case 'where-expression':
    case 'having-expression':
    case 'group-by-expression':
      return ctx.hasTail
        ? [...EXPRESSION_KEYWORDS, ...FOLLOWING_CLAUSE_KEYWORDS]
        : [...EXPRESSION_KEYWORDS]
    case 'order-by-expression':
      // ORDER BY 位置额外给 ASC / DESC
      return ctx.hasTail
        ? [...EXPRESSION_KEYWORDS, 'ASC', 'DESC', ...FOLLOWING_CLAUSE_KEYWORDS]
        : [...EXPRESSION_KEYWORDS, 'ASC', 'DESC']
    case 'join-predicate-start':
    case 'join-expression':
      return [...EXPRESSION_KEYWORDS]
    case 'statement-start':
      return STATEMENT_START_KEYWORDS
    default:
      // 判不出位置（空文档、纯注释…）→ 宽松给全量
      return SQL_KEYWORDS
  }
}

/** 该候选有没有资格出现在该槽位（默认宽松，只拦明显不该有的） */
export function isCandidateAllowed(
  option: { type?: string, label: string },
  ctx: EligibilityContext,
): boolean {
  const kind = candidateKindOf(option)

  switch (ctx.slot) {
    case 'from-source':
      // 来源位置：表 / 视图 / CTE / 库名，不给列名与关键字
      return kind === 'table' || kind === 'namespace'
    case 'from-after-source':
      // 表来源写完：只给接下来的子句关键字与结构化候选
      return kind === 'keyword' || kind === 'other'
    case 'insert-column':
    case 'update-set-column':
      // 列清单 / SET 左侧：只写列
      return kind === 'column' || kind === 'other'
    case 'insert-value':
      // VALUES：函数与字面量
      return kind === 'function' || kind === 'keyword' || kind === 'other'
    case 'alias':
      return false
    case 'select-item-start':
      return kind !== 'table' && kind !== 'namespace'
    case 'select-expression':
    case 'where-expression':
    case 'having-expression':
    case 'group-by-expression':
    case 'order-by-expression':
    case 'join-predicate-start':
    case 'join-expression':
      // 表达式位置：不给表和库
      return kind !== 'table' && kind !== 'namespace'
    default:
      return true
  }
}

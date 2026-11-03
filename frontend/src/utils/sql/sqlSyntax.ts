/** 语法树辅助（编辑器自带的 SQL 语法树）：只做它擅长的两件事 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { statementAtCursor } from '@/utils/sql/sqlStatementRanges'

/** 语法树节点类型：从 `syntaxTree` 的返回值推导 */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

/** 文本范围 */
export interface TextRange {
  from: number
  to: number
}

/** 光标是否落在字符串或注释里 */
export function inLiteralOrComment(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(pos, -1)
  while (node) {
    if (node.name === 'String' || node.name === 'LineComment' || node.name === 'BlockComment') {
      return true
    }
    node = node.parent
  }
  return false
}

/** 由内到外的作用域范围：子查询（括号内）→ … → 外层语句 */
export function scopeRanges(
  state: EditorState,
  pos: number,
  text: string,
  dbType = '',
  statement?: TextRange | null,
): TextRange[] {
  const scopes: TextRange[] = []
  const tree = syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(pos, -1)
  while (node) {
    if (node.name === 'Parens' && node.to - node.from > 2) {
      scopes.push({ from: node.from + 1, to: node.to - 1 })
    }
    node = node.parent
  }

  const range = statement ?? statementAtCursor(text, pos, dbType)
  if (range) {
    scopes.push({ from: range.from, to: range.to })
  }
  return scopes
}

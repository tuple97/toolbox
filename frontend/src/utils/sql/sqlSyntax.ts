/**
 * 语法树辅助（编辑器自带的 SQL 语法树）：只做它擅长的两件事，
 * 语句切分与光标归属都交给 `sqlStatementRanges.ts` 的扫描器。
 *
 * 分工原因：语法树是**高亮用**的，容错但不精确——`Statement` 节点会吞掉语句末尾
 * 的换行、对 `DELIMITER $$` 这类客户端指令没有概念、未写完的语句只剩错误节点；
 * 而这些恰恰是「执行当前语句 / 画边框」最在意的。反过来，扫描器不知道
 * 「光标是不是在字符串/注释里」「这一层括号内有哪些表」，语法树一眼就能给出。
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { statementAtCursor } from '@/utils/sql/sqlStatementRanges'

/**
 * 语法树节点类型：从 `syntaxTree` 的返回值推导。
 * 不 import 语法树的底层包——它不是本项目的直接依赖，
 * pnpm 的严格 node_modules 布局下取不到它的类型声明（会直接编译报错）。
 */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

/** 文本范围 */
export interface TextRange {
  from: number
  to: number
}

/**
 * 光标是否落在字符串或注释里。
 *
 * 节点名按 SQL 语法树的命名：`String` / `LineComment` / `BlockComment`
 *（实测确认；没有统一的 `Comment` 节点，写错名字会静默失效）。
 */
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

/**
 * 由内到外的作用域范围：子查询（括号内）→ … → 外层语句。
 *
 * 用于补全的别名解析：`Parens` 是语法树给的嵌套括号节点，逐层向上收集，
 * 内层先命中（内层别名遮蔽外层，符合 SQL 的作用域规则）；
 * 最外层补上光标所在语句的范围。语法树拿不到嵌套信息时就只剩语句本身这一层。
 *
 * @param statement 显式指定最外层语句范围；不传时按「光标归属」（`statementAtCursor`）
 *   推算。补全场景应传入自己的范围计算——补全发生在「正在写」的时候，
 *   光标常停在语句末尾空白或新起的一行上，执行口径的归属会返回 null。
 */
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

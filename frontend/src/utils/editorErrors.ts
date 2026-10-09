/** 编辑器里的错误标记（底部红色波浪线，用 CM6 的 StateField + Decoration.mark 实现） */
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'

/** 编辑器里要标出的一段错误（文档坐标） */
export interface EditorError {
  from: number
  to: number
  /** 悬停提示文案 */
  message: string
}

/** 错误位置（行 / 列都从 1 起；列为 0 表示后端没给出列号） */
export interface ErrorPosition {
  line: number
  column?: number
  message: string
}

/** 设置 / 清空错误标记（传空数组即清空） */
export const setEditorErrors = StateEffect.define<EditorError[]>()

/** 单条波浪线最长画到多少字符 */
const MAX_UNDERLINE = 80

/** 把「行号 + 列号」换算成编辑器里的标记范围；行号越界返回 null */
export function errorRangeOf(state: EditorState, position: ErrorPosition): EditorError | null {
  if (position.line < 1 || position.line > state.doc.lines) {
    return null
  }

  const line = state.doc.line(position.line)
  const offset = Math.max(0, Math.min((position.column ?? 1) - 1, line.length))

  let from = line.from + offset
  if (from >= line.to) {
    from = Math.max(line.from, line.to - 1)
  }

  const end = position.column ? Math.min(line.to, from + MAX_UNDERLINE) : line.to
  return {
    from,
    to: Math.max(end, Math.min(line.to, from + 1)),
    message: position.message,
  }
}

/** 错误标记的装饰集（样式见 utils/logLanguage.ts 的 .cm-error-mark） */
export const editorErrorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setEditorErrors)) {
        continue
      }
      next = Decoration.set(
        effect.value.map(error => Decoration.mark({
          class: 'cm-error-mark',
          // 悬停文案走全局 title 代理（utils/tooltip.ts）
          attributes: { title: error.message },
        }).range(error.from, error.to)),
        // true：按位置排序
        true,
      )
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

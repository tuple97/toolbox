/**
 * 光标所在符号的引用高亮：把「这个别名在哪些地方被用到」直接画出来。
 *
 * 与重命名 / 跳转定义共用同一套符号解析（`symbolOccurrencesAt`），**不另写
 * 「找同名标识符」的正则** —— 那种做法会把字符串、注释、别的作用域里的同名别名
 * 一起点亮，看着热闹，但有一处是错的就会让人不敢信。
 *
 * 代价说明：引用收集是「逐 token × 作用域解析」，每次光标移动都要跑一遍。
 * 因此对超大文档直接放弃高亮（宁可不画，也不能让输入发涩）。
 */
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { sqlContextFromRuntime } from '../sqlCompletion'
import type { CompletionRuntime } from '../sqlCompletion'
import { symbolOccurrencesAt } from './sqlSymbols'

const DECLARATION_MARK = Decoration.mark({ class: 'cm-symbol-declaration' })
const REFERENCE_MARK = Decoration.mark({ class: 'cm-symbol-reference' })

/**
 * 超过这个字符数就不算引用集合。
 *
 * 12 万字符相当于几千行 SQL：到这个量级，光标每动一下都重算一遍引用不值得，
 * 而重命名 / 跳转这类「用户主动发起」的动作仍照常可用（它们不在这里）。
 */
const MAX_HIGHLIGHT_LENGTH = 120_000

export interface SymbolHighlightOptions {
  runtime: (view: EditorView) => CompletionRuntime
}

/** 光标处符号的引用高亮扩展 */
export function symbolHighlightExtension(options: SymbolHighlightOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, options)
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, options)
        }
      }
    },
    { decorations: plugin => plugin.decorations },
  )
}

/** 计算当前光标处符号的装饰（没有符号则为空） */
function buildDecorations(view: EditorView, options: SymbolHighlightOptions): DecorationSet {
  const state = view.state
  if (state.doc.length > MAX_HIGHLIGHT_LENGTH) {
    return Decoration.none
  }

  const sql = sqlContextFromRuntime(options.runtime(view))
  const occurrences = symbolOccurrencesAt(state, state.selection.main.head, sql?.dbType ?? '')
  if (!occurrences) {
    return Decoration.none
  }

  const ranges = [
    DECLARATION_MARK.range(occurrences.declaration.from, occurrences.declaration.to),
    ...occurrences.references.map(range => REFERENCE_MARK.range(range.from, range.to)),
  ].sort((left, right) => left.from - right.from)

  return Decoration.set(ranges)
}

/** 光标所在符号的引用高亮：把「这个别名在哪些地方被用到」直接画出来 */
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { sqlContextFromRuntime } from '../sqlCompletion'
import type { CompletionRuntime } from '../sqlCompletion'
import { symbolOccurrencesAt } from './sqlSymbols'

const DECLARATION_MARK = Decoration.mark({ class: 'cm-symbol-declaration' })
const REFERENCE_MARK = Decoration.mark({ class: 'cm-symbol-reference' })

/** 超过这个字符数就不算引用集合 */
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

/** 跳转到定义（Ctrl / Cmd + 左键、F12） */
import { EditorSelection, Prec } from '@codemirror/state'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { TextRange } from '../sqlSyntax'
import { sqlContextFromRuntime } from '../sqlCompletion'
import type { CompletionRuntime } from '../sqlCompletion'
import { resolveSymbolAtPosition, symbolReferencesOf } from './sqlSymbols'

/** 导航目标：声明或某处引用 */
export interface DefinitionTarget extends TextRange {
  /** 目标是声明还是引用（界面据此给不同措辞） */
  role: 'declaration' | 'reference'
}

/** 位置 → 导航目标；没有可跳的目标返回 null */
export function definitionTargetAt(
  state: EditorState,
  pos: number,
  dbType: string,
): DefinitionTarget | null {
  const symbol = resolveSymbolAtPosition(state, pos, dbType)
  if (!symbol || symbol.kind === 'table') {
    return null
  }

  const declaration = symbol.declarationRange
  const onDeclaration = pos >= declaration.from && pos <= declaration.to
  if (!onDeclaration) {
    return { from: declaration.from, to: declaration.to, role: 'declaration' }
  }

  const first = symbolReferencesOf(state, symbol, dbType)[0]
  return first ? { from: first.from, to: first.to, role: 'reference' } : null
}

/** 跳转选项：运行期上下文与其它扩展同源（每次现读） */
export interface DefinitionNavOptions {
  runtime: (view: EditorView) => CompletionRuntime
}

/** 执行跳转；没有目标返回 false（调用方据此不消费按键 / 点击） */
export function goToDefinition(
  view: EditorView,
  pos: number,
  options: DefinitionNavOptions,
): boolean {
  const sql = sqlContextFromRuntime(options.runtime(view))
  const target = definitionTargetAt(view.state, pos, sql?.dbType ?? '')
  if (!target) {
    return false
  }

  view.dispatch({
    selection: EditorSelection.single(target.from, target.to),
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    // 滚动与选区移到别处不该被记成一次「编辑」
    userEvent: 'select.definition',
  })
  view.focus()
  return true
}

/** 跳转扩展：Ctrl / Cmd + 左键与 F12 */
export function definitionNavigationExtension(options: DefinitionNavOptions): Extension {
  return [
    Prec.high(EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) {
          return false
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null || !goToDefinition(view, pos, options)) {
          return false
        }
        event.preventDefault()
        return true
      },
    })),
    Prec.high(keymap.of([
      { key: 'F12', run: view => goToDefinition(view, view.state.selection.main.head, options) },
    ])),
  ]
}

/** 编辑器的查找 / 替换能力（@codemirror/search） */
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'

/** 查找能力要注册的扩展：顶部面板 + 选中词同名高亮 + 官方快捷键 */
export function editorSearchExtensions(): Extension[] {
  return [
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([...searchKeymap]),
  ]
}

/** 打开查找 / 替换面板（右键菜单入口） */
export function openEditorSearch(view: EditorView): boolean {
  return openSearchPanel(view)
}

/**
 * 应用自己的默认右键菜单（复制 / 剪切 / 粘贴）。
 *
 * 背景：应用整体屏蔽了浏览器原生右键菜单（见 main.ts），但输入框、文本域这些
 * 「真正的输入场景」此前被豁免，用户在这些控件上看到的仍是浏览器菜单。现在统一
 * 由这里接管，菜单项按三条规则决定启用与禁用：
 *
 *   - 复制：有选中内容，且右键点在选中的内容上；
 *   - 剪切：同复制，且选区位于可编辑位置；
 *   - 粘贴：剪贴板能读到非空内容，且右键位置可输入。
 *
 * 实现上有个关键点：点菜单会把焦点与选区从原控件上抢走，所以打开菜单时必须把
 * 「目标元素 + 选区区间」快照下来，执行动作前再恢复。
 */
import { reactive } from 'vue'
import { copyText, readText } from '@/utils/clipboard'
import { notify } from '@/utils/notify'

/** 可执行的编辑动作 */
export type EditingAction = 'copy' | 'cut' | 'paste'

/** 菜单状态：响应式，直接驱动 EditingContextMenu.vue */
export const editingMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  canCopy: false,
  canCut: false,
  canPaste: false,
})

/** 支持选区操作的 input 类型（其余类型读 selectionStart 无意义或直接抛错） */
const SELECTABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email'])

/** 右键时命中的可编辑元素：输入框 / 文本域 / contenteditable（含 CM6 编辑区） */
let editTarget: HTMLElement | null = null
/** 右键那一刻的选中文本 */
let selectedText = ''
/** 输入框里选中的区间（点菜单会把焦点抢走，必须快照） */
let inputRange: [number, number] | null = null
/** contenteditable 里选中的区间（同上） */
let domRange: Range | null = null

/** 关闭菜单 */
export function closeEditingMenu(): void {
  editingMenu.visible = false
}

/** 向上找可编辑元素；disabled / readonly 的不算 */
function findEditable(node: EventTarget | null): HTMLElement | null {
  let element = node instanceof HTMLElement ? node : null
  while (element) {
    if (element instanceof HTMLInputElement) {
      return element.disabled || element.readOnly ? null : element
    }
    if (element instanceof HTMLTextAreaElement) {
      return element.disabled || element.readOnly ? null : element
    }
    if (element.isContentEditable) {
      return element
    }
    element = element.parentElement
  }
  return null
}

/** 该元素是否读得到选区（input 只有文本类才有 selectionStart） */
function supportsSelection(target: HTMLElement | null): boolean {
  if (!target) {
    return false
  }
  if (target instanceof HTMLTextAreaElement) {
    return true
  }
  if (target instanceof HTMLInputElement) {
    return SELECTABLE_INPUT_TYPES.has(target.type)
  }
  return target.isContentEditable
}

/** 打开菜单时快照下来的选区信息 */
interface CapturedSelection {
  text: string
  inputRange: [number, number] | null
  domRange: Range | null
  /** 右键点是否落在选中的内容上 */
  onSelection: boolean
}

/** 快照当前选区，并判断右键点是否落在选区上 */
function captureSelection(target: HTMLElement | null, event: MouseEvent): CapturedSelection {
  const empty: CapturedSelection = { text: '', inputRange: null, domRange: null, onSelection: false }
  if (!supportsSelection(target) || !target) {
    return empty
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart
    const end = target.selectionEnd
    if (start === null || end === null || start === end) {
      return empty
    }
    return {
      text: target.value.slice(start, end),
      inputRange: [start, end],
      domRange: null,
      // 输入框拿不到选区的几何矩形，约定为「选中的就是右键命中的那个输入框」
      onSelection: true,
    }
  }

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return empty
  }
  const range = selection.getRangeAt(0)
  const text = selection.toString()
  if (!text) {
    return empty
  }
  return {
    text,
    inputRange: null,
    domRange: range.cloneRange(),
    onSelection: pointInRange(range, event),
  }
}

/**
 * 右键点是否落在选区的矩形内。
 *
 * 浏览器在「点选中的文字以外」时会先清掉选区，所以这一步多数情况下是冗余的；
 * 留着是为了把「点在选中内容上」这条规则表述完整，不依赖浏览器的清理时机。
 */
function pointInRange(range: Range, event: MouseEvent): boolean {
  for (const rect of Array.from(range.getClientRects())) {
    if (event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom) {
      return true
    }
  }
  return false
}

/**
 * 打开默认右键菜单。
 *
 * 由 main.ts 的全局 contextmenu 监听调用。组件自己实现了右键菜单的位置会在
 * 冒泡阶段先 preventDefault，那种情况由 main.ts 挡掉，不会走到这里。
 */
export function openEditingContextMenu(event: MouseEvent): void {
  const target = findEditable(event.target)
  const captured = captureSelection(target, event)

  editTarget = target
  selectedText = captured.text
  inputRange = captured.inputRange
  domRange = captured.domRange

  editingMenu.x = event.clientX
  editingMenu.y = event.clientY
  editingMenu.canCopy = captured.onSelection
  editingMenu.canCut = captured.onSelection && canEdit(target)
  // 剪贴板内容是异步读的：先记下「目标可输入」，读到结果后再收敛
  editingMenu.canPaste = canEdit(target)
  editingMenu.visible = true

  void resolvePasteAvailability()
}

/** 目标是否真的能接收输入（粘贴要有落点） */
function canEdit(target: HTMLElement | null): boolean {
  return target !== null && supportsSelection(target)
}

/** 读一次剪贴板，把「粘贴」的可用状态收敛到真实情况 */
async function resolvePasteAvailability(): Promise<void> {
  if (!editingMenu.canPaste) {
    return
  }
  const text = await readText()
  // null = 读不了，'' = 剪贴板为空；两种情况都只能置灰
  if (!text) {
    editingMenu.canPaste = false
  }
}

/** 执行菜单动作 */
export async function runEditingAction(action: EditingAction): Promise<void> {
  closeEditingMenu()

  const target = editTarget
  try {
    switch (action) {
      case 'copy':
        if (selectedText) {
          await copyText(selectedText)
        }
        return

      case 'cut':
        if (!target || !selectedText) {
          return
        }
        await copyText(selectedText)
        removeSelection(target)
        return

      case 'paste': {
        if (!target) {
          return
        }
        const text = await readText()
        if (text === null) {
          notify.warning('当前环境无法读取剪贴板')
          return
        }
        if (text) {
          writeText(target, text)
        }
        return
      }

      default:
        return
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 删除快照下来的选区 */
function removeSelection(target: HTMLElement): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const [start, end] = inputRange ?? [target.selectionStart ?? 0, target.selectionEnd ?? 0]
    replaceInputRange(target, start, end, '')
    return
  }
  // contenteditable：先恢复选区再交给浏览器删，CM6 才会收到变更事件
  restoreDomSelection(target)
  if (!document.execCommand('delete')) {
    domRange?.deleteContents()
  }
}

/** 把文本写到快照位置 */
function writeText(target: HTMLElement, text: string): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const [start, end] = inputRange ?? [target.value.length, target.value.length]
    replaceInputRange(target, start, end, text)
    return
  }
  // contenteditable：恢复选区后走 execCommand，它会派发 beforeinput / input，
  // CodeMirror 等编辑器正是靠这些事件把输入并入自己的状态机
  restoreDomSelection(target)
  if (!document.execCommand('insertText', false, text)) {
    insertIntoDom(target, text)
  }
}

/** 把元素自身的选区恢复成快照状态并聚焦 */
function restoreDomSelection(target: HTMLElement): void {
  target.focus()
  if (!domRange) {
    return
  }
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(domRange)
}

/** execCommand 不可用时的兜底：直接用 Range 插文本 */
function insertIntoDom(target: HTMLElement, text: string): void {
  const range = domRange?.cloneRange()
  if (!range) {
    target.append(document.createTextNode(text))
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 替换输入框里的一段文本，并补发 input 事件让 v-model 跟上 */
function replaceInputRange(
  target: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): void {
  const next = target.value.slice(0, start) + text + target.value.slice(end)
  target.value = next
  const caret = start + text.length
  target.setSelectionRange(caret, caret)
  target.focus()
  inputRange = [caret, caret]
  // Vue 的 v-model 监听原生 input 事件并从 target.value 取值，必须补发
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

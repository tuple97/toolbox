/** 表格行选择的规则（结果表格用）：普通点击 / Ctrl 加减选 / Shift 区间选 */

export interface RowSelectionInput {
  /** 当前已选行下标 */
  current: number[]
  /** 本次点击的行下标 */
  clicked: number
  /** 是否按住 Shift */
  shift: boolean
  /** 是否按住 Ctrl / Cmd */
  toggle: boolean
  /** 上一次操作留下的锚点（区间起点），没有则为 null */
  anchor: number | null
}

export interface RowSelectionResult {
  selected: number[]
  anchor: number
}

export function applyRowSelection(input: RowSelectionInput): RowSelectionResult {
  const { current, clicked, shift, toggle, anchor } = input

  // Shift：选中锚点到点击处的区间（反向也成立），锚点保持不动
  if (shift && anchor !== null) {
    const from = Math.min(anchor, clicked)
    const to = Math.max(anchor, clicked)
    const range: number[] = []
    for (let index = from; index <= to; index++) {
      range.push(index)
    }
    return { selected: range, anchor }
  }

  // Ctrl / Cmd：切换单行，并把它设为新锚点
  if (toggle) {
    const selected = current.includes(clicked)
      ? current.filter(index => index !== clicked)
      : [...current, clicked]
    return { selected, anchor: clicked }
  }

  // 普通点击：只选这一行
  return { selected: [clicked], anchor: clicked }
}

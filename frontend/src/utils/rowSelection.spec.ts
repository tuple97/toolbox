import { describe, expect, it } from 'vitest'
import { applyRowSelection } from '@/utils/rowSelection'

/** 其余字段给默认值，用例只写关心的字段 */
function select(overrides: Partial<Parameters<typeof applyRowSelection>[0]> = {}) {
  return applyRowSelection({
    current: [],
    clicked: 0,
    shift: false,
    toggle: false,
    anchor: null,
    ...overrides,
  })
}

describe('行选择规则', () => {
  it('普通点击：只选这一行，并把它设为锚点', () => {
    expect(select({ current: [0, 1, 2], clicked: 5 })).toEqual({ selected: [5], anchor: 5 })
  })

  it('Ctrl 点击：加选一行，锚点跟着走', () => {
    expect(select({ current: [2], clicked: 5, toggle: true })).toEqual({ selected: [2, 5], anchor: 5 })
  })

  it('Ctrl 点击已选行：取消这一行（锚点仍指向它）', () => {
    expect(select({ current: [2, 5], clicked: 2, toggle: true })).toEqual({ selected: [5], anchor: 2 })
  })

  it('Shift 点击：选中锚点到点击处的整个区间', () => {
    expect(select({ current: [1], clicked: 4, shift: true, anchor: 1 }))
      .toEqual({ selected: [1, 2, 3, 4], anchor: 1 })
  })

  it('反向 Shift（点在锚点上面）同样成立', () => {
    expect(select({ shift: true, anchor: 4, clicked: 2 }))
      .toEqual({ selected: [2, 3, 4], anchor: 4 })
  })

  it('Shift 覆盖原选择但保留锚点 —— 连续 Shift 能来回调整范围', () => {
    const first = select({ shift: true, anchor: 2, clicked: 5 })
    expect(first.selected).toEqual([2, 3, 4, 5])
    // 锚点仍是 2：再点 3 收窄成 [2,3]
    const second = select({ current: first.selected, shift: true, anchor: first.anchor, clicked: 3 })
    expect(second.selected).toEqual([2, 3])
    // 再点 5 又扩回 [2..5]
    const third = select({ current: second.selected, shift: true, anchor: second.anchor, clicked: 5 })
    expect(third.selected).toEqual([2, 3, 4, 5])
  })

  it('区间选择包含单行（锚点 = 点击处）', () => {
    expect(select({ shift: true, anchor: 3, clicked: 3 })).toEqual({ selected: [3], anchor: 3 })
  })

  it('没有锚点时 Shift 退化成普通点击（不会选出一个空区间）', () => {
    expect(select({ current: [0, 1], clicked: 7, shift: true, anchor: null }))
      .toEqual({ selected: [7], anchor: 7 })
  })

  it('选择顺序：区间一律升序，Ctrl 加选保持加选先后', () => {
    // 区间覆盖，顺序自上而下
    const ranged = select({ current: [5], shift: true, anchor: 0, clicked: 2 })
    expect(ranged.selected).toEqual([0, 1, 2])

    // 连续 Ctrl 加选：按加选顺序排列
    const first = select({ clicked: 5, toggle: true })
    const second = select({ current: first.selected, clicked: 1, toggle: true })
    const third = select({ current: second.selected, clicked: 3, toggle: true })
    expect(third.selected).toEqual([5, 1, 3])
  })
})

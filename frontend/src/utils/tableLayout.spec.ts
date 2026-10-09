import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_WIDTH,
  alignClassOf,
  cellTextOf,
  columnWidthStyle,
  flexWeightOf,
  tableMinWidthOf,
} from '@/utils/tableLayout'
import type { TableColumn } from '@/utils/tableLayout'

function columnsOf(...columns: TableColumn[]): TableColumn[] {
  return columns
}

describe('表格列布局', () => {
  it('固定宽度列按像素给宽度', () => {
    const columns = columnsOf(
      { key: 'status', label: '状态', width: 96 },
      { key: 'note', label: '备注', minWidth: 200 },
    )
    expect(columnWidthStyle(columns[0], columns)).toEqual({ width: '96px' })
  })

  it('弹性列按 minWidth 比例分剩余空间（注释长的列更宽）', () => {
    const columns = columnsOf(
      { key: 'name', label: '字段', minWidth: 150 },
      { key: 'comment', label: '注释', minWidth: 300 },
    )
    // 150 : 300 → 1/3 与 2/3
    expect(columnWidthStyle(columns[0], columns)).toEqual({ width: `${150 / 450 * 100}%` })
    expect(columnWidthStyle(columns[1], columns)).toEqual({ width: `${300 / 450 * 100}%` })
  })

  it('没写 minWidth 的弹性列用默认权重', () => {
    const columns = columnsOf(
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B', minWidth: DEFAULT_MIN_WIDTH * 3 },
    )
    expect(flexWeightOf(columns)).toBe(DEFAULT_MIN_WIDTH * 4)
  })

  it('固定宽度列不参与弹性权重（否则表会被越算越窄）', () => {
    const columns = columnsOf(
      { key: 'index', label: '#', width: 64 },
      { key: 'name', label: '名字', minWidth: 160 },
    )
    expect(flexWeightOf(columns)).toBe(160)
  })

  it('全部列都是固定宽度时不写百分比（交给浏览器分配，而不是编一个假的）', () => {
    const columns = columnsOf({ key: 'a', label: 'A', width: 100 }, { key: 'b', label: 'B', width: 80 })
    expect(flexWeightOf(columns)).toBe(0)
    expect(columnWidthStyle(columns[0], columns)).toEqual({ width: '100px' })
    expect(columnWidthStyle({ key: 'c', label: 'C' }, columns)).toEqual({})
  })

  it('最小总宽度 = 各列「固定宽度或最小宽度」之和（列多时靠它撑出横向滚动）', () => {
    const columns = columnsOf(
      { key: 'a', label: 'A', width: 100 },
      { key: 'b', label: 'B', minWidth: 200 },
      { key: 'c', label: 'C' },
    )
    // 100 + 200 + 默认 120
    expect(tableMinWidthOf(columns)).toBe(420)
  })

  it('行号列要计入最小总宽度（漏掉它会让第一列被压掉 64px）', () => {
    const columns = columnsOf({ key: 'a', label: 'A', minWidth: 200 })
    expect(tableMinWidthOf(columns, 64)).toBe(264)
  })

  it('列数很多时最小总宽度成比例增长（这才是「挤在一起」的解药）', () => {
    const many = columnsOf(
      ...Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `C${i}` })),
    )
    expect(tableMinWidthOf(many)).toBe(12 * DEFAULT_MIN_WIDTH)
    // 远大于常见窗口宽度
    expect(tableMinWidthOf(many)).toBeGreaterThan(1280)
  })

  it('对齐：默认左对齐，center / right 各归其位', () => {
    expect(alignClassOf({ key: 'a', label: 'A' })).toBe('text-left')
    expect(alignClassOf({ key: 'a', label: 'A', align: 'center' })).toBe('text-center')
    expect(alignClassOf({ key: 'a', label: 'A', align: 'right' })).toBe('text-right')
  })

  it('单元格取值：null / undefined 显示为空串，0 与 false 要照实显示', () => {
    const column: TableColumn = { key: 'v', label: 'V' }
    expect(cellTextOf({ v: null }, column)).toBe('')
    expect(cellTextOf({ v: undefined }, column)).toBe('')
    expect(cellTextOf({}, column)).toBe('')
    // 用 `value || ''` 会把 0 / false 也吞掉
    expect(cellTextOf({ v: 0 }, column)).toBe('0')
    expect(cellTextOf({ v: false }, column)).toBe('false')
    expect(cellTextOf({ v: 'text' }, column)).toBe('text')
  })
})

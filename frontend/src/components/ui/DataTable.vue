<script setup lang="ts" generic="TRow extends object">
/** 数据表：列由 columns 数组声明，行类型为泛型 TRow */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { cn } from '@/lib/utils'
import EmptyState from '@/components/ui/EmptyState.vue'
import { applyRowSelection } from '@/utils/rowSelection'
import { alignClassOf, cellTextOf, columnWidthStyle, tableMinWidthOf } from '@/utils/tableLayout'
import type { TableColumn } from '@/utils/tableLayout'

const props = withDefaults(defineProps<{
  columns: TableColumn[]
  /** 行数据 */
  rows: TRow[]
  /** 行号列：给了才渲染 # 列 */
  indexOf?: (index: number) => number
  /** 行号列宽度，默认 64 */
  indexWidth?: number
  /** 无数据时的说明 */
  emptyText?: string
  /** 隔行底色 */
  striped?: boolean
  /** 紧凑尺寸 */
  size?: 'sm' | 'default'
  /** 开启行选择 */
  selectable?: boolean
  /** 双击单元格选中该格文本 */
  selectTextOnDblClick?: boolean
  class?: string
}>(), {
  emptyText: '暂无数据',
  size: 'default',
  indexWidth: 64,
})

const emit = defineEmits<{
  (e: 'row-contextmenu', payload: {
    row: TRow
    index: number
    /** 本次操作实际作用的行 */
    rows: TRow[]
    x: number
    y: number
  }): void
  /** 无文本选中时按 Ctrl / Cmd + C 触发 */
  (e: 'copy-rows', payload: { rows: TRow[] }): void
}>()

/* 显式声明插槽类型，避免动态插槽名推断成 any */
defineSlots<{
  [name: `cell-${string}`]: (props: { row: TRow, index: number }) => unknown
  [name: `header-${string}`]: (props: { column: TableColumn }) => unknown
  default?: () => unknown
}>()

/** 单元格文本，缺键返回空串 */
function cellText(row: TRow, col: TableColumn): string {
  return cellTextOf(row as Record<string, unknown>, col)
}

/** 表格最小总宽度：列宽按百分比算，需要下限 */
const minTableWidth = computed(() =>
  tableMinWidthOf(props.columns, props.indexOf ? props.indexWidth : 0))

/* 行选择规则在 utils/rowSelection.ts，这里只做事件接线 */
const selected = defineModel<number[]>('selected', { default: () => [] })
/** 区间选择锚点 */
const anchorIndex = ref<number | null>(null)
/** 滚动容器：键盘事件的落点 */
const container = ref<HTMLElement | null>(null)

function isSelected(index: number): boolean {
  return props.selectable === true && selected.value.includes(index)
}

function handleRowClick(index: number, event: MouseEvent) {
  // 表格内有文本选中时不改行选择
  if (hasTextSelectionInside()) {
    return
  }
  const next = applyRowSelection({
    current: selected.value,
    clicked: index,
    shift: event.shiftKey,
    toggle: event.ctrlKey || event.metaKey,
    anchor: anchorIndex.value,
  })
  selected.value = next.selected
  anchorIndex.value = next.anchor
}

/** 表格内是否有文本选中 */
function hasTextSelectionInside(): boolean {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode) {
    return false
  }
  return container.value?.contains(selection.anchorNode) ?? false
}

/** 行上按下鼠标：拿焦点，Shift 时阻止原生文本选择 */
function handleRowMouseDown(event: MouseEvent) {
  if (!props.selectable) {
    return
  }
  container.value?.focus({ preventScroll: true })
  if (event.shiftKey) {
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
  }
}

/** 全选（Ctrl / Cmd + A） */
function selectAll() {
  selected.value = props.rows.map((_, index) => index)
  anchorIndex.value = props.rows.length ? props.rows.length - 1 : null
}

/** 表格里的快捷键 */
function handleTableKeydown(event: KeyboardEvent) {
  if (!props.selectable || !(event.ctrlKey || event.metaKey)) {
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'a') {
    event.preventDefault()
    selectAll()
    return
  }
  if (key === 'c') {
    // 有文本选中交给浏览器，否则复制选中行
    const textSelection = window.getSelection()
    if (textSelection && !textSelection.isCollapsed) {
      return
    }
    if (!selected.value.length) {
      return
    }
    event.preventDefault()
    emit('copy-rows', {
      rows: selected.value
        .map(index => props.rows[index])
        .filter((row): row is TRow => row !== undefined),
    })
  }
}

/** 双击选中整个单元格文本 */
function handleCellDblClick(event: MouseEvent) {
  if (!props.selectTextOnDblClick) {
    return
  }
  const target = event.target as HTMLElement | null
  if (!target || target.closest('input, textarea, select')) {
    return
  }
  const cell = target.closest('td')
  const selection = window.getSelection()
  if (!cell || !selection) {
    return
  }
  const range = document.createRange()
  range.selectNodeContents(cell)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 清空选择 */
function clearSelection() {
  if (selected.value.length) {
    selected.value = []
  }
  anchorIndex.value = null
}

/* 换数据（新查询 / 翻页）时清空选择 */
watch(() => props.rows, () => clearSelection())

/* Esc 清空选择 */
function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && selected.value.length) {
    clearSelection()
  }
}
document.addEventListener('keydown', handleEscape)
onBeforeUnmount(() => document.removeEventListener('keydown', handleEscape))

function onRowContextMenu(row: TRow, index: number, event: MouseEvent) {
  /* 右键作用范围＝选区；点在选区外时只保留该行 */
  if (props.selectable && !selected.value.includes(index)) {
    selected.value = [index]
    anchorIndex.value = index
  }
  const rows = props.selectable && selected.value.length
    ? selected.value
        .map(item => props.rows[item])
        .filter((item): item is TRow => item !== undefined)
    : [row]
  emit('row-contextmenu', { row, index, rows, x: event.clientX, y: event.clientY })
}
</script>

<template>
  <div :class="cn('flex min-h-0 flex-col overflow-hidden', props.class)">
    <!-- 键盘快捷键的落点：tabindex 让容器可聚焦 -->
    <div
      ref="container"
      tabindex="-1"
      class="min-h-0 flex-1 overflow-auto outline-none"
      @keydown="handleTableKeydown"
      @click.self="selectable && clearSelection()"
    >
      <table
        v-if="rows.length"
        class="w-full table-fixed border-collapse text-sm"
        :style="{ minWidth: `${minTableWidth}px` }"
      >
        <colgroup>
          <col v-if="indexOf" :style="{ width: `${indexWidth}px` }">
          <col v-for="col in columns" :key="col.key" :style="columnWidthStyle(col, columns)">
        </colgroup>

        <thead class="sticky top-0 z-10">
          <tr class="bg-panel">
            <th
              v-if="indexOf"
              :class="cn(
                'border-b border-r border-border px-2 font-medium text-muted',
                size === 'sm' ? 'py-1 text-xs' : 'py-1.5',
              )"
            >
              #
            </th>
            <th
              v-for="(col, columnIndex) in columns"
              :key="col.key"
              :class="cn(
                'border-b border-border px-2 font-medium text-muted',
                columnIndex < columns.length - 1 && 'border-r',
                size === 'sm' ? 'py-1 text-xs' : 'py-1.5',
                alignClassOf(col),
              )"
            >
              <slot :name="`header-${col.key}`" :column="col">{{ col.label }}</slot>
            </th>
          </tr>
        </thead>

        <tbody>
          <tr
            v-for="(row, index) in rows"
            :key="index"
            :class="cn(
              'border-b border-border last:border-b-0',
              striped && index % 2 === 1 && 'bg-surface/40',
              // 选中态盖过斑马纹
              isSelected(index) && 'bg-active',
            )"
            @mousedown="handleRowMouseDown($event)"
            @click="selectable && handleRowClick(index, $event)"
            @contextmenu="onRowContextMenu(row, index, $event)"
          >
            <td
              v-if="indexOf"
              :class="cn(
                'overflow-hidden border-r border-border px-2 text-center text-muted',
                size === 'sm' ? 'py-0.5 text-xs' : 'py-1',
              )"
            >
              {{ indexOf(index) }}
            </td>
            <td
              v-for="(col, columnIndex) in columns"
              :key="col.key"
              :class="cn(
                'overflow-hidden border-border px-2 align-middle',
                columnIndex < columns.length - 1 && 'border-r',
                size === 'sm' ? 'py-0.5 text-xs' : 'py-1',
                alignClassOf(col),
              )"
              @dblclick="handleCellDblClick"
            >
              <slot v-if="$slots[`cell-${col.key}`]" :name="`cell-${col.key}`" :row="row" :index="index" />
              <div
                v-else
                :class="col.ellipsis && 'truncate'"
                :title="col.ellipsis ? cellText(row, col) : undefined"
              >
                {{ cellText(row, col) }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空表 -->
      <EmptyState v-else :description="emptyText" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import DataTable from '@/components/ui/DataTable.vue'
import Icon from '@/components/ui/Icon.vue'
import { copyText } from '@/utils/clipboard'
import { toCsv } from '@/utils/csv'
import { notify } from '@/utils/notify'
import { primaryKeysOfResult } from '@/utils/sql/rowSql'
import { typeColorTokenOf } from '@/utils/sql/typeBadge'
import { useDictStore } from '@/stores/dictStore'
import { buildColumns, createMappingLookup, formatCell } from '@/utils/dictFormatter'
import { suggestionsForRow } from '@/utils/sql/explainTips'
import type { TableColumn } from '@/utils/tableLayout'
import type { ResultSourceContext } from '@/utils/sql/rowSql'
import type { TypeColorToken } from '@/utils/sql/typeBadge'
import type { FieldMapping, QueryResult } from '@/types'

const props = withDefaults(defineProps<{
  /** 查询结果 */
  result: QueryResult
  /** 字段映射配置 */
  mappings: FieldMapping[]
  /** 是否为 EXPLAIN 分析结果：单元格悬停时给出优化建议 */
  analysis?: boolean
  /** 结果来源（连接 / 库 / SQL）：用来给主键列加标识 */
  source?: ResultSourceContext | null
}>(), {
  mappings: () => [],
  analysis: false,
  source: null,
})

const emit = defineEmits<{
  /** 行右键：带上要作用的行与鼠标位置（多选时即全部选中行） */
  (e: 'row-contextmenu', payload: {
    row: Record<string, unknown>
    rows: Record<string, unknown>[]
    x: number
    y: number
  }): void
}>()

/** 已选行下标（多选：Ctrl 加减选、Shift 区间选） */
const selectedRows = ref<number[]>([])

/** 行右键：把鼠标位置与要作用的行上报 */
function handleRowContextMenu(payload: {
  row: Record<string, unknown>
  rows: Record<string, unknown>[]
  x: number
  y: number
}) {
  emit('row-contextmenu', { row: payload.row, rows: payload.rows, x: payload.x, y: payload.y })
}

/** Ctrl+C：把选中行复制成 CSV（带列名，用原始值而非显示文本） */
async function handleCopyRows(payload: { rows: Record<string, unknown>[] }) {
  const columns = tableColumns.value
  const csv = toCsv(
    columns.map(col => col.label),
    payload.rows.map(row => columns.map(col => row[col.key])),
  )
  try {
    await copyText(csv)
    notify.success(`已复制 ${payload.rows.length} 行（CSV，含列名）`)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

const dictStore = useDictStore()

/** 按映射配置生成表格列 */
const columns = computed(() => buildColumns(props.result.columns, props.mappings))

/** 未配置宽度的结果列的最小宽度（px；列多时由 DataTable 出横向滚动条） */
const RESULT_COLUMN_MIN_WIDTH = 150

/** 表格列配置：把 dictFormatter 的列描述翻译成 DataTable 的列 */
const tableColumns = computed<TableColumn[]>(() => columns.value.map(col => ({
  key: col.column,
  label: col.label,
  width: col.width,
  minWidth: RESULT_COLUMN_MIN_WIDTH,
  align: col.align,
  ellipsis: true,
})))

/** 列键 → 列描述：表头要展示类型与备注，单元格要按列取值 */
const columnInfo = computed(() => new Map(columns.value.map(col => [col.column, col])))

/** 列名 → 映射配置，避免每格重复遍历 */
const mappingLookup = computed(() => createMappingLookup(props.mappings))

/** 单元格渲染结果：命中词典按模板展示，EXPLAIN 分析再合并该行优化建议 */
function renderCell(row: Record<string, unknown>, column: string) {
  const cell = formatCell(row[column], mappingLookup.value(column), dictStore.lookup)
  if (!props.analysis) {
    return cell
  }
  const advice = suggestionsForRow(row)
  if (!advice.length) {
    return cell
  }
  const tips = advice.map(item => `【${item.source}】${item.text}`)
  return { ...cell, tooltip: [cell.tooltip, ...tips].filter(Boolean).join('\n') }
}

/** 行号列：跨页连续（offset = (page - 1) * pageSize） */
function rowIndex(index: number): number {
  const page = props.result.page ?? 1
  const size = props.result.pageSize ?? 0
  return (page - 1) * size + index + 1
}

/** 列的元信息（表头与悬停卡片各取所需，取不到给空串） */
function typeOf(column: string): string {
  return columnInfo.value.get(column)?.type ?? ''
}

function commentOf(column: string): string {
  return columnInfo.value.get(column)?.comment ?? ''
}

function tableOf(column: string): string {
  return columnInfo.value.get(column)?.table ?? ''
}

/** 类型文字的配色：语义由 typeBadge 按类型大类决定 */
const TYPE_TEXT_CLASS: Record<TypeColorToken, string> = {
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
}

function typeTextClass(column: string): string {
  return TYPE_TEXT_CLASS[typeColorTokenOf(typeOf(column))]
}

/** 该列是不是来源表的主键（大小写不敏感） */
const primaryKeys = ref<Set<string>>(new Set())

function isPrimaryKey(column: string): boolean {
  return primaryKeys.value.has(column.toLowerCase())
}

/** 主键查询的输入指纹（source 是对象，摊平成字符串才能按内容比较） */
const sourceKey = computed(() => {
  const source = props.source
  return source
    ? [source.connId, source.database, source.dbType, source.sql].join('\u0000')
    : ''
})

// 只在「换了结果 / 连接或库」时查一次主键；用递增序号丢弃过期响应
let primaryKeyRequest = 0
watch(sourceKey, async () => {
  const token = ++primaryKeyRequest
  const source = props.source
  const keys = source ? await primaryKeysOfResult(source) : []
  if (token === primaryKeyRequest) {
    primaryKeys.value = new Set(keys.map(key => key.toLowerCase()))
  }
}, { immediate: true })
</script>

<template>
  <!-- selectable：允许选中表头与单元格文本，便于 Ctrl+C 复制 -->
  <div class="result-table selectable flex h-full flex-col">
    <DataTable
      v-model:selected="selectedRows"
      selectable
      select-text-on-dbl-click
      :columns="tableColumns"
      :rows="result.rows"
      :index-of="rowIndex"
      size="sm"
      striped
      class="min-h-0 flex-1"
      empty-text="查询成功，但未返回数据"
      @row-contextmenu="handleRowContextMenu"
      @copy-rows="handleCopyRows"
    >
      <template v-for="col in tableColumns" :key="`head-${col.key}`" #[`header-${col.key}`]>
        <div
          class="result-table__head"
          :class="{
            'result-table__head--right': col.align === 'right',
            'result-table__head--center': col.align === 'center',
          }"
          :data-col-name="col.label"
          :data-col-type="typeOf(col.key) || undefined"
          :data-col-table="tableOf(col.key) || undefined"
          :data-col-comment="commentOf(col.key) || undefined"
        >
          <span class="result-table__head-main">
            <Icon
              v-if="isPrimaryKey(col.key)"
              name="key"
              class="result-table__head-pk"
              title="主键"
            />
            <span class="result-table__head-name">{{ col.label }}</span>
          </span>
          <span v-if="typeOf(col.key)" class="result-table__head-meta">
            <span class="result-table__head-type" :class="typeTextClass(col.key)">
              {{ typeOf(col.key) }}
            </span>
          </span>
          <span v-if="commentOf(col.key)" class="result-table__head-meta">
            {{ commentOf(col.key) }}
          </span>
        </div>
      </template>

      <!-- 单元格：单元素数组的 v-for 给渲染结果起别名，一格里只算一次 -->
      <template v-for="col in tableColumns" :key="`cell-${col.key}`" #[`cell-${col.key}`]="{ row }">
        <template v-for="cell in [renderCell(row, col.key)]" :key="0">
          <span
            v-if="cell.tooltip"
            class="result-table__cell"
            :class="{ 'result-table__cell--matched': cell.matched }"
            :title="cell.tooltip"
          >{{ cell.text }}</span>
          <span
            v-else
            class="result-table__cell"
            :class="{ 'result-table__cell--matched': cell.matched }"
          >{{ cell.text }}</span>
        </template>
      </template>
    </DataTable>
  </div>
</template>

<style scoped>
.result-table {
  flex: 1;
  min-height: 0;
  padding: 0 16px 12px;
}

/* 列头：纵向两行，对齐跟随列的 align */
.result-table__head {
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
  min-width: 0;
}

.result-table__head--center {
  align-items: center;
}

.result-table__head--right {
  align-items: flex-end;
}

/* 两行内部都按行排：主键标识与列名一行、类型与备注一行 */
.result-table__head-main,
.result-table__head-meta {
  display: flex;
  gap: 4px;
  align-items: center;
  max-width: 100%;
  min-width: 0;
}

/* 列名：表头主体，正文色 + 加粗 + 比元信息大两档 */
.result-table__head-name {
  overflow: hidden;
  color: var(--text-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 主键标识：钥匙用金色 */
.result-table__head-pk {
  flex: none;
  color: var(--warning-color);
}

/* 元信息（类型 / 备注）：独占一行，比列名小两档、颜色弱化 */
.result-table__head-meta {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--app-font-size-2xs);
  font-weight: 400;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 类型文字：只上色（配色见 TYPE_TEXT_CLASS） */
.result-table__head-type {
  font-weight: 500;
}

.result-table__cell {
  cursor: help;
}

.result-table__cell--matched {
  color: var(--brand-color);
}
</style>

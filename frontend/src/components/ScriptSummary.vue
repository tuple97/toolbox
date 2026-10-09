<script setup lang="ts">
import { computed } from 'vue'
import DataTable from '@/components/ui/DataTable.vue'
import Tag from '@/components/ui/Tag.vue'
import type { TableColumn } from '@/utils/tableLayout'
import type { ScriptRunSummary, StatementRunRecord } from '@/types'

/** 「执行全部」的摘要页签：上半整体信息，下半逐条明细 */
const props = defineProps<{
  summary: ScriptRunSummary
}>()

/** 时间戳 → HH:mm:ss.SSS */
function formatTime(value: number): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  const pad = (num: number, length = 2) => String(num).padStart(length, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** 耗时格式化：小于 1 秒显示 ms，否则显示秒 */
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

/** 顶部整体信息 */
const stats = computed(() => [
  { label: '语句总数', value: `${props.summary.records.length} 条` },
  { label: '成功', value: `${props.summary.successCount} 条` },
  { label: '失败', value: `${props.summary.failedCount} 条` },
  { label: '开始时间', value: formatTime(props.summary.startedAt) },
  {
    label: '结束时间',
    value: props.summary.finishedAt ? formatTime(props.summary.finishedAt) : '执行中…',
  },
  { label: '总耗时', value: props.summary.totalMs ? formatDuration(props.summary.totalMs) : '—' },
])

/** 明细表列 */
const COLUMNS: TableColumn[] = [
  { key: 'sql', label: '语句', minWidth: 220, ellipsis: true },
  { key: 'status', label: '状态', width: 96, align: 'center' },
  { key: 'result', label: '结果', minWidth: 160, ellipsis: true },
  { key: 'startedAt', label: '开始时间', width: 118, align: 'center' },
  { key: 'finishedAt', label: '结束时间', width: 118, align: 'center' },
  { key: 'elapsedMs', label: '耗时', width: 100, align: 'right' },
]

/** 状态文案 */
function statusText(record: StatementRunRecord): string {
  switch (record.status) {
    case 'success':
      return '成功'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '运行中'
  }
}

/** 状态标签语气 */
function statusTone(record: StatementRunRecord): 'success' | 'danger' | 'info' | 'brand' {
  switch (record.status) {
    case 'success':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'info'
    default:
      return 'brand'
  }
}

/** 结果列文案 */
function resultText(record: StatementRunRecord): string {
  if (record.status === 'failed' || record.status === 'cancelled') {
    return record.error ?? statusText(record)
  }
  if (record.status !== 'success') {
    return '—'
  }
  if (record.kind === 'query' && record.rowCount !== undefined) {
    return `返回 ${record.rowCount} 行`
  }
  if (record.kind === 'exec' && record.affectedRows !== undefined) {
    return `影响 ${record.affectedRows} 行`
  }
  return '—'
}

/** 失败 / 取消的结果文字用错误色 */
function isFailed(record: StatementRunRecord): boolean {
  return record.status === 'failed' || record.status === 'cancelled'
}

/** 行号：从 1 开始 */
function rowNumberOf(index: number): number {
  return index + 1
}
</script>

<template>
  <div class="script-summary flex min-h-0 flex-1 flex-col gap-2.5">
    <div class="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
      <div
        v-for="item in stats"
        :key="item.label"
        class="flex items-baseline gap-2 rounded-md border border-border bg-surface px-3 py-2"
      >
        <span class="text-xs text-muted">{{ item.label }}</span>
        <span class="text-sm font-semibold text-text">{{ item.value }}</span>
      </div>
    </div>

    <DataTable
      :columns="COLUMNS"
      :rows="summary.records"
      :index-of="rowNumberOf"
      :index-width="52"
      size="sm"
      striped
      class="min-h-0 flex-1 rounded-md border border-border"
      empty-text="没有可执行的语句"
    >
      <template #cell-status="{ row }">
        <Tag :tone="statusTone(row)" size="sm">
          {{ statusText(row) }}
        </Tag>
      </template>

      <!-- 结果列 -->
      <template #cell-result="{ row }">
        <span :class="isFailed(row) ? 'text-danger' : 'text-muted'">{{ resultText(row) }}</span>
      </template>

      <template #cell-startedAt="{ row }">
        {{ formatTime(row.startedAt) }}
      </template>

      <template #cell-finishedAt="{ row }">
        {{ row.finishedAt ? formatTime(row.finishedAt) : '执行中…' }}
      </template>

      <template #cell-elapsedMs="{ row }">
        {{ row.finishedAt ? formatDuration(row.elapsedMs) : '—' }}
      </template>
    </DataTable>
  </div>
</template>

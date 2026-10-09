<script setup lang="ts">
import { computed } from 'vue'
import Combobox from '@/components/ui/Combobox.vue'
import ConnectionOption from '@/components/ConnectionOption.vue'
import { connectionOptionLabel } from '@/utils/connectionDisplay'
import type { DBConnection } from '@/types'

/** 数据源（数据库连接）下拉，内部值为字符串，对外为 number | null */
const props = withDefaults(defineProps<{
  /** 选中的连接 ID；null 表示未选择 */
  modelValue: number | null
  /** 可选连接列表 */
  connections: DBConnection[]
  placeholder?: string
  /** 是否可清空 */
  clearable?: boolean
  /** 是否允许输入过滤 */
  filterable?: boolean
  /** 宽度，不传时由外部 class 决定 */
  width?: string
}>(), {
  placeholder: '选择数据库连接',
  clearable: false,
  filterable: true,
  width: '',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: number | null): void
}>()

/** 双向绑定：空串 ↔ null */
const selected = computed({
  get: () => (props.modelValue === null ? '' : String(props.modelValue)),
  set: (value: string) => emit('update:modelValue', value === '' ? null : Number(value)),
})

/** 选项：值为连接 id，label 供搜索匹配 */
const options = computed(() => props.connections.map(conn => ({
  label: connectionOptionLabel(conn),
  value: String(conn.id),
})))

/** 按选项值取连接对象 */
function connectionOf(value: string): DBConnection | null {
  return props.connections.find(conn => String(conn.id) === value) ?? null
}
</script>

<template>
  <Combobox
    v-model="selected"
    :options="options"
    :placeholder="placeholder"
    :clearable="clearable"
    :filterable="filterable"
    search-placeholder="搜索连接…"
    :style="width ? { width } : undefined"
  >
    <!-- 选中项：与下拉项同一渲染 -->
    <template #value="{ option }">
      <ConnectionOption
        v-if="connectionOf(option.value)"
        class="w-full"
        :connection="connectionOf(option.value) as DBConnection"
      />
    </template>

    <template #option="{ option }">
      <ConnectionOption
        v-if="connectionOf(option.value)"
        class="w-full"
        :connection="connectionOf(option.value) as DBConnection"
      />
    </template>
  </Combobox>
</template>

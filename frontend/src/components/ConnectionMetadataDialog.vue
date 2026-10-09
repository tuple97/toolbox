<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Combobox from '@/components/ui/Combobox.vue'
import DataTable from '@/components/ui/DataTable.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Input from '@/components/ui/Input.vue'
import { notify } from '@/utils/notify'
import { useMetadataStore } from '@/stores/metadataStore'
import { useConfigStore } from '@/stores/configStore'
import { dialectOf } from '@/utils/sql/rowSql'
import { filterDatabaseInfos, parseShowSystemDatabases } from '@/utils/sql/sqlVisibility'
import type { TableColumn } from '@/utils/tableLayout'
import type { DBConnection } from '@/types'

/** 连接元数据查看：左侧表 / 视图，右侧字段（名称 / 类型 / 注释） */

const props = defineProps<{
  /** 是否显示 */
  visible: boolean
  /** 要查看的连接 */
  connection: DBConnection | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const meta = useMetadataStore()
const configStore = useConfigStore()

/** 该连接的方言 */
const dialect = computed(() => dialectOf(props.connection?.dbType ?? ''))

/** 是否展示系统库 */
const showSystemDatabases = computed(() =>
  parseShowSystemDatabases(configStore.values.sql_show_system_databases))

/** 双向绑定可见性 */
const dialogVisible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

const connId = computed(() => props.connection?.id ?? 0)

/** 当前查看的库 */
const database = ref('')
/** 表名搜索关键字 */
const keyword = ref('')
/** 当前选中的表 */
const selectedTable = ref('')

/** 下拉框展示的库列表（系统库按设置过滤） */
const databases = computed(() => filterDatabaseInfos(
  connId.value ? meta.databaseInfos[connId.value] ?? [] : [],
  dialect.value,
  showSystemDatabases.value,
))

/** 当前库的表 / 视图（按搜索词过滤） */
const tables = computed(() => {
  if (!connId.value || !database.value) {
    return []
  }
  const all = meta.tables[`${connId.value}::${database.value}`] ?? []
  const text = keyword.value.trim().toLowerCase()
  return text ? all.filter(name => name.toLowerCase().includes(text)) : all
})

/** 当前选中表的字段 */
const columns = computed(() => {
  if (!connId.value || !database.value || !selectedTable.value) {
    return []
  }
  return meta.columns[`${connId.value}::${database.value}::${selectedTable.value}`] ?? []
})

const databasesLoading = computed(() => meta.isDatabasesLoading(connId.value))
const tablesLoading = computed(() => meta.isTablesLoading(connId.value, database.value))
const columnsLoading = computed(
  () => meta.isColumnsLoading(connId.value, database.value, selectedTable.value),
)

/** 字段表列 */
const FIELD_COLUMNS: TableColumn[] = [
  { key: 'name', label: '字段', minWidth: 150, ellipsis: true },
  { key: 'dataType', label: '类型', minWidth: 130, ellipsis: true },
  { key: 'comment', label: '注释', minWidth: 180, ellipsis: true },
]

/** 字段表空态文案 */
const fieldEmptyText = computed(() => {
  if (columnsLoading.value) {
    return '正在读取字段…'
  }
  return selectedTable.value ? '该表没有字段信息' : '选择左侧的表查看字段'
})

/** 库下拉选项 */
const databaseOptions = computed(() =>
  databases.value.map(info => ({ label: info.name, value: info.name })))

/** 打开时准备数据：库列表 → 默认库 → 表列表 */
watch(() => props.visible, async (open) => {
  if (!open || !connId.value) {
    return
  }
  keyword.value = ''
  selectedTable.value = ''
  await prepare()
})

/** 载入库列表并选中合适的库 */
async function prepare() {
  try {
    const list = await meta.loadDatabases(connId.value)
    // 选库优先级：上次查看的库 → 连接配置的库 → 列表首项
    const preferred = [database.value, props.connection?.database ?? '']
      .find(name => Boolean(name) && list.includes(name))
    // 兜底取首项时跳过被隐藏的系统库
    const visible = filterDatabaseInfos(
      meta.ensureDatabaseInfos(connId.value),
      dialect.value,
      showSystemDatabases.value,
    )
    database.value = preferred ?? visible[0]?.name ?? list[0] ?? ''
    if (database.value) {
      await meta.loadTables(connId.value, database.value)
    }
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 切换库：字段列表清空，重新拉表 */
async function handleDatabaseChange() {
  selectedTable.value = ''
  try {
    await meta.loadTables(connId.value, database.value)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 选中表：按需加载字段 */
async function selectTable(name: string) {
  selectedTable.value = name
  try {
    await meta.loadColumns(connId.value, database.value, name)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <Dialog v-model="dialogVisible" :title="`元数据 · ${connection?.name ?? ''}`" :width="880">
    <div class="flex flex-col gap-2.5">
      <header class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-muted">数据库</span>
        <Combobox
          v-model="database"
          :options="databaseOptions"
          :placeholder="databasesLoading ? '读取中…' : '选择数据库'"
          search-placeholder="搜索数据库…"
          class="w-[220px]"
          @update:model-value="handleDatabaseChange"
        />
        <Input
          v-model="keyword"
          prefix-icon="search"
          clearable
          placeholder="搜索表 / 视图"
          class="w-[200px]"
        />

        <span class="text-xs text-muted">{{ tables.length }} 张表 / 视图</span>
        <span class="ml-auto font-mono text-xs text-muted">
          {{ connection?.dbType }} · {{ connection?.host }}:{{ connection?.port }}
        </span>
      </header>

      <div class="flex h-[460px] min-h-0 gap-3">
        <!-- 表 / 视图列表：固定宽度，条目保持 shrink-0 -->
        <ul class="flex w-[240px] shrink-0 flex-col overflow-auto rounded-md border border-border p-1.5">
          <li
            v-for="name in tables"
            :key="name"
            class="shrink-0 cursor-pointer truncate rounded-md px-2 py-1.5 text-sm leading-normal
              transition-colors hover:bg-hover"
            :class="name === selectedTable && 'bg-active'"
            :title="name"
            @click="selectTable(name)"
          >
            {{ name }}
          </li>
          <li v-if="!tables.length" class="shrink-0 px-2.5 py-4 text-center text-xs text-muted">
            {{ tablesLoading ? '正在读取表…' : (database ? '该库下没有表或视图' : '请先选择数据库') }}
          </li>
        </ul>

        <DataTable
          :columns="FIELD_COLUMNS"
          :rows="columns"
          size="sm"
          class="min-w-0 flex-1 rounded-md border border-border"
          :empty-text="fieldEmptyText"
        />
      </div>
    </div>
  </Dialog>
</template>



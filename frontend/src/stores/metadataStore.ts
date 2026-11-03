/** 数据库元数据（库 / 表 / 字段）的全局缓存 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchDatabases, fetchForeignKeys, fetchTableColumns, fetchTables } from '@/api/executor'
import type { DatabaseInfo, ExecutorColumn, TableForeignKey } from '@/types'

/** 元数据缓存有效期 */
export const META_TTL = 5 * 60 * 1000

/** 拉取失败后的退避窗口：期间 `ensureXxx()` 不再自动重试 */
export const META_RETRY_BACKOFF = 30 * 1000

export const useMetadataStore = defineStore('metadata', () => {
  /** 连接 ID → 库列表（含是否系统库标记） */
  const databaseInfos = ref<Record<number, DatabaseInfo[]>>({})
  const databasesFetchedAt = ref<Record<number, number>>({})
  const databasesFailedAt = ref<Record<number, number>>({})
  const databasesLoading = ref<Record<number, boolean>>({})

  /** 连接 ID → 库名列表（从上面派生：补全候选与「这个库存在吗」判断用） */
  const databases = computed<Record<number, string[]>>(() =>
    Object.fromEntries(Object.entries(databaseInfos.value).map(([connId, list]) => [
      connId,
      list.map(info => info.name),
    ])))

  /** `${connId}::${database}` → 表名列表 */
  const tables = ref<Record<string, string[]>>({})
  const tablesFetchedAt = ref<Record<string, number>>({})
  const tablesFailedAt = ref<Record<string, number>>({})
  const tablesLoading = ref<Record<string, boolean>>({})

  /** `${connId}::${database}::${table}` → 字段列表 */
  const columns = ref<Record<string, ExecutorColumn[]>>({})
  const columnsFetchedAt = ref<Record<string, number>>({})
  const columnsFailedAt = ref<Record<string, number>>({})
  const columnsLoading = ref<Record<string, boolean>>({})

  /** `${connId}::${database}::${table}` → 外键列表（按表单独记账） */
  const foreignKeys = ref<Record<string, TableForeignKey[]>>({})
  const foreignKeysFetchedAt = ref<Record<string, number>>({})
  const foreignKeysFailedAt = ref<Record<string, number>>({})
  const foreignKeysLoading = ref<Record<string, boolean>>({})

  /** 最近一次失败原因，界面可据此给提示 */
  const lastError = ref('')

  /** `${connId}::${database}`：表列表的键 */
  function schemaKey(connId: number, database: string): string {
    return `${connId}::${database}`
  }

  /** `${connId}::${database}::${table}`：字段列表的键 */
  function tableKey(connId: number, database: string, table: string): string {
    return `${connId}::${database}::${table}`
  }

  /** 缓存是否仍在有效期内 */
  function isFresh(fetchedAt?: number): boolean {
    return Boolean(fetchedAt) && Date.now() - (fetchedAt as number) < META_TTL
  }

  /** 上一次失败是否仍在退避窗口内 */
  function inBackoff(failedAt?: number): boolean {
    return Boolean(failedAt) && Date.now() - (failedAt as number) < META_RETRY_BACKOFF
  }

  /** 是否该自动发起一次后台拉取：缓存不新鲜、不在退避期、也没有在途请求 */
  function shouldAutoLoad(fetchedAt?: number, failedAt?: number, loading?: boolean): boolean {
    return !isFresh(fetchedAt) && !inBackoff(failedAt) && !loading
  }

  // ------------------------------------------------------------ 库列表

  /** 读取库列表缓存并在需要时后台刷新；同步返回当前可见数据 */
  function ensureDatabases(connId: number): string[] {
    return ensureDatabaseInfos(connId).map(info => info.name)
  }

  /** 读取库列表（含系统库标记）并在需要时后台刷新 */
  function ensureDatabaseInfos(connId: number): DatabaseInfo[] {
    if (!connId) {
      return []
    }
    if (shouldAutoLoad(
      databasesFetchedAt.value[connId],
      databasesFailedAt.value[connId],
      databasesLoading.value[connId],
    )) {
      // 后台拉取的失败已在 load 里记进 lastError，这里吞掉以免产生未处理的 rejection
      void loadDatabases(connId).catch(() => {})
    }
    return databaseInfos.value[connId] ?? []
  }

  /** 拉取库列表；force 为真时忽略缓存 */
  async function loadDatabases(connId: number, force = false): Promise<string[]> {
    if (!connId) {
      return []
    }
    if (!force && isFresh(databasesFetchedAt.value[connId])) {
      return ensureDatabases(connId)
    }
    // 同一目标正在加载时复用同一次请求，避免重复打数据库
    if (databasesLoading.value[connId]) {
      return ensureDatabases(connId)
    }

    databasesLoading.value[connId] = true
    try {
      const infos = await fetchDatabases(connId)
      databaseInfos.value[connId] = infos
      databasesFetchedAt.value[connId] = Date.now()
      delete databasesFailedAt.value[connId]
      return infos.map(info => info.name)
    }
    catch (e) {
      databasesFailedAt.value[connId] = Date.now()
      lastError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
    finally {
      databasesLoading.value[connId] = false
    }
  }

  /** 库列表是否正在加载 */
  function isDatabasesLoading(connId: number): boolean {
    return Boolean(databasesLoading.value[connId])
  }

  // ------------------------------------------------------------ 表列表

  /** 读取表列表缓存并在需要时后台刷新；同步返回当前可见数据 */
  function ensureTables(connId: number, database: string): string[] {
    if (!connId) {
      return []
    }
    const key = schemaKey(connId, database)
    if (shouldAutoLoad(tablesFetchedAt.value[key], tablesFailedAt.value[key], tablesLoading.value[key])) {
      void loadTables(connId, database).catch(() => {})
    }
    return tables.value[key] ?? []
  }

  /** 拉取表列表；force 为真时忽略缓存 */
  async function loadTables(connId: number, database: string, force = false): Promise<string[]> {
    if (!connId) {
      return []
    }
    const key = schemaKey(connId, database)
    if (!force && isFresh(tablesFetchedAt.value[key])) {
      return tables.value[key] ?? []
    }
    if (tablesLoading.value[key]) {
      return tables.value[key] ?? []
    }

    tablesLoading.value[key] = true
    try {
      const names = await fetchTables(connId, database)
      tables.value[key] = names
      tablesFetchedAt.value[key] = Date.now()
      delete tablesFailedAt.value[key]
      return names
    }
    catch (e) {
      tablesFailedAt.value[key] = Date.now()
      lastError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
    finally {
      tablesLoading.value[key] = false
    }
  }

  /** 表列表是否正在加载 */
  function isTablesLoading(connId: number, database: string): boolean {
    return Boolean(tablesLoading.value[schemaKey(connId, database)])
  }

  // ------------------------------------------------------------ 字段列表

  /** 读取字段缓存并在需要时后台刷新（字段按表单独记账） */
  function ensureColumns(connId: number, database: string, table: string): ExecutorColumn[] {
    if (!connId || !table) {
      return []
    }
    const key = tableKey(connId, database, table)
    if (shouldAutoLoad(columnsFetchedAt.value[key], columnsFailedAt.value[key], columnsLoading.value[key])) {
      void loadColumns(connId, database, table).catch(() => {})
    }
    return columns.value[key] ?? []
  }

  /** 拉取某张表的字段；force 为真时忽略缓存 */
  async function loadColumns(
    connId: number,
    database: string,
    table: string,
    force = false,
  ): Promise<ExecutorColumn[]> {
    if (!connId || !table) {
      return []
    }
    const key = tableKey(connId, database, table)
    if (!force && isFresh(columnsFetchedAt.value[key])) {
      return columns.value[key] ?? []
    }
    if (columnsLoading.value[key]) {
      return columns.value[key] ?? []
    }

    columnsLoading.value[key] = true
    try {
      const list = await fetchTableColumns(connId, database, table)
      columns.value[key] = list
      columnsFetchedAt.value[key] = Date.now()
      delete columnsFailedAt.value[key]
      return list
    }
    catch (e) {
      columnsFailedAt.value[key] = Date.now()
      lastError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
    finally {
      columnsLoading.value[key] = false
    }
  }

  /** 字段列表是否正在加载 */
  function isColumnsLoading(connId: number, database: string, table: string): boolean {
    return Boolean(columnsLoading.value[tableKey(connId, database, table)])
  }

  // ------------------------------------------------------------ 外键

  /** 读取外键缓存并在需要时后台刷新；同步返回当前可见数据 */
  function ensureForeignKeys(connId: number, database: string, table: string): TableForeignKey[] {
    if (!connId || !table) {
      return []
    }
    const key = tableKey(connId, database, table)
    if (shouldAutoLoad(
      foreignKeysFetchedAt.value[key],
      foreignKeysFailedAt.value[key],
      foreignKeysLoading.value[key],
    )) {
      void loadForeignKeys(connId, database, table)
    }
    return foreignKeys.value[key] ?? []
  }

  /** 拉取外键；失败不抛出，按「无外键」处理并进入退避窗口 */
  async function loadForeignKeys(
    connId: number,
    database: string,
    table: string,
    force = false,
  ): Promise<TableForeignKey[]> {
    if (!connId || !table) {
      return []
    }
    const key = tableKey(connId, database, table)
    if (!force && isFresh(foreignKeysFetchedAt.value[key])) {
      return foreignKeys.value[key] ?? []
    }
    if (foreignKeysLoading.value[key]) {
      return foreignKeys.value[key] ?? []
    }

    foreignKeysLoading.value[key] = true
    try {
      const list = await fetchForeignKeys(connId, database, table)
      foreignKeys.value[key] = list
      foreignKeysFetchedAt.value[key] = Date.now()
      delete foreignKeysFailedAt.value[key]
      return list
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      foreignKeysFailedAt.value[key] = Date.now()
      foreignKeys.value[key] = []
      return []
    }
    finally {
      foreignKeysLoading.value[key] = false
    }
  }

  // ------------------------------------------------------------ 缓存管理

  /** 丢掉某个连接的全部元数据缓存（库 + 该连接下所有库的表 / 字段 / 外键） */
  function invalidateConnection(connId: number) {
    delete databaseInfos.value[connId]
    delete databasesFetchedAt.value[connId]
    delete databasesFailedAt.value[connId]

    const schemaPrefix = `${connId}::`
    for (const key of Object.keys(tables.value)) {
      if (key.startsWith(schemaPrefix)) {
        delete tables.value[key]
        delete tablesFetchedAt.value[key]
        delete tablesFailedAt.value[key]
      }
    }
    for (const key of Object.keys(columns.value)) {
      if (key.startsWith(schemaPrefix)) {
        delete columns.value[key]
        delete columnsFetchedAt.value[key]
        delete columnsFailedAt.value[key]
      }
    }
    for (const key of Object.keys(foreignKeys.value)) {
      if (key.startsWith(schemaPrefix)) {
        delete foreignKeys.value[key]
        delete foreignKeysFetchedAt.value[key]
        delete foreignKeysFailedAt.value[key]
      }
    }
  }

  /** 丢掉某个库下的表 / 字段 / 外键缓存（库列表保留） */
  function invalidateSchema(connId: number, database: string) {
    const prefix = `${schemaKey(connId, database)}::`
    delete tables.value[schemaKey(connId, database)]
    delete tablesFetchedAt.value[schemaKey(connId, database)]
    delete tablesFailedAt.value[schemaKey(connId, database)]
    for (const key of Object.keys(columns.value)) {
      if (key.startsWith(prefix)) {
        delete columns.value[key]
        delete columnsFetchedAt.value[key]
        delete columnsFailedAt.value[key]
      }
    }
    for (const key of Object.keys(foreignKeys.value)) {
      if (key.startsWith(prefix)) {
        delete foreignKeys.value[key]
        delete foreignKeysFetchedAt.value[key]
        delete foreignKeysFailedAt.value[key]
      }
    }
  }

  /** 刷新某个连接：清空该连接缓存后重拉库列表与指定库的表列表 */
  async function refreshConnection(connId: number, database = ''): Promise<void> {
    if (!connId) {
      return
    }
    invalidateConnection(connId)
    lastError.value = ''

    await loadDatabases(connId, true)
    if (database) {
      await loadTables(connId, database, true)
    }
  }

  /** 清空全部缓存 */
  function clear() {
    databaseInfos.value = {}
    databasesFetchedAt.value = {}
    databasesFailedAt.value = {}
    tables.value = {}
    tablesFetchedAt.value = {}
    tablesFailedAt.value = {}
    columns.value = {}
    columnsFetchedAt.value = {}
    columnsFailedAt.value = {}
    foreignKeys.value = {}
    foreignKeysFetchedAt.value = {}
    foreignKeysFailedAt.value = {}
    lastError.value = ''
  }

  return {
    databases,
    databaseInfos,
    tables,
    columns,
    foreignKeys,
    lastError,
    ensureDatabases,
    ensureDatabaseInfos,
    ensureTables,
    ensureColumns,
    ensureForeignKeys,
    loadDatabases,
    loadTables,
    loadColumns,
    loadForeignKeys,
    isDatabasesLoading,
    isTablesLoading,
    isColumnsLoading,
    invalidateConnection,
    invalidateSchema,
    refreshConnection,
    clear,
  }
})

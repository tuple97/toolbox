/**
 * 数据库元数据（库 / 表 / 字段）的全局缓存。
 *
 * 为什么用 pinia 而不是模块级 Map：
 *  - 连接管理页需要「查看 / 刷新」元数据，SQL 执行页的补全也要用同一份数据，
 *    刷新后两处必须立刻一致，不能各存一份；
 *  - 加载状态与缓存时间可观测，界面可以直接绑定（弹窗显示 loading、空态等）。
 *
 * 语义约定（与智能补全的用法一致）：
 *  - 缓存 TTL 为 `META_TTL`；
 *  - `ensureXxx()` **同步**返回当前缓存（可能为空），需要时在后台发起拉取，
 *    绝不阻塞调用方——补全候选必须立刻返回，不能等网络；
 *  - `loadXxx()` 返回 Promise，供需要等待结果的界面（元数据弹窗）使用；
 *  - 刷新 = 丢掉该连接的缓存后重新拉取。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchDatabases, fetchForeignKeys, fetchTableColumns, fetchTables } from '@/api/executor'
import type { DatabaseInfo, ExecutorColumn, TableForeignKey } from '@/types'

/** 元数据缓存有效期 */
export const META_TTL = 5 * 60 * 1000

export const useMetadataStore = defineStore('metadata', () => {
  /**
   * 连接 ID → 库列表（含「是否系统库」标记，由后端按方言给出）。
   *
   * 只存这一份：库名视图由它派生（`databases`），不另存一份名字清单 ——
   * 两份数据迟早会不一致。
   */
  const databaseInfos = ref<Record<number, DatabaseInfo[]>>({})
  const databasesFetchedAt = ref<Record<number, number>>({})
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
  const tablesLoading = ref<Record<string, boolean>>({})

  /** `${connId}::${database}::${table}` → 字段列表 */
  const columns = ref<Record<string, ExecutorColumn[]>>({})
  const columnsFetchedAt = ref<Record<string, number>>({})
  const columnsLoading = ref<Record<string, boolean>>({})

  /**
   * `${connId}::${database}::${table}` → 外键列表。
   *
   * 与字段同样是「按表单独记账」：共用一个时间戳会让先拉完的那份把另一份饿死
   * （见下面 ensureColumns 的说明）。
   */
  const foreignKeys = ref<Record<string, TableForeignKey[]>>({})
  const foreignKeysFetchedAt = ref<Record<string, number>>({})
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
    if (!isFresh(databasesFetchedAt.value[connId]) && !databasesLoading.value[connId]) {
      void loadDatabases(connId)
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
      return infos.map(info => info.name)
    }
    catch (e) {
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
    if (!isFresh(tablesFetchedAt.value[key]) && !tablesLoading.value[key]) {
      void loadTables(connId, database)
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
      return names
    }
    catch (e) {
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

  /**
   * 读取字段缓存并在需要时后台刷新；同步返回当前可见数据。
   *
   * 字段按表单独记账（键含表名），不能与表列表共用一个时间戳：
   * 否则「表列表刚拉完 → 字段查询看到缓存是新的 → 直接返回空列表且永不发起请求」。
   */
  function ensureColumns(connId: number, database: string, table: string): ExecutorColumn[] {
    if (!connId || !table) {
      return []
    }
    const key = tableKey(connId, database, table)
    if (!isFresh(columnsFetchedAt.value[key]) && !columnsLoading.value[key]) {
      void loadColumns(connId, database, table)
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
      return list
    }
    catch (e) {
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
    if (!isFresh(foreignKeysFetchedAt.value[key]) && !foreignKeysLoading.value[key]) {
      void loadForeignKeys(connId, database, table)
    }
    return foreignKeys.value[key] ?? []
  }

  /**
   * 拉取某张表的外键；force 为真时忽略缓存。
   *
   * **失败不抛出**：外键只用于把关联条件补全得更准，没有它还有命名启发式兜底，
   * 不能因为无 information_schema 权限、方言差异之类的原因把补全链路打断 ——
   * 失败按「这张表没有外键」缓存下来，并记进 lastError 供界面提示。
   */
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
      return list
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      foreignKeys.value[key] = []
      return []
    }
    finally {
      foreignKeysFetchedAt.value[key] = Date.now()
      foreignKeysLoading.value[key] = false
    }
  }

  // ------------------------------------------------------------ 缓存管理

  /** 丢掉某个连接的全部元数据缓存（库 + 该连接下所有库的表 / 字段 / 外键） */
  function invalidateConnection(connId: number) {
    delete databaseInfos.value[connId]
    delete databasesFetchedAt.value[connId]

    const schemaPrefix = `${connId}::`
    for (const key of Object.keys(tables.value)) {
      if (key.startsWith(schemaPrefix)) {
        delete tables.value[key]
        delete tablesFetchedAt.value[key]
      }
    }
    for (const key of Object.keys(columns.value)) {
      if (key.startsWith(schemaPrefix)) {
        delete columns.value[key]
        delete columnsFetchedAt.value[key]
      }
    }
    for (const key of Object.keys(foreignKeys.value)) {
      if (key.startsWith(schemaPrefix)) {
        delete foreignKeys.value[key]
        delete foreignKeysFetchedAt.value[key]
      }
    }
  }

  /** 丢掉某个库下的表 / 字段 / 外键缓存（库列表保留） */
  function invalidateSchema(connId: number, database: string) {
    const prefix = `${schemaKey(connId, database)}::`
    delete tables.value[schemaKey(connId, database)]
    delete tablesFetchedAt.value[schemaKey(connId, database)]
    for (const key of Object.keys(columns.value)) {
      if (key.startsWith(prefix)) {
        delete columns.value[key]
        delete columnsFetchedAt.value[key]
      }
    }
    for (const key of Object.keys(foreignKeys.value)) {
      if (key.startsWith(prefix)) {
        delete foreignKeys.value[key]
        delete foreignKeysFetchedAt.value[key]
      }
    }
  }

  /**
   * 刷新某个连接的元数据：清空该连接缓存后重新拉取库列表与指定库的表列表。
   *
   * 字段列表不在这里预取——表可能很多，全量拉字段代价过高，
   * 等用户点开某张表（或补全用到）时再按需加载。
   */
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
    tables.value = {}
    tablesFetchedAt.value = {}
    columns.value = {}
    columnsFetchedAt.value = {}
    foreignKeys.value = {}
    foreignKeysFetchedAt.value = {}
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

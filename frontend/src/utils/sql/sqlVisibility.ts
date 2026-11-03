/** 数据库可见性策略（Database Visibility Policy） */
import type { SqlDialect } from './rowSql'

/** 各方言自带的系统库 / 系统 schema（小写） */
export const SYSTEM_DATABASES: Record<SqlDialect, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgres: ['pg_catalog', 'information_schema', 'pg_toast'],
}

/** PostgreSQL 的临时 schema（`pg_temp_3`）与 toast 分片（`pg_toast_12345`）同样是系统对象 */
const PG_TEMP_RE = /^pg_temp_?\d*$/
const PG_TOAST_RE = /^pg_toast_\d+$/

/** 该库是不是系统库（按方言判断，按名字精确比对） */
export function isSystemDatabase(name: string, dialect: SqlDialect): boolean {
  const lower = name.trim().toLowerCase()
  if (!lower) {
    return false
  }
  if ((SYSTEM_DATABASES[dialect] ?? []).includes(lower)) {
    return true
  }
  if (dialect !== 'postgres') {
    return false
  }
  return PG_TEMP_RE.test(lower) || PG_TOAST_RE.test(lower)
}

/** 在当前设置下，该库是否应该出现在下拉框 / 候选里 */
export function isDatabaseVisible(
  name: string,
  dialect: SqlDialect,
  showSystemDatabases: boolean,
): boolean {
  return showSystemDatabases || !isSystemDatabase(name, dialect)
}

/** 库项（结构化类型）：名字 + 可选的「系统库」标记 */
export interface DatabaseVisibilityItem {
  name: string
  isSystem?: boolean
}

/** 该项是不是系统库：**后端标记优先**，没有标记才按方言表判断 */
export function isSystemDatabaseItem(item: DatabaseVisibilityItem, dialect: SqlDialect): boolean {
  return item.isSystem ?? isSystemDatabase(item.name, dialect)
}

/** 过滤一组库项（下拉框与补全候选共用，返回原对象） */
export function filterDatabaseInfos<T extends DatabaseVisibilityItem>(
  list: readonly T[],
  dialect: SqlDialect,
  showSystemDatabases: boolean,
): T[] {
  if (showSystemDatabases) {
    return [...list]
  }
  return list.filter(item => !isSystemDatabaseItem(item, dialect))
}

/** 过滤一组库名（只拿得到名字的场景） */
export function filterDatabases(
  names: readonly string[],
  dialect: SqlDialect,
  showSystemDatabases: boolean,
): string[] {
  return filterDatabaseInfos(
    names.map(name => ({ name })),
    dialect,
    showSystemDatabases,
  ).map(item => item.name)
}

/** 解析设置项 `sql_show_system_databases` */
export function parseShowSystemDatabases(raw: string | undefined): boolean {
  return raw !== 'false'
}

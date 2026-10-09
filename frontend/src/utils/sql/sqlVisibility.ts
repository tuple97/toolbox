/**
 * 数据库可见性策略（Database Visibility Policy）。
 *
 * 「隐藏系统库」是一条**展示策略**，不是解析规则：
 *  - 关掉之后，库下拉框与补全候选不再主动列出系统库；
 *  - 但显式手写 `mysql.user` / `information_schema.tables` 仍然照常解析 ——
 *    resolver 根本不认识这个设置（隐藏 ≠ 非法）。
 *
 * 两件事必须在**同一处**判定，否则迟早出现「补全里没有、下拉里有」这种
 * 自相矛盾的状态：库下拉框、库名候选、schema 候选全部走这里的函数。
 *
 * 「什么算系统库」由方言决定（相当于各自 adapter 的职责），
 * **不靠 `name.startsWith('sys')` 猜** —— 那会把用户的 `sys_logs` 也一起藏掉。
 */
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

/**
 * 库项（结构化类型）：名字 + 可选的「系统库」标记。
 *
 * 标记来自后端（`ListDatabases` 的 `isSystem`，由适配层按方言判定）；
 * 缺失时退回按名字 + 方言表判断，于是只给名字的场景（老绑定、单测）照样能用。
 * 用结构化类型而不是 import `@/types`，是为了让本模块保持零依赖 ——
 * 策略只认「名字 + 可选标记」这两件事。
 */
export interface DatabaseVisibilityItem {
  name: string
  isSystem?: boolean
}

/** 该项是不是系统库：**后端标记优先**，没有标记才按方言表判断 */
export function isSystemDatabaseItem(item: DatabaseVisibilityItem, dialect: SqlDialect): boolean {
  return item.isSystem ?? isSystemDatabase(item.name, dialect)
}

/**
 * 过滤一组库项（下拉框与补全候选共用，返回原对象）。
 *
 * 顺序保持原样：库列表的顺序来自数据库自己（`ORDER BY schema_name`），
 * 这里只做「去掉不可见的」，不重排 —— 用户对列表位置的记忆不该被设置项打乱。
 */
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

/**
 * 解析设置项 `sql_show_system_databases`。
 *
 * 默认**显示**（与改造前的行为一致，用户已有的习惯不变）；
 * 只有明确写成 `false` 才隐藏，其余（缺失 / 脏值）都按显示处理。
 */
export function parseShowSystemDatabases(raw: string | undefined): boolean {
  return raw !== 'false'
}

/**
 * 比较位置的值候选（类型感知）。
 *
 * 场景：`WHERE created_at = |`、`WHERE status = |`、`WHERE enabled = |`。
 * 这里回答「这个位置该写什么值」：
 *
 *  1. **值域候选**：词典里这份数据真实出现过的值（`status` → `active/disabled/pending`），
 *     永远排在前面 —— 它们最可能正是用户想写的；
 *  2. **类型模板**：列的**类型**决定还有哪些写法一定有 ——
 *     时间列给当前时间 / 今天的零点字面量，布尔列按方言给 `1/0` 或 `TRUE/FALSE`。
 *
 * 拿不到类型（列不属于已知表）时只给值域候选，不猜类型。
 */
import type { Completion } from '@codemirror/autocomplete'
import type { SqlDialect } from './rowSql'
import { BOOST_SMART_ITEM } from './sqlCompletionKeywords'
import { smartValueItems } from './sqlSmartItems'
import type { SmartCompareValue } from './sqlSmartItems'
import { typeFamilyOf } from './sqlTypeCompat'

/** 生成值候选所需的上下文 */
export interface TypedValueArgs {
  /** 比较运算符左侧的列名（用于提示文案） */
  column: string
  /** 列的类型（元数据缺失时为空） */
  dataType?: string
  dialect: SqlDialect
  /** 值域数据（通常来自同名词典） */
  values?: SmartCompareValue[]
}

/** 比较位置的值候选 */
export function typedValueItems(args: TypedValueArgs): Completion[] {
  const items: Completion[] = []

  // ① 值域候选：有就给，且排在最前
  if (args.values?.length) {
    items.push(...smartValueItems(args.values, args.dataType, args.dialect))
  }

  // ② 类型模板
  items.push(...typeTemplateItems(args))
  return items
}

/** 按类型大类给「一定有意义的写法」 */
function typeTemplateItems(args: TypedValueArgs): Completion[] {
  // 布尔先判：各库的布尔列写法五花八门（bool / bit(1) / tinyint(1)），
  // 归到大类里会落到 number，那样就漏掉了真假候选。
  if (isBooleanLike(args.dataType)) {
    return args.dialect === 'postgres'
      ? [
          templateItem('TRUE', 'TRUE', '真', args, '布尔列按方言写成 TRUE / FALSE'),
          templateItem('FALSE', 'FALSE', '假', args, '布尔列按方言写成 TRUE / FALSE'),
        ]
      : [
          templateItem('1', '1', '真', args, '布尔列在 MySQL 里就是 1 / 0'),
          templateItem('0', '0', '假', args, '布尔列在 MySQL 里就是 1 / 0'),
        ]
  }

  switch (typeFamilyOf(args.dataType)) {
    case 'time': {
      const today = todayStart()
      return [
        templateItem('CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP', '当前时间', args, '取数据库当前时间，各数据库都支持'),
        templateItem(today, `'${today}'`, '今天 00:00:00', args, '今天零点，常用来筛「今天的数据」'),
        templateItem('CURRENT_DATE', 'CURRENT_DATE', '今天（日期）', args, '只取日期部分，按天比较时更直观'),
      ]
    }
    default:
      return []
  }
}

/**
 * 是否是布尔列。
 *
 * `tinyint(1)` 是 MySQL 里布尔的惯例写法，`bit(1)` 同理，
 * 这两者都要按布尔给候选（而不是当成普通数字）。
 */
function isBooleanLike(dataType: string | undefined): boolean {
  const raw = (dataType ?? '').toLowerCase().replace(/\s+/g, '')
  return raw === 'bool' || raw === 'boolean'
    || raw === 'bit' || raw === 'bit(1)'
    || raw === 'tinyint(1)'
}

/**
 * 类型模板候选项。
 *
 * `detail` 带上列名与真实类型（`device.status · tinyint`），
 * 这样列表里能一眼看出这个候选是为哪一列、哪个类型准备的。
 */
function templateItem(
  label: string,
  insert: string,
  meaning: string,
  args: TypedValueArgs,
  info: string,
): Completion {
  return {
    label,
    type: 'text',
    detail: `${args.column} · ${args.dataType || typeNameOfLabel(args)} · ${meaning}`,
    info,
    boost: BOOST_SMART_ITEM,
    apply: insert,
  }
}

/** detail 里类型缺失时的兜底文案 */
function typeNameOfLabel(args: TypedValueArgs): string {
  const family = typeFamilyOf(args.dataType)
  return family === 'unknown' ? '值' : family
}

/**
 * 今天的零点字面量（本地时区）。
 *
 * 刻意只精确到「天」：补全候选不该带着秒级时间到处跑，
 * 用户写日期筛选时「今天 00:00:00」正是最常见的起点。
 */
function todayStart(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 00:00:00`
}

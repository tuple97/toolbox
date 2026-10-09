/**
 * 关联条件补全（`JOIN … ON |` 位置）。
 *
 * 候选是整条条件表达式，而不是单个列名：在 ON 后面最想写的就是
 * 「左右两张表按哪个字段连起来」，逐个挑列名再自己拼 `=` 属于重复劳动。
 *
 * 三种来源，优先级从高到低：
 *  1. **外键约束**：数据库里真实存在的引用关系（需要元数据提供者给出，拿不到就跳过）；
 *  2. **命名启发式**：`{单数表名}_id` → `{对方表}.id`，两个方向都试；
 *  3. 类型兼容过滤：两侧列类型明显不兼容（如 int 与 text）的直接不给。
 *
 * 全部是纯函数：表格引用与列都从参数传入，用例可注入静态数据。
 */
import type { Completion } from '@codemirror/autocomplete'
import { typesCompatible } from './sqlTypeCompat'

/** 外键信息：某表的一列引用另一张表的一列 */
export interface ForeignKeyInfo {
  /** 本表列名 */
  column: string
  /** 被引用的表 */
  referencedTable: string
  /** 被引用的列名（通常为 id） */
  referencedColumn: string
}

/** 参与条件生成的一张表（已解析出别名与列） */
export interface JoinSide {
  /** 表名（不含库名） */
  table: string
  /** 别名 / 限定符：候选文本里用它（没有别名时用表名） */
  alias: string
  /** 列（名称 + 类型） */
  columns: Array<{ name: string, dataType?: string }>
  /** 该表的外键（可为空） */
  foreignKeys?: ForeignKeyInfo[]
}

/** 生成条件候选项所需的输入 */
export interface JoinConditionInput {
  /** 新加入的表（ON 左侧通常写它） */
  left: JoinSide
  /** 已经在这条语句里的其它表（逐个与 left 配对） */
  others: JoinSide[]
}

/**
 * 表名单数化（`orders` → `order`、`companies` → `company`）。
 *
 * 只处理关联条件里最常见的几种后缀；不认识的词原样返回，
 * 宁可不生成候选，也不要猜出错误的条件。
 */
export function singularTableName(table: string): string {
  const lower = table.toLowerCase()
  const irregular: Record<string, string> = {
    children: 'child',
    people: 'person',
    men: 'man',
    women: 'woman',
    status: 'status',
    news: 'news',
    series: 'series',
  }
  if (irregular[lower]) {
    return irregular[lower]
  }
  if (lower.endsWith('ies') && lower.length > 3) {
    return `${table.slice(0, -3)}y`
  }
  if (lower.endsWith('ves') && lower.length > 3) {
    return `${table.slice(0, -3)}f`
  }
  if (/(ses|xes|zes|ches|shes)$/.test(lower)) {
    return table.slice(0, -2)
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 1) {
    return table.slice(0, -1)
  }
  return table
}

/** 限定符：有别名用别名，否则用表名 */
function qualifierOf(side: JoinSide): string {
  return side.alias || side.table
}

/**
 * 为一对表生成关联条件候选。
 *
 * 生成的顺序是「外键优先、命名启发式其次」，同一来源内保持列顺序稳定。
 */
export function joinConditionsForPair(left: JoinSide, other: JoinSide): Completion[] {
  const items: Completion[] = []
  const seen = new Set<string>()

  const push = (text: string, detail: string) => {
    if (seen.has(text)) {
      return
    }
    seen.add(text)
    items.push({ label: text, type: 'text', detail, apply: text })
  }

  /*
   * 列名一律小写做键：元数据可能返回 `USER_ID` 而外键信息写的是 `user_id`，
   * 直接按原样查会静默匹配不到（不同数据库的大小写习惯差异很大）。
   */
  const columnsOf = (side: JoinSide) =>
    new Map(side.columns.map(column => [column.name.toLowerCase(), column]))
  const leftColumns = columnsOf(left)
  const otherColumns = columnsOf(other)

  // 1. 外键：两个方向都看（外键可能定义在任意一侧）
  for (const fk of left.foreignKeys ?? []) {
    if (fk.referencedTable.toLowerCase() !== other.table.toLowerCase()) {
      continue
    }
    const local = leftColumns.get(fk.column.toLowerCase())
    const remote = otherColumns.get(fk.referencedColumn.toLowerCase())
    if (!local || !remote || !typesCompatible(local.dataType, remote.dataType)) {
      continue
    }
    push(`${qualifierOf(left)}.${local.name} = ${qualifierOf(other)}.${remote.name}`, '关联条件 · 外键')
  }
  for (const fk of other.foreignKeys ?? []) {
    if (fk.referencedTable.toLowerCase() !== left.table.toLowerCase()) {
      continue
    }
    const local = otherColumns.get(fk.column.toLowerCase())
    const remote = leftColumns.get(fk.referencedColumn.toLowerCase())
    if (!local || !remote || !typesCompatible(local.dataType, remote.dataType)) {
      continue
    }
    push(`${qualifierOf(other)}.${local.name} = ${qualifierOf(left)}.${remote.name}`, '关联条件 · 外键')
  }

  // 2. 命名启发式：`{对方表单数}_id = 对方.id`
  const leftKey = leftColumns.get(`${singularTableName(other.table)}_id`.toLowerCase())
  const leftId = otherColumns.get('id')
  if (leftKey && leftId && typesCompatible(leftKey.dataType, leftId.dataType)) {
    push(`${qualifierOf(left)}.${leftKey.name} = ${qualifierOf(other)}.${leftId.name}`, '关联条件')
  }

  const otherKey = otherColumns.get(`${singularTableName(left.table)}_id`.toLowerCase())
  const otherId = leftColumns.get('id')
  if (otherKey && otherId && typesCompatible(otherKey.dataType, otherId.dataType)) {
    push(`${qualifierOf(other)}.${otherKey.name} = ${qualifierOf(left)}.${otherId.name}`, '关联条件')
  }

  return items
}

/** 与输入里所有其它表逐个配对，合并去重后的条件候选 */
export function joinConditionItems(input: JoinConditionInput): Completion[] {
  const items: Completion[] = []
  const seen = new Set<string>()
  for (const other of input.others) {
    if (other.table.toLowerCase() === input.left.table.toLowerCase() && other.alias === input.left.alias) {
      continue
    }
    for (const item of joinConditionsForPair(input.left, other)) {
      if (!seen.has(item.label)) {
        seen.add(item.label)
        items.push(item)
      }
    }
  }
  return items
}

/**
 * SQL 列类型兼容判定（纯数据 + 纯函数）。
 *
 * 用途：生成关联条件（`ON a.x = b.y`）时先过滤掉显然不兼容的列对
 * （`int = varchar` 这种条件即使写出来也没意义，还容易误导）。
 *
 * 只做「大类」判定，不区分长度 / 精度 / 有无符号：
 *   - 关联条件本来就要人工确认，这里只负责挡掉明显错的；
 *   - 各数据库的类型名五花八门（`bigint(20) unsigned`、`character varying(64)`、
 *     `timestamp without time zone`…），归一到大类比穷举类型名稳。
 */

/** 类型大类 */
export type SqlTypeFamily = 'number' | 'string' | 'time' | 'boolean' | 'json' | 'binary' | 'unknown'

/** 类型名关键字 → 大类（按顺序匹配，先命中先算） */
const FAMILY_RULES: Array<{ family: SqlTypeFamily, patterns: string[] }> = [
  {
    family: 'number',
    patterns: [
      'int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint',
      'decimal', 'numeric', 'float', 'double', 'real', 'serial', 'money',
    ],
  },
  {
    family: 'boolean',
    patterns: ['bool', 'boolean', 'bit'],
  },
  {
    family: 'time',
    patterns: ['date', 'time', 'timestamp', 'datetime', 'year', 'interval'],
  },
  {
    family: 'json',
    patterns: ['json', 'jsonb', 'array'],
  },
  {
    family: 'binary',
    patterns: ['blob', 'binary', 'varbinary', 'bytea', 'raw'],
  },
  {
    family: 'string',
    patterns: [
      'char', 'varchar', 'character', 'text', 'clob', 'string', 'enum', 'set',
      'uuid', 'citext', 'name',
    ],
  },
]

/** 把数据库返回的类型名归一到大类 */
export function typeFamilyOf(dataType: string | undefined): SqlTypeFamily {
  const raw = (dataType ?? '').toLowerCase().trim()
  if (!raw) {
    return 'unknown'
  }
  for (const rule of FAMILY_RULES) {
    if (rule.patterns.some(pattern => raw.includes(pattern))) {
      return rule.family
    }
  }
  return 'unknown'
}

/**
 * 两个类型是否兼容（可以作为关联条件的两端）。
 *
 * 规则：同大类兼容；任一方类型未知时**放行**（元数据缺失不该让条件消失，
 * 由用户自己判断）；数字与布尔互相兼容（很多库里就是 0/1）。
 */
export function typesCompatible(left: string | undefined, right: string | undefined): boolean {
  const a = typeFamilyOf(left)
  const b = typeFamilyOf(right)
  if (a === 'unknown' || b === 'unknown') {
    return true
  }
  if (a === b) {
    return true
  }
  const numeric = (family: SqlTypeFamily) => family === 'number' || family === 'boolean'
  return numeric(a) && numeric(b)
}

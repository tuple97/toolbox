/** SQL 列类型兼容判定（纯数据 + 纯函数） */

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

/** 两个类型是否兼容（可以作为关联条件的两端） */
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

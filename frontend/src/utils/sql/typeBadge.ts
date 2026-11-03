/** 列类型的**颜色语义**（结果表头上那个类型小药丸用） */
import { typeFamilyOf } from './sqlTypeCompat'
import type { SqlTypeFamily } from './sqlTypeCompat'

/** 语义色（对应应用的四套主题变量，见 global.css） */
export type TypeColorToken = 'brand' | 'success' | 'warning' | 'danger' | 'muted'

/** 大类 → 语义色 */
const FAMILY_COLORS: Record<SqlTypeFamily, TypeColorToken> = {
  number: 'brand',
  string: 'success',
  time: 'warning',
  boolean: 'danger',
  json: 'muted',
  binary: 'muted',
  unknown: 'muted',
}

/** 类型名 → 语义色 token（空 / 未知类型给中性色） */
export function typeColorTokenOf(dataType: string | undefined): TypeColorToken {
  return FAMILY_COLORS[typeFamilyOf(dataType)]
}

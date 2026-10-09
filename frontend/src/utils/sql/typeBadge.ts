/**
 * 列类型的**颜色语义**（结果表头上那个类型小药丸用）。
 *
 * 只回答「该用哪个语义色」，不回答「具体哪个 CSS 类」—— 视觉映射留在组件里，
 * 于是换配色不用动这里，这里的规则也能离线测。
 *
 * 大类判定复用 `sqlTypeCompat.typeFamilyOf`：数据库的类型名五花八门
 * （`bigint(20) unsigned`、`character varying(64)`、`timestamp without time zone`…），
 * 按大类上色才不会「见一个新类型就加一条规则」。新增方言类型自动落到对应大类。
 */
import { typeFamilyOf } from './sqlTypeCompat'
import type { SqlTypeFamily } from './sqlTypeCompat'

/** 语义色（对应应用的四套主题变量，见 global.css） */
export type TypeColorToken = 'brand' | 'success' | 'warning' | 'danger' | 'muted'

/**
 * 大类 → 语义色。
 *
 * 前三类（数值 / 文本 / 时间）是日常最需要一眼分清的，各占一色；
 * 布尔单独给一色（`0/1`、`TRUE/FALSE` 最容易看错）；
 * 其余（JSON / 二进制 / 判不出来）用中性灰 —— 给它们也上色只会让整行花掉，
 * 而这类列本来就少。
 */
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

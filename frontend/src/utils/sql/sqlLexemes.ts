/** SQL 标识符词法：**全项目唯一**的一份定义 */

/** 标识符首字符（正则对象，逐个字符判断用） */
export const IDENT_START_RE = /[A-Za-z_$\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** 标识符后续字符（字母 / 数字 / 下划线 / `$` / CJK） */
export const IDENT_BODY_RE = /[\w$\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** 标识符首字符的**正则源码片段**（拼正则用，与 IDENT_START_RE 必须同步） */
export const IDENT_START_SOURCE = '[A-Za-z_$\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]'

/** 标识符后续字符的正则源码片段 */
export const IDENT_BODY_SOURCE = '[\\w$\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]*'

/** 一个裸标识符的正则源码片段 */
export const IDENT_SOURCE = `${IDENT_START_SOURCE}${IDENT_BODY_SOURCE}`

/** 带引号的标识符：`` `x` `` / `"x"` / `[x]` */
export const QUOTED_IDENT_SOURCE = '`[^`]*`|"[^"]*"|\\[[^\\]]*\\]'

/** 一个标识符：裸写或带引号 */
export const IDENT_OR_QUOTED_SOURCE = `${QUOTED_IDENT_SOURCE}|${IDENT_SOURCE}`

/** 该字符能否作为标识符首字符 */
export function isIdentStart(char: string): boolean {
  return IDENT_START_RE.test(char)
}

/** 该字符能否出现在标识符中（首字符之后） */
export function isIdentBody(char: string): boolean {
  return IDENT_BODY_RE.test(char)
}

/** 是否是可以裸写的标识符（跑一遍词法，不做任何宽容） */
export function isPlainIdent(name: string): boolean {
  if (!name || !isIdentStart(name[0] ?? '')) {
    return false
  }
  for (const char of name.slice(1)) {
    if (!isIdentBody(char)) {
      return false
    }
  }
  return true
}

/** 「ASCII 裸标识符」——**生成 SQL 时**判断要不要加引号用的 */
export const ASCII_IDENT_RE = /^[A-Za-z_][\w$]*$/

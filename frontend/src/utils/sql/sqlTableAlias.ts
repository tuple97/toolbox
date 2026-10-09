/**
 * 表名 → 自动别名（设置项 `sql_completion_alias` 开启时，补全表名顺手带上别名）。
 *
 * 取名规则（贴着手写习惯，且保证结果是合法标识符）：
 *  - 去掉常见表前缀 `t_` / `tb_` / `tbl_`：`t_user` 的别名按 `user` 派生，而不是 `tu`；
 *  - 多词（下划线 / 驼峰 / 空白分隔）取各词首字母，最多 3 个：
 *    `order_items` → `oi`、`sys_device_info` → `sdi`；
 *  - 单个 ASCII 词取首字母：`users` → `u`（与设置面板里的说明一致，也是手写 SQL 的习惯）；
 *  - 单个中文词取拼音首字母的前两位：`设备表` → `sb`
 *    （一个字母对中文表名几乎没区分度）；
 *  - 撞上保留字时补 `_t` 后缀，保证生成的别名不需要引用符。
 *
 * 注意：这里只看单张表名，不掌握同一语句里的其它表 —— 别名冲突留给使用者判断
 * （宁可给出直觉上对的短别名，也不要为了猜冲突退化成看不懂的长名字）。
 */
import { hasCjk, pinyinInitialsOf, wordInitialsOf } from './sqlCompletionRank'
import { RESERVED_WORDS } from './sqlCompletionKeywords'

/** 常见表名前缀：去掉后别名更贴近直觉 */
const TABLE_PREFIX_RE = /^(?:tbl|tb|t)_/i

/** 单个 ASCII 词取几个字母 */
const SINGLE_WORD_LETTERS = 1

/** 单个中文词取几个拼音首字母（一个字母几乎没区分度） */
const SINGLE_CJK_WORD_LETTERS = 2

/** 多词表名最多取几个首字母 */
const MAX_ALIAS_LENGTH = 3

/** 按下划线 / 驼峰 / 空白拆词（与补全排序里的词首字母口径一致） */
function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u3400-\u9FFF]+/)
    .filter(Boolean)
}

/** 单个词的前几个字母：中文走拼音首字母，ASCII 取前几个字符 */
function lettersOf(word: string, count: number): string {
  const source = hasCjk(word) ? pinyinInitialsOf(word) : word.replace(/[^A-Za-z0-9]/g, '')
  return source.slice(0, count)
}

/** 多词取首字母（中文词取其拼音首字母的第一位） */
function initialsOf(words: string[]): string {
  return words
    .map((word) => {
      if (hasCjk(word)) {
        // 中文词：先按词首字母（`设备` → sb），再取第一位
        const initials = pinyinInitialsOf(word) || wordInitialsOf(word)
        return initials[0] ?? ''
      }
      return word[0] ?? ''
    })
    .join('')
    .toLowerCase()
    .slice(0, MAX_ALIAS_LENGTH)
}

/** 兜底收拾：保证是合法且不需要引用符的标识符 */
function sanitize(alias: string): string {
  const lower = alias.toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (!lower) {
    return ''
  }
  // 数字开头不是合法标识符：加个 t 前缀
  const named = /^[a-z_]/.test(lower) ? lower : `t${lower}`
  return RESERVED_WORDS.has(named) ? `${named}_t` : named
}

/**
 * 由表名推导自动别名；推导不出（表名为空）时返回空串，调用方按「不给别名」处理。
 */
export function aliasForTable(table: string): string {
  const trimmed = table.trim()
  if (!trimmed) {
    return ''
  }
  // 前缀只在整个名字不止一段时去掉（表名就叫 t 的话保持原样）
  const stripped = trimmed.replace(TABLE_PREFIX_RE, '')
  const body = stripped || trimmed

  const words = splitWords(body)
  if (!words.length) {
    return ''
  }

  const single = words.length === 1
  const alias = single
    ? lettersOf(words[0], hasCjk(words[0]) ? SINGLE_CJK_WORD_LETTERS : SINGLE_WORD_LETTERS)
    : initialsOf(words)
  return sanitize(alias)
}

/**
 * 表名 + 自动别名的插入文本。
 *
 * 显式写 `AS`：省略 AS 的写法虽然合法，但生成的 SQL 是给人读的 ——
 * `FROM users u` 这种一眼看过去分不清哪个是表名哪个是别名，`AS` 把意图写明白。
 *
 * 表名已按方言加引用符，别名是推导出来的纯标识符（保证不需要引用符）。
 */
export function aliasedTableText(quotedTable: string, alias: string): string {
  return alias ? `${quotedTable} AS ${alias}` : quotedTable
}

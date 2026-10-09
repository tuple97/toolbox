/**
 * SQL 语句切分与「光标落在哪条语句上」。
 *
 * 这里原来用语法树切分（Statement 节点 + 分号/空行规则），有三个绕不过去
 * 的问题：语法树会吞掉语句末尾的换行、对 `DELIMITER $$` 这类**客户端指令**没有概念、
 * 未写完的语句只剩错误节点；而「执行当前语句 / 画边框」恰恰最在意这三件事。
 * 所以改成显式的字符扫描器，并针对本项目的用法做了三处优化：
 *
 *  1. **括号深度增量维护**：判「行首关键字是否开启新语句」只看当前深度是否为 0，
 *     不再回头重扫语句前缀，避免逐行判定退化成 O(n²)；
 *  2. **切分结果按文本对象记忆**：CodeMirror 的 `Text` 不可变，光标移动时 `doc`
 *     引用不变，命中缓存就不必把整篇文档 `toString()` 再扫一遍（按方向键不再有开销）；
 *  3. **关键字表与续行规则只保留 MySQL / PostgreSQL**，其余方言细节直接砍掉。
 *
 * 术语：
 *  - `from` / `to`：语句**自身文本**的范围，两端都不含空白，`to` **不含**结尾分号
 *    （边框要连分号一起框时用 `statementEndWithSemicolon()` 扩一位）；
 *  - `leadFrom`：前置可归属的空白起点，光标停在这段空白里（行首缩进等）也算这条语句。
 *
 * 语句分隔符两类：**分号**（可被 MySQL `DELIMITER` 改写）与
 * **行首关键字软分隔**——不写分号、直接换行写第二条也能识别，
 * 因此语句内部出现空行也不会被切碎。
 */
import type { Text } from '@codemirror/state'

/** 可以参与切分的文本：字符串，或 CodeMirror 的文档对象（用于复用缓存） */
export type SqlSource = string | Text

/** 一段 SQL 文本范围（两端不含空白） */
export interface SqlRange {
  from: number
  to: number
  sql: string
}

/** 一条语句：在 `SqlRange` 之外多带一个「前置空白起点」 */
export interface SqlStatement extends SqlRange {
  /** 光标停在这段前置空白里也算这条语句 */
  leadFrom: number
}

/** 词法状态：普通 / 单引号 / 双引号 / 反引号 / PostgreSQL dollar 引用 */
type ScanState = 'plain' | 'single' | 'double' | 'backtick' | 'dollar'

/** 行首可能开启新语句的关键字（两种方言通用） */
const COMMON_STARTERS = [
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'TRUNCATE',
  'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'COMMENT', 'EXPLAIN',
  'SHOW', 'DESCRIBE', 'DESC', 'USE', 'SET', 'CALL', 'EXEC', 'EXECUTE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'DECLARE', 'ANALYZE', 'VACUUM', 'PRAGMA',
  'REFRESH', 'COPY', 'PREPARE', 'DEALLOCATE', 'DISCARD', 'LOCK', 'UNLOCK',
  'SAVEPOINT', 'RELEASE',
]

/** 方言特有的行首关键字 */
const DIALECT_STARTERS: Record<'mysql' | 'postgres' | 'other', readonly string[]> = {
  mysql: ['HANDLER', 'LOAD', 'OPTIMIZE', 'REPAIR', 'FLUSH', 'RESET', 'KILL', 'RENAME', 'CHECKSUM', 'DO', 'SIGNAL'],
  postgres: ['LISTEN', 'NOTIFY', 'UNLISTEN', 'CLUSTER', 'REINDEX', 'CHECKPOINT', 'SECURITY', 'IMPORT'],
  other: [],
}

/** 既是函数名又是语句起始的关键字：紧跟 `(` 时不算新语句（`REPLACE(a,'x','y')`） */
const FUNCTION_LIKE_STARTERS = new Set(['REPLACE', 'TRUNCATE', 'INSERT', 'VALUES'])

/**
 * 语句「头部关键字」允许吞掉的正文关键字。
 * 例：`WITH c AS (...) SELECT ...` 里的 SELECT、`INSERT INTO t SELECT ...` 里的 SELECT
 * 都属于同一条语句，不该切分。
 */
const HEAD_CONTINUATIONS: Record<string, ReadonlySet<string>> = {
  WITH: new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']),
  INSERT: new Set(['SELECT', 'WITH', 'VALUES']),
  UPDATE: new Set(['SET']),
  CREATE: new Set(['SELECT', 'WITH', 'BEGIN', 'DECLARE', 'AS', 'CALL', 'RETURN']),
  ALTER: new Set(['ADD', 'ALTER', 'COMMENT', 'DROP', 'MODIFY', 'CHANGE', 'RENAME', 'SET', 'CONVERT', 'ORDER']),
  EXPLAIN: new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'ANALYZE', 'VERBOSE', 'FORMAT']),
  DESC: new Set(['SELECT', 'WITH']),
  DESCRIBE: new Set(['SELECT', 'WITH']),
}

/** 只有 `COMMENT ON ...` 是独立语句，`COMMENT '...'` 是 CREATE TABLE 的列选项 */
const COMMENT_TARGET_KEYWORD = 'ON'

/** 集合运算关键字：`UNION` 之后的 SELECT/WITH 属于同一条语句 */
const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS'])
const SET_OPERATOR_MODIFIERS = new Set(['ALL', 'DISTINCT'])

/** `EXPLAIN` / `DESC` 之后紧跟的目标语句属于同一条（只允许一个目标） */
const PREFIX_KEYWORDS = new Set(['EXPLAIN', 'DESC', 'DESCRIBE'])
const PREFIX_TARGETS = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])

/** 扫描方言：本项目只区分 MySQL / PostgreSQL 家族的词法差异 */
export type SqlScanDialect = 'mysql' | 'postgres' | 'other'

/**
 * 把数据库类型收敛成扫描方言。
 *
 * 补全层的空行边界检测也用它 —— 字符串 / 注释 / dollar quote 这些词法规则
 * 真实语句扫描器已经有一份，不能再各写一套。
 */
export function normalizeSqlScanDialect(dbType = ''): SqlScanDialect {
  const value = dbType.toLowerCase()
  if (value.includes('mysql') || value.includes('maria')) return 'mysql'
  if (value.includes('postgres') || value.includes('gauss')) return 'postgres'
  return 'other'
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

/** 读出从 `pos` 开始的一个词（大写），不是词首返回 null */
function wordAt(text: string, pos: number): string | null {
  const match = /^[A-Za-z_][\w$]*/.exec(text.slice(pos, pos + 32))
  return match ? match[0].toUpperCase() : null
}

/** 跳过空白后取下一个字符 */
function nextVisibleChar(text: string, pos: number): string | null {
  let i = pos
  while (i < text.length && isSpace(text[i])) i += 1
  return i < text.length ? text[i] : null
}

/** 去掉 `[from, to)` 末尾的空白 */
function trimEnd(text: string, from: number, to: number): number {
  let end = to
  while (end > from && isSpace(text[end - 1])) end -= 1
  return end
}

/** 当前位置是否处于行首（前面只有空格/制表符） */
function isLineStartAt(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '\n' || ch === '\r') return true
    if (ch !== ' ' && ch !== '\t') return false
  }
  return true
}

/** 位置 pos 所在行的行首偏移 */
function lineStartAt(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1
}

// --------------------------------------------------------------- 切分

/** 切分结果缓存：`Text` 是不可变对象，引用相同就说明文档没变 */
let lastSplit: { source: SqlSource; dialect: SqlScanDialect; statements: SqlStatement[] } | null = null

/**
 * 把整段脚本切成顶层语句。
 *
 * @param source 整段脚本（字符串或 CodeMirror 文档对象）
 * @param dbType 数据库类型，决定方言细节（反引号、`DELIMITER`、dollar 引用）
 */
export function splitSqlStatements(source: SqlSource, dbType?: string): SqlStatement[] {
  const dialect = normalizeSqlScanDialect(dbType)
  if (lastSplit && lastSplit.source === source && lastSplit.dialect === dialect) {
    return lastSplit.statements
  }

  const text = typeof source === 'string' ? source : source.toString()
  const statements = scanStatements(text, dialect)
  lastSplit = { source, dialect, statements }
  return statements
}

/** 逐字符扫描出的语句列表 */
function scanStatements(text: string, dialect: SqlScanDialect): SqlStatement[] {
  const isMysql = dialect === 'mysql'
  const isPostgres = dialect === 'postgres'
  const starters = new Set([...COMMON_STARTERS, ...DIALECT_STARTERS[dialect]])

  const statements: SqlStatement[] = []
  let state: ScanState = 'plain'
  let dollarTag = ''
  let delimiter: string | null = null
  let from = -1
  let to = -1
  let leadFrom = 0
  // 增量维护的三个扫描态：括号深度、是否行首、当前语句是否还没遇到正文
  let depth = 0
  let atLineStart = true
  let i = 0

  const mark = (pos: number) => {
    if (from === -1) from = pos
    to = pos + 1
  }

  const flush = (end = to) => {
    if (from !== -1) {
      const trimmed = trimEnd(text, from, end)
      if (trimmed > from) {
        statements.push({ leadFrom, from, to: trimmed, sql: text.slice(from, trimmed) })
      }
    }
    from = -1
    to = -1
  }

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1] ?? ''

    if (state === 'dollar') {
      const closing = `$${dollarTag}$`
      if (ch === '$' && text.startsWith(closing, i)) {
        for (let k = 0; k < closing.length; k += 1) mark(i + k)
        i += closing.length
        state = 'plain'
        // 引用体可以跨行，收尾后要按实际位置重算行首态
        atLineStart = isLineStartAt(text, i)
        continue
      }
      mark(i)
      i += 1
      continue
    }

    if (state === 'single' || state === 'double' || state === 'backtick') {
      mark(i)
      const open = state === 'single' ? '\'' : state === 'double' ? '"' : '`'
      // MySQL 家族里 `\` 是转义符；标准 SQL 中它只是普通字符，吞掉下一个字符会吃掉收尾引号
      if (ch === '\\' && next && isMysql) {
        mark(i + 1)
        i += 2
        continue
      }
      if (ch === open) {
        if (next === open) {
          // 连写两个引号是转义，不是收尾
          mark(i + 1)
          i += 2
          continue
        }
        state = 'plain'
        // 字符串/标识符里允许换行，收尾后同样要重算行首态
        atLineStart = isLineStartAt(text, i + 1)
      }
      i += 1
      continue
    }

    // ---- 以下都是普通状态 ----

    if (ch === '\n' || ch === '\r') {
      atLineStart = true
      i += 1
      continue
    }

    // MySQL 的 DELIMITER 指令：整行生效，之后改用自定义分隔符
    if (isMysql && atLineStart && /^delimiter[ \t]/i.test(text.slice(i, i + 10))) {
      const lineEnd = text.indexOf('\n', i)
      const line = text.slice(i, lineEnd === -1 ? text.length : lineEnd)
      const value = line.replace(/^delimiter[ \t]+/i, '').trim()
      flush()
      delimiter = value && value !== ';' ? value : null
      i = lineEnd === -1 ? text.length : lineEnd + 1
      leadFrom = i
      atLineStart = true
      continue
    }

    if ((ch === '-' && next === '-') || (isMysql && ch === '#')) {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
      atLineStart = true
      continue
    }

    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? text.length : close + 2
      // 块注释可以跨行，收尾后按实际位置重算行首态
      atLineStart = isLineStartAt(text, i)
      continue
    }

    if (ch === '\'' || ch === '"' || (ch === '`' && isMysql)) {
      mark(i)
      state = ch === '\'' ? 'single' : ch === '"' ? 'double' : 'backtick'
      i += 1
      atLineStart = false
      continue
    }

    if (isPostgres && ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i))
      if (tag) {
        for (let k = 0; k < tag[0].length; k += 1) mark(i + k)
        dollarTag = tag[0].slice(1, -1)
        i += tag[0].length
        state = 'dollar'
        atLineStart = false
        continue
      }
    }

    if (delimiter) {
      if (text.startsWith(delimiter, i)) {
        flush(i)
        i += delimiter.length
        leadFrom = i
        atLineStart = false
        continue
      }
    }
    else if (ch === ';') {
      flush()
      i += 1
      leadFrom = i
      atLineStart = false
      continue
    }

    // 行首关键字软分隔：不写分号也能识别下一条语句
    if (from !== -1 && atLineStart && ch !== ')' && opensNewStatement(text, i, from, depth, starters)) {
      flush(i)
      // 新语句从关键字开始，但行首缩进仍归属它（光标停在缩进上应执行这条）
      leadFrom = lineStartAt(text, i)
      mark(i)
      atLineStart = false
      i += 1
      continue
    }

    if (!isSpace(ch)) {
      mark(i)
      // 括号深度只统计普通状态下的括号，字符串/注释里的括号在上面的分支里已经跳过
      if (ch === '(') depth += 1
      else if (ch === ')' && depth > 0) depth -= 1
    }
    atLineStart = atLineStart && (ch === ' ' || ch === '\t')
    i += 1
  }

  flush()
  return statements
}

/**
 * `pos` 处的行首关键字是否开启一条新语句。
 *
 * @param depth 当前括号深度：子查询/函数参数里的关键字不算语句首
 */
function opensNewStatement(text: string, pos: number, statementFrom: number, depth: number, starters: Set<string>): boolean {
  const keyword = wordAt(text, pos)
  if (!keyword || !starters.has(keyword)) return false
  if (depth > 0) return false
  // 函数调用：`REPLACE(`、`TRUNCATE(` 不是语句起始
  if (FUNCTION_LIKE_STARTERS.has(keyword) && nextVisibleChar(text, pos + keyword.length) === '(') {
    return false
  }

  // 语句开头的原始关键字（判断 EXPLAIN/DESC 前缀），以及它解析出的正文关键字（判断续行）
  const head = wordAt(text, statementFrom)
  const bodyHead = headKeywordOf(text, statementFrom)
  const recent = lastTopKeywords(text, statementFrom, pos, 2)
  const previous = recent[recent.length - 1]

  /*
   * EXPLAIN / DESC 后面紧跟的目标语句属于同一条，但**只允许一个**：
   * 已经出现过目标关键字，说明这条 EXPLAIN 写完了，后面的 SELECT 就是新语句。
   */
  if (head && PREFIX_KEYWORDS.has(head) && PREFIX_TARGETS.has(keyword)) {
    return hasPrefixTarget(text, statementFrom, head, pos)
  }

  // 头部关键字还没等到正文（WITH 的主语句、INSERT 的数据源等）
  if (bodyHead && HEAD_CONTINUATIONS[bodyHead]?.has(keyword)) return false

  // 集合运算：UNION [ALL] 之后的 SELECT 属于同一条
  if (keyword === 'SELECT' || keyword === 'WITH') {
    if (previous && SET_OPERATORS.has(previous)) return false
    if (previous && SET_OPERATOR_MODIFIERS.has(previous)) {
      const before = recent[recent.length - 2]
      if (before && SET_OPERATORS.has(before)) return false
    }
  }

  // `COMMENT ON ...` 才是语句
  if (keyword === 'COMMENT') return nextTopKeyword(text, pos + keyword.length) === COMMENT_TARGET_KEYWORD

  return true
}

/** 当前语句的头部关键字（EXPLAIN / DESC 要看它后面真正的正文关键字） */
function headKeywordOf(text: string, statementFrom: number): string | null {
  const keyword = wordAt(text, statementFrom)
  if (!keyword || !PREFIX_KEYWORDS.has(keyword)) return keyword
  let i = statementFrom + keyword.length
  while (i < text.length && isSpace(text[i])) i += 1
  // `EXPLAIN (ANALYZE, BUFFERS) SELECT ...`：跳过括号选项
  if (text[i] === '(') {
    const close = text.indexOf(')', i)
    i = close === -1 ? text.length : close + 1
    while (i < text.length && isSpace(text[i])) i += 1
  }
  return wordAt(text, i) ?? keyword
}

/** EXPLAIN / DESC 之后是否已经出现过目标关键字（出现过就说明该收尾了） */
function hasPrefixTarget(text: string, statementFrom: number, head: string, to: number): boolean {
  let from = statementFrom + head.length
  let i = from
  while (i < to && isSpace(text[i])) i += 1
  if (text[i] === '(') {
    const close = text.indexOf(')', i)
    from = close === -1 ? to : close + 1
  }
  return lastTopKeywords(text, from, to, 1).some(word => PREFIX_TARGETS.has(word))
}

/** `[from, to)` 里最后 n 个顶层关键字（按出现顺序返回） */
function lastTopKeywords(text: string, from: number, to: number, limit: number): string[] {
  const keywords: string[] = []
  for (const token of topLevelTokens(text, from, to)) {
    keywords.push(token.word)
    if (keywords.length > limit) keywords.shift()
  }
  return keywords
}

/** `pos` 之后（跳过空白与注释）的第一个顶层关键字 */
function nextTopKeyword(text: string, pos: number): string | null {
  let i = pos
  while (i < text.length) {
    if (isSpace(text[i])) {
      i += 1
      continue
    }
    if (text[i] === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
      continue
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) return null
      i = close + 2
      continue
    }
    break
  }
  return wordAt(text, i)
}

interface TopLevelToken {
  word: string
}

/**
 * 枚举 `[from, to)` 里括号深度为 0 的单词，跳过字符串与注释。
 * 只服务于「续行判定」这类小范围查询，不需要完整词法。
 */
function* topLevelTokens(text: string, from: number, to: number): Generator<TopLevelToken> {
  let depth = 0
  let i = from

  while (i < to) {
    const ch = text[i]
    const next = text[i + 1] ?? ''

    if ((ch === '-' && next === '-') || ch === '#') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? to : newline + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? to : close + 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      i += 1
      while (i < to) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === ch) {
          if (text[i + 1] === ch) {
            i += 2
            continue
          }
          break
        }
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      const word = wordAt(text, i)
      if (word) {
        yield { word }
        i += word.length
        continue
      }
    }
    i += 1
  }
}

// --------------------------------------------------------------- 光标归属

/** 光标所在行是否为空行（只有空白） */
function isBlankLineAt(text: string, pos: number): boolean {
  const lineFrom = text.lastIndexOf('\n', pos - 1) + 1
  let lineTo = text.indexOf('\n', pos)
  if (lineTo === -1) lineTo = text.length
  return text.slice(lineFrom, lineTo).trim() === ''
}

/** 光标是否紧跟在语句的结尾分号之后（中间不允许换行，行尾注释除外） */
function followsSemicolon(text: string, statementTo: number, pos: number): boolean {
  if (pos < statementTo) return false

  let semicolon = statementTo
  while (semicolon < text.length && isSpace(text[semicolon])) {
    // 分号与语句之间允许同行空白；跨行就不算了
    if (text[semicolon] === '\n') return false
    semicolon += 1
  }
  if (text[semicolon] !== ';') return false
  if (pos <= semicolon + 1) return true

  // 分号到光标之间只允许同行空白与行尾注释（`SELECT 1; -- 备注`）
  const gap = text.slice(semicolon + 1, pos)
  if (gap.includes('\n')) return false
  return !/[^\s]/.test(gap.replace(/--.*$/, '').replace(/#.*$/, ''))
}

/**
 * 光标 / 选区落点对应的语句，没有则返回 null。
 *
 * 判定顺序：
 *  1. 光标所在行是空行 → null（执行器据此提示「光标处未匹配到 SQL 命令」）；
 *  2. 落在语句文本范围内（含首尾）→ 这条；
 *  3. 紧跟结尾分号之后、且中间不跨行 → 仍算这条；
 *  4. 落在语句前的前置空白里（行首缩进、上一条注释行）→ 算这条。
 */
export function statementAtCursor(source: SqlSource, pos: number, dbType?: string): SqlRange | null {
  const text = typeof source === 'string' ? source : source.toString()
  const cursor = Math.max(0, Math.min(pos, text.length))
  if (isBlankLineAt(text, cursor)) return null

  const statements = splitSqlStatements(source, dbType)
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]
    if (cursor >= statement.from && cursor <= statement.to) return toRange(statement)

    const next = statements[index + 1]
    if (cursor > statement.to && (!next || cursor < next.from) && followsSemicolon(text, statement.to, cursor)) {
      return toRange(statement)
    }
    if (cursor >= statement.leadFrom && cursor < statement.from && text.slice(cursor, statement.from).trim() === '') {
      // 语句之间的空行已被上面的空行判断拦掉，剩下的是行首缩进这类情形
      return toRange(statement)
    }
  }
  return null
}

function toRange(statement: SqlStatement): SqlRange {
  return { from: statement.from, to: statement.to, sql: statement.sql }
}

/**
 * 语句范围扩展到包含结尾分号（画边框用）。
 * 分号与语句文本之间既允许同行空白，也允许换行（`SELECT 1\n;`）。
 */
export function statementEndWithSemicolon(source: SqlSource, range: SqlRange): number {
  const text = typeof source === 'string' ? source : source.toString()
  let pos = range.to
  while (pos < text.length && isSpace(text[pos])) pos += 1
  return text[pos] === ';' ? pos + 1 : range.to
}

/**
 * SQL 光标的语义分析（文本层）。
 *
 * 这里回答 SQL 侧的「我在哪」：**哪条语句 / 哪个子句 / 什么位置类别 / 正在输入什么**。
 * 与补全主模块的关系：
 *
 * ```
 *   analyzeHybridCursor   语言区域（模板 / 脚本 / 字符串注释 / SQL）
 *         ↓
 *   analyzeSqlCursorText  语句 + 子句 + 位置类别 + 前缀（本文件，纯文本、可廉价调用）
 *         ↓
 *   SqlCursorIntent       再加作用域链（表 / 别名 / CTE，由补全主模块填）
 *         ↓
 *   候选生成              generalSuggestions / smartSuggestions / 点号补全 …
 * ```
 *
 * 之所以分两层：位置判定要在**每次按键**时跑（触发策略），不能查元数据；
 * 而候选生成需要作用域。上面的文本层两种场景共用，口径不会分叉。
 *
 * 子句判定用「同一语句内的反向扫描」而不是完整语法树：补全时语句十有八九
 * 还没写完（正打到 `where u.`），严格 parser 会直接失败，而这里只需要回答
 * 「最近的、同层级的子句关键字是哪个」。
 */
import type { EditorState } from '@codemirror/state'
import { normalizeSqlScanDialect, splitSqlStatements } from '@/utils/sql/sqlStatementRanges'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { KEYWORD_WORDS } from './sqlCompletionKeywords'
import { IDENT_BODY_SOURCE, IDENT_SOURCE } from './sqlLexemes'
import { readAlias, readIdentifier, readQualifiedName, skipQuoted } from './sqlSchema'

/** 补全所处位置的候选类型 */
export type CompletionContextKind =
  /** 表名位置：FROM / JOIN / INTO / UPDATE 之后 */
  | 'table'
  /** 表达式位置：SELECT 列表 / WHERE / ON / SET / BY 等 */
  | 'column'
  /** 语句头（语句开头或判不出位置） */
  | 'statement-start'
  /** 子句关键字位置（表来源写完之后） */
  | 'keyword'
  /** 别名位置（AS 之后），此处不给候选 */
  | 'alias'
  /** 关联条件位置（`JOIN … ON |`：这里该写整条条件） */
  | 'join-on'
  /** JOIN 条件表达式内部（`ON o.user_id = u.|`：只给列，不再给整条条件） */
  | 'join-expression'
  /** 分组位置（GROUP BY 之后） */
  | 'group-by'
  /** INSERT 列清单内 */
  | 'insert'
  /** 模板片段 `{{ … }}` 内 */
  | 'template'
  /** 脚本编辑器 */
  | 'script'
  /** 无（日志等不补全的编辑器） */
  | 'none'

/**
 * 补全所处位置的候选类型（子句视角）。
 *
 *  - `source`：**表名还没写**（`FROM |`、`JOIN |`、`INTO |`、`FROM t, |`）→ 只给表与库；
 *  - `afterSource`：表来源已写（`FROM t |`、`AS t1 |`）→ 表 + 库 + 连接 / 子句关键字；
 *  - `column`：表达式位置（SELECT / WHERE / ON / SET / BY / 函数参数…）
 *    → 列 + 别名 + 函数 + 关键字；
 *  - `alias`：别名位置（`… AS |`）→ **什么也不给**：这里只能写别名，
 *    列名、函数、关键字全是噪音；
 *  - `any`：判断不出（语句开头、空行）→ 表 + 库 + 全量关键字（含 DDL）。
 */
export type ClauseKind = 'source' | 'afterSource' | 'column' | 'alias' | 'any'

/** 「后面接表」的子句关键字 */
const TABLE_CLAUSE_KEYWORDS = new Set([
  'from', 'join', 'into', 'update', 'table', 'truncate', 'describe',
  'use', 'database', 'schema', 'rename', 'analyze', 'optimize', 'repair',
])

/**
 * 「后面接列 / 表达式」的子句关键字。
 * `desc` / `limit` / `offset` 故意不收：它们后面接的是值或者别的关键字，
 * 而且 `order by x desc` 收尾时反向扫描还要继续往左找 BY，才能判成列位置。
 */
const COLUMN_CLAUSE_KEYWORDS = new Set([
  'select', 'where', 'on', 'and', 'or', 'set', 'by', 'having', 'using',
  'when', 'then', 'else', 'case', 'like', 'in', 'between', 'is', 'not',
  'distinct', 'returning', 'values', 'as', 'order', 'group',
])

/**
 * 反向扫描出的子句结论。
 *
 * 除位置类别外还带上「命中的关键字」与「它左边那个关键字」：
 * 位置细分（关联条件 / 分组 / INSERT 列清单）要靠这两个词区分，
 * 而它们本来就是同一次扫描读出来的，没必要再扫一遍。
 */
export interface ClauseScan {
  kind: ClauseKind
  /** 命中的关键字（小写）；未命中为空串 */
  keyword: string
  /** 命中关键字左边的那个词（如 `GROUP BY` 的 group、`o.user_id` 的 o） */
  previousKeyword: string
  /**
   * 命中关键字之后、到光标之间的文本（已 trim）。
   *
   * 判断「这里是不是刚开了个头」用：`ON |` 还空着（该写整条条件），
   * `ON o.user_id = |` 已经在表达式里了（只该给列）。
   */
  tail: string
  /**
   * 光标是否**紧贴刚读到的那个词**（`FROM|` 对 `FROM |`）。
   *
   * 紧贴说明用户还在写这个词，位置语义还没进入「关键字之后的那个槽位」——
   * 上层据此收窄候选（明细见 `TightKind`）。
   */
  tight: TightKind
}

/**
 * 「紧贴」的三种情形。
 *
 * - `'none'`：不紧贴（`FROM |`）—— 空位就是下一个槽位，表 / 库都该给；
 * - `'keyword'`：紧贴的就是命中的关键字（`FROM|`、`INTO|`）—— 表和库都不该给，
 *   否则 `FROM|` 的 pattern 会把长库名当子序列匹配上、再由高 boost 顶到第一位；
 * - `'name'`：紧贴的词被当成「正在输入的名字」让过（`FROM ord|` 的 `ord`）——
 *   表名与库名候选正是用户要的（`orders` / `order_center`），照给。
 *
 * 注意 `'name'` 的判据是**词本身的身份**（不在关键字词表里），不是它长什么样：
 * 任何非关键字的词紧贴光标时都是「正在输入的名字」，因此 `FROM d|`、`FROM ord|`、
 * `FROM user|` 与曾经的 `FROM or|` 走的是同一条路 —— 不再依赖「恰好是个关键字」。
 */
export type TightKind = 'none' | 'keyword' | 'name'

/** 判断光标处属于哪个子句 */
export function readClauseKind(prefix: string): ClauseKind {
  return scanClause(prefix).kind
}

/** 反向扫描子句上下文（readClauseKind 的实现，额外透出命中的关键字） */
export function scanClause(prefix: string): ClauseScan {
  let index = prefix.length
  let depth = 0
  /** 反向扫描时是否跨过了一个左括号 */
  let enteredParen = false
  /** 是否让过了一个紧贴光标的词（`FROM or|` 的 `or`）—— 位置结论来自它左边的关键字 */
  let skippedName = false
  /** 那个被让过的词的起点：tail 要从这里截断，不能把它算成「已写好的内容」 */
  let skippedNameStart = prefix.length
  /** 已读过的上一个词（用于区分 GROUP BY / ORDER BY 这类两词结构） */
  let previousKeyword = ''

  const result = (kind: ClauseKind, keyword = '', at = index, tight: TightKind = 'none'): ClauseScan => ({
    kind,
    keyword,
    previousKeyword,
    tail: prefix.slice(at).trim(),
    // 让过名字的情形优先级最低：显式判定为紧贴关键字时以它为准
    tight: tight === 'none' && skippedName ? 'name' : tight,
  })

  while (index > 0) {
    const ch = prefix[index - 1] ?? ''

    if (/\s/.test(ch)) {
      index--
      continue
    }

    if (ch === ')') {
      depth++
      index--
      continue
    }

    if (ch === '(') {
      enteredParen = true
      depth = Math.max(0, depth - 1)
      index--
      continue
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      index = skipQuotedBackward(prefix, index - 1)
      continue
    }

    // 行注释：跳到行首；块注释：跳到 /* 之前
    if (ch === '-' && prefix[index - 2] === '-') {
      const lineStart = prefix.lastIndexOf('\n', index - 1)
      index = lineStart < 0 ? 0 : lineStart
      continue
    }
    if (ch === '/' && prefix[index - 2] === '*') {
      const blockStart = prefix.lastIndexOf('/*', index - 3)
      index = blockStart < 0 ? 0 : blockStart
      continue
    }

    const word = readWordBackward(prefix, index)
    if (word) {
      const lower = word.text.toLowerCase()
      if (depth === 0) {
        /*
         * 紧贴光标的词，左边紧邻点号 ⇒ 它一定是限定名的一部分，不可能是关键字：
         * `SELECT * FROM `test`.use|` 里的 `use` 是表名开头，不是 USE 语句关键字。
         * 先按「正在输入的名字」让过它，再继续往左找真正的子句关键字 ——
         * 不这样做的话 `use` / `order` / `as` 这类关键字开头的表名会整批没有候选。
         */
        if (index === prefix.length && prefix[index - 1] === '.') {
          skippedName = true
          skippedNameStart = word.start
          previousKeyword = lower
          index = word.start
          continue
        }
        // 括号里的列清单：INSERT INTO t (a, |) / CREATE TABLE t (a |)
        if (enteredParen && (lower === 'into' || lower === 'update' || lower === 'table')) {
          return result('column', lower)
        }
        /*
         * `AS` 之后就是别名本身（表别名 / 列别名）：
         * 光标还在 `AS |` 时不该弹任何候选；
         * 别名已经写完（`AS t1 |`）则回到「表之后」，接下来是 JOIN / WHERE 这些子句关键字。
         */
        if (lower === 'as') {
          // `AS|` 紧贴：这个词还没写完，位置也没进入别名之后
          return result(
            prefix.slice(index).trim() ? 'afterSource' : 'alias',
            lower,
            index,
            index === prefix.length ? 'keyword' : 'none',
          )
        }
        /*
         * BY 是两词结构的后半截（GROUP BY / ORDER BY），命中时前半截还没读到：
         * 再往左读一个词填进 previousKeyword —— 位置细分才能把「分组」认出来。
         */
        if (lower === 'by') {
          let head = word.start
          while (head > 0 && /\s/.test(prefix[head - 1] ?? '')) {
            head--
          }
          const previous = readWordBackward(prefix, head)
          if (previous) {
            previousKeyword = previous.text.toLowerCase()
          }
          // `GROUP BY|` / `ORDER BY|` 紧贴：BY 本身还在写
          return result('column', lower, index, index === prefix.length ? 'keyword' : 'none')
        }
        if (TABLE_CLAUSE_KEYWORDS.has(lower)) {
          /*
           * 表位置再细分：关键字到光标之间有没有内容，决定了「表还没写」还是「已写了表」。
           * `FROM |` → source（只给表/库）；`FROM t |` → afterSource（再给 JOIN/WHERE 等关键字）；
           * `FROM t, |` → 逗号后面又该接表名，回到 source。
           */
          /*
           * tail 要排除「正在输入的那个词」：`FROM or|` 里 `or` 是没写完的表名，
           * 它不是「已写好的来源」。不排除的话这里会判成 afterSource，
           * 于是表名候选整批消失（资格过滤后一条不剩）。
           */
          const tail = prefix.slice(index, skippedName ? skippedNameStart : prefix.length).trim()
          /*
           * `FROM|`（紧贴，还没敲空格）与 `FROM |` 位置不同：
           * 前者还在写这个词，表 / 库都不该给；后者才是「该写表名」的空位。
           */
          const tight: TightKind = index === prefix.length ? 'keyword' : 'none'
          /*
           * 还在写来源的三种情形：什么都没写、刚敲了逗号（接着写下一个来源）、
           * 以及**限定名写到一半**（`FROM mysql.` —— 库名写了，表名还没写）。
           * 最后一种不能算「来源已完成」，否则槽位会按 afterSource 只给关键字，
           * 表名候选整批消失。
           */
          if (!tail || tail.endsWith(',') || tail.endsWith('.')) {
            return result('source', lower, index, tight)
          }
          if (tail.includes('(') || tail.includes(')')) {
            return result('any', lower, index, tight)
          }
          return result('afterSource', lower, index, tight)
        }
        if (COLUMN_CLAUSE_KEYWORDS.has(lower)) {
          /*
           * 贴住光标的词，只有「左边明确是名字位置」时才当作**还没写完的名字**：
           *
           *   SELECT * FROM or|   → 左边是 `from`（表位置）⇒ `or` 其实是 orders
           *   SELECT * FROM users WHERE|  → 左边是表名 ⇒ 这就是 WHERE 关键字本身
           *   SELECT CASE|        → 左边是 SELECT（表达式位置）⇒ 关键字本身
           *
           * 只有前一种情况让步（跳过它继续往左找真正的子句关键字）。
           * 反例曾经踩过：一刀切「紧贴光标就不算关键字」会把 `WHERE|` 判成表位置。
           */
          if (index === prefix.length && previousIsTableClauseKeyword(prefix, word.start)) {
            skippedName = true
            skippedNameStart = word.start
            previousKeyword = lower
            index = word.start
            continue
          }
          return result('column', lower)
        }
        /*
         * 走到这里只可能是一种情况：这个词**不在关键字词表里**，于是它只能是
         * 正在输入的标识符（表名 / 列名 / 别名 / 库名）。
         *
         * 位置语义由关键字给出，不由内容给出 —— 所以让过它、继续往左找子句关键字：
         *
         *   `SELECT * FROM d|`        → 让过 `d`，命中 FROM ⇒ 仍是**表位置**（给表名）
         *   `SELECT * FROM user|`     → 同上（`user` 是需要引用符的保留字，但不是关键字）
         *   `SELECT * FROM db.tab|`   → 让过 `tab`，tail 只剩 `db.` ⇒ 仍是表位置
         *
         * 只有**紧贴光标**才让过：`FROM users |` 里 users 后面已落空格，
         * 那是个写完的来源，位置确实是「表之后」。
         */
        if (index === prefix.length && !KEYWORD_WORDS.has(lower)) {
          skippedName = true
          skippedNameStart = word.start
          previousKeyword = lower
          index = word.start
          continue
        }
      }
      previousKeyword = lower
      index = word.start
      continue
    }

    index--
  }

  // 进了括号又判断不出关键字：按表达式位置处理（函数参数、子查询列清单等）
  return result(enteredParen ? 'column' : 'any')
}

/**
 * 紧贴光标的关键字，左边是不是「表位置关键字」（from / join / into / update…）。
 *
 * 用来区分 `FROM or|`（`or` 是还没写完的表名）与 `WHERE|`（`where` 就是关键字）。
 */
function previousIsTableClauseKeyword(prefix: string, before: number): boolean {
  let head = before
  while (head > 0 && /\s/.test(prefix[head - 1] ?? '')) {
    head--
  }
  const previous = readWordBackward(prefix, head)
  return Boolean(previous && TABLE_CLAUSE_KEYWORDS.has(previous.text.toLowerCase()))
}

/** 从 index 向左读一个词，返回词与起始下标 */
function readWordBackward(text: string, index: number): { text: string, start: number } | null {
  let i = index
  while (i > 0 && /[\w$]/.test(text[i - 1] ?? '')) {
    i--
  }
  if (i === index || !/[A-Za-z_$]/.test(text[i] ?? '')) {
    return null
  }
  return { text: text.slice(i, index), start: i }
}

/** 从 index（引号字符）向左找到配对的开引号，返回开引号之前的下标 */
export function skipQuotedBackward(text: string, index: number): number {
  const quote = text[index] ?? ''
  let i = index - 1
  while (i >= 0) {
    if (text[i] === quote) {
      // 双写（''）或反斜杠转义：继续往左找
      if (text[i - 1] === quote || text[i - 1] === '\\') {
        i -= 2
        continue
      }
      return i
    }
    i--
  }
  return 0
}

/**
 * 光标所在（可能还没写完）语句中，光标之前的文本。
 *
 * 起点由语句范围给出（`completionStatementContext`）：
 * 光标停在语句末尾空白或新起一行时也算这条语句，否则会从头把
 * **上一条语句**的子句当成上下文（在 FROM 后面之后接着弹列名）。
 *
 * 拿不到范围时返回空串 —— 不能退回「按最后一个分号切」：没写分号的脚本
 * 会因此把整篇文档当成当前语句的上下文。
 */
export function currentClausePrefix(doc: string, pos: number, range: TextRange | null): string {
  if (!range) {
    return ''
  }
  return doc.slice(Math.max(0, range.from), pos)
}

/**
 * 补全口径的语句边界类别。
 *
 * 「光标属于哪条语句」有两个容易混淆的答案，这里显式区分：
 *  - 语句**之后**的普通空白（换行、缩进）仍属于那条语句（`… WHERE |` 接着写）；
 *  - 空行才是分界：用户用空行起一条新 SQL 时，即使没写分号也不该继承上一条。
 */
export type SqlStatementBoundary =
  /** 光标落在语句文本里 */
  | 'inside-statement'
  /** 光标在语句之后的普通空白里（换行 / 缩进）—— 仍属于这条语句 */
  | 'trailing-whitespace'
  /** 光标在一个**完整空行**之后 —— 新语句（不必写分号） */
  | 'blank-line'
  /** 没有语句覆盖光标（文件开头、分号之后）—— 本身就是新语句 */
  | 'new-statement'

/** 补全口径的语句上下文：解析范围 + 边界类别 */
export interface CompletionStatementContext {
  /** 当前语句的解析范围（`clause` / 作用域都基于它） */
  range: TextRange
  boundary: SqlStatementBoundary
}

/**
 * 补全口径的语句上下文。
 *
 * 与 `statementAtCursor`（执行 / 画边框用）的区别：那边要求光标确实"落在"语句里，
 * 空行与语句末尾之后的换行都算不归属；而补全几乎总在"正在写"的位置——
 * 光标停在 `… WHERE ` 之后、或新起一行准备继续写时，必须仍能看到这张表的列，
 * 所以这里把「语句末尾之后、下一条语句之前的空白」也算作该语句。
 *
 * 另外比旧实现多一层：**空行是补全语义上的语句边界**。
 * `SELECT * FROM users\n\nS|` 里的 `S` 要按新语句解析（否则会继续给上一条
 * FROM 之后的 SET / AS / OFFSET 之类候选）。语句内部的空行不会误判 ——
 * 见 `findCompletionBlankLineBoundary` 的结构性判据。
 *
 * 注意语义分工：这里是**补全视图**（编辑器意图）；真实语句要用
 * `statementAtCursor`（执行 / 语义 / 重命名 / 悬停都走那条）。
 */
export function completionStatementContext(
  doc: string,
  pos: number,
  dbType = '',
): CompletionStatementContext | null {
  const statements = splitSqlStatements(doc, dbType)

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]

    if (pos >= statement.from && pos <= statement.to) {
      /*
       * 光标在语句文本里，但这段文本内部可能夹着空行。
       * 没写分号时（行首软分隔只认完整关键字）`… users\n\nS` 仍是一条语句，
       * 补全要把它当「空行之后的新语句」—— 新的范围从空行之后算起，
       * 上一条 SQL 的表 / 别名就不会进作用域。
       */
      const start = findCompletionBlankLineBoundary(doc, statement.from, pos, dbType)
      if (start !== null) {
        return { range: { from: start, to: statement.to }, boundary: 'blank-line' }
      }
      return {
        range: { from: statement.from, to: statement.to },
        boundary: 'inside-statement',
      }
    }

    const next = statements[index + 1]
    if (pos <= statement.to || (next && pos >= next.from)) {
      continue
    }

    const gap = doc.slice(statement.to, pos)
    if (gap.trim() !== '') {
      continue
    }

    // 语句之后的空白：普通换行仍是这条语句，完整空行才起新语句
    if (hasBlankLineBoundary(gap)) {
      return { range: { from: lineStartOf(doc, pos), to: pos }, boundary: 'blank-line' }
    }
    return {
      range: { from: statement.from, to: statement.to },
      boundary: 'trailing-whitespace',
    }
  }

  return { range: { from: lineStartOf(doc, pos), to: pos }, boundary: 'new-statement' }
}

/**
 * 只取解析范围的兼容入口（**仅补全**）。
 *
 * @deprecated 语义 / 重命名 / 悬停请用 `statementAtCursor`（真实 SQL statement）。
 * 这个范围是**补全视图**：它会把空行之后的光标当成新语句，属于编辑器的产品规则，
 * 不是 SQL 标准里的语句边界。
 */
export function completionStatementRange(doc: string, pos: number, dbType = ''): TextRange | null {
  return completionStatementContext(doc, pos, dbType)?.range ?? null
}

/** 文本里是否出现**完整空行**（一整行只有空白）——单个换行不算 */
export function hasBlankLineBoundary(text: string): boolean {
  return /\r?\n[ \t]*\r?\n/.test(text)
}

/** 光标所在行的行首 */
function lineStartOf(doc: string, pos: number): number {
  return doc.lastIndexOf('\n', pos - 1) + 1
}

/**
 * 当前补全语句里「空行边界」的候选起点（空行之后的行首），没有则返回 null。
 *
 * **它不是第二个 SQL 解析器**，职责刻意保持小：
 *  - 只找空行、只判「是否在字符串 / 注释 / dollar quote / 括号里」、
 *    只识别**明显的续写信号**；
 *  - 不做语法分析、不判断语句起始关键字：`SELECT` / `INSERT` 这类完整关键字
 *    已经由 `splitSqlStatements` 按行首软分隔切开（光标落在新的真实语句里）；
 *    这里服务的是 `S` / `SE` / `UP` 这类**还没写全的关键字前缀**；
 *  - 词法规则与真实语句扫描器共用方言归一（`normalizeSqlScanDialect`），
 *    不另立一套标准。
 *
 * 判据（结构性信号，不猜语义）：
 *  1. 括号必须闭合 —— `WHERE id IN (\n\n1` 的空行在括号里；
 *  2. 空行前最后一个字符不是续写符 —— `SELECT a,\n\nb` 只是排版
 *     （`SELECT *\nFROM users` 结尾的 `*` 不算续写符，那是完整表达式）；
 *  3. 空行前最后一个词不是续写词 —— `SELECT\n\nname` 显然没写完；
 *  4. 空行后第一个有意义的词（跳过注释）也不是续写词 ——
 *     `WHERE id = 1\n\n-- 注释\nAND name = 'a'` 是同一条件的续写。
 */
function findCompletionBlankLineBoundary(
  doc: string,
  from: number,
  to: number,
  dbType = '',
): number | null {
  const dialect = normalizeSqlScanDialect(dbType)
  let i = from
  let depth = 0
  let boundary = -1
  /** 最近一个「有内容的字符」（注释与引号内的内容不算） */
  let contentEnd = -1
  /** 最近一个词（小写）：判断它是不是续写词 */
  let lastWord = ''

  while (i < to) {
    const ch = doc[i]

    // 标识符：整块读掉，顺便记下最后一个词
    // （词首不认 `$`：那是 PostgreSQL dollar quote 的起始，不能当标识符吃掉）
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < to && /[\w$]/.test(doc[j] ?? '')) {
        j += 1
      }
      lastWord = doc.slice(i, j).toLowerCase()
      contentEnd = j - 1
      i = j
      continue
    }

    // 字符串 / 引号标识符：反引号只在 MySQL 家族里是引用符
    if (ch === '\'' || ch === '"' || (ch === '`' && dialect === 'mysql')) {
      const next = skipQuoted(doc, i)
      if (next > to) {
        return null
      }
      contentEnd = next - 1
      i = next
      continue
    }

    // PostgreSQL dollar quote：`$$ … $$`（可跨行）里的空行不是语句边界
    if (dialect === 'postgres' && ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(doc.slice(i, i + 64))
      if (tag) {
        const close = doc.indexOf(tag[0], i + tag[0].length)
        if (close < 0 || close + tag[0].length > to) {
          return null
        }
        contentEnd = close + tag[0].length - 1
        i = close + tag[0].length
        continue
      }
    }

    // 行注释：`--` 通用；`#` 只有 MySQL 家族（PostgreSQL / 标准 SQL 里 # 是普通字符）
    if ((ch === '-' && doc[i + 1] === '-') || (dialect === 'mysql' && ch === '#')) {
      const newline = doc.indexOf('\n', i)
      i = newline === -1 || newline > to ? to : newline
      continue
    }

    if (ch === '/' && doc[i + 1] === '*') {
      const close = doc.indexOf('*/', i + 2)
      if (close === -1 || close + 2 > to) {
        return null
      }
      i = close + 2
      continue
    }

    if (ch === '(') {
      depth += 1
    }
    else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    }
    else if (ch === '\n') {
      // 空行 = 换行之后只有空白，紧跟又一个换行
      let j = i + 1
      while (j < to && (doc[j] === ' ' || doc[j] === '\t' || doc[j] === '\r')) {
        j += 1
      }
      if (
        j < to
        && doc[j] === '\n'
        && depth === 0
        && !endsWithContinuation(doc, contentEnd)
        && !isContinuationWord(lastWord)
      ) {
        // 空行之后的行首即是新语句起点（后面若还有注释行，一并算进去）
        const start = lineStartOf(doc, j + 1)
        if (!isContinuationWord(firstMeaningfulWordAt(doc, start, to, dbType))) {
          boundary = start
        }
      }
      i = j > i + 1 ? j : i + 1
      continue
    }
    else if (!/\s/.test(ch)) {
      contentEnd = i
      lastWord = ''
    }
    i += 1
  }

  return boundary >= 0 ? boundary : null
}

/**
 * 从 lineStart 起第一个**有意义的**词（跳过空白、行注释、块注释）；没有则返回空串。
 *
 * 必须跳过注释：`\n-- 注释\nAND name = 'a'` 里的 `AND` 才是续写信号，
 * 只看首个非空白字符会漏掉它，把续写误判成新语句。
 */
function firstMeaningfulWordAt(doc: string, lineStart: number, to: number, dbType = ''): string {
  const dialect = normalizeSqlScanDialect(dbType)
  let i = lineStart

  while (i < to) {
    const ch = doc[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if ((ch === '-' && doc[i + 1] === '-') || (dialect === 'mysql' && ch === '#')) {
      const newline = doc.indexOf('\n', i)
      if (newline < 0 || newline >= to) {
        return ''
      }
      i = newline + 1
      continue
    }
    if (ch === '/' && doc[i + 1] === '*') {
      const close = doc.indexOf('*/', i + 2)
      if (close < 0 || close + 2 >= to) {
        return ''
      }
      i = close + 2
      continue
    }
    break
  }

  const match = /^[A-Za-z_][\w$]*/.exec(doc.slice(i, to))
  return match ? match[0].toLowerCase() : ''
}

/**
 * 结尾字符是否**必须**继续写（逗号 / 括号 / 赋值与比较运算符）。
 *
 * 刻意收窄：`*` `/` `%` `[` 都**不算**续写信号 —— 它们可能只是表达式的一部分
 * （`SELECT *\nFROM users` 的 `*` 已经写完了），误判会让空行边界永远不成立。
 */
function endsWithContinuation(doc: string, contentEnd: number): boolean {
  if (contentEnd < 0) {
    return true
  }
  return /[,.(=+\-<>:&|!?]/.test(doc[contentEnd] ?? '')
}

/**
 * 续写提示词 —— **只用来消除「明显续写」的误切，不是 SQL grammar**。
 *
 * 缺了某个关键字，最多让极少数合法写法被判成新语句；这是「空行 = 编辑器里的
 * 新 SQL 意图」这条产品规则的一部分，不是 SQL 标准解析。
 * 不收可以独立收尾的词（如 `DESC`、`NULL`、`TRUE`）。
 */
const CONTINUATION_CLAUSE_WORDS = new Set([
  'select', 'distinct', 'all', 'from', 'join', 'left', 'right', 'inner', 'outer',
  'full', 'cross', 'on', 'using', 'where', 'group', 'order', 'by', 'having',
  'set', 'values', 'into', 'as', 'union', 'intersect', 'except', 'limit', 'offset',
  'with', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate',
  'add', 'returning', 'over', 'partition', 'window',
])

/** 表达式内部的连接词：出现在空行前后都说明还在写同一个表达式 */
const CONTINUATION_OPERATOR_WORDS = new Set([
  'and', 'or', 'not', 'between', 'like', 'is', 'in', 'when', 'then', 'else', 'case',
])

/** 这个词是否表示「还要接着写」 */
function isContinuationWord(word: string): boolean {
  return CONTINUATION_CLAUSE_WORDS.has(word) || CONTINUATION_OPERATOR_WORDS.has(word)
}

/** 由子句扫描结论细化为位置类别 */
export function sqlContextKindOf(scan: ClauseScan, statementText: string): CompletionContextKind {
  switch (scan.kind) {
    case 'alias':
      return 'alias'
    case 'source':
      return 'table'
    case 'afterSource':
      return 'keyword'
    case 'column':
      /*
       * 关联条件：ON 且同一条语句里出现过 JOIN（ON 也会出现在 CREATE INDEX 等语句里）。
       *
       * 但只有「ON 之后还空着」才是「该写整条条件」的位置：
       * `ON |` → join-on（给 `o.user_id = u.id`）；
       * `ON o.user_id = u.|` → join-expression（只给列）。
       */
      if (scan.keyword === 'on' && /\bjoin\b/i.test(statementText)) {
        return scan.tail ? 'join-expression' : 'join-on'
      }
      // `ON … AND |`：还在同一个 ON 子句里，可以再给一条条件
      if ((scan.keyword === 'and' || scan.keyword === 'or') && !scan.tail && isInsideJoinClause(statementText)) {
        return 'join-on'
      }
      // 分组：GROUP BY（previousKeyword 是同一个扫描里读出来的 group）
      if (scan.keyword === 'by' && scan.previousKeyword === 'group') {
        return 'group-by'
      }
      // INSERT 的列清单：INTO 之后还没闭合的括号内
      if (scan.keyword === 'into') {
        return 'insert'
      }
      return 'column'
    default:
      return 'statement-start'
  }
}

/** 光标处是否还在 ON 子句里（最近的 ON 晚于最近的 WHERE / HAVING） */
function isInsideJoinClause(statementText: string): boolean {
  const lower = statementText.toLowerCase()
  const on = lower.lastIndexOf(' on ')
  if (on < 0) {
    return false
  }
  return on > lower.lastIndexOf(' where ') && on > lower.lastIndexOf(' having ')
}

// ---------------------------------------------------------------- 列补全意图

/**
 * 列补全模式。
 *
 * - `single`：普通单选补全（选一个候选继续写）；**不出现复选框**；
 * - `multi`：多选列模式（勾选若干列，回车一次插入）；**出现复选框**。
 *
 * 这是「补全意图」的语义结果，不是候选类型的自然结果 ——
 * 列候选在任何地方都长得一样，是否多选取决于光标处在什么状态。
 */
export type ColumnCompletionMode = 'single' | 'multi'

/** 光标前那一个输出项是什么（决定 `,|` 与 `, |` 的差别） */
export type PreviousItemKind = 'column' | 'expression' | 'function' | 'unknown'

/**
 * 光标处的列补全意图。
 *
 * 文档要求把 `t.|`、`t.user_id,|`、`t.user_id, |` 三种状态分开表达，
 * 这里就是那份表达：**由结构推导**（子句关键字 + 括号深度 + 逗号位置），
 * 而不是 `prefix === ''` 或 `text.includes(',')` 这类字符串条件。
 */
export interface SqlColumnIntent {
  /** 是否处于 SELECT 列表的列位置（其它子句的列位置不算） */
  isColumnList: boolean
  /** 左侧点号限定符（`t.` 的 t）；没有为空串 */
  qualifier: string
  /** 正在输入的词 */
  prefix: string
  /** 光标左侧是否处于「逗号之后的新输出项」 */
  afterComma: boolean
  /** 逗号之后是否已经落了空白（`,|` 与 `, |` 的分界） */
  commaFollowedBySpace: boolean
  /** 上一个输出项的类型 */
  previousItemKind: PreviousItemKind
  /** 上一个输出项用的限定符（多选时新列沿用它的 `t.`）；没有为空串 */
  previousQualifier: string
  /** 当前输出项原文（保留空白；判定槽位要区分「新的一项」与「已写了表达式」） */
  itemText: string
  /** 当前输出项还没写任何表达式：`SELECT |` / `SELECT t.` 为真，`SELECT id |` 为假 */
  itemEmpty: boolean
  /** 列选择模式 */
  mode: ColumnCompletionMode
}

/** 不在列位置时的默认意图（单选、无限定符） */
function emptyColumnIntent(): SqlColumnIntent {
  return {
    isColumnList: false,
    qualifier: '',
    prefix: '',
    afterComma: false,
    commaFollowedBySpace: false,
    previousItemKind: 'unknown',
    previousQualifier: '',
    itemText: '',
    itemEmpty: false,
    mode: 'single',
  }
}

/** 单独写一个关键字也算「还没开始写表达式」（`SELECT DISTINCT |`） */
const ITEM_ONLY_KEYWORDS = new Set(['distinct', 'all'])

/**
 * 该输出项是否还没写表达式内容。
 *
 * `SELECT |`、`SELECT t.`、`SELECT DISTINCT |` 都是「新的一项刚开头」，
 * 而 `SELECT id |`、`SELECT a + ` 已经在表达式里了 —— 两者允许的关键字不同
 * （前者不该出现 FROM / WHERE / GROUP BY）。
 */
function isEmptyItem(itemText: string, qualifier: string, prefix: string): boolean {
  // `SELECT DISTINCT |` 里的 DISTINCT 只是列表开头的修饰，不影响「这一项还没开始写」
  if (prefix && !ITEM_ONLY_KEYWORDS.has(prefix.toLowerCase())) {
    return false
  }
  let head = itemText.trim()
  if (qualifier && head.endsWith('.')) {
    head = head.slice(0, -1)
  }
  if (qualifier) {
    head = head.slice(0, Math.max(0, head.length - qualifier.length))
  }
  const trimmed = head.trim()
  return trimmed === '' || ITEM_ONLY_KEYWORDS.has(trimmed.toLowerCase())
}

/** 忽略引号后的括号深度（> 0 表示在函数参数 / 子查询括号里） */
function parenDepthOf(text: string): number {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === '(') {
      depth++
    }
    else if (ch === ')') {
      depth--
    }
    i++
  }
  return depth
}

/** 光标所在输出项：原文 + 它的起点是逗号还是 SELECT */
interface OutputItemTail {
  /** 从上一个同层逗号 / SELECT 关键字之后到光标的原文（**保留空白**） */
  text: string
  /** 起点是不是逗号（即「光标落在逗号之后的新一项」） */
  afterComma: boolean
}

/**
 * 光标所在**输出项**的原文 + 起点类型。
 *
 * 保留空白很关键：`,|` 与 `, |` 的区别就是逗号后面有没有落空格，
 * 任何 trim 过的中间结果都会把这条信息丢掉（`ClauseScan.tail` 正是 trim 过的）。
 *
 * 必须**从左往右**扫：只有正向扫描才知道某个逗号处在第几层括号里。
 * 反向扫描会踩坑 —— `SELECT func(a,|` 里那个逗号左边还有 `(`，
 * 但反向扫到它时还没见过 `(`，于是被误判成「输出项边界」（真实 bug，已修）。
 */
function itemTailOf(prefix: string): OutputItemTail {
  let depth = 0
  let boundary = 0
  let afterComma = false
  let i = 0

  while (i < prefix.length) {
    const ch = prefix[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(prefix, i)
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (ch === ',' && depth === 0) {
      boundary = i + 1
      afterComma = true
      i++
      continue
    }
    const ident = readIdentifier(prefix, i)
    if (ident) {
      if (depth === 0 && ident.name.toLowerCase() === 'select') {
        boundary = ident.end
        afterComma = false
      }
      i = ident.end
      continue
    }
    i++
  }

  return { text: prefix.slice(boundary), afterComma }
}

/**
 * 上一个输出项的原文（最后一个同层逗号**之前那一项**的内容，不含 SELECT 等前导）。
 *
 * 同样从左往右扫，只在「新一项还没开始输入」时调用，用来取它的类型与限定符：
 * `t.user_id` 得到限定符 `t`，于是多选新列能沿用同一个来源。
 */
function previousItemText(prefix: string): string {
  let depth = 0
  let boundary = 0
  let prevBoundary = 0
  let lastComma = -1
  let i = 0

  while (i < prefix.length) {
    const ch = prefix[i] ?? ''
    if (ch === `'` || ch === '"' || ch === '`') {
      i = skipQuoted(prefix, i)
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (ch === ',' && depth === 0) {
      prevBoundary = boundary
      boundary = i + 1
      lastComma = i
      i++
      continue
    }
    const ident = readIdentifier(prefix, i)
    if (ident) {
      if (depth === 0 && ident.name.toLowerCase() === 'select') {
        boundary = ident.end
      }
      i = ident.end
      continue
    }
    i++
  }

  return lastComma < 0 ? '' : prefix.slice(prevBoundary, lastComma)
}

/** 输出项的类型：完整列引用 / 函数调用 / 其它表达式 / 空 */
function itemKindOf(item: string): PreviousItemKind {
  const trimmed = item.trim()
  if (!trimmed) {
    return 'unknown'
  }
  const bare = new RegExp(`^${IDENT_SOURCE}$`)
  const qualified = new RegExp(`^${IDENT_SOURCE}\\s*\\.\\s*(${IDENT_SOURCE}|\\*)$`)
  if (bare.test(trimmed) || qualified.test(trimmed)) {
    return 'column'
  }
  return trimmed.endsWith(')') ? 'function' : 'expression'
}

/**
 * 从「语句内光标之前的文本」推导列补全意图。
 *
 * 规则完全由结构给出：
 *
 * | 光标状态            | 依据                                   | 模式    |
 * | ------------------- | -------------------------------------- | ------- |
 * | `SELECT t.`         | SELECT 列表内 + 限定符 + 空前缀         | multi   |
 * | `SELECT `           | SELECT 列表内 + 新项，还没输入          | multi   |
 * | `SELECT t.user_id, `| 逗号后已落空白（新项还没开始输入）      | multi   |
 * | `SELECT t.user_id,` | 逗号紧跟光标（还在上一项的收尾手感里）  | single  |
 * | `SELECT t.em`       | 已经在输入词                            | single  |
 * | `SELECT func(a, `   | 括号深度 > 0，不是 SELECT 列表          | single  |
 * | `INSERT INTO t (a,` | 命中关键字不是 select                   | single  |
 *
 * 「逗号紧跟光标 = single」是产品规则：`t.user_id,|` 是**继续写下一列**的手感，
 * 此时不该弹一屏复选框；用户主动落下空格（`, |`）才算「开始新的一项」。
 */
export function readColumnIntent(prefix: string): SqlColumnIntent {
  const scan = scanClause(prefix)
  const intent = emptyColumnIntent()
  /*
   * INPUT：`SELECT` 列表（含 `SELECT DISTINCT` —— DISTINCT 是列表开头的修饰，
   * 位置仍然是「新的一项」）。其它关键字（WHERE / ON / SET…）不是输出项，一律空意图。
   */
  const inSelectList = scan.keyword === 'select'
    || scan.keyword === 'distinct'
    || scan.keyword === 'all'
  if (scan.kind !== 'column' || !inSelectList) {
    return intent
  }

  /*
   * tail 是「当前输出项」的原文（光标前最后一个同层逗号 / SELECT 之后的全部文本，
   * **保留空白**）：`,|` 与 `, |` 的差别全在里面，所以不能用 ClauseScan.tail ——
   * 那份是 trim 过的，正好把要判的那个空格吃掉了。
   */
  const item = itemTailOf(prefix)
  if (parenDepthOf(item.text) !== 0) {
    return intent
  }

  const afterComma = item.afterComma
  const itemText = item.text
  const commaFollowedBySpace = afterComma && /^\s/.test(itemText)
  const previousText = afterComma ? previousItemText(prefix) : ''

  const { qualifier, prefix: word } = qualifierAndPrefix(itemText)
  // `DISTINCT` / `ALL` 只是列表开头的修饰，不算「已经在输入词」
  const typedWord = ITEM_ONLY_KEYWORDS.has(word.toLowerCase()) ? '' : word
  const mode: ColumnCompletionMode = (() => {
    // 逗号紧跟光标：继续写下一列的单选状态
    if (afterComma && !commaFollowedBySpace) {
      return 'single'
    }
    // 逗号后落空白 / 限定符后空前缀 / 列表刚开：都是「新的一项还没开始输入」
    if (!typedWord) {
      return 'multi'
    }
    return 'single'
  })()

  return {
    isColumnList: true,
    qualifier,
    prefix: word,
    afterComma,
    commaFollowedBySpace,
    previousItemKind: itemKindOf(previousText),
    previousQualifier: previousQualifierOf(previousText),
    itemText: itemText.trim(),
    itemEmpty: isEmptyItem(itemText, qualifier, word),
    mode,
  }
}

/**
 * 输出项里的「词 + 左侧限定符」。
 *
 * `t.` → qualifier `t`、prefix 空串；`t.em` → `t` / `em`；`em` → 空串 / `em`。
 * 限定符必须紧贴点号，所以「表达式里的点号」（`a + b.`）不会被误认成限定符。
 */
function qualifierAndPrefix(itemText: string): { qualifier: string, prefix: string } {
  const trimmed = itemText.trimEnd()
  const word = new RegExp(`${IDENT_BODY_SOURCE}$`).exec(trimmed)?.[0] ?? ''
  const before = trimmed.slice(0, trimmed.length - word.length)
  const dot = /\.\s*$/.exec(before)
  if (!dot) {
    return { qualifier: '', prefix: word }
  }
  const head = before.slice(0, dot.index).trimEnd()
  const qualifier = new RegExp(`(${IDENT_SOURCE})$`).exec(head)?.[1] ?? ''
  return { qualifier, prefix: word }
}

/** 上一个输出项用的限定符（`t.user_id` → `t`；没有则空串） */
function previousQualifierOf(itemText: string): string {
  const trail = new RegExp(`(${IDENT_SOURCE})\\s*\\.\\s*${IDENT_SOURCE}\\s*$`).exec(itemText.trim())
  return trail?.[1] ?? ''
}

// ---------------------------------------------------------------- 光标语义

/**
 * SQL 光标语义（文本层）。
 *
 * 一次分析把「在哪条语句 / 什么位置 / 正在输入什么 / 列补全是什么意图」全部落在
 * 这个对象上，上层（触发策略、候选生成、复选框渲染）不再各自推导。
 */
export interface SqlCursorText {
  /** 光标所在语句 */
  statement: TextRange | null
  /**
   * 语句边界：光标是「仍在语句里 / 语句后的空白」还是「已进入新语句」。
   *
   * 新语句（空行之后、分号之后、文件开头）的 `statement` 只覆盖新语句本身，
   * 因此作用域解析不会看到上一条 SQL 的表与别名。
   */
  statementBoundary: SqlStatementBoundary
  /** 语句内光标之前的文本（子句扫描的输入） */
  clausePrefix: string
  /** 上面这段文本在文档中的起点 */
  prefixStart: number
  /** 子句扫描结论（含命中的关键字与它左边那个词） */
  clause: ClauseScan
  /** 位置类别（触发策略与候选生成共用） */
  kind: CompletionContextKind
  /** 列补全意图（列模式 / 限定符 / 逗号状态；复选框与空格都据此判断） */
  column: SqlColumnIntent
  /** 语句的主关键字（select / update / insert / delete…），判不出为空串 */
  command: string
  /**
   * 当前 JOIN 的源（最近一个 `JOIN` 后面的表与别名）。
   *
   * 关联条件生成用它当「ON 左侧的表」，而不是靠作用域数组的先后顺序猜 ——
   * 派生表、CTE、多级 JOIN 混在一起时，顺序并不可靠。取不到时为 null。
   */
  joinTarget: { table: string, alias: string } | null
}

/** 分析光标（只做文本扫描，不查元数据，可在每次按键时廉价调用） */
export function analyzeSqlCursorText(
  state: EditorState,
  pos: number,
  dbType = '',
): SqlCursorText {
  const doc = state.doc.toString()
  const context = completionStatementContext(doc, pos, dbType)
  const clausePrefix = currentClausePrefix(doc, pos, context?.range ?? null)
  const clause = scanClause(clausePrefix)

  return {
    statement: context?.range ?? null,
    statementBoundary: context?.boundary ?? 'new-statement',
    clausePrefix,
    prefixStart: pos - clausePrefix.length,
    clause,
    kind: sqlContextKindOf(clause, clausePrefix),
    column: readColumnIntent(clausePrefix),
    command: mainCommandOf(clausePrefix),
    joinTarget: joinTargetOf(clausePrefix),
  }
}

/**
 * 取最近一个 `JOIN` 后面的表与别名。
 *
 * `JOIN orders o ON …` → `{ table: 'orders', alias: 'o' }`。
 * `JOIN (SELECT …) o ON …` 这种派生表拿不到（返回 null），
 * 调用方退回「作用域里最后加入的表」。
 */
function joinTargetOf(clausePrefix: string): { table: string, alias: string } | null {
  let end = -1
  for (const match of clausePrefix.matchAll(/\bjoin\b/gi)) {
    end = (match.index ?? 0) + match[0].length
  }
  if (end < 0) {
    return null
  }

  const rest = clausePrefix.slice(end)
  const parsed = readQualifiedName(rest, 0)
  if (!parsed?.parts.length) {
    return null
  }

  const table = parsed.parts[parsed.parts.length - 1]
  const alias = readAlias(rest, parsed.end)?.alias ?? table
  return { table, alias }
}

/** 语句的主关键字：跳过前导空白与注释后的第一个词（select / with / update…） */
function mainCommandOf(clausePrefix: string): string {
  let index = 0
  while (index < clausePrefix.length) {
    const ch = clausePrefix[index]
    if (/\s/.test(ch)) {
      index++
      continue
    }
    if ((ch === '-' && clausePrefix[index + 1] === '-') || ch === '#') {
      const lineEnd = clausePrefix.indexOf('\n', index)
      index = lineEnd < 0 ? clausePrefix.length : lineEnd + 1
      continue
    }
    if (ch === '/' && clausePrefix[index + 1] === '*') {
      const blockEnd = clausePrefix.indexOf('*/', index + 2)
      index = blockEnd < 0 ? clausePrefix.length : blockEnd + 2
      continue
    }
    break
  }

  const match = /^[A-Za-z_]+/.exec(clausePrefix.slice(index))
  return match ? match[0].toLowerCase() : ''
}

/**
 * SQL 美化与压缩（编辑器操作行的「美化 / 压缩」按钮用）。
 *
 * 分工：
 *  - 美化：用 sql-formatter（方言感知，MySQL / PostgreSQL 各一套关键字与引号规则），
 *    关键字统一大写、两空格缩进；
 *  - 压缩：自己实现——只需正确跳过字符串与引号标识符，其余空白折叠成单个空格、
 *    注释直接丢弃即可，引库反而更重。
 */
import { format } from 'sql-formatter'
import type { SqlDialect } from '@/utils/sql/rowSql'

/** 美化 SQL（按方言） */
export function formatSql(sql: string, dialect: SqlDialect): string {
  return format(sql, {
    language: dialect === 'postgres' ? 'postgresql' : 'mysql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
  })
}

/**
 * 压缩 SQL：折叠多余空白、去掉注释。
 * 字符串字面量（'…'）、引号标识符（"…" / `…`）内部原样保留，转义按 SQL 习惯处理。
 */
export function minifySql(sql: string): string {
  let out = ''
  /** 上一段是否遇到了空白（延迟到下一个实际字符前再补一个空格） */
  let pendingSpace = false

  const push = (text: string) => {
    if (pendingSpace && out && !out.endsWith(' ')) {
      out += ' '
    }
    pendingSpace = false
    out += text
  }

  let i = 0
  while (i < sql.length) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    // 字符串 / 引号标识符：整体原样拷贝
    if (ch === `'` || ch === '"' || ch === '`') {
      const quote = ch
      let literal = quote
      let j = i + 1
      while (j < sql.length) {
        const c = sql[j] ?? ''
        if (c === '\\') {
          literal += c + (sql[j + 1] ?? '')
          j += 2
          continue
        }
        if (c === quote) {
          // 连续两个引号是转义写法，继续留在字面量内
          if (sql[j + 1] === quote) {
            literal += quote + quote
            j += 2
            continue
          }
          j++
          break
        }
        literal += c
        j++
      }
      if (!literal.endsWith(quote)) {
        literal += quote
      }
      push(literal)
      i = j
      continue
    }

    // 行注释：整行丢弃
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        i++
      }
      pendingSpace = true
      continue
    }

    // 块注释：整段丢弃
    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i++
      }
      i += 2
      pendingSpace = true
      continue
    }

    if (/\s/.test(ch)) {
      pendingSpace = true
      i++
      continue
    }

    // 分号：去掉前面可能的空格，分号后统一跟一个空格
    if (ch === ';') {
      out = `${out.trimEnd()}; `
      pendingSpace = false
      i++
      continue
    }

    push(ch)
    i++
  }

  return out.trim()
}

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 单条日志的前缀类型 */
export type LogKind = 'request' | 'success' | 'error' | 'info'

export const useLogStore = defineStore('logs', () => {
  /** 日志行集合；每条记录可能包含多行（如请求行 + SQL 缩进） */
  const entries = ref<string[]>([])

  /** 日志保留上限，由外部（configStore）同步 */
  const maxLines = ref(200)

  /** 追加一条日志并裁剪到上限 */
  function append(text: string) {
    entries.value.push(text)

    // 超出上限时丢弃最旧的记录
    const limit = maxLines.value
    if (entries.value.length > limit) {
      entries.value = entries.value.slice(-limit)
    }
  }

  /**
   * 记录一次请求。
   * 格式：`>> [时间] [连接名@库] 执行SQL: <单行 SQL>`
   * 带上库名，是为了让「这条 SQL 到底打在哪个库上」一目了然——
   * 不带库名的语句（`SELECT * FROM t`）取的就是这里显示的库。
   * SQL 压成单行便于按行阅读；过长时由编辑器自动换行。
   */
  function logRequest(connName: string, sql: string, database = '') {
    const time = now()
    const target = database ? `[${connName}@${database}]` : `[${connName}]`
    append(`>> [${time}] ${target} 执行SQL: ${flattenSql(sql)}`)
  }

  /**
   * 记录执行成功。
   * 带上实际生效的库：0 行时能一眼看出「查的是哪个库」，避免误以为是语句写错。
   */
  function logSuccess(rowCount: number, elapsedMs: number, database = '') {
    const where = database ? ` · 库 ${database}` : ''
    append(`<< [${now()}] 成功: 共 ${rowCount} 行, 耗时 ${elapsedMs}ms${where}`)
  }

  /** 记录执行错误 */
  function logError(message: string) {
    append(`<< [${now()}] 错误: ${message}`)
  }

  /**
   * 记录分页改写后的 SQL。
   *
   * 请求行照旧展示用户输入的原文，这里补一条「实际执行」——
   * 界面上把页大小设为 30 之类的值后，能直接看到拼上去的 LIMIT / OFFSET。
   */
  function logPagedSQL(sql: string) {
    append(`<< [分页] 实际执行: ${flattenSql(sql)}`)
  }

  /** 清空日志 */
  function clear() {
    entries.value = []
  }

  /** 同步日志上限 */
  function setMaxLines(limit: number) {
    maxLines.value = limit > 0 ? limit : 200
    if (entries.value.length > maxLines.value) {
      entries.value = entries.value.slice(-maxLines.value)
    }
  }

  return {
    entries,
    maxLines,
    append,
    logRequest,
    logSuccess,
    logError,
    logPagedSQL,
    clear,
    setMaxLines,
  }
})

/** 当前时间 HH:mm:ss */
function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 把多行 SQL 压成单行。
 *
 * 只压缩引号（' " `）之外的空白，避免破坏字符串字面量里的空格；
 * 连续空白统一收敛为一个空格，换行符一并去掉。
 */
function flattenSql(sql: string): string {
  let result = ''
  let pendingSpace = false
  let inSingle = false
  let inDouble = false
  let inBacktick = false

  for (const ch of sql) {
    if (ch === '\'' && !inDouble && !inBacktick) {
      inSingle = !inSingle
    }
    else if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble
    }
    else if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick
    }

    const quoted = inSingle || inDouble || inBacktick

    if (!quoted && /\s/.test(ch)) {
      pendingSpace = true
      continue
    }

    if (pendingSpace) {
      if (result) {
        result += ' '
      }
      pendingSpace = false
    }
    result += ch
  }

  return result.trim()
}

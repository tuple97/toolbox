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

  /** 记录一次请求 */
  function logRequest(connName: string, sql: string, database = '') {
    const time = now()
    const target = database ? `[${connName}@${database}]` : `[${connName}]`
    append(`>> [${time}] ${target} 执行SQL: ${flattenSql(sql)}`)
  }

  /** 记录执行成功 */
  function logSuccess(rowCount: number, elapsedMs: number, database = '') {
    const where = database ? ` · 库 ${database}` : ''
    append(`<< [${now()}] 成功: 共 ${rowCount} 行, 耗时 ${elapsedMs}ms${where}`)
  }

  /** 记录执行错误 */
  function logError(message: string) {
    append(`<< [${now()}] 错误: ${message}`)
  }

  /** 记录分页改写后的 SQL */
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

/** 把多行 SQL 压成单行 */
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

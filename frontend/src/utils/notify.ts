/** 应用内提示（替代 Element Plus 的 ElMessage）：响应式队列 + 宿主组件 Toaster.vue */
import { readonly, ref } from 'vue'

export type NoticeTone = 'success' | 'error' | 'warning' | 'info'

export interface Notice {
  id: number
  tone: NoticeTone
  /** 正文（整句，由调用方拼好） */
  message: string
}

/** 停留时长（毫秒） */
const NOTICE_DURATION_MS = 3000
/** 最多同时显示几条 */
const MAX_VISIBLE = 4

const notices = ref<Notice[]>([])
let seq = 0

function push(tone: NoticeTone, message: string): number {
  const id = ++seq
  // 拷贝生成新数组，读方触发更可预期
  notices.value = [...notices.value, { id, tone, message }].slice(-MAX_VISIBLE)
  setTimeout(() => dismiss(id), NOTICE_DURATION_MS)
  return id
}

/** 关掉某条提示（到时间自动触发，也可由关闭按钮触发） */
export function dismiss(id: number) {
  notices.value = notices.value.filter(notice => notice.id !== id)
}

/** 当前提示列表（宿主组件消费；用例也用它断言） */
export const activeNotices = readonly(notices)

/** 与旧 `ElMessage` 同形的四个入口 */
export const notify = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  warning: (message: string) => push('warning', message),
  info: (message: string) => push('info', message),
}

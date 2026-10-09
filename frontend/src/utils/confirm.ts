/** 确认对话框（替代 Element Plus 的 ElMessageBox.confirm）：返回 boolean，取消是正常分支 */
import { readonly, ref } from 'vue'

export interface ConfirmOptions {
  /** 正文 */
  message: string
  title?: string
  confirmText?: string
  cancelText?: string
  /** 语气：不可撤销的操作用 danger */
  tone?: 'warning' | 'danger'
}

/** 待确认请求（宿主组件 ConfirmHost.vue 消费） */
export interface PendingConfirm {
  /** 请求序号 */
  id: number
  title: string
  message: string
  confirmText: string
  cancelText: string
  tone: 'warning' | 'danger'
}

const pending = ref<PendingConfirm | null>(null)
let resolver: ((ok: boolean) => void) | null = null
let seq = 0

/** 当前待确认的请求（无则 null） */
export const pendingConfirm = readonly(pending)

/** 弹一个确认框：确定 true，取消 / Esc / 点遮罩 false */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  resolver?.(false)
  seq += 1
  pending.value = {
    id: seq,
    title: options.title ?? '请确认',
    message: options.message,
    confirmText: options.confirmText ?? '确定',
    cancelText: options.cancelText ?? '取消',
    tone: options.tone ?? 'warning',
  }
  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

/** 宿主组件结算当前请求（确定 / 取消都走这里） */
export function settleConfirm(ok: boolean) {
  const resolve = resolver
  resolver = null
  pending.value = null
  resolve?.(ok)
}

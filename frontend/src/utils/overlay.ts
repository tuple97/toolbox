/** 浮层层级与滚动锁：层级单调递增，保证后打开的一定在上层 */

/** 起始层级：高于普通内容，低于通知等系统级浮层 */
const BASE_Z_INDEX = 9990

let seed = BASE_Z_INDEX

/** 取下一个可用层级（每次调用都更大，不回收） */
export function nextOverlayZIndex(): number {
  seed += 1
  return seed
}

/** 当前持有滚动锁的浮层数量 */
let lockCount = 0

/** 锁定 / 解锁页面滚动；用计数以支持嵌套弹窗 */
export function lockBodyScroll(lock: boolean): void {
  lockCount = lock ? lockCount + 1 : Math.max(0, lockCount - 1)
  document.body.style.overflow = lockCount > 0 ? 'hidden' : ''
}

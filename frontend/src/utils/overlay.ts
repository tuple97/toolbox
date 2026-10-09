/**
 * 浮层层级与滚动锁。
 *
 * 所有 Dialog 都 Teleport 到 body，若层级写成同一个常量，
 * 上下关系就只能靠 DOM 顺序决定 —— 而顺序取决于各自锚点的创建时机
 * （常驻的确认框组件挂在 App 里，锚点比按需渲染的详情弹窗更靠前），
 * 于是「弹窗里再弹一个」时，后开的那个反而被压在下面。
 *
 * 这里改用单调递增的数值，让「后打开的一定在上层」成为确定行为。
 */

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

/**
 * 锁定 / 解锁页面滚动。
 *
 * 用计数而不是直接赋值：嵌套弹窗时，内层关闭不应该把外层
 * 还需要保持的滚动锁一并放掉。
 */
export function lockBodyScroll(lock: boolean): void {
  lockCount = lock ? lockCount + 1 : Math.max(0, lockCount - 1)
  document.body.style.overflow = lockCount > 0 ? 'hidden' : ''
}

/** 浮层定位（下拉 / 选择器的 Teleport 浮层用） */
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'

export interface PopoverPosition {
  left: number
  top: number
  width: number
}

export interface PopoverAnchorOptions {
  /** 浮层与触发器之间的间隙 */
  gap?: number
  /** 浮层最大高度（与样式里的 max-height 一致） */
  maxHeight?: number
}

export function usePopoverAnchor(
  trigger: Ref<HTMLElement | null>,
  panel: Ref<HTMLElement | null>,
  options: PopoverAnchorOptions = {},
) {
  const gap = options.gap ?? 4
  const maxHeight = options.maxHeight ?? 256

  /** 浮层位置（配合 `position: fixed` 使用） */
  const position = ref<PopoverPosition>({ left: 0, top: 0, width: 0 })

  /** 重新计算位置；refine 时渲染完再修正一次 */
  async function update(refine = true) {
    const el = trigger.value
    if (!el) {
      return
    }
    const rect = el.getBoundingClientRect()
    const height = Math.min(panel.value?.offsetHeight || maxHeight, maxHeight)
    const below = window.innerHeight - rect.bottom - gap
    // 下方放不下、且上方更宽敞 → 向上弹
    const up = below < height && rect.top - gap > below
    position.value = {
      left: rect.left,
      width: rect.width,
      top: up ? Math.max(gap, rect.top - gap - height) : rect.bottom + gap,
    }
    if (refine) {
      await nextTick()
      await update(false)
    }
  }

  /** 视口变化（含祖先容器滚动）时跟着挪：capture 才能收到内层滚动 */
  function handleViewportChange() {
    void update(false)
  }

  function bind() {
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)
  }

  function unbind() {
    window.removeEventListener('scroll', handleViewportChange, true)
    window.removeEventListener('resize', handleViewportChange)
  }

  return { position, update, bind, unbind }
}

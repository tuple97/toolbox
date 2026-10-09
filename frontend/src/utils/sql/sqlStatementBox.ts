/**
 * 当前语句边框：给光标所在的那条 SQL 画一个**连续的矩形框**。
 *
 * 核心是用 CodeMirror 自带的图层设施绘制（另有两处针对本项目的调整，见下）：
 *
 *  - `layer({ above: true, markers, update })` + `RectangleMarker`：与 CM 画光标层、
 *    选区层用的是同一套机制，**每个 measure 周期都会重跑 `markers()`**，滚动、改窗口、
 *    软换行重排、改字体全由 CM 驱动重绘 —— 不需要自己挂 ResizeObserver，也不用猜
 *    「这次几何变了没有」，早先那套「停稳后重测」的补丁因此全部删除；
 *  - `above: true`：层排在文本之上（CM 给的 z-index 从 150 起），主题里不透明的
 *    当前行底色不会把只占一行的语句框盖住；
 *  - 标记坐标是**文档坐标**，层随内容一起滚动，无需换算滚动偏移。
 *
 * 相对参考实现的两处调整：
 *  1. **只对已渲染的行做几何探针**：离屏行调 `coordsAtPos` 本来也只会拿到 null，
 *     这里先用 `visibleRanges` 框出真正渲染出来的行区间，区间外的行直接走
 *     「语句起点 x + 字数 × 字宽」估算，省掉大量无用的布局查询；
 *  2. **语句整体不在视口内时直接放弃**：既不必量也不必画（CM 会在滚动后重跑）。
 *
 * 量法：纵向取 `coordsAtPos` 的 top/bottom，拿不到时退回 `lineBlockAt`（它本身就是
 * 文档坐标）；横向逐行取行首的 `left` 与行尾的 `right`；某行的首尾落在不同视觉行
 * 说明发生了软换行，此时把**内容视口的左右边界**并进来（中间那些视觉行会一直排到
 * 折行边缘，即使最后一行很短）。四边各留 `BOX_INSET_PX` 的呼吸感；语句跨行超过
 * `MAX_BOXED_LINES` 时不画（PL/SQL 包体常是一整条语句，逐行探针会拖慢滚动）。
 */
import type { EditorView, LayerMarker, ViewUpdate } from '@codemirror/view'
import * as cmView from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { statementAtCursor, statementEndWithSemicolon } from '@/utils/sql/sqlStatementRanges'

/** 边框与文字之间留的呼吸感（像素） */
const BOX_INSET_PX = 2

/** 语句行数超过该值不画边框（逐行探针的代价上限） */
const MAX_BOXED_LINES = 500

/** 一个待绘制的框（文档坐标） */
interface StatementBox {
  left: number
  top: number
  width: number
  height: number
}

/** 需要框的文档范围 */
interface BoxRange {
  from: number
  to: number
}

/**
 * `layer` 与 `RectangleMarker` 是 @codemirror/view 的**内部 API**：运行时确实导出
 * （CM 自己的光标层、选区层就用它），但类型声明里没有公开。这里按参考项目的做法
 * 用模块对象接过来，并给出最小可用的类型；万一将来被移除，`statementBoxExtension`
 * 会安静地不画框，而不是让编辑器整个挂掉。
 */
interface LayerConfig {
  above?: boolean
  class?: string
  markers(view: EditorView): readonly LayerMarker[]
  update(update: ViewUpdate, layer: HTMLElement): boolean
}

interface LayerApi {
  layer: (config: LayerConfig) => Extension
  RectangleMarker: new (className: string, left: number, top: number, width: number | null, height: number) => LayerMarker
}

const layerApi = cmView as unknown as LayerApi

/**
 * 量框需要用到视图成员。这里不 `Pick<EditorView, ...>`：其中 scaleX、
 * defaultCharacterWidth、visibleRanges 都属于内部成员，类型声明与运行时形态
 * 并不一致，直接用会让编译器与实现互相打架。改为按实际用到的形态自行声明，
 * 并在使用处做运行时判断（见 `renderedLineSpan`）。
 */
interface GeometryView {
  state: EditorView['state']
  coordsAtPos(pos: number, side?: -1 | 0 | 1): { top: number; bottom: number; left: number; right: number } | null
  defaultCharacterWidth: number
  defaultLineHeight: number
  /** 页面缩放比例 */
  scaleX: number
  /** 已渲染的文档范围；取不到时返回 undefined，此时按「全部行都可能已渲染」处理 */
  visibleRanges?: readonly { from: number; to: number }[]
  lineBlockAt(pos: number): { top: number; bottom: number; height: number }
  scrollDOM: Pick<HTMLElement, 'scrollLeft' | 'scrollTop' | 'getBoundingClientRect'>
  contentDOM: Pick<HTMLElement, 'getBoundingClientRect'>
}

type PositionRect = NonNullable<ReturnType<EditorView['coordsAtPos']>>

/**
 * 视口真正渲染出来的行号区间。
 * `visibleRanges` 是内部成员，取不到就返回 null（调用方退回「全部行都当已渲染」）。
 */
function renderedLineSpan(view: GeometryView): { first: number; last: number } | null {
  const ranges = view.visibleRanges
  if (!Array.isArray(ranges) || ranges.length === 0) return null
  const doc = view.state.doc
  return {
    first: doc.lineAt(ranges[0].from).number,
    last: doc.lineAt(ranges[ranges.length - 1].to).number,
  }
}

/** 两个端点是否落在不同的视觉行（即发生了软换行） */
function softWraps(view: GeometryView, line: { from: number; to: number }, lineFrom: number, lineTo: number, fromRect: PositionRect | null, toRect: PositionRect | null): boolean {
  if (fromRect && toRect) {
    const fromMid = (fromRect.top + fromRect.bottom) / 2
    const toMid = (toRect.top + toRect.bottom) / 2
    const minHeight = Math.min(fromRect.bottom - fromRect.top, toRect.bottom - toRect.top)
    return Math.abs(fromMid - toMid) > Math.max(2, minHeight / 2)
  }
  // 拿不到坐标时退回行高判断：整行参与且高度明显超过单行高度，说明折成了多行
  const wholeLine = lineFrom === line.from && lineTo === line.to
  return wholeLine && view.lineBlockAt(lineFrom).height > view.defaultLineHeight * 1.5
}

/** 量出语句的矩形；量不出来返回 null */
function measureStatementBox(view: GeometryView, from: number, to: number): StatementBox | null {
  const doc = view.state.doc
  if (to <= from || from < 0 || to > doc.length) return null

  const firstLine = doc.lineAt(from)
  const lastLine = doc.lineAt(Math.max(from, to - 1))
  if (lastLine.number - firstLine.number >= MAX_BOXED_LINES) return null

  const rendered = renderedLineSpan(view)
  // 整条语句滚出视口：画了也看不见，直接跳过
  if (rendered && (lastLine.number < rendered.first || firstLine.number > rendered.last)) return null

  const viewport = view.scrollDOM.getBoundingClientRect()

  // 纵向：优先 coordsAtPos（CM 会为离屏行外推），拿不到时用 lineBlockAt 的文档坐标
  const firstRect = view.coordsAtPos(from, 1)
  const top = firstRect ? firstRect.top - viewport.top + view.scrollDOM.scrollTop : view.lineBlockAt(from).top

  const lastPos = Math.max(from, to - 1)
  const lastRect = view.coordsAtPos(lastPos, -1)
  const bottom = lastRect ? lastRect.bottom - viewport.top + view.scrollDOM.scrollTop : view.lineBlockAt(lastPos).bottom
  if (bottom <= top) return null

  const charWidth = view.defaultCharacterWidth
  /*
   * 离屏行的横向估算基准：**语句起点**的屏幕 x。
   * 起点可见就直接量；否则用「行首 x + 行内偏移 × 字宽」推算（与缩进无关的部分是常量）。
   */
  const statementLeft = (() => {
    const coords = view.coordsAtPos(from, 1)
    if (coords) return coords.left
    const lineStart = view.coordsAtPos(firstLine.from, 1)
    return lineStart ? lineStart.left + (from - firstLine.from) * charWidth : null
  })()

  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let contentBounds: DOMRect | null = null

  for (let number = firstLine.number; number <= lastLine.number; number += 1) {
    const line = doc.line(number)
    const lineFrom = number === firstLine.number ? from : line.from
    const lineTo = Math.min(line.to, to)
    if (lineTo < lineFrom) continue

    const isRendered = !rendered || (number >= rendered.first && number <= rendered.last)
    const fromRect = isRendered ? view.coordsAtPos(lineFrom, 1) : null
    const toRect = isRendered ? view.coordsAtPos(lineTo, -1) : null

    if (fromRect) {
      left = Math.min(left, fromRect.left)
      right = Math.max(right, toRect?.right ?? fromRect.left)
    }
    else if (statementLeft !== null && charWidth > 0) {
      // 离屏行只用于推右边界；左边界由上面至少一个已渲染行给出
      right = Math.max(right, statementLeft + line.length * charWidth)
    }

    if (softWraps(view, line, lineFrom, lineTo, fromRect, toRect)) {
      contentBounds ??= view.contentDOM.getBoundingClientRect()
      left = Math.min(left, contentBounds.left)
      right = Math.max(right, contentBounds.right)
    }
  }

  if (!Number.isFinite(left) || !Number.isFinite(right)) return null

  // 页面缩放时 scrollLeft 是缩放后的像素，换算回文档坐标要乘 scaleX
  const leftOffset = viewport.left - view.scrollDOM.scrollLeft * (view.scaleX || 1)

  return {
    left: left - leftOffset - BOX_INSET_PX,
    top: top - BOX_INSET_PX,
    width: right - left + BOX_INSET_PX * 2,
    height: bottom - top + BOX_INSET_PX * 2,
  }
}

/** 决定框哪一段；返回 null 表示不画 */
type StatementLocator = (view: EditorView) => BoxRange | null

/**
 * 边框扩展。
 *
 * @param locate 解析出要框的语句范围，返回 null 时不画
 */
function statementBoxExtension(locate: StatementLocator): Extension {
  // 内部 API 万一改名/移除，就安静地不画框，而不是让编辑器挂掉
  if (typeof layerApi.layer !== 'function' || typeof layerApi.RectangleMarker !== 'function') {
    return []
  }

  let drawnRange: BoxRange | null | undefined

  const sameRange = (left: BoxRange | null | undefined, right: BoxRange | null): boolean =>
    left === right || (!!left && !!right && left.from === right.from && left.to === right.to)

  return layerApi.layer({
    // 层排在文本之上，主题里不透明的当前行底色盖不住边框
    above: true,
    class: 'cm-sql-box-layer',
    markers(view) {
      const range = locate(view)
      drawnRange = range
      if (!range) return []
      const box = measureStatementBox(view as unknown as GeometryView, range.from, range.to)
      return box
        ? [new layerApi.RectangleMarker('cm-sql-box', box.left, box.top, box.width, box.height)]
        : []
    },
    update(update) {
      // 文档、视口、几何或配置变化都要重画（挂载/字体/宽度变化都会走 geometryChanged）
      if (
        update.docChanged
        || update.viewportChanged
        || update.geometryChanged
        || update.transactions.some(transaction => transaction.reconfigured)
      ) {
        drawnRange = undefined
        return true
      }
      if (!update.selectionSet) return false
      // 同一条语句内移动光标（连按方向键）不重画，避免每帧都做逐行几何探针
      const range = locate(update.view)
      if (sameRange(drawnRange, range)) return false
      drawnRange = undefined
      return true
    },
  })
}

/**
 * 给编辑器装配的入口：框住光标所在语句（含结尾分号）。
 * 语句之间的空行、纯空白处不显示边框。
 */
export function createStatementBoxExtension(getDbType: () => string): Extension {
  return statementBoxExtension((view) => {
    // 直接把文档对象交给切分缓存：光标移动时 doc 引用不变，不会重复扫描整篇文档
    const range = statementAtCursor(view.state.doc, view.state.selection.main.head, getDbType())
    if (!range) return null
    return { from: range.from, to: statementEndWithSemicolon(view.state.doc, range) }
  })
}

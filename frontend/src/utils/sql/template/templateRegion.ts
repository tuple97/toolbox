/**
 * 模板区域的扫描与定位。
 *
 * 「模板区域」= 一段 `{{ … }}`。这里只做**文本级**的配对扫描，不关心
 * 它出现在 SQL 的哪个位置 —— 因此 `'{{ device_no }}'` 这种写在字符串里的
 * 插值同样是模板区域：区域优先于 SQL 的字符串/注释判定，这是混合语言的
 * 基本事实，而不是靠调用顺序凑出来的效果。
 */

/** 光标前回看多远找 `{{`（模板片段不会太长，避免全文扫描） */
const REGION_LOOKBACK = 2000

/** 光标后看多远找 `}}`（判断片段是否已经写完闭合括号） */
const REGION_LOOKAHEAD = 400

/** 一段模板区域 */
export interface TemplateRegion {
  /** `{{` 的下标 */
  openAt: number
  /** 闭合 `}}` 的下标；null 表示片段还没闭合（正在写） */
  closeAt: number | null
  /** 区域内文本（不含分隔符）的起止 */
  bodyFrom: number
  bodyTo: number
  /** 整段范围（闭合时含 `}}`） */
  from: number
  to: number
}

/** 由 `{{` 与可选的 `}}` 组装区域对象 */
function regionOf(openAt: number, closeAt: number | null, docLength: number): TemplateRegion {
  return {
    openAt,
    closeAt,
    bodyFrom: openAt + 2,
    bodyTo: closeAt ?? docLength,
    from: openAt,
    to: closeAt === null ? docLength : closeAt + 2,
  }
}

/**
 * 光标是否在某段未闭合（或已闭合但其内部）的模板区域里，返回该区域。
 *
 * 判定标准：光标之前最近的 `{{` 比最近的 `}}` 更近。
 * 片段是否已经写好 `}}` 由 `closeAt` 单独给出 —— 它决定插入时要不要补右括号，
 * 与「光标在不在区域内」是两件事。
 */
export function templateRegionAt(
  doc: string,
  pos: number,
  lookback = REGION_LOOKBACK,
): TemplateRegion | null {
  const start = Math.max(0, pos - lookback)
  const window = doc.slice(start, pos)
  const open = window.lastIndexOf('{{')
  if (open < 0) {
    return null
  }
  if (window.lastIndexOf('}}') > open) {
    return null
  }

  const after = doc.slice(pos, Math.min(pos + REGION_LOOKAHEAD, doc.length))
  const closeRel = after.indexOf('}}')
  return regionOf(start + open, closeRel < 0 ? null : pos + closeRel, doc.length)
}

/**
 * 扫描范围内的全部模板区域（顺序返回）。
 *
 * 未闭合的最后一段也会返回（`closeAt` 为 null）；`{{` 不嵌套，
 * 因此配对就是简单的先后关系。
 */
export function scanTemplateRegions(doc: string, from = 0, to = doc.length): TemplateRegion[] {
  const regions: TemplateRegion[] = []
  let index = from

  while (index < to) {
    const open = doc.indexOf('{{', index)
    if (open < 0 || open >= to) {
      break
    }
    const close = doc.indexOf('}}', open + 2)
    if (close < 0 || close >= to + 1) {
      regions.push(regionOf(open, null, doc.length))
      break
    }
    regions.push(regionOf(open, close, doc.length))
    index = close + 2
  }
  return regions
}

/**
 * 找出包含某个位置的全部区域（内层优先）。
 *
 * 目前 `{{ … }}` 不允许嵌套，所以至多一段；返回数组是为了将来支持
 * 嵌套结构（例如块内再展开）时调用方不用改。
 */
export function templateRegionStackAt(doc: string, pos: number): TemplateRegion[] {
  const region = templateRegionAt(doc, pos)
  if (!region) {
    return []
  }
  // 已闭合的片段：只有光标落在片段内部（含分隔符之间）才算命中
  if (region.closeAt !== null && pos > region.closeAt + 1) {
    return []
  }
  return [region]
}

/** 模板区域的扫描与定位 */

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

/** 光标是否在某段未闭合（或已闭合但其内部）的模板区域里，返回该区域 */
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

/** 扫描范围内的全部模板区域（顺序返回） */
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

/** 找出包含某个位置的全部区域（内层优先） */
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

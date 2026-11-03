/** 模板占位符：片段插入后可以「一次性改名」的变量位置 */
import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { IDENT_BODY_SOURCE, IDENT_START_SOURCE } from '../sqlLexemes'
import { isTemplateKeyword } from './templateParser'
import { scanTemplateRegions } from './templateRegion'

/** 解析设置项 `template_placeholder_tab`（片段插入后是否用 Tab / 回车跳占位符） */
export function parsePlaceholderTabJump(raw: string | undefined): boolean {
  return raw !== 'false'
}

/** 文档里的一段范围 */
export interface TemplatePlaceholderRange {
  from: number
  to: number
}

/** 一组占位：同一个名字的全部出现位置；`name` 为空表示只是一个跳转位置 */
export interface TemplatePlaceholderGroup {
  /** 占位名（片段里的变量名）；空串表示「只是一个位置」 */
  name: string
  /** 该名字在文档中的所有出现范围（升序、互不重叠） */
  ranges: TemplatePlaceholderRange[]
}

/** 设置（或清空，传 null）占位链 */
export const setTemplatePlaceholders = StateEffect.define<TemplatePlaceholderGroup[] | null>()

/** 占位链：按首次出现位置升序的组 */
const placeholderField = StateField.define<TemplatePlaceholderGroup[]>({
  create: () => [],

  update(groups, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTemplatePlaceholders)) {
        return effect.value ? normalizePlaceholderGroups(effect.value) : []
      }
    }
    if (!tr.docChanged) {
      return groups
    }
    const limit = tr.state.doc.length
    return normalizePlaceholderGroups(groups.map(group => ({
      name: group.name,
      ranges: group.ranges
        // 边界映射：起点向前、终点向后 —— 在占位符上直接输入时范围跟着长，
        // 于是「现在选中的还是这一组」始终成立
        .map(range => ({
          from: tr.changes.mapPos(range.from, -1),
          to: tr.changes.mapPos(range.to, 1),
        }))
        .filter(range => range.from <= range.to && range.to <= limit),
    })))
  },
})

/** 占位链扩展（挂到编辑器即可；没有占位时就是空数组，零开销） */
export function templatePlaceholderExtension(): Extension {
  return [placeholderField, EditorState.allowMultipleSelections.of(true)]
}

/** 当前占位组（按首次出现位置升序） */
export function placeholderGroups(state: EditorState): TemplatePlaceholderGroup[] {
  return state.field(placeholderField, false) ?? []
}

/** 是否正处于「片段占位改编」状态：有占位组，且光标落在某一组里 */
export function isPlaceholderEditing(state: EditorState): boolean {
  const groups = placeholderGroups(state)
  if (!groups.length) {
    return false
  }
  const head = state.selection.main.head
  return groups.some(group =>
    group.ranges.some(range => range.from <= head && head <= range.to))
}

/** 跳到下一组占位并选中它（组内所有出现一起选中） */
export function jumpToNextPlaceholder(view: EditorView): boolean {
  const groups = placeholderGroups(view.state)
  if (!groups.length) {
    return false
  }

  const head = view.state.selection.main.head
  const next = groups.find(group => (group.ranges[0]?.from ?? 0) > head)
  if (!next) {
    clearTemplatePlaceholders(view)
    return false
  }

  view.dispatch({ selection: groupSelection(next), scrollIntoView: true })
  return true
}

/** 清空占位链 */
export function clearTemplatePlaceholders(view: EditorView): void {
  if (!placeholderGroups(view.state).length) {
    return
  }
  view.dispatch({ effects: setTemplatePlaceholders.of(null) })
}

// ---------------------------------------------------------------- 解析与规划

/** 一次「插入片段」的事务计划：改动、占位组与初始选区一次算清 */
export interface TemplateInsertPlan {
  changes: { from: number, to: number, insert: string }
  selection: EditorSelection
  effects: Array<StateEffect<TemplatePlaceholderGroup[] | null>>
  /** 解析出的占位组（调用方要追加「空位置」时可基于它合并） */
  groups: TemplatePlaceholderGroup[]
}

/** 规划一次片段插入 */
export function planTemplateInsert(
  text: string,
  start: number,
  replaceTo: number = start,
): TemplateInsertPlan {
  const groups = planPlaceholders(text, start)
  return {
    changes: { from: start, to: replaceTo, insert: text },
    selection: placeholderSelection(groups, start + text.length),
    effects: [setTemplatePlaceholders.of(groups)],
    groups,
  }
}

/** 解析一段模板文本里的占位变量，返回文档坐标下的占位组（`offset` 为文本起点） */
export function planPlaceholders(text: string, offset = 0): TemplatePlaceholderGroup[] {
  const names = placeholderNamesOf(text)
  if (!names.size) {
    return []
  }

  const byName = new Map<string, TemplatePlaceholderRange[]>()
  for (const word of wordsOf(text, offset)) {
    if (!names.has(word.name)) {
      continue
    }
    const ranges = byName.get(word.name)
    if (ranges) {
      ranges.push({ from: word.from, to: word.to })
    }
    else {
      byName.set(word.name, [{ from: word.from, to: word.to }])
    }
  }

  return normalizePlaceholderGroups(
    [...byName].map(([name, ranges]) => ({ name, ranges })),
  )
}

/** 占位名集合：只认 `{{ }}` 内部作为变量出现的词 */
function placeholderNamesOf(text: string): Set<string> {
  const names = new Set<string>()
  for (const region of scanTemplateRegions(text, 0, text.length)) {
    const body = text.slice(region.bodyFrom, region.closeAt ?? text.length)
    for (const word of wordsOf(body, region.bodyFrom)) {
      names.add(word.name)
    }
  }
  return names
}

/** 第一组占位的选区（组内所有出现一起选中）；没有占位时退化为 `fallback` 处的光标 */
export function placeholderSelection(
  groups: TemplatePlaceholderGroup[],
  fallback: number,
): EditorSelection {
  const first = groups[0]
  return first ? groupSelection(first) : EditorSelection.single(fallback)
}

/** 一组占位的选区：组内所有出现一起选中（同名多处 = 多光标） */
export function groupSelection(group: TemplatePlaceholderGroup): EditorSelection {
  return EditorSelection.create(
    group.ranges.map(range => EditorSelection.range(range.from, range.to)),
    0,
  )
}

/** 规整占位链：组内范围按位置排序去重、丢掉空组、组间按首次出现排序 */
export function normalizePlaceholderGroups(
  groups: TemplatePlaceholderGroup[],
): TemplatePlaceholderGroup[] {
  return groups
    .map(group => ({
      name: group.name,
      ranges: [...group.ranges]
        // 无名字的组是「空位置」（骨架的块体行首），零宽是它的正常形态；
        // 有名字的组必须真的覆盖一段文字，零宽的丢掉（文字被删掉了）
        .filter(range => group.name === '' || range.to > range.from)
        .sort((left, right) => left.from - right.from),
    }))
    .filter(group => group.ranges.length > 0)
    .sort((left, right) => left.ranges[0].from - right.ranges[0].from)
}

// ---------------------------------------------------------------- 词法

/** 模板标识符：与 sqlLexemes 同一套字符（含 `$` 前缀的局部变量与中文占位名） */
const TEMPLATE_WORD = new RegExp(`${IDENT_START_SOURCE}${IDENT_BODY_SOURCE}`, 'g')

/** 字符串字面量：引号里的词不是变量，扫描前先等长掩掉 */
const TEMPLATE_STRING_LITERAL = /"[^"\\]*(?:\\.[^"\\]*)*"|`[^`]*`/g

/** 片段里的一个词 */
interface PlaceholderWord {
  name: string
  from: number
  to: number
}

/** 取出一段文本里所有「可能是占位变量」的词（文档坐标） */
function wordsOf(text: string, offset: number): PlaceholderWord[] {
  const masked = text.replace(TEMPLATE_STRING_LITERAL, match => ' '.repeat(match.length))
  const words: PlaceholderWord[] = []
  TEMPLATE_WORD.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = TEMPLATE_WORD.exec(masked))) {
    const name = match[0]
    const before = masked.slice(0, match.index)
    if (!isPlaceholderName(name, before)) {
      continue
    }
    words.push({ name, from: offset + match.index, to: offset + match.index + name.length })
  }
  return words
}

/** 这个词算不算占位变量 */
function isPlaceholderName(name: string, before: string): boolean {
  if (name.startsWith('$')) {
    return false
  }
  if (before.endsWith('.')) {
    return false
  }
  return !isTemplateKeyword(name)
}

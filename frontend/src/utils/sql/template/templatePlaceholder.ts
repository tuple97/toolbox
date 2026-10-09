/**
 * 模板占位符：片段插入后可以「一次性改名」的变量位置。
 *
 * 模型是**占位组**（`TemplatePlaceholderGroup`）：一个名字 + 它在文档里的所有出现位置。
 *
 *  - 片段里的变量合成一组：`{{if 变量}} AND 变量 = {{变量}} {{end}}` 的三处 `变量`
 *    是一组，选中时用**原生多选区**把三处一起选中 —— 输入即同步，
 *    改一处等于改全部（比「提交时批量替换」少一次心智负担）；
 *  - 骨架里的空位置（块体行首）是「无名字的零宽组」，只作为跳转目标。
 *
 * 位置存在 `StateField` 里：随编辑自动漂移、不写进文档、不进撤销历史。
 * Tab 与回车都在组之间依次跳（见 CodeEditor 的键位），跳到最后一组之后自动释放。
 *
 * 「哪些词是占位变量」由文本解析得出（`planPlaceholders`）：标识符词法取自
 * `sqlLexemes`、关键字表取自 `templateParser` / `templateFunctions`，
 * 因此片段库里新增一条片段、或新增一个模板函数，这里都不需要改代码。
 */
import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { IDENT_BODY_SOURCE, IDENT_START_SOURCE } from '../sqlLexemes'
import { isTemplateKeyword } from './templateParser'
import { scanTemplateRegions } from './templateRegion'

/**
 * 解析设置项 `template_placeholder_tab`（片段插入后是否用 Tab / 回车跳占位符）。
 *
 * 默认**开启**（与改造前一致），只有明确写成 `false` 才关；
 * 关掉后 Tab 回到缩进行为、回车回到换行。调用方在**按键时**读它，
 * 于是改完设置立即生效。
 */
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

/**
 * 占位链扩展（挂到编辑器即可；没有占位时就是空数组，零开销）。
 *
 * 一并开启多选区：同名占位要「一处改、处处改」，靠的就是多光标选区；
 * 而 CodeMirror 默认会把多选区收敛成单选区（`selection.asSingle()`），
 * 于是这件事必须由扩展自己声明 —— 不能指望每个调用方都记得开。
 */
export function templatePlaceholderExtension(): Extension {
  return [placeholderField, EditorState.allowMultipleSelections.of(true)]
}

/** 当前占位组（按首次出现位置升序） */
export function placeholderGroups(state: EditorState): TemplatePlaceholderGroup[] {
  return state.field(placeholderField, false) ?? []
}

/**
 * 是否正处于「片段占位改编」状态：有占位组，且光标落在某一组里。
 *
 * 与表别名重命名同一套约定：这时**不给补全候选**（否则回车会被补全截走、
 * 多选区也可能被只替换主选区），回车归「跳到下一个占位」。
 */
export function isPlaceholderEditing(state: EditorState): boolean {
  const groups = placeholderGroups(state)
  if (!groups.length) {
    return false
  }
  const head = state.selection.main.head
  return groups.some(group =>
    group.ranges.some(range => range.from <= head && head <= range.to))
}

/**
 * 跳到下一组占位并选中它（组内所有出现一起选中）。
 *
 * 没有占位、或已经走到最后一组时返回 false —— 交回默认的 Tab / 回车行为。
 */
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

/**
 * 规划一次片段插入。
 *
 * 用 `[start, replaceTo)` 换成本段文本（默认只是插入到 start），
 * 占位组按**插入后**的文档坐标给出，初始选区落在第一组上。
 */
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

/**
 * 解析一段模板文本里的占位变量，返回文档坐标下的占位组（`offset` 为文本起点）。
 *
 * 分两遍扫描：
 *  1. 先在 `{{ }}` 里找出**占位名集合** —— 只有作为模板变量出现过的词才算占位，
 *     这样普通 SQL 文本里的词（`INSERT` / `VALUES` / 列名）不会被误判；
 *  2. 再按这个名字集合扫全文（含普通文本），把同名出现全部收进同一组。
 *
 * 于是 `{{if 变量}} AND 变量 = {{变量}} {{end}}` 的三处 `变量` 是一组 ——
 * 中间那处在 SQL 文本里（用户要改的列名），只按「片段内的变量引用」扫会漏掉它。
 *
 * 同名合并成一组、按首次出现顺序排列 —— 这正是「多选改名」需要的形状。
 */
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

/**
 * 规整占位链：组内范围按位置排序去重、丢掉空组、组间按首次出现排序。
 *
 * 跳转依赖「按位置升序」这个不变式，所以规整只有这一处。
 */
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

/**
 * 这个词算不算占位变量。
 *
 * 排除三类：局部变量（`$i`，由 range 自己定义）、属性访问（`.字段` 由当前作用域提供）、
 * 模板关键字（函数 / 指令 / `else` / `end`，它们的名字不该被当成变量改写）。
 */
function isPlaceholderName(name: string, before: string): boolean {
  if (name.startsWith('$')) {
    return false
  }
  if (before.endsWith('.')) {
    return false
  }
  return !isTemplateKeyword(name)
}

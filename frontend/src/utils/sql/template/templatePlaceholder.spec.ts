/**
 * 模板占位链用例。
 *
 * 覆盖两件事：
 *  1. **位置链**：随编辑漂移、Tab / 回车依次跳、走完自动释放；
 *  2. **占位分组**：片段里的同名变量合成一组（多选一起改）、
 *     以及哪些词算占位变量（排除局部变量、属性访问、函数名与字面量）。
 *
 * 断言尽量用「切出来的文本」而不是硬编码下标 —— 片段形状一改，
 * 手算偏移量的用例必然写错，而切片断言改不改都读得懂。
 */
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { EditorView } from '@codemirror/view'
import {
  isPlaceholderEditing,
  jumpToNextPlaceholder,
  placeholderGroups,
  planPlaceholders,
  setTemplatePlaceholders,
  templatePlaceholderExtension,
} from '@/utils/sql/template/templatePlaceholder'
import type { TemplatePlaceholderGroup } from '@/utils/sql/template/templatePlaceholder'

/** 零宽占位组：只想跳光标位置时用（骨架的空位置就是这个形状） */
function positions(...list: number[]): TemplatePlaceholderGroup[] {
  return [...list]
    .sort((left, right) => left - right)
    .map(pos => ({ name: '', ranges: [{ from: pos, to: pos }] }))
}

/** 建一个带占位链扩展的编辑器状态 */
function stateOf(doc: string, groups: TemplatePlaceholderGroup[] = []) {
  const base = EditorState.create({ doc, extensions: [templatePlaceholderExtension()] })
  return groups.length
    ? base.update({ effects: setTemplatePlaceholders.of(groups) }).state
    : base
}

/** 假视图：接住 dispatch 并更新自己的 state */
function viewOf(state: EditorState) {
  const view = {
    state,
    dispatch(spec: Record<string, unknown>) {
      view.state = view.state.update(spec as Parameters<EditorState['update']>[0]).state
    },
  } as unknown as { state: EditorState, dispatch: (spec: unknown) => void } & EditorView
  return view
}

/** 当前选区在文档里覆盖的文本（多选时是多个片段） */
function selectedText(view: EditorView): string[] {
  const doc = view.state.doc
  return view.state.selection.ranges.map(range => doc.sliceString(range.from, range.to))
}

/** 占位组在文档里覆盖的文本 */
function groupTexts(doc: string, group: TemplatePlaceholderGroup): string[] {
  return group.ranges.map(range => doc.slice(range.from, range.to))
}

describe('模板占位链：位置', () => {
  it('登记后可以读出（按首次出现升序）', () => {
    const groups = placeholderGroups(stateOf('{{if }}\n\n{{end}}', positions(14, 7)))
    expect(groups.map(group => group.ranges[0].from)).toEqual([7, 14])
  })

  it('未登记时为空', () => {
    expect(placeholderGroups(stateOf('plain'))).toEqual([])
  })

  it('Tab 依次跳转，最后释放占位', () => {
    const view = viewOf(stateOf('{{if }}\n  \n{{end}}', positions(5, 10)))
    view.dispatch({ selection: { anchor: 0 } })

    expect(jumpToNextPlaceholder(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(5)

    expect(jumpToNextPlaceholder(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(10)

    // 走完最后一个：返回 false（Tab 交回默认缩进），并清空占位
    expect(jumpToNextPlaceholder(view)).toBe(false)
    expect(placeholderGroups(view.state)).toEqual([])
  })

  it('没有占位时不消费 Tab', () => {
    const view = viewOf(stateOf('plain'))
    expect(jumpToNextPlaceholder(view)).toBe(false)
  })

  it('位置随编辑漂移：在光标前插入文本后占位一并后移', () => {
    const state = stateOf('ab', positions(2))
    const moved = state.update({ changes: { from: 0, insert: 'XY' } }).state
    expect(placeholderGroups(moved).map(group => group.ranges[0].from)).toEqual([4])
  })

  it('整段替换后占位落在新文档范围内', () => {
    const state = stateOf('abcdef', positions(6))
    const shrunk = state.update({ changes: { from: 0, to: 6, insert: 'a' } }).state
    for (const group of placeholderGroups(shrunk)) {
      expect(group.ranges[0].from).toBeLessThanOrEqual(shrunk.doc.length)
      expect(group.ranges[0].to).toBeLessThanOrEqual(shrunk.doc.length)
    }
  })
})

describe('模板占位链：分组跳转', () => {
  it('同名变量的所有出现一起选中（多选区）', () => {
    const doc = '{{if 变量}} AND 变量 = {{变量}} {{end}}'
    const view = viewOf(stateOf(doc, planPlaceholders(doc)))
    view.dispatch({ selection: { anchor: 0 } })

    expect(jumpToNextPlaceholder(view)).toBe(true)
    // 三处 `变量` 一次选中：改一处等于改三处
    expect(selectedText(view)).toEqual(['变量', '变量', '变量'])
  })

  it('多组占位按出现顺序依次跳', () => {
    const doc = '{{if and 开始时间 结束时间}} {{quote 开始时间}} {{quote 结束时间}} {{end}}'
    const view = viewOf(stateOf(doc, planPlaceholders(doc)))
    view.dispatch({ selection: { anchor: 0 } })

    expect(jumpToNextPlaceholder(view)).toBe(true)
    expect(selectedText(view)).toEqual(['开始时间', '开始时间'])

    expect(jumpToNextPlaceholder(view)).toBe(true)
    expect(selectedText(view)).toEqual(['结束时间', '结束时间'])

    expect(jumpToNextPlaceholder(view)).toBe(false)
  })

  it('光标不在占位上时不算「编辑中」（回车归换行）', () => {
    const doc = '{{if 变量}} x {{end}}'
    const state = stateOf(doc, planPlaceholders(doc))
    const inside = state.update({ selection: { anchor: doc.indexOf('变量') + 1 } }).state
    const outside = state.update({ selection: { anchor: doc.length } }).state
    expect(isPlaceholderEditing(inside)).toBe(true)
    expect(isPlaceholderEditing(outside)).toBe(false)
  })

  it('没有占位时说不上「编辑中」', () => {
    expect(isPlaceholderEditing(stateOf('plain'))).toBe(false)
  })
})

describe('占位变量解析', () => {
  it('同名多处合成一组，按首次出现顺序排列', () => {
    const doc = '{{if 变量}} AND 变量 = {{变量}} {{end}}'
    const groups = planPlaceholders(doc)
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('变量')
    expect(groupTexts(doc, groups[0])).toEqual(['变量', '变量', '变量'])
  })

  it('不同名字各成一组（先出现的排前面）', () => {
    const doc = '{{if and 开始时间 结束时间}} {{quote 开始时间}} {{quote 结束时间}} {{end}}'
    expect(planPlaceholders(doc).map(group => group.name)).toEqual(['开始时间', '结束时间'])
  })

  it('函数名、指令、收尾词与局部变量都不是占位变量', () => {
    const doc = '{{if and $flag 变量}} {{quote 变量}} {{else}} x {{end}} {{range $i, $v := 列表}}{{.}}{{end}}'
    expect(planPlaceholders(doc).map(group => group.name)).toEqual(['变量', '列表'])
  })

  it('属性访问与字符串字面量里的词不算占位', () => {
    const doc = '{{with device}}{{.device_no}}{{end}} {{if eq 变量 "prod"}}x{{end}}'
    // device 是 with 作用的对象（真变量），.device_no 是属性访问，都不该被漏掉 / 误收
    expect(planPlaceholders(doc).map(group => group.name)).toEqual(['device', '变量'])
  })

  it('偏移量参与计算（片段插入到文档中间时坐标要对）', () => {
    const doc = '{{ 变量 }}'
    const [group] = planPlaceholders(doc, 100)
    const start = doc.indexOf('变量')
    expect(group.ranges).toEqual([{ from: 100 + start, to: 100 + start + 2 }])
  })

  it('没有变量时返回空（骨架只留空位置）', () => {
    expect(planPlaceholders('{{if }} x {{end}}')).toEqual([])
  })
})

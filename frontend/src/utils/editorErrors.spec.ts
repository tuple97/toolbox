/** 编辑器错误标记的换算用例（波浪线位置） */
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { errorRangeOf } from '@/utils/editorErrors'

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc })
}

describe('编辑器错误标记：位置换算', () => {
  it('只有行号时标整行', () => {
    const error = errorRangeOf(stateOf('SELECT 1\nSELECT 2'), { line: 2, message: 'x' })
    expect(error?.from).toBe(9)
    expect(error?.to).toBe(17)
    expect(error?.message).toBe('x')
  })

  it('给了列号就从该列标到行尾', () => {
    const error = errorRangeOf(stateOf('SELECT {{ id'), {
      line: 1,
      column: 8,
      message: '未闭合',
    })
    expect(error?.from).toBe(7)
    expect(error?.to).toBe(12)
    expect(error?.message).toBe('未闭合')
  })

  it('行号越界返回 null', () => {
    const state = stateOf('SELECT 1')
    expect(errorRangeOf(state, { line: 0, message: 'x' })).toBeNull()
    expect(errorRangeOf(state, { line: 9, message: 'x' })).toBeNull()
  })

  it('错误落在行尾时回退一格，保证波浪线可见', () => {
    const error = errorRangeOf(stateOf('SELECT 1'), { line: 1, column: 20, message: 'x' })
    expect(error).not.toBeNull()
    expect(error!.to).toBeGreaterThan(error!.from)
  })

  it('很长的行只标一段，不整行铺满', () => {
    const doc = `SELECT ${'a'.repeat(200)}`
    const error = errorRangeOf(stateOf(doc), { line: 1, column: 8, message: 'x' })
    expect(error).not.toBeNull()
    expect(error!.to - error!.from).toBeLessThanOrEqual(80)
  })
})

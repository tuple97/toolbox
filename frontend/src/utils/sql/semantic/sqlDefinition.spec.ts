/**
 * 跳转到定义的用例。
 *
 * 导航是对称的：引用 → 声明（常用方向），声明 → 第一处引用。
 * 物理表名与无关标识符都不给目标 —— 跳过去没有意义，或者干脆是猜。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { definitionTargetAt } from '@/utils/sql/semantic/sqlDefinition'

/** 用 `|` 标出光标位置，返回「目标角色 + 目标文本」 */
function targetAt(docWithCursor: string) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] })
  const target = definitionTargetAt(state, pos, 'mysql')
  return target ? { role: target.role, text: doc.slice(target.from, target.to) } : null
}

describe('跳转到定义：对称导航', () => {
  it('引用 → 声明', () => {
    expect(targetAt('SELECT |u.id FROM users u')).toEqual({ role: 'declaration', text: 'u' })
    expect(targetAt('SELECT u.id FROM users |u')).toEqual({ role: 'reference', text: 'u' })
  })

  it('声明 → 第一处引用（按文档顺序）', () => {
    // 声明在最后，第一处引用是 SELECT 列表里的那个
    expect(targetAt("SELECT u.id, u.name FROM users |u")).toEqual({ role: 'reference', text: 'u' })
  })

  it('CTE 名称同样可跳', () => {
    expect(targetAt('WITH recent AS (SELECT 1) SELECT * FROM |recent'))
      .toEqual({ role: 'declaration', text: 'recent' })
    expect(targetAt('WITH |recent AS (SELECT 1) SELECT * FROM recent'))
      .toEqual({ role: 'reference', text: 'recent' })
  })

  it('列别名可跳（声明 ↔ ORDER BY）', () => {
    expect(targetAt('SELECT u.name AS n FROM users u ORDER BY |n'))
      .toEqual({ role: 'declaration', text: 'n' })
    expect(targetAt('SELECT u.name AS |n FROM users u ORDER BY n'))
      .toEqual({ role: 'reference', text: 'n' })
  })

  it('物理表名没有 SQL 里的定义，不给目标', () => {
    expect(targetAt('SELECT * FROM |users')).toBeNull()
  })

  it('无关标识符不给目标', () => {
    expect(targetAt('SELECT |1 FROM users')).toBeNull()
  })
})

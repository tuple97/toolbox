/**
 * 列别名重命名的准入判断用例。
 *
 * 重点只有一条：**名字与来源列重名时必须拒绝**（ORDER BY 与 GROUP BY 的归属
 * 在 MySQL / PostgreSQL 里相反），并给出用户看得懂的原因；
 * 其余情况放行，并带上 ORDER BY / GROUP BY 里的全部引用。
 */
import { EditorState } from '@codemirror/state'
import { MySQL, sql } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { planColumnAliasRename } from '@/utils/sql/rename/sqlColumnAlias'
import type { TableRef } from '@/utils/sql/sqlSchema'

/** 用 `|` 标出光标位置，建一个编辑器状态 */
function stateOf(docWithCursor: string) {
  const pos = docWithCursor.indexOf('|')
  const doc = docWithCursor.replace('|', '')
  return { state: EditorState.create({ doc, extensions: [sql({ dialect: MySQL })] }), pos }
}

/** 假元数据：users 有 id / name 两列，其余表拿不到列 */
function columnsOf(ref: TableRef): { name: string }[] {
  return ref.table === 'users' ? [{ name: 'id' }, { name: 'name' }] : []
}

function planAt(docWithCursor: string) {
  const { state, pos } = stateOf(docWithCursor)
  return planColumnAliasRename({ state, pos, dbType: 'mysql', columnsOf })
}

describe('列别名重命名：准入判断', () => {
  it('与来源列不重名时放行，并带上 BY 子句里的全部引用', () => {
    const plan = planAt('SELECT u.id AS |uid FROM users u ORDER BY uid, uid DESC')
    expect(plan && !('reason' in plan)).toBe(true)
    if (!plan || 'reason' in plan) {
      throw new Error('应当放行')
    }
    expect(plan.symbol.name).toBe('uid')
    expect(plan.symbol.kind).toBe('column-alias')
    expect(plan.references).toHaveLength(2)
  })

  it('没有引用的别名也能改（只改声明）', () => {
    const plan = planAt('SELECT u.id AS |uid FROM users u')
    if (!plan || 'reason' in plan) {
      throw new Error('应当放行')
    }
    expect(plan.references).toEqual([])
  })

  it('与来源列重名时拒绝，并说清是哪个来源、为什么', () => {
    const plan = planAt('SELECT u.id AS |name FROM users u ORDER BY name')
    expect(plan).not.toBeNull()
    if (!plan || !('reason' in plan)) {
      throw new Error('应当拒绝')
    }
    // 提示里用用户写下的那个来源（别名 u），不是物理表名
    expect(plan.reason).toContain('name')
    expect(plan.reason).toContain('u')
    expect(plan.reason).toContain('歧义')
  })

  it('别名来自别名的来源表：重名同样拒绝', () => {
    const plan = planAt('SELECT o.id AS |name FROM users o ORDER BY name')
    if (!plan || !('reason' in plan)) {
      throw new Error('应当拒绝')
    }
    // 提示里用别名（用户写的那一个），不是物理表名
    expect(plan.reason).toContain('o')
  })

  it('不是列别名的位置返回 null（调用方按「没有动作」处理）', () => {
    expect(planAt('SELECT |u.id FROM users u')).toBeNull()
    expect(planAt('SELECT u.id AS uid FROM users u WHERE |u.id = 1')).toBeNull()
  })
})

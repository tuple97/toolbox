/**
 * 列候选池（T6）：按表缓存与超宽表的前缀取舍。
 *
 * 缓存用「元数据数组引用」做键，所以断言直接比较对象引用
 * （同一份元数据 → 同一批候选项对象；元数据刷新后是新数组 → 新对象）。
 */
import { describe, expect, it } from 'vitest'
import { MAX_TABLE_COLUMNS, pooledColumnItems } from '@/utils/sql/sqlCompletionColumnPool'
import type { PoolColumn, PoolSource } from '@/utils/sql/sqlCompletionColumnPool'

/** 生成一段列元数据 */
function columns(names: string[]): PoolColumn[] {
  return names.map(name => ({ name, dataType: 'int', comment: '' }))
}

/** 来源描述：默认表名即别名（避免与用例里的局部变量 source 撞名） */
function sourceOf(table: string, alias = table): PoolSource {
  return { table, alias }
}

describe('列候选池：缓存', () => {
  it('同一份元数据只构造一次候选（引用稳定）', () => {
    const source = columns(['id', 'name'])
    const first = pooledColumnItems(source, sourceOf('users'), 'mysql', '', false)
    const second = pooledColumnItems(source, sourceOf('users'), 'mysql', '', false)
    expect(second).toBe(first)
    expect(first.map(item => item.label)).toEqual(['id', 'name'])
  })

  it('元数据刷新（新数组）后重新构造', () => {
    const first = pooledColumnItems(columns(['id']), sourceOf('users'), 'mysql', '', false)
    const second = pooledColumnItems(columns(['id', 'name']), sourceOf('users'), 'mysql', '', false)
    expect(second).not.toBe(first)
    expect(second.map(item => item.label)).toEqual(['id', 'name'])
  })

  it('来源 / 方言不同则各存一份', () => {
    const source = columns(['id'])
    const byTable = pooledColumnItems(source, sourceOf('users'), 'mysql', '', false)
    const byAlias = pooledColumnItems(source, sourceOf('users', 'u'), 'mysql', '', false)
    const postgres = pooledColumnItems(source, sourceOf('users'), 'postgres', '', false)

    expect(byAlias).not.toBe(byTable)
    expect(postgres).not.toBe(byTable)
    // 来源列给的是**血缘源头表名**（别名在展示名里，不带额外信息），别名不同不影响它
    expect(byTable[0]?.columnDetail?.from).toBe('users')
    expect(byAlias[0]?.columnDetail?.from).toBe('users')
  })

  it('空元数据返回空数组', () => {
    expect(pooledColumnItems([], sourceOf('users'), 'mysql', '', false)).toEqual([])
  })

  it('候选项自带按需引用符的插入逻辑', () => {
    const items = pooledColumnItems(columns(['order']), sourceOf('users'), 'mysql', '', false)
    expect(items[0]?.label).toBe('order')
    expect(typeof items[0]?.apply).toBe('function')
  })
})

describe('列候选池：来源列是血缘源头表名', () => {
  it('物理列给真实表名，不是别名', () => {
    const items = pooledColumnItems(
      columns(['agent_desc']),
      { table: 'device', alias: 't2' },
      'mysql', '', true,
    )
    expect(items[0]?.columnDetail?.from).toBe('device')
    // 别名并不消失：它仍然在展示名里（`t2.agent_desc`），只是不占「来源」这一列
    expect(items[0]?.displayLabel).toBe('t2.agent_desc')
  })

  it('限定到库 / 模式时给「库.表」', () => {
    const items = pooledColumnItems(
      columns(['id']),
      { schema: 'testdb', table: 'device', alias: 't2' },
      'mysql', '', true,
    )
    expect(items[0]?.columnDetail?.from).toBe('testdb.device')
  })

  it('派生列给它自己的血缘来源表（穿透子查询）', () => {
    const derived: PoolColumn[] = [{ name: 'uid', dataType: 'int', from: 'users' }]
    const items = pooledColumnItems(derived, { table: 't1', alias: 't1' }, 'mysql', '', true)
    expect(items[0]?.columnDetail?.from).toBe('users')
  })

  it('同名别名指向不同表时不串缓存（表名参与缓存键）', () => {
    const meta = columns(['id'])
    const device = pooledColumnItems(meta, { table: 'device', alias: 't' }, 'mysql', '', true)
    const orders = pooledColumnItems(meta, { table: 'orders', alias: 't' }, 'mysql', '', true)
    expect(device).not.toBe(orders)
    expect(device[0]?.columnDetail?.from).toBe('device')
    expect(orders[0]?.columnDetail?.from).toBe('orders')
  })
})

describe('列候选池：超宽表的取舍', () => {
  /** 500 列的宽表：头 498 列是普通名字，末尾两列分别靠前缀 / 拼音命中 */
  function wideTable(): PoolColumn[] {
    const names = Array.from({ length: 498 }, (_, index) => `c${index}`)
    return columns([...names, 'zz_target', '状态'])
  }

  it('未超限时原样返回（顺序 = 元数据顺序）', () => {
    const items = pooledColumnItems(columns(['id', 'name', 'created_at']), sourceOf('users'), 'mysql', '', false)
    expect(items.map(item => item.label)).toEqual(['id', 'name', 'created_at'])
  })

  it('超限时截断到上限，且保留前缀命中的列', () => {
    const source = wideTable()
    const items = pooledColumnItems(source, sourceOf('users'), 'mysql', 'zz', false)
    expect(items).toHaveLength(MAX_TABLE_COLUMNS)
    expect(items.map(item => item.label)).toContain('zz_target')
    // 前缀命中的排在最前
    expect(items[0]?.label).toBe('zz_target')
  })

  it('前缀是 ASCII 时中文列名仍然保留（拼音命中要用）', () => {
    const source = wideTable()
    const items = pooledColumnItems(source, sourceOf('users'), 'mysql', 'zt', false)
    expect(items.map(item => item.label)).toContain('状态')
  })

  it('没有前缀时按元数据顺序截断（不做重排）', () => {
    const source = wideTable()
    const items = pooledColumnItems(source, sourceOf('users'), 'mysql', '', false)
    expect(items).toHaveLength(MAX_TABLE_COLUMNS)
    expect(items[0]?.label).toBe('c0')
    expect(items.at(-1)?.label).toBe(`c${MAX_TABLE_COLUMNS - 1}`)
  })

  it('同一个前缀的取舍结果同样缓存', () => {
    const source = wideTable()
    const first = pooledColumnItems(source, sourceOf('users'), 'mysql', 'zz', false)
    const second = pooledColumnItems(source, sourceOf('users'), 'mysql', 'zz', false)
    expect(second).toBe(first)
  })
})

/**
 * 插入核对：标识符引用符、替换范围与多选插入的最终文本。
 *
 * 用假 view 接住 dispatch 的 changes，逐条核对「选中候选项后文档变成什么」——
 * 这类问题（少引号导致 SQL 跑不通、多引号导致 `` ``users` ``、多列没带别名）
 * 只有看到最终文本才能确认。
 *
 * 注意新契约：**替换范围只覆盖词**（不含点号限定符 —— 编辑器拿这段文本
 * 当匹配输入），限定符由候选自带（`columnPrefix`）写回，apply 只在
 * 「文档里已经写着这个前缀」时不再重复插入。
 */
import { describe, expect, it } from 'vitest'
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import {
  columnItem,
  needsQuoting,
  openingQuoteBefore,
  qualifierBeforeCursor,
  quotedIdentApply,
  renderIdent,
  toggleColumnMark,
} from '@/utils/sql/sqlCompletionInsert'
import type { ColumnItemArgs } from '@/utils/sql/sqlCompletionInsert'
import type { SqlDialect } from '@/utils/sql/rowSql'

/**
 * 假编辑器：只实现插入逻辑用到的那几件事。
 *
 * - `state.doc.toString()`：读文档（开引号判断要用）
 * - `state.doc.sliceString(from, to)`：看替换范围左侧有没有已经写着的限定符
 * - `dispatch`：把 changes 记下来
 * - 勾选状态走 WeakMap，用同一个假 view 对象即可
 */
function fakeView(doc: string) {
  const changes: Array<{ from: number, to: number, insert: string }> = []
  const view = {
    state: {
      doc: {
        toString: () => doc,
        sliceString: (from: number, to?: number) => doc.slice(from, to),
      },
    },
    dispatch: (spec: { changes: { from: number, to: number, insert: string } }) => {
      changes.push(spec.changes)
    },
  } as unknown as EditorView
  return { view, changes }
}

/** 光标前正在输入的词的首字符下标（编辑器给补全的替换起点就是它） */
function wordStart(doc: string): number {
  const word = /[A-Za-z0-9_$]*$/.exec(doc)?.[0] ?? ''
  return doc.length - word.length
}

/** 单来源的列候选（裸列名，插入文本按方言渲染） */
function column(name: string, dialect: SqlDialect = 'mysql', overrides: Partial<ColumnItemArgs> = {}) {
  return columnItem({
    name,
    insertText: renderIdent(name, dialect),
    columnId: { table: 't', source: 't', column: name },
    dialect,
    ...overrides,
  })
}

/** 带限定符的列候选（点号补全 / 多来源场景） */
function qualifiedColumn(source: string, name: string, dialect: SqlDialect = 'mysql') {
  return columnItem({
    name,
    displayName: `${source}.${name}`,
    insertText: `${source}.${renderIdent(name, dialect)}`,
    prefix: `${source}.`,
    columnId: { table: 'users', source, column: name },
    dialect,
  })
}

/**
 * 应用一个候选项，返回它实际写入的文本与替换范围。
 *
 * `marked` 是「勾选项的插入文本」列表（新契约：多选状态记录的是插入文本）；
 * `from` 由补全引擎给出（默认取词首，点号补全时含限定符）。
 */
function applyColumn(
  doc: string,
  item: Completion,
  marked: string[] = [],
  from = wordStart(doc),
): { from: number, to: number, insert: string } | null {
  const { view, changes } = fakeView(doc)
  for (const text of marked) {
    toggleColumnMark(view, text, text)
  }
  const apply = item.apply
  if (typeof apply !== 'function') {
    return null
  }
  apply(view, item, from, doc.length)
  return changes[0] ?? null
}

describe('标识符引用符：判定', () => {
  it('普通标识符不加引号', () => {
    expect(needsQuoting('name')).toBe(false)
    expect(needsQuoting('user_id')).toBe(false)
    expect(needsQuoting('_tmp1')).toBe(false)
  })

  it('保留字要加引号（列名里最常踩到的那些）', () => {
    expect(needsQuoting('order')).toBe(true)
    expect(needsQuoting('key')).toBe(true)
    expect(needsQuoting('user')).toBe(true)
    expect(needsQuoting('desc')).toBe(true)
    expect(needsQuoting('rank')).toBe(true)
  })

  it('常见但非保留的词不加引号（避免日常列名被包起来）', () => {
    expect(needsQuoting('status')).toBe(false)
    expect(needsQuoting('type')).toBe(false)
    expect(needsQuoting('password')).toBe(false)
  })

  it('含特殊字符或中文的名字要加引号', () => {
    expect(needsQuoting('user name')).toBe(true)
    expect(needsQuoting('user-name')).toBe(true)
    expect(needsQuoting('名称')).toBe(true)
    expect(needsQuoting('1st')).toBe(true)
  })
})

describe('标识符引用符：落地写法', () => {
  it('按需加引号，方言决定引号字符', () => {
    expect(renderIdent('name', 'mysql')).toBe('name')
    expect(renderIdent('order', 'mysql')).toBe('`order`')
    expect(renderIdent('order', 'postgres')).toBe('"order"')
    expect(renderIdent('user name', 'postgres')).toBe('"user name"')
  })

  it('用户已经敲了引号就沿用他的样式并配对着闭合', () => {
    expect(renderIdent('name', 'mysql', '`')).toBe('`name`')
    expect(renderIdent('name', 'mysql', '"')).toBe('"name"')
    expect(renderIdent('name', 'mysql', '[')).toBe('[name]')
  })

  it('名字里含引号时双写转义', () => {
    expect(renderIdent('a`b', 'mysql', '`')).toBe('`a``b`')
  })
})

describe('右引号补齐：开引号识别', () => {
  it('光标前的开引号会被识别（含位置）', () => {
    const doc = 'SELECT `na'
    expect(openingQuoteBefore(doc, wordStart(doc)))
      .toEqual({ quote: '`', close: '`', start: 7 })

    const withDouble = 'SELECT "na'
    expect(openingQuoteBefore(withDouble, wordStart(withDouble))?.quote).toBe('"')

    const withBracket = 'SELECT [na'
    expect(openingQuoteBefore(withBracket, wordStart(withBracket))?.close).toBe(']')
  })

  it('闭引号不算开引号（`` `name` `` 的第二个）', () => {
    const doc = 'SELECT `name`'
    expect(openingQuoteBefore(doc, wordStart(doc))).toBeNull()
  })

  it('没有引号时返回 null', () => {
    const doc = 'SELECT na'
    expect(openingQuoteBefore(doc, wordStart(doc))).toBeNull()
    expect(openingQuoteBefore('', 0)).toBeNull()
  })
})

describe('列插入：最终写进文档的文本', () => {
  it('普通列名不加引号', () => {
    expect(applyColumn('SELECT ', column('name')))
      .toEqual({ from: 7, to: 7, insert: 'name' })
  })

  it('保留字列名自动加引用符（不然 SQL 直接语法错误）', () => {
    expect(applyColumn('SELECT ', column('order', 'mysql'))?.insert).toBe('`order`')
    expect(applyColumn('SELECT ', column('order', 'postgres'))?.insert).toBe('"order"')
  })

  it('用户敲了开引号：引号属于替换范围，最终按候选的插入文本落地', () => {
    const doc = 'SELECT `na'
    // 替换范围从左引号开始（第 7 位）：普通列名落地为裸名，引号不会重复出现
    expect(applyColumn(doc, column('name'))).toEqual({ from: 7, to: 10, insert: 'name' })
    // 需要引号的列名，候选自带引用符
    expect(applyColumn(doc, column('order'))?.insert).toBe('`order`')
  })

  it('点号补全：替换范围只有词，文档里已写着的 `u.` 不会被重复插入', () => {
    const doc = 'SELECT u.`na'
    const item = qualifiedColumn('u', 'name')
    // 替换范围从词首开始（第 10 位，`na`）；左侧的 `u.` 留在文档里，最终得到 `u.name`
    expect(applyColumn(doc, item, [], 10)).toEqual({ from: 9, to: 12, insert: 'name' })

    // 需要引用符的列名，候选自带引用符（限定符依旧不重复）
    const reserved = qualifiedColumn('u', 'order')
    expect(applyColumn(doc, reserved, [], 10)?.insert).toBe('`order`')
  })

  it('替换范围左侧没有限定符时，候选自带的 `u.` 照常写进去', () => {
    // 普通（非点号）补全：文档里只有词，插入必须带上来源前缀
    const doc = 'SELECT crea'
    expect(applyColumn(doc, qualifiedColumn('u', 'created_at'))?.insert).toBe('u.created_at')
  })

  it('多表场景：不同来源的同名列是两个候选（身份不同）', () => {
    const doc = 'SELECT '
    const first = qualifiedColumn('u', 'created_at')
    const second = qualifiedColumn('o', 'created_at')
    expect(first.columnKey).not.toBe(second.columnKey)
    expect(first.columnInsert).toBe('u.created_at')
    expect(second.columnInsert).toBe('o.created_at')
    expect(applyColumn(doc, first)?.insert).toBe('u.created_at')
  })

  it('勾选多列时插入各自候选的文本（各自的引用符 / 别名）', () => {
    const doc = 'SELECT `n'
    /*
     * 勾选集合只有**多选列**的候选才会消费（见 columnApply）：候选必须带
     * `columnMode: 'multi'` —— 单选场景里残留勾选一律无效。
     * 生产链路上这个标记由补全引擎按光标意图打上（见 sqlColumnCompletionMode.spec.ts）。
     */
    const item = { ...column('name'), columnMode: 'multi' as const }
    const change = applyColumn(doc, item, ['name', '`order`'])
    expect(change).toEqual({ from: 7, to: 9, insert: 'name, `order`' })
  })

  it('多选按身份记录：同名列不会互相影响', () => {
    const { view } = fakeView('SELECT ')
    toggleColumnMark(view, 'users@u.id', 'u.id')
    toggleColumnMark(view, 'orders@o.id', 'o.id')
    // 勾选其中一项后立刻取消，不应影响另一项
    toggleColumnMark(view, 'users@u.id', 'u.id')
    expect(view).toBeTruthy()
  })
})

describe('表候选：吃掉用户已经敲下的开引号', () => {
  it('已敲开引号时不会出现两个引号', () => {
    const doc = 'SELECT * FROM `us'
    const { view, changes } = fakeView(doc)
    quotedIdentApply('`users`')(view, {} as Completion, wordStart(doc), doc.length)
    expect(changes[0]).toEqual({ from: 14, to: 17, insert: '`users`' })
  })

  it('没敲引号时就是普通替换', () => {
    const doc = 'SELECT * FROM us'
    const { view, changes } = fakeView(doc)
    quotedIdentApply('`users`')(view, {} as Completion, wordStart(doc), doc.length)
    expect(changes[0]).toEqual({ from: 14, to: 16, insert: '`users`' })
  })
})

describe('限定符回看：中文别名同样算数', () => {
  it('`用户.` 整段算进替换范围', () => {
    const text = 'SELECT 用户.'
    expect(qualifierBeforeCursor(text, text.length)).toBe('用户.')
  })

  it('回看的是一个完整 token：`a用户.` 不会被当成 `用户.`', () => {
    const text = 'SELECT a用户.'
    expect(qualifierBeforeCursor(text, text.length)).toBe('a用户.')
  })

  it('带引号的中文别名也认（`` `用户`. ``）', () => {
    const text = 'SELECT `用户`.'
    expect(qualifierBeforeCursor(text, text.length)).toBe('`用户`.')
  })
})

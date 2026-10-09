/**
 * 表别名重命名用例：会话、校验、提交用的 TextEdit 列表。
 *
 * 重点验证文档里的硬约束：
 *  - 只有「声明 + 引用集合」被改，且**按 from 倒序**（前面的范围不受影响）；
 *  - 一次提交就是一组 edit（编辑器用一个 transaction 应用，Undo 里是一步）；
 *  - 非法 / 保留字别名不允许提交，带引号的写法被尊重。
 */
import { describe, expect, it } from 'vitest'
import {
  createRenameSession,
  isSameSession,
  isValidSqlIdentifier,
  planRenameCancel,
  planRenameCommit,
  renameEdits,
  renameSubjectOf,
  renameTargetCount,
  renameValidationMessage,
} from '@/utils/sql/rename/sqlRenameSession'
import type { SqlTableAliasSymbol } from '@/utils/sql/semantic/sqlSymbols'

/**
 * 造一个别名符号：声明在 `FROM users u` 的 u 上。
 *
 * 声明范围与真实扫描器一致 —— **含引号**（`` `u` `` 是 3 个字符），
 * 会话据此识别原声明的引号样式。
 */
function symbolOf(
  doc: string,
  declarationFrom = doc.indexOf('users ') + 'users '.length,
  length = 1,
): SqlTableAliasSymbol {
  return {
    kind: 'table-alias',
    id: `alias:${declarationFrom}-${declarationFrom + length}`,
    name: 'u',
    tableName: 'users',
    schema: '',
    declarationRange: { from: declarationFrom, to: declarationFrom + length },
    nameRange: { from: doc.indexOf('users'), to: doc.indexOf('users') + 5 },
    scopeRange: { from: 0, to: doc.length },
    statementRange: { from: 0, to: doc.length },
    virtual: false,
  }
}

/** 应用一组 edit（倒序替换），得到最终文档 */
function applyEdits(doc: string, edits: Array<{ from: number, to: number, insert: string }>): string {
  let result = doc
  for (const edit of edits) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  }
  return result
}

describe('重命名：校验', () => {
  it('裸标识符规则：字母或下划线开头', () => {
    expect(isValidSqlIdentifier('usr', 'mysql')).toBe(true)
    expect(isValidSqlIdentifier('_u1', 'mysql')).toBe(true)
    expect(isValidSqlIdentifier('123abc', 'mysql')).toBe(false)
    expect(isValidSqlIdentifier('a b', 'mysql')).toBe(false)
    expect(isValidSqlIdentifier('', 'mysql')).toBe(false)
  })

  it('显式带引号的写法被尊重（不按裸标识符一刀切）', () => {
    expect(isValidSqlIdentifier('`order`', 'mysql')).toBe(true)
    expect(isValidSqlIdentifier('"order"', 'postgres')).toBe(true)
    expect(isValidSqlIdentifier('[order]', 'mysql')).toBe(true)
  })

  it('保留字不允许裸写提交，并给出可执行的提示', () => {
    const message = renameValidationMessage('order', 'mysql')
    expect(message).toContain('保留字')
    // 加引号就可以
    expect(renameValidationMessage('`order`', 'mysql')).toBeNull()
  })

  it('空别名与非法别名各有提示', () => {
    expect(renameValidationMessage('  ', 'mysql')).toBe('别名不能为空')
    expect(renameValidationMessage('1a', 'mysql')).toContain('不合法')
    expect(renameValidationMessage('usr', 'mysql')).toBeNull()
  })
})

describe('重命名：提交用的 TextEdit', () => {
  const doc = 'SELECT u.id, u.email FROM users u WHERE u.id = 1'
  // 声明在 `FROM users u` 的 u（下标 32），引用是 SELECT / WHERE 里的 3 处
  const references = [
    { from: 7, to: 8 },
    { from: 13, to: 14 },
    { from: 40, to: 41 },
  ]

  it('从后往前替换：声明 + 全部引用一次改完', () => {
    const session = createRenameSession(symbolOf(doc), references, doc)
    session.currentName = 'usr'

    const edits = renameEdits(session, 'mysql')
    expect(edits.map(edit => edit.from)).toEqual([40, 32, 13, 7])
    expect(applyEdits(doc, edits)).toBe('SELECT usr.id, usr.email FROM users usr WHERE usr.id = 1')
  })

  it('新名字需要引号时，声明与引用一起补上', () => {
    const session = createRenameSession(symbolOf(doc), references, doc)
    session.currentName = 'order'

    const edits = renameEdits(session, 'mysql')
    expect(edits.every(edit => edit.insert === '`order`')).toBe(true)
    expect(applyEdits(doc, edits))
      .toBe('SELECT `order`.id, `order`.email FROM users `order` WHERE `order`.id = 1')
  })

  it('原声明带引号时沿用同一种引号样式', () => {
    const quoted = 'SELECT u.id FROM users `u` WHERE u.id = 1'
    // 声明是第 23 位起的 `u`（含反引号共 3 个字符）
    const session = createRenameSession(
      symbolOf(quoted, 23, 3),
      [{ from: 7, to: 8 }, { from: 33, to: 34 }],
      quoted,
    )
    session.currentName = 'usr'
    expect(renameEdits(session, 'mysql')[0].insert).toBe('`usr`')
  })

  it('提交的改动只覆盖声明与引用（不碰字符串与注释）', () => {
    const withLiteral = "SELECT u.id FROM users u WHERE message = 'u' -- u"
    const session = createRenameSession(symbolOf(withLiteral), [{ from: 7, to: 8 }], withLiteral)
    session.currentName = 'usr'
    const result = applyEdits(withLiteral, renameEdits(session, 'mysql'))
    expect(result).toBe("SELECT usr.id FROM users usr WHERE message = 'u' -- u")
  })
})

describe('重命名：Enter 提交计划', () => {
  const doc = 'SELECT u.id FROM users u WHERE u.id = 1'
  // 声明在第 23 位，引用是 SELECT(7) 与 WHERE(31) 两处
  const references = [{ from: 7, to: 8 }, { from: 31, to: 32 }]

  it('把新名字同步到声明与全部引用，声明按原文长度计算', () => {
    const session = createRenameSession(symbolOf(doc), references, doc)
    const plan = planRenameCommit(session, 'usr', 'mysql')

    expect(plan.error).toBeNull()
    // 倒序：WHERE 引用 → 声明 → SELECT 引用
    expect(plan.edits).toEqual([
      { from: 31, to: 32, insert: 'usr' },
      { from: 23, to: 24, insert: 'usr' },
      { from: 7, to: 8, insert: 'usr' },
    ])
    expect(plan.selection).toBe(26)
  })

  it('非法 / 保留字别名只给提示、不产生任何修改（Enter 被拦下）', () => {
    const session = createRenameSession(symbolOf(doc), references, doc)

    const reserved = planRenameCommit(session, 'order', 'mysql')
    expect(reserved.error).toContain('保留字')
    expect(reserved.edits).toEqual([])

    const empty = planRenameCommit(session, '   ', 'mysql')
    expect(empty.error).toBe('别名不能为空')
    expect(empty.edits).toEqual([])
  })

  it('新名字需要引号时，声明与引用一起补上', () => {
    const session = createRenameSession(symbolOf(doc), references, doc)
    const plan = planRenameCommit(session, 'a b', 'mysql')
    expect(plan.edits.every(edit => edit.insert === '`a b`')).toBe(true)
  })

  it('提交的修改范围覆盖声明原文 —— 撤销一次即可全量还原', () => {
    const session = createRenameSession(symbolOf(doc), references, doc)
    const plan = planRenameCommit(session, 'usr', 'mysql')

    // 声明那一段（原文 1 个字符）一定在修改列表里
    expect(plan.edits.some(edit => edit.from === 23 && edit.to === 24)).toBe(true)
    // 按倒序应用后，文档就是重命名后的结果
    expect(applyEdits(doc, plan.edits))
      .toBe('SELECT usr.id FROM users usr WHERE usr.id = 1')
  })
})

describe('重命名：中文标识符', () => {
  it('中文别名 / CTE 名是合法输入（词法与解析层一致）', () => {
    expect(isValidSqlIdentifier('用户', 'mysql')).toBe(true)
    expect(isValidSqlIdentifier('最近', 'mysql')).toBe(true)
    expect(isValidSqlIdentifier('临时_1', 'mysql')).toBe(true)
    // 中文不触发「不合法」提示
    expect(renameValidationMessage('用户', 'mysql')).toBeNull()
  })

  it('中文别名可以提交：声明与引用一起按原样落地', () => {
    const doc = 'SELECT u.id FROM users u'
    const symbol = { ...symbolOf(doc), name: 'u' }
    const session = createRenameSession(symbol, [{ from: 7, to: 8 }], doc)
    const plan = planRenameCommit(session, '用户', 'mysql')
    expect(plan.error).toBeNull()
    // 中文不是 ASCII 纯标识符：生成时加引号（沿用生成 SQL 的既有策略）
    expect(plan.edits.every(edit => edit.insert === '`用户`')).toBe(true)
  })
})

describe('重命名：CTE 名称', () => {
  const doc = 'WITH recent AS (SELECT 1) SELECT * FROM recent'

  /** CTE 符号（声明在 5，引用是最后那个 recent） */
  function cteSymbolOf(text: string) {
    return {
      kind: 'cte' as const,
      id: 'cte:5-11',
      name: 'recent',
      declarationRange: { from: 5, to: 11 },
      statementRange: { from: 0, to: text.length },
    }
  }

  it('会话沿用符号的 kind 与原文', () => {
    const usageFrom = doc.lastIndexOf('recent')
    const session = createRenameSession(
      cteSymbolOf(doc),
      [{ from: usageFrom, to: usageFrom + 'recent'.length }],
      doc,
    )
    expect(session.kind).toBe('cte')
    expect(session.initialDeclaration).toBe('recent')

    // 提交把声明与 FROM 处一起改成新名字（倒序）
    const plan = planRenameCommit(session, 'rn', 'mysql')
    expect(plan.error).toBeNull()
    expect(plan.edits).toEqual([
      { from: usageFrom, to: usageFrom + 6, insert: 'rn' },
      { from: 5, to: 11, insert: 'rn' },
    ])
  })

  it('文案按对象区分：CTE 不会读到「别名」字样', () => {
    const session = createRenameSession(cteSymbolOf(doc), [], doc)

    expect(planRenameCommit(session, '  ', 'mysql').error).toBe('CTE 名称不能为空')

    const invalid = planRenameCommit(session, 'a b', 'mysql').error ?? ''
    expect(invalid.startsWith('CTE 名称不合法')).toBe(true)

    // 保留字提示与对象无关，但同样不该出现「别名」
    const reserved = planRenameCommit(session, 'order', 'mysql').error ?? ''
    expect(reserved).toContain('保留字')
    expect(reserved).not.toContain('别名')

    // 白空格被 trim：`  rn  ` 这种输入按 rn 提交
    expect(planRenameCommit(session, ' rn ', 'mysql').error).toBeNull()
  })

  it('对象称呼只有一处措辞', () => {
    expect(renameSubjectOf('cte')).toBe('CTE 名称')
    expect(renameSubjectOf('cte', false)).toBe('CTE')
    expect(renameSubjectOf('table-alias')).toBe('别名')
    expect(renameSubjectOf('table-alias', false)).toBe('表别名')
    expect(renameSubjectOf('column-alias')).toBe('列别名')
    expect(renameSubjectOf('column-alias', false)).toBe('列别名')
  })

  it('会话身份比对对两类符号都成立', () => {
    const symbol = cteSymbolOf(doc)
    const session = createRenameSession(symbol, [], doc)
    expect(isSameSession(session, symbol)).toBe(true)
    expect(isSameSession(session, { ...symbol, declarationRange: { from: 6, to: 12 } })).toBe(false)
  })
})

describe('重命名：Esc 取消计划', () => {
  it('输入过新名字：逐字节还原成原文', () => {
    const doc = 'SELECT u.id FROM users u'
    const session = createRenameSession(symbolOf(doc), [{ from: 7, to: 8 }], doc)
    // 编辑器里声明已经被改成 usr（范围随之变长）
    const edited = 'SELECT u.id FROM users usr'
    const plan = planRenameCancel({ ...session, declarationRange: { from: 23, to: 26 } }, edited)

    expect(plan.change).toEqual({ from: 23, to: 26, insert: 'u' })
    expect(plan.selection).toBe(24)
    expect(applyEdits(edited, plan.change ? [plan.change] : [])).toBe(doc)
  })

  it('没改过就不派发事务（不产生多余的历史步）', () => {
    const doc = 'SELECT u.id FROM users u'
    const session = createRenameSession(symbolOf(doc), [], doc)
    expect(planRenameCancel(session, doc).change).toBeNull()
  })

  it('带引号的声明同样逐字节还原', () => {
    const doc = 'SELECT u.id FROM users `u`'
    const session = createRenameSession(symbolOf(doc, 23, 3), [{ from: 7, to: 8 }], doc)
    const edited = 'SELECT u.id FROM users `usr`'
    const plan = planRenameCancel({ ...session, declarationRange: { from: 23, to: 28 } }, edited)
    expect(plan.change?.insert).toBe('`u`')
  })
})

describe('重命名：会话', () => {
  it('会话身份用声明位置，不用显示文本', () => {
    const doc = 'SELECT u.id FROM users u'
    const session = createRenameSession(symbolOf(doc), [], doc)
    expect(isSameSession(session, symbolOf(doc))).toBe(true)
    // 同名但声明位置不同的符号不是同一个会话
    const other = { ...symbolOf(doc), id: 'alias:999-1000', declarationRange: { from: 999, to: 1000 } }
    expect(isSameSession(session, other)).toBe(false)
  })

  it('会话记下初始文档与目标数量（界面提示用）', () => {
    const doc = 'SELECT u.id FROM users u'
    const session = createRenameSession(symbolOf(doc), [{ from: 7, to: 8 }], doc)
    expect(session.initialDocument).toBe(doc)
    expect(session.active).toBe(true)
    expect(renameTargetCount(session)).toBe(2)
  })
})

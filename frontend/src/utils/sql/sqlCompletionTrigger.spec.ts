/**
 * SQL 补全触发策略的用例。
 *
 * `shouldTriggerCompletion` 是纯函数（只吃 facts），
 * 因此这些用例不需要编辑器实例，跑在 node 环境下。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SQL_TRIGGER_MODE,
  parseSqlTriggerMode,
  shouldTriggerCompletion,
} from '@/utils/sql/sqlCompletionTrigger'
import type { TriggerFacts, SqlTriggerMode } from '@/utils/sql/sqlCompletionTrigger'

/** 造一份 facts：默认「打字中、什么都不满足」，用例只覆盖关心的字段 */
function facts(overrides: Partial<TriggerFacts> = {}): TriggerFacts {
  return {
    origin: 'typing',
    hasIdentifierPrefix: false,
    qualifierTriggered: false,
    inCommentOrString: false,
    positionalEligible: true,
    insertedChar: undefined,
    ...overrides,
  }
}

describe('SQL 补全触发：显式触发', () => {
  it('显式触发在任何模式下都放行', () => {
    const modes: SqlTriggerMode[] = ['manual', 'require-prefix', 'positional']
    for (const mode of modes) {
      expect(shouldTriggerCompletion(facts({ origin: 'explicit' }), mode)).toBe(true)
    }
  })

  it('显式触发在字符串 / 注释里也放行（用户主动要候选时不拦）', () => {
    const manual = facts({ origin: 'explicit', inCommentOrString: true })
    expect(shouldTriggerCompletion(manual, 'manual')).toBe(true)
    expect(shouldTriggerCompletion(manual, 'positional')).toBe(true)
  })
})

describe('SQL 补全触发：仅手动', () => {
  it('打字触发一律不弹', () => {
    expect(shouldTriggerCompletion(facts({ hasIdentifierPrefix: true }), 'manual')).toBe(false)
    expect(shouldTriggerCompletion(facts({ qualifierTriggered: true }), 'manual')).toBe(false)
  })
})

describe('SQL 补全触发：需要前缀', () => {
  it('有标识符前缀时弹出', () => {
    expect(shouldTriggerCompletion(facts({ hasIdentifierPrefix: true }), 'require-prefix')).toBe(true)
  })

  it('刚敲下点号时弹出（点号补全不能等前缀）', () => {
    expect(shouldTriggerCompletion(facts({ qualifierTriggered: true }), 'require-prefix')).toBe(true)
  })

  it('没有前缀、也没敲点号时不弹', () => {
    expect(shouldTriggerCompletion(facts(), 'require-prefix')).toBe(false)
  })

  it('字符串 / 注释里打字不弹', () => {
    const inside = facts({ hasIdentifierPrefix: true, inCommentOrString: true })
    expect(shouldTriggerCompletion(inside, 'require-prefix')).toBe(false)
  })
})

describe('SQL 补全触发：位置感知', () => {
  it('合理位置 + 已有前缀 → 弹出', () => {
    expect(shouldTriggerCompletion(facts({ hasIdentifierPrefix: true }), 'positional')).toBe(true)
  })

  it('合理位置 + 敲下结构字符（空格/括号/逗号/等号/点号）→ 弹出', () => {
    for (const char of [' ', '(', ',', '=', '.']) {
      expect(shouldTriggerCompletion(facts({ insertedChar: char }), 'positional')).toBe(true)
    }
  })

  it('合理位置但没有输入内容（粘贴多字符）→ 不弹', () => {
    expect(shouldTriggerCompletion(facts({ insertedChar: undefined }), 'positional')).toBe(false)
  })

  it('不合理位置（如别名位）→ 不弹', () => {
    const alias = facts({ hasIdentifierPrefix: true, positionalEligible: false })
    expect(shouldTriggerCompletion(alias, 'positional')).toBe(false)
  })

  it('字符串 / 注释里即使位置合理也不弹', () => {
    const inside = facts({ hasIdentifierPrefix: true, inCommentOrString: true })
    expect(shouldTriggerCompletion(inside, 'positional')).toBe(false)
  })

  it('点号触发不要求标识符前缀（`a.` 后要立刻给列）', () => {
    expect(shouldTriggerCompletion(facts({ qualifierTriggered: true }), 'positional')).toBe(true)
  })

  it('点号落在不合理位置（别名位）时不弹', () => {
    const dotted = facts({ qualifierTriggered: true, positionalEligible: false })
    expect(shouldTriggerCompletion(dotted, 'positional')).toBe(false)
  })
})

describe('SQL 补全触发：配置解析', () => {
  it('识别三档取值', () => {
    expect(parseSqlTriggerMode('manual')).toBe('manual')
    expect(parseSqlTriggerMode('require-prefix')).toBe('require-prefix')
    expect(parseSqlTriggerMode('positional')).toBe('positional')
  })

  it('未知值 / 空值回退默认档', () => {
    expect(parseSqlTriggerMode(undefined)).toBe(DEFAULT_SQL_TRIGGER_MODE)
    expect(parseSqlTriggerMode('')).toBe('positional')
    expect(parseSqlTriggerMode('whatever')).toBe('positional')
  })
})

/**
 * 函数参数提示的位置判定用例（纯文本 + 光标，node 环境直测）。
 *
 * 用 `|` 标记光标位置，断言「命中哪个函数、当前是第几个参数」；
 * 反例（`IN (`、未知函数、纯数字）与陷阱（字符串 / 注释里的括号逗号）单独锁。
 */
import { describe, expect, it } from 'vitest'
import { parameterInfoAt } from '@/utils/sql/sqlParameterInfo'

/** 用 `|` 标记光标，解析并返回精简结论 */
function infoOf(docWithCursor: string): { name: string, argIndex: number } | null {
  const pos = docWithCursor.indexOf('|')
  const text = docWithCursor.replace('|', '')
  const info = parameterInfoAt(text, pos)
  return info ? { name: info.doc.name, argIndex: info.argIndex } : null
}

describe('函数参数提示：位置判定', () => {
  it('括号内刚开头：第 0 个参数', () => {
    expect(infoOf('SELECT MAX(|) FROM t')).toEqual({ name: 'MAX', argIndex: 0 })
  })

  it('写到一半的表达式也算第 0 个参数', () => {
    expect(infoOf('SELECT MAX(amount|) FROM t')).toEqual({ name: 'MAX', argIndex: 0 })
  })

  it('顶层逗号决定当前参数下标', () => {
    expect(infoOf('SELECT IFNULL(status, |)')).toEqual({ name: 'IFNULL', argIndex: 1 })
    expect(infoOf('SELECT SUBSTRING(name, 2, |)')).toEqual({ name: 'SUBSTRING', argIndex: 2 })
  })

  it('嵌套函数：认最内层的括号', () => {
    expect(infoOf('SELECT CONCAT(UPPER(|), name) FROM t')).toEqual({ name: 'UPPER', argIndex: 0 })
    // 内层闭合后回到外层
    expect(infoOf('SELECT CONCAT(UPPER(name), |) FROM t')).toEqual({ name: 'CONCAT', argIndex: 1 })
  })

  it('参数个数超出目录时下标照实返回（由 UI 钳到末参）', () => {
    expect(infoOf('SELECT MAX(a, b, |)')).toEqual({ name: 'MAX', argIndex: 2 })
  })

  it('反例：非函数的括号不提示', () => {
    // IN 不是目录里的函数
    expect(infoOf('SELECT * FROM t WHERE id IN (|)')).toBeNull()
    // 未知标识符
    expect(infoOf('SELECT whatever(|)')).toBeNull()
    // 纯数字后面跟括号
    expect(infoOf('SELECT 1|')).toBeNull()
    // 没有括号
    expect(infoOf('SELECT | FROM t')).toBeNull()
  })

  it('字符串里的括号与逗号不是结构', () => {
    // 语句层的裸逗号不在任何函数括号里：没有命中
    expect(infoOf("SELECT '(', |, MAX(a) FROM t WHERE x = ')'")).toBeNull()
    // 字符串里的括号 / 逗号不参与参数计数（注意：用例的字符串里不能出现 `|`，
    // 否则光标标记 indexOf 会先撞上它）
    expect(infoOf("SELECT MAX('(', |) FROM t")).toEqual({ name: 'MAX', argIndex: 1 })
    expect(infoOf("SELECT MAX('a,b', |)")).toEqual({ name: 'MAX', argIndex: 1 })
  })

  it('注释里的括号与逗号不是结构', () => {
    expect(infoOf('SELECT MAX( /* (, ) */ | ) FROM t')).toEqual({ name: 'MAX', argIndex: 0 })
    expect(infoOf('SELECT MAX(\n-- (,\n|) FROM t')).toEqual({ name: 'MAX', argIndex: 0 })
  })

  it('大小写不敏感地命中目录', () => {
    expect(infoOf('select max(|) from t')).toEqual({ name: 'MAX', argIndex: 0 })
  })
})

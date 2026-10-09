/**
 * 候选排序引擎的用例。
 *
 * 全部是纯函数（拼音 / 分层打分 / 历史加权），跑在 node 环境下。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HIGH_FREQ_KEYWORDS,
  computeMatchScore,
  dumpCompletionHistory,
  hasCjk,
  historyBoostOf,
  matchRanges,
  matchedByPinyinOnly,
  matchesPrefix,
  pinyinInitialsOf,
  recordCompletionSelection,
  resetCompletionHistory,
  sortByRank,
  tierOf,
  wordInitialsOf,
} from '@/utils/sql/sqlCompletionRank'

/** 造一个候选并打分 */
function score(
  label: string,
  prefix: string,
  extra: { boost?: number, type?: string, isHighFrequencyKeyword?: boolean } = {},
) {
  return computeMatchScore({
    label,
    prefix,
    boost: extra.boost ?? 0,
    type: extra.type,
    isHighFrequencyKeyword: extra.isHighFrequencyKeyword,
  })
}

beforeEach(() => {
  resetCompletionHistory()
})

describe('候选排序：分层打分', () => {
  it('精确命中高于一切', () => {
    expect(tierOf('name', 'name')).toBeGreaterThan(tierOf('name_en', 'name'))
  })

  it('词首字母命中高于普通前缀命中', () => {
    // 同一个候选：oi 命中词首字母（order_items），or 只是普通前缀
    expect(tierOf('order_items', 'oi')).toBeGreaterThan(tierOf('order_items', 'or'))
  })

  it('前缀命中高于子串与紧凑模糊', () => {
    expect(tierOf('user_name', 'user')).toBeGreaterThan(tierOf('name_user', 'user'))
  })

  it('紧凑模糊（子序列）命中高于纯子串', () => {
    // uname 是 user_name 的子序列，但不是连续子串
    expect(tierOf('user_name', 'uname')).toBeGreaterThan(0)
    expect(tierOf('user_name', 'uname')).toBe(tierOf('user_name', 'uname'))
  })

  it('完全不命中得 0 分（只剩余 boost）', () => {
    expect(tierOf('name', 'zzz')).toBe(0)
  })

  it('空前缀只按类型 / 权重排序（保持既有分类顺序）', () => {
    const column = score('id', '', { boost: 90, type: 'field' })
    const table = score('users', '', { boost: 70, type: 'table' })
    const fn = score('COUNT', '', { boost: 50, type: 'function' })
    const keyword = score('DISTINCT', '', { boost: 30, type: 'keyword' })
    expect(column).toBeGreaterThan(table)
    expect(table).toBeGreaterThan(fn)
    expect(fn).toBeGreaterThan(keyword)
  })

  it('高频关键字加成不会把关键字抬到表名之前', () => {
    const table = score('users', '', { boost: 70, type: 'table' })
    const frequent = score('WHERE', '', { boost: 30, type: 'keyword', isHighFrequencyKeyword: true })
    const rare = score('DISTINCT', '', { boost: 30, type: 'keyword', isHighFrequencyKeyword: false })
    expect(table).toBeGreaterThan(frequent)
    expect(frequent).toBeGreaterThan(rare)
  })

  it('变量类候选加成最高', () => {
    const variable = score('device_no', '', { boost: 0, type: 'variable' })
    const column = score('device_no', '', { boost: 90, type: 'field' })
    expect(variable).toBeGreaterThan(column)
  })

  it('高频关键字比普通关键字更靠前', () => {
    const freq = score('WHERE', '', { boost: 30, type: 'keyword', isHighFrequencyKeyword: true })
    const rare = score('DISTINCT', '', { boost: 30, type: 'keyword', isHighFrequencyKeyword: false })
    expect(freq).toBeGreaterThan(rare)
    expect(HIGH_FREQ_KEYWORDS.has('WHERE')).toBe(true)
  })
})

describe('候选排序：词首字母与拼音', () => {
  it('下划线 / 驼峰都能取词首字母', () => {
    expect(wordInitialsOf('order_items')).toBe('oi')
    expect(wordInitialsOf('deviceNo')).toBe('dn')
  })

  it('中文表名按拼音首字母命中', () => {
    expect(pinyinInitialsOf('设备编号')).toBe('sbbh')
    expect(tierOf('设备编号', 'sbbh')).toBeGreaterThan(0)
    expect(score('设备编号', 'sbbh')).toBeGreaterThan(score('设备编号', 'zzz'))
  })

  it('中英混排表名：非中文片段原样保留', () => {
    expect(pinyinInitialsOf('设备device_no')).toContain('sb')
  })

  it('只有含中文的候选才走拼音分支', () => {
    expect(hasCjk('设备编号')).toBe(true)
    expect(hasCjk('device_no')).toBe(false)
    // ASCII 候选不会因为拼音分支被误判为命中
    expect(tierOf('device_no', 'sbbh')).toBe(0)
  })

  it('拼音命中与字面命中可区分（用于决定是否自行过滤）', () => {
    expect(matchedByPinyinOnly('设备编号', 'sbbh')).toBe(true)
    // 字面就能命中的不算「仅拼音」
    expect(matchedByPinyinOnly('device_no', 'device')).toBe(false)
    expect(matchedByPinyinOnly('用户表', 'yhb')).toBe(true)
  })

  it('matchesPrefix 与本模块的打分口径一致', () => {
    expect(matchesPrefix('user_name', 'user')).toBe(true)
    expect(matchesPrefix('设备编号', 'sbbh')).toBe(true)
    expect(matchesPrefix('user_name', 'zzz')).toBe(false)
  })
})

describe('候选排序：排序结果', () => {
  it('同分候选保持原有顺序（列仍排在关键字前）', () => {
    const options = [
      { label: 'id', boost: 90, type: 'field' },
      { label: 'name', boost: 90, type: 'field' },
      { label: 'WHERE', boost: 30, type: 'keyword' },
    ]
    expect(sortByRank(options, '').map(item => item.label)).toEqual(['id', 'name', 'WHERE'])
  })

  it('有前缀时把精确命中顶到最前', () => {
    const options = [
      { label: 'user_name', boost: 90, type: 'field' },
      { label: 'name', boost: 90, type: 'field' },
    ]
    expect(sortByRank(options, 'name').map(item => item.label)).toEqual(['name', 'user_name'])
  })

  it('前缀命中优先于字段类型：dis 时 DISTINCT 不被 device_status 压后', () => {
    const options = [
      { label: 'device_status', boost: 90, type: 'field' },
      { label: 'device_time_zone_offset', boost: 90, type: 'field' },
      { label: 'DISTINCT', boost: 30, type: 'keyword' },
    ]
    expect(sortByRank(options, 'dis').map(item => item.label)).toEqual([
      'DISTINCT', 'device_status', 'device_time_zone_offset',
    ])
  })

  it('不修改入参数组', () => {
    const options = [{ label: 'b', boost: 0 }, { label: 'a', boost: 0 }]
    const sorted = sortByRank(options, '')
    expect(options.map(item => item.label)).toEqual(['b', 'a'])
    expect(sorted).not.toBe(options)
  })
})

describe('候选排序：历史加权', () => {
  it('记录过的候选项获得加权，且随次数递增后收敛', () => {
    expect(historyBoostOf('name')).toBe(0)

    recordCompletionSelection('name')
    const first = historyBoostOf('name')

    recordCompletionSelection('name')
    const second = historyBoostOf('name')

    recordCompletionSelection('name')
    recordCompletionSelection('name')
    const fourth = historyBoostOf('name')

    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(first)
    expect(fourth).toBeGreaterThan(second)
  })

  it('历史加权只在前缀非空时生效（空前缀严格按 schema 顺序）', () => {
    recordCompletionSelection('name')

    const withHistory = computeMatchScore({
      label: 'name',
      prefix: 'na',
      boost: 90,
      type: 'field',
      historyBoost: historyBoostOf('name'),
    })
    const plain = computeMatchScore({ label: 'name', prefix: 'na', boost: 90, type: 'field' })
    expect(withHistory).toBeGreaterThan(plain)

    /*
     * 空前缀时没有任何「用户在找哪个」的信号，历史不参与 ——
     * 否则被用过几次的列会跑到 id 前面，列表顺序与建表顺序对不上（文档 §27）。
     */
    expect(computeMatchScore({
      label: 'name',
      prefix: '',
      boost: 90,
      type: 'field',
      historyBoost: historyBoostOf('name'),
    })).toBe(computeMatchScore({ label: 'name', prefix: '', boost: 90, type: 'field' }))
  })

  it('最近使用排在前面（同一档位内，且需要前缀）', () => {
    recordCompletionSelection('id')
    recordCompletionSelection('id')

    const options = [
      { label: 'item', boost: 90, type: 'field' },
      { label: 'id', boost: 90, type: 'field' },
    ]
    // 空前缀：保持传入顺序（= schema 顺序），历史不影响
    expect(sortByRank(options, '').map(item => item.label)).toEqual(['item', 'id'])
    // 有前缀且两个候选同档位（都命中前缀）时，才由历史决定先后
    expect(sortByRank(options, 'i').map(item => item.label)).toEqual(['id', 'item'])
    // 最近使用的记录在导出里排在最前
    expect(dumpCompletionHistory()[0]).toBe('id')
  })

  it('清空历史后加权归零', () => {
    recordCompletionSelection('name')
    resetCompletionHistory()
    expect(historyBoostOf('name')).toBe(0)
  })
})

/**
 * 命中区间：自行过滤（filter: false）时补全要把加粗位置交回编辑器。
 * 少了它，打字触发的重查会把上一次画出的加粗擦掉（表现为「粗体一闪就没了」）。
 */
describe('补全命中区间', () => {
  it('前缀命中：标出最前面的那一段', () => {
    expect(matchRanges('users', 'us')).toEqual([0, 2])
    expect(matchRanges('users', 'US')).toEqual([0, 2])
  })

  it('子串命中：标出中间那一段', () => {
    expect(matchRanges('user_roles', 'roles')).toEqual([5, 10])
  })

  it('紧凑子序列：逐个字符标出，相邻区间合并', () => {
    expect(matchRanges('user_orders', 'uo')).toEqual([0, 1, 5, 6])
    // u(0) s(1) r(3)：中间跳过的 e 不标，区间不重叠
    expect(matchRanges('user', 'usr')).toEqual([0, 2, 3, 4])
  })

  it('没命中 / 空前缀：不加粗', () => {
    expect(matchRanges('users', 'zz')).toEqual([])
    expect(matchRanges('users', '')).toEqual([])
    expect(matchRanges('', 'us')).toEqual([])
  })
})

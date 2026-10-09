/**
 * 候选排序引擎。
 *
 * 补全列表的最终顺序由两层决定：
 *  1. 编辑器自身的匹配分 + 候选携带的 `boost`（本模块不改现有 boost 语义）；
 *  2. 本模块的**分层打分**：精确 → 词首字母 → 拼音首字母 → 前缀 → 紧凑模糊 → 子串，
 *     再叠加类型加成与「历史选中」加权。
 *
 * 为什么要自己做一层：编辑器自带的模糊匹配只认 label 字面量，
 * 中文列名（`设备编号`）无法用拼音首字母（`sbbh`）命中，
 * 也没法把「上次选过的东西」往前排。这层打分同时用于：
 *  - 需要按拼音命中时（此时关掉编辑器自带的过滤，顺序完全由本模块决定）；
 *  - 其余场景作为并列候选的顺序提示。
 *
 * 纯函数 + 模块级状态，浏览器与 node 环境都能跑。
 */
import { pinyin } from 'pinyin-pro'

/** 分层分：数值本身不重要，档位高低才是语义 */
const TIER_EXACT = 3000
const TIER_INITIALS = 2400
const TIER_PINYIN = 2300
const TIER_PREFIX = 2000
const TIER_FUZZY = 1200
const TIER_SUBSTRING = 900

/**
 * 语言 / 来源加成：模板变量与脚本文本最需要靠前。
 *
 * **SQL 的类别次序（列 / 表 / 关键字 / 函数…）不在这里** —— 那是候选自带的
 * `boost`（`sqlCompletionKeywords` 的 BOOST_*）。一个概念只有一个出处：
 * 本模块只管「匹配档位 + 历史加权」，类别次序归候选生成层。
 * 两处都写类别次序会让它们互相打架（曾出现：这里给函数 20、boost 给函数 50，
 * 关键字被顶到后面）。
 */
const TYPE_BONUS: Record<string, number> = {
  variable: 200,
  text: 200,
}

/** 高频关键字（写 SQL 时最常接着敲的），只给这一类关键字加成 */
export const HIGH_FREQ_KEYWORDS = new Set([
  'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY',
  'HAVING', 'LIMIT', 'SELECT', 'FROM', 'AS', 'IN', 'IS NULL', 'LIKE', 'EXISTS',
])

/**
 * 高频关键字加成。
 *
 * 只作用于关键字类**内部**（同层同档时让 WHERE / AND / FROM 这些更常用的靠前），
 * 取值必须小于「关键字各层之间的间距」（表达式 1500 → 子句 1200 差 300），
 * 否则会把子句关键字顶到表达式关键字之上。
 */
const HIGH_FREQ_KEYWORD_BONUS = 20

/** 打分输入 */
export interface RankInput {
  /** 候选显示文本 */
  label: string
  /** 用户已输入的片段（光标左侧的标识符） */
  prefix: string
  /** 现有语义权重（见 sqlCompletionKeywords 的 BOOST_*） */
  boost: number
  /** 候选类型：field / table / variable / keyword … */
  type?: string
  /** 历史选中加权（见 historyBoostOf） */
  historyBoost?: number
  /** 是否高频关键字；缺省时按 label 自查 */
  isHighFrequencyKeyword?: boolean
}

/** 是否含中日韩字符（只有含 CJK 才走拼音分支，ASCII 零开销） */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(text)
}

/**
 * 取文本的拼音首字母（小写）。
 * 非中文片段原样保留并转小写，因此 `用户表 user_info` → `yhbuser_info`。
 */
export function pinyinInitialsOf(text: string): string {
  const raw = pinyin(text, { pattern: 'first', toneType: 'none', type: 'string', nonZh: 'consecutive' })
  return raw.replace(/\s+/g, '').toLowerCase()
}

/**
 * 词首字母：按分隔符（下划线 / 驼峰 / 空白）取每个词的首字符。
 * `order_items` → `oi`；`deviceNo` → `dn`。
 */
export function wordInitialsOf(label: string): string {
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u3400-\u9FFF]+/)
    .filter(Boolean)
  return words.map(word => word[0]).join('').toLowerCase()
}

/** 子序列匹配（紧凑模糊）：`uo` 命中 `user_order` */
function isSubsequence(prefix: string, label: string): boolean {
  let index = 0
  for (const ch of label) {
    if (ch === prefix[index]) {
      index++
      if (index === prefix.length) {
        return true
      }
    }
  }
  return prefix.length === 0
}

/**
 * 计算候选得分。
 *
 * 空前缀（刚敲完空格 / 点号）时只剩「类型加成 + boost + 历史」，
 * 这样各类型之间的相对顺序与改造前完全一致（列 → 别名 → 表 / 库 → 函数 → 关键字）。
 */
export function computeMatchScore(input: RankInput): number {
  const prefix = input.prefix.trim()
  /*
   * 空前缀时**不参与历史加权**（文档 §27 / §28）：没有输入就没有「用户在找哪个」的
   * 信号，这时候必须严格按 schema 顺序 —— 否则被用过几次的 `created_at` 会跑到
   * `id` 前面，列表顺序与建表顺序对不上。有前缀时才启用 fuzzy / pinyin / history。
   */
  const history = prefix ? (input.historyBoost ?? 0) : 0
  const typeBonus = TYPE_BONUS[input.type ?? ''] ?? 0
  const highFreq = input.isHighFrequencyKeyword ?? HIGH_FREQ_KEYWORDS.has(input.label)
  const keywordBonus = highFreq && input.type === 'keyword' ? HIGH_FREQ_KEYWORD_BONUS : 0
  const base = typeBonus + input.boost + history + keywordBonus

  if (!prefix) {
    return base
  }

  return base + tierOf(input.label, prefix)
}

/** 分层档位（导出便于用例直接断言档位关系） */
export function tierOf(label: string, prefix: string): number {
  const lowerLabel = label.toLowerCase()
  const lowerPrefix = prefix.toLowerCase()
  if (!lowerPrefix) {
    return 0
  }
  if (lowerLabel === lowerPrefix) {
    return TIER_EXACT
  }
  if (wordInitialsOf(label) === lowerPrefix) {
    return TIER_INITIALS
  }
  if (hasCjk(label) && pinyinInitialsOf(label).startsWith(lowerPrefix)) {
    return TIER_PINYIN
  }
  if (lowerLabel.startsWith(lowerPrefix)) {
    return TIER_PREFIX
  }
  if (isSubsequence(lowerPrefix, lowerLabel)) {
    return TIER_FUZZY
  }
  if (lowerLabel.includes(lowerPrefix)) {
    return TIER_SUBSTRING
  }
  return 0
}

/**
 * 候选是否命中前缀（本模块的匹配口径）。
 * 用于自行过滤候选时判断「留还是丢」。
 */
export function matchesPrefix(label: string, prefix: string): boolean {
  return tierOf(label, prefix) > 0
}

/**
 * 候选标签里「与输入前缀匹配」的区间（扁平数组：`[from, to, from, to…]`）。
 *
 * 补全自行过滤时会把编辑器的 `filter` 关掉，此时**编辑器不再自己算命中区间**，
 * 必须由这里交回去 —— 否则命中加粗会先被上一次结果画出来、再被重查结果擦掉，
 * 用户看到的就是「粗体一闪就没了」。
 *
 * 口径与 tierOf 的字面量命中一致：前缀 → 子串 → 紧凑子序列；
 * 拼音首字母命中落不到标签的具体字符上，这里返回空数组（不高亮，但不影响排序）。
 */
export function matchRanges(label: string, prefix: string): number[] {
  const trimmed = prefix.trim()
  if (!trimmed || !label) {
    return []
  }
  const lowerLabel = label.toLowerCase()
  const lowerPrefix = trimmed.toLowerCase()

  if (lowerLabel.startsWith(lowerPrefix)) {
    return [0, trimmed.length]
  }

  const substringAt = lowerLabel.indexOf(lowerPrefix)
  if (substringAt >= 0) {
    return [substringAt, substringAt + trimmed.length]
  }

  // 紧凑子序列：逐字符标出命中位置，相邻的合并成一段（区间不重叠）
  const ranges: number[] = []
  let cursor = 0
  for (let i = 0; i < lowerLabel.length && cursor < lowerPrefix.length; i++) {
    if (lowerLabel[i] !== lowerPrefix[cursor]) {
      continue
    }
    const lastEnd = ranges[ranges.length - 1]
    if (lastEnd === i) {
      ranges[ranges.length - 1] = i + 1
    }
    else {
      ranges.push(i, i + 1)
    }
    cursor++
  }
  return cursor === lowerPrefix.length ? ranges : []
}

/**
 * 是否「仅」靠拼音首字母命中（字面量匹配不到）。
 * 这种候选项编辑器自带的匹配认不出来，需要由本模块接管过滤。
 */
export function matchedByPinyinOnly(label: string, prefix: string): boolean {
  const trimmed = prefix.trim()
  if (!trimmed || !hasCjk(label)) {
    return false
  }
  return tierOf(label, trimmed) === TIER_PINYIN
}

/** 参与排序的最小候选形态 */
interface Rankable {
  label: string
  boost?: number
  type?: string
}

/**
 * 按打分稳定排序。
 *
 * 稳定很关键：同档位候选保持原有插入顺序，避免把「列在前、关键字在后」
 * 这类既有的分类顺序打乱。返回新数组，不改动入参。
 */
export function sortByRank<T extends Rankable>(options: T[], prefix: string): T[] {
  return options
    .map((option, index) => ({
      option,
      index,
      // 匹配质量是第一排序键。以前把 boost 直接加进总分，字段的语义
      // 权重会压过已经完整输入的关键字（如 dis → DISTINCT），不符合输入预期。
      tier: tierOf(option.label, prefix.trim()),
      score: computeMatchScore({
        label: option.label,
        prefix,
        boost: option.boost ?? 0,
        type: option.type,
        historyBoost: historyBoostOf(option.label),
      }),
    }))
    .sort((a, b) => (b.tier - a.tier) || (b.score - a.score) || (a.index - b.index))
    .map(item => item.option)
}

// ---------------------------------------------------------------- 历史选中加权

/** 历史记录上限（超出后按最近使用淘汰） */
const HISTORY_LIMIT = 512

/** 最近被选中的候选：label → 命中次数（Map 的迭代顺序即插入顺序） */
const history = new Map<string, number>()

/** 是否已经尝试从本地存储载入（只做一次） */
let historyLoaded = false

/** 本地存储键（用 localStorage：高频写入不值得每次都落 SQLite） */
const HISTORY_STORAGE_KEY = 'toolbox-completion-history'

/**
 * 历史加权档位（按选中次数递增，最后一档封顶）：
 * 首次 +3、两次 +5、三次 +8、四次及以上 +12。
 * 增幅刻意做小——历史只是「同等条件下略优先」，压不过精确匹配与类型顺序。
 */
const HISTORY_BOOST_STEPS = [3, 5, 8, 12]

/**
 * 记录一次「用户选中了某个候选」。
 *
 * 由补全项的 apply 包装器调用（见 sqlCompletion 的 withHistoryRecording）。
 */
export function recordCompletionSelection(label: string): void {
  if (!label) {
    return
  }
  ensureHistoryLoaded()
  // 重新插入以获得「最近使用」的迭代顺序
  const count = (history.get(label) ?? 0) + 1
  history.delete(label)
  history.set(label, count)
  while (history.size > HISTORY_LIMIT) {
    const oldest = history.keys().next().value
    if (oldest === undefined) {
      break
    }
    history.delete(oldest)
  }
  schedulePersist()
}

/** 某个候选的历史加权（未记录过返回 0） */
export function historyBoostOf(label: string): number {
  ensureHistoryLoaded()
  const count = history.get(label) ?? 0
  if (count <= 0) {
    return 0
  }
  return HISTORY_BOOST_STEPS[Math.min(count, HISTORY_BOOST_STEPS.length) - 1]
}

/** 清空历史（设置面板 / 测试用） */
export function resetCompletionHistory(): void {
  history.clear()
  historyLoaded = true
  persistNow()
}

/**
 * 导出历史：**最近使用在前**。
 * Map 内部按「最旧 → 最新」保存（这样超限时删的第一个 key 就是最旧的），
 * 导出时翻转一次，落盘内容与阅读顺序一致。
 */
export function dumpCompletionHistory(): string[] {
  ensureHistoryLoaded()
  return Array.from(history.keys()).reverse()
}

/** 载入历史（启动时调用；入参是「最近使用在前」，容错处理脏数据） */
export function loadCompletionHistory(labels: string[]): void {
  history.clear()
  for (const label of [...labels].reverse()) {
    if (typeof label === 'string' && label) {
      history.set(label, (history.get(label) ?? 0) + 1)
    }
  }
  historyLoaded = true
}

/** 首次取用时从 localStorage 载入 */
function ensureHistoryLoaded() {
  if (historyLoaded || typeof localStorage === 'undefined') {
    historyLoaded = true
    return
  }
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      loadCompletionHistory(parsed.filter((item): item is string => typeof item === 'string'))
      return
    }
  }
  catch {
    // 存储被禁用或内容损坏：忽略，按无历史运行
  }
  historyLoaded = true
}

/** 落盘（防抖，避免连续勾选多次写存储） */
let persistTimer: number | null = null
function schedulePersist() {
  if (typeof window === 'undefined') {
    return
  }
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer)
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    persistNow()
  }, 800)
}

function persistNow() {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(dumpCompletionHistory()))
  }
  catch {
    // 存储不可用时忽略（历史只是排序优化）
  }
}

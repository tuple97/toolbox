/** 补全包（bundle）级的候选族注册表 */
import type { Completion } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { CompletionFeatureFlags } from '../sqlCompletion'
import type { CompletionContextKind, SqlCursorText } from '../sqlCursor'
import type { TableRef } from '../sqlSchema'
import {
  generalSuggestions,
  joinConditionSuggestions,
  resolveAfterDot,
  smartSuggestions,
} from '../sqlSuggestions'
import type { SqlSuggestDeps } from '../sqlSuggestions'
import type { SmartColumn } from '../sqlSmartItems'
import type { SqlCompletionSlot } from './sqlCompletionSlot'

/** 候选生成前的全部输入：候选族只读它，不自己去解析 SQL */
export interface BundleContext {
  state: EditorState
  pos: number
  doc: string
  /** 光标前正在输入的词 */
  word: string
  /** 光标前的限定符段（`` `db`.u `` → `['db']`）；没有点号时为 null */
  qualifier: string[] | null
  /** SQL 光标语义（子句 / 位置类别 / 多选意图 / 关联目标） */
  intent: SqlCursorText
  /** 作用域链（内 → 外） */
  scopes: TableRef[][]
  deps: SqlSuggestDeps
  flags: CompletionFeatureFlags
  /** 槽位（资格过滤与关键字集合都按它算） */
  slot: SqlCompletionSlot
  contextKind: CompletionContextKind
  /** 智能项总开关 */
  smart: boolean
  /** 片段型候选是否可用 */
  fragments: boolean
  autoAlias: boolean
  preferredQualifier: string
  /** GROUP BY 推荐列与需跳过的列 */
  promoted: { items: Completion[], skip: Set<string> }
  /** 表引用 → 列清单 */
  columnsOf: (ref: TableRef) => SmartColumn[]
}

/** 一个补全包级候选族 */
export interface BundleProvider {
  id: string
  supports: (ctx: BundleContext) => boolean
  provide: (ctx: BundleContext) => Completion[]
}

/** 点号路径：光标前有 `u.` / `库.` */
const afterDotProvider: BundleProvider = {
  id: 'after-dot',
  supports: ctx => ctx.qualifier !== null,
  // 候选来自共享缓存，必须复制再交给调用方，否则 push 会写坏缓存
  provide: (ctx) => {
    const segments = ctx.qualifier
    if (!segments) {
      return []
    }
    return [...resolveAfterDot(
      segments,
      ctx.scopes,
      ctx.deps,
      ctx.word,
      { skipAlias: ctx.slot === 'from-source' },
    )]
  },
}

/** 非点号场景：交给 sqlSuggestions 的候选族 */
const generalProvider: BundleProvider = {
  id: 'general',
  supports: ctx => ctx.qualifier === null,
  provide: ctx => generalSuggestions({
    intent: ctx.intent,
    scopes: ctx.scopes,
    deps: ctx.deps,
    flags: ctx.flags,
    skipColumns: ctx.promoted.skip,
    prefix: ctx.word,
    autoAlias: ctx.autoAlias,
    preferredQualifier: ctx.preferredQualifier,
    slot: ctx.slot,
  }),
}

/** 关联条件：`ON |` 位置追加整条条件（外键 + 命名启发式） */
const joinConditionProvider: BundleProvider = {
  id: 'join-conditions',
  supports: ctx => ctx.contextKind === 'join-on' && ctx.flags.joinSuggestions !== false,
  provide: ctx => joinConditionSuggestions(ctx.scopes, ctx.deps, ctx.intent.joinTarget),
}

/** GROUP BY 推荐列 */
const groupByProvider: BundleProvider = {
  id: 'group-by',
  supports: () => true,
  provide: ctx => ctx.promoted.items,
}

/** 智能项：`*` 展开 / 比较值 / INSERT 列清单 */
const smartItemsProvider: BundleProvider = {
  id: 'smart-items',
  supports: ctx => ctx.smart,
  provide: ctx => smartSuggestions({
    intent: ctx.intent,
    pos: ctx.pos,
    scopes: ctx.scopes,
    deps: ctx.deps,
    columnsOf: ctx.columnsOf,
    fragments: ctx.fragments,
  }),
}

/** 默认注册表：顺序 = 候选出现顺序 */
export const DEFAULT_BUNDLE_PROVIDERS: BundleProvider[] = [
  afterDotProvider,
  generalProvider,
  joinConditionProvider,
  groupByProvider,
  smartItemsProvider,
]

/** 跑一遍注册表：`supports` 通过就取它的候选，按注册顺序拼起来 */
export function runBundleProviders(
  ctx: BundleContext,
  providers: BundleProvider[] = DEFAULT_BUNDLE_PROVIDERS,
): Completion[] {
  const out: Completion[] = []
  for (const provider of providers) {
    if (provider.supports(ctx)) {
      out.push(...provider.provide(ctx))
    }
  }
  return out
}

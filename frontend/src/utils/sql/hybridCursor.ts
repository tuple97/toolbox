/** 混合语言光标分析 */
import type { EditorState } from '@codemirror/state'
import { inLiteralOrComment } from '@/utils/sql/sqlSyntax'
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { qualifierBeforeCursor } from './sqlCompletionInsert'
import { templateRegionAt } from './template/templateRegion'

/** 光标所在的语言区域 */
export type HybridLanguage =
  /** SQL 语句主体 */
  | 'sql'
  /** 模板片段 `{{ … }}`（含写在 SQL 字符串里的插值） */
  | 'template'
  /** 脚本编辑器（语言自带的补全另算） */
  | 'script'
  /** 字符串 / 注释：不补全 */
  | 'blocked'
  /** 不补全的编辑器 */
  | 'none'

/** 光标分析结果 */
export interface HybridCursor {
  language: HybridLanguage
  /** 正在输入的词（无则为空串） */
  prefix: string
  /** 词范围：**补全的替换范围**（所有候选都用它） */
  wordRange: TextRange
  /** 左侧点号限定符（`u.` / `` `db`.`t`. ``），无则为空串） */
  qualifier: string
  /** 模板区域的边界（`language === 'template'` 时给出） */
  templateRegion: { openAt: number, closeAt: number | null, from: number, to: number } | null
  /** 光标是否落在 SQL 字符串 / 注释里 */
  inLiteral: boolean
}

/** 分析选项 */
export interface HybridCursorOptions {
  /** 编辑器用途（模板区域只在模板编辑器里成立） */
  mode: 'sql' | 'sql-template' | 'javascript' | 'none'
  /** 词字符集（默认 SQL 标识符） */
  wordPattern?: RegExp
}

/** SQL / 模板共用的词：字母数字下划线（模板变量名同构） */
const WORD_BEFORE = /[A-Za-z0-9_$]*$/

/** 光标右侧的词字符（决定替换范围的结束位置） */
const WORD_AFTER = /^[A-Za-z0-9_$]*/

/** 往右看多远找词尾（词不会太长） */
const WORD_LOOKAHEAD = 128

/** 分析光标 */
export function analyzeHybridCursor(
  state: EditorState,
  pos: number,
  options: HybridCursorOptions,
): HybridCursor {
  const doc = state.doc.toString()
  const line = state.doc.lineAt(pos)
  const lineBefore = line.text.slice(0, pos - line.from)
  const prefix = (options.wordPattern ?? WORD_BEFORE).exec(lineBefore)?.[0] ?? ''

  /* 词范围取「整个词」而不是「光标左边那半截」：光标停在词中间补全时 （`u.na|me`）要替换到词尾 */
  const tail = WORD_AFTER.exec(doc.slice(pos, pos + WORD_LOOKAHEAD))?.[0] ?? ''
  const wordRange: TextRange = { from: pos - prefix.length, to: pos + tail.length }
  const qualifier = qualifierBeforeCursor(doc, wordRange.from)

  const base: Omit<HybridCursor, 'language' | 'templateRegion' | 'inLiteral'> = {
    prefix,
    wordRange,
    qualifier,
  }

  if (options.mode === 'none') {
    return { ...base, language: 'none', templateRegion: null, inLiteral: false }
  }

  if (options.mode === 'javascript') {
    return { ...base, language: 'script', templateRegion: null, inLiteral: false }
  }

  /* 模板区域只在模板编辑器里成立：`sql` 模式的编辑器里 `{{` 只是普通字符 */
  if (options.mode === 'sql-template') {
    const region = templateRegionAt(doc, pos)
    if (region) {
      return {
        ...base,
        language: 'template',
        templateRegion: {
          openAt: region.openAt,
          closeAt: region.closeAt,
          from: region.from,
          to: region.to,
        },
        inLiteral: false,
      }
    }
  }

  const inLiteral = inLiteralOrComment(state, pos)
  return {
    ...base,
    language: inLiteral ? 'blocked' : 'sql',
    templateRegion: null,
    inLiteral,
  }
}

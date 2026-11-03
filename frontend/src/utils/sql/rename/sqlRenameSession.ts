/** 表别名 / CTE 名称重命名（Rename Session） */
import type { TextRange } from '@/utils/sql/sqlSyntax'
import { RESERVED_WORDS } from '../sqlCompletionKeywords'
import { needsQuoting, renderIdent } from '../sqlCompletionInsert'
import { isPlainIdent } from '../sqlLexemes'
import type { SqlDialect } from '../rowSql'
import type { SqlColumnAliasSymbol, SqlCteSymbol, SqlTableAliasSymbol } from '../semantic/sqlSymbols'

/** 可以交给会话的符号（三类对象都有身份 / 名字 / 声明范围） */
export type RenameSymbol = SqlTableAliasSymbol | SqlCteSymbol | SqlColumnAliasSymbol

/** 可以重命名的对象类型（与语义层符号的 kind 一一对应） */
export type SqlRenameKind = 'table-alias' | 'cte' | 'column-alias'

/** 一次重命名会话 */
export interface SqlRenameSession {
  kind: SqlRenameKind
  /** 被重命名的符号身份（声明位置决定，与显示文本无关） */
  sourceId: string
  /** 原别名（已去引号） */
  oldName: string
  /** 当前输入的新别名（提交前只有声明处是它） */
  currentName: string
  /** 原声明使用的引号（`` ` `` / `"` / `[`）；裸写为 '' */
  quote: string
  /** 别名声明范围（重命名期间会随输入长度变化，由编辑器映射） */
  declarationRange: TextRange
  /** 进入会话时声明处的**原文**（含引号）——Esc 逐字节还原，不做二次渲染 */
  initialDeclaration: string
  /** 引用范围（不含声明） */
  referenceRanges: TextRange[]
  /** 进入会话时的文档（Esc 恢复用） */
  initialDocument: string
  /** 是否仍在重命名中 */
  active: boolean
}

/** 一处待应用的文本修改 */
export interface SqlTextEdit {
  from: number
  to: number
  insert: string
}

/** 取出某个范围首字符的引号（没有则空串） */
function quoteOf(text: string): string {
  return text === '`' || text === '"' || text === '[' ? text : ''
}

/** 开始一次重命名会话 */
export function createRenameSession(
  symbol: RenameSymbol,
  references: TextRange[],
  doc: string,
): SqlRenameSession {
  const declarationText = doc.slice(symbol.declarationRange.from, symbol.declarationRange.to)
  return {
    kind: symbol.kind,
    sourceId: symbol.id,
    oldName: symbol.name,
    currentName: symbol.name,
    quote: quoteOf(declarationText[0] ?? ''),
    declarationRange: symbol.declarationRange,
    initialDeclaration: declarationText,
    referenceRanges: references,
    initialDocument: doc,
    active: true,
  }
}

/** 会话是否仍然有效（符号身份与声明范围都对得上） */
export function isSameSession(
  session: SqlRenameSession | null,
  symbol: RenameSymbol | null,
): boolean {
  if (!session || !symbol) {
    return false
  }
  return session.sourceId === symbol.id
    && session.declarationRange.from === symbol.declarationRange.from
}

/** 带引号的标识符写法：`` `x` `` / `"x"` / `[x]` */
function unquotedOf(name: string): { name: string, quote: string } {
  const trimmed = name.trim()
  const first = trimmed[0] ?? ''
  const quote = quoteOf(first)
  if (!quote) {
    return { name: trimmed, quote: '' }
  }
  const close = quote === '[' ? ']' : quote
  if (!trimmed.endsWith(close) || trimmed.length < 2) {
    // 只写了开引号：按「还没写完」处理，内容原样返回
    return { name: trimmed.slice(1), quote }
  }
  return { name: trimmed.slice(1, -1), quote }
}

/** 别名是否合法（按方言） */
export function isValidSqlIdentifier(name: string, dialect: SqlDialect): boolean {
  const trimmed = name.trim()
  if (!trimmed) {
    return false
  }
  const { name: inner, quote } = unquotedOf(trimmed)
  if (!inner) {
    return false
  }
  if (quote) {
    return true
  }
  void dialect
  // 走全项目唯一的那套词法：中文别名（`用户`）与其它解析层认得的东西一致
  return isPlainIdent(trimmed)
}

/** 提示文案里怎么称呼被重命名的对象（措辞只在这一处） */
export function renameSubjectOf(kind: SqlRenameKind, full = true): string {
  if (kind === 'cte') {
    return full ? 'CTE 名称' : 'CTE'
  }
  if (kind === 'column-alias') {
    return '列别名'
  }
  return full ? '别名' : '表别名'
}

/** 重命名的校验提示：返回 null 表示可以提交 */
export function renameValidationMessage(
  name: string,
  dialect: SqlDialect,
  subject = '别名',
): string | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return `${subject}不能为空`
  }
  const { name: inner, quote } = unquotedOf(trimmed)
  if (!isValidSqlIdentifier(trimmed, dialect)) {
    return `${subject}不合法：请以字母或下划线开头，只包含字母、数字、下划线`
  }
  if (!quote && needsQuoting(inner)) {
    // 裸写的保留字会给后续 SQL 埋雷（`ORDER BY order.id` 直接把语句写坏）
    if (RESERVED_WORDS.has(inner.toLowerCase())) {
      return `「${inner}」是 SQL 保留字，换个名字，或手动加引号（如 \`${inner}\`）`
    }
    /* 中文等 CJK 标识符：词法上就是合法标识符 */
    if (isPlainIdent(inner)) {
      return null
    }
    return `「${inner}」含特殊字符，请手动加引号后再提交`
  }
  return null
}

/** 会话内「新别名的落地写法」（沿用原声明的引号样式，必要时补引号） */
export function renamedIdentOf(session: SqlRenameSession, dialect: SqlDialect): string {
  const { name, quote } = unquotedOf(session.currentName)
  if (quote) {
    return renderIdent(name, dialect, quote)
  }
  // 原来是带引号的写法：新名字继续用同一种引号，避免风格突变
  if (session.quote) {
    return renderIdent(name, dialect, session.quote)
  }
  return renderIdent(name, dialect)
}

/** 把新名字同步到「声明 + 所有引用」的文本修改列表 */
export function renameEdits(session: SqlRenameSession, dialect: SqlDialect): SqlTextEdit[] {
  const insert = renamedIdentOf(session, dialect)
  const ranges = [session.declarationRange, ...session.referenceRanges]
  return ranges
    .map(range => ({ from: range.from, to: range.to, insert }))
    .sort((left, right) => right.from - left.from)
}

/** 会话范围内的引用数量（界面提示「将重命名 N 处」用） */
export function renameTargetCount(session: SqlRenameSession): number {
  return session.referenceRanges.length + 1
}

/** Enter 提交的计划（纯函数，UI 层只负责把它变成一个 transaction） */
export interface RenameCommitPlan {
  /** 校验失败时的提示；非空表示这次 Enter 不提交 */
  error: string | null
  /** 要交付给编辑器的修改（声明 + 全部引用，from 倒序） */
  edits: SqlTextEdit[]
  /** 提交后光标落在哪里（新别名末尾） */
  selection: number
}

/** 规划一次提交 */
export function planRenameCommit(
  session: SqlRenameSession,
  typedName: string,
  dialect: SqlDialect,
): RenameCommitPlan {
  const declarationRange: TextRange = {
    from: session.declarationRange.from,
    to: session.declarationRange.from + session.initialDeclaration.length,
  }
  const error = renameValidationMessage(typedName, dialect, renameSubjectOf(session.kind))
  if (error) {
    return { error, edits: [], selection: declarationRange.from + typedName.length }
  }

  const insert = renamedIdentOf({ ...session, currentName: typedName }, dialect)
  const edits = [declarationRange, ...session.referenceRanges]
    .map(range => ({ from: range.from, to: range.to, insert }))
    .sort((left, right) => right.from - left.from)

  return {
    error: null,
    edits,
    selection: declarationRange.from + insert.length,
  }
}

/** Esc / 光标移出的恢复计划 */
export interface RenameCancelPlan {
  /** 需要恢复的修改；声明没被改过时为 null（不必派发事务） */
  change: SqlTextEdit | null
  /** 恢复后光标位置 */
  selection: number
}

/** 规划一次取消：把声明改回进入会话时的**原文** */
export function planRenameCancel(session: SqlRenameSession, doc: string): RenameCancelPlan {
  const current = doc.slice(session.declarationRange.from, session.declarationRange.to)
  return {
    change: current === session.initialDeclaration
      ? null
      : {
          from: session.declarationRange.from,
          to: session.declarationRange.to,
          insert: session.initialDeclaration,
        },
    selection: session.declarationRange.from + session.initialDeclaration.length,
  }
}

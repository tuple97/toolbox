/** 表别名重命名的 CodeMirror 接线 */
import { closeCompletion } from '@codemirror/autocomplete'
import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import type { EditorState, Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import type { TextRange } from '../sqlSyntax'
import { dialectOf } from '../rowSql'
import { defaultMetadataProvider, sqlContextFromRuntime } from '../sqlCompletion'
import type { CompletionRuntime } from '../sqlCompletion'
import {
  getCteReferences,
  getTableAliasReferences,
  resolveCteAtPosition,
  resolveTableAliasAtPosition,
} from '../semantic/sqlSymbols'
import { planColumnAliasRename } from './sqlColumnAlias'
import {
  createRenameSession,
  planRenameCancel,
  planRenameCommit,
  renameSubjectOf,
} from './sqlRenameSession'
import type { RenameSymbol, SqlRenameKind, SqlRenameSession } from './sqlRenameSession'

/** 可重命名的对象类型（与语义层符号 kind 一致） */
export type RenameTargetKind = SqlRenameKind

/** 解析结果：要么给出目标与引用，要么给出一句拒绝理由 */
type RenameResolution =
  | { ok: true, kind: RenameTargetKind, symbol: RenameSymbol, references: TextRange[] }
  | { ok: false, reason: string }

/** 设置 / 清除当前重命名会话 */
const setRenameSession = StateEffect.define<SqlRenameSession | null>()

/** 反馈出口（UI 层接 ElMessage） */
export interface RenameNotice {
  type: 'success' | 'warning'
  message: string
}

/** 接线选项 */
export interface SqlRenameViewOptions {
  /** 运行期上下文（连接 / 方言 / 元数据），与补全同源 */
  runtime: (view: EditorView) => CompletionRuntime
  /** 提示出口；不传则静默 */
  notify?: (notice: RenameNotice) => void
}

/** 当前会话（没有则为 null） */
function sessionOf(state: EditorState): SqlRenameSession | null {
  return state.field(renameSessionField, false) ?? null
}

/** 是否正在重命名（补全源据此让位） */
export function isRenaming(state: EditorState): boolean {
  return sessionOf(state) !== null
}

/** 会话状态字段：持有会话并把声明范围跟着编辑一起映射 */
const renameSessionField = StateField.define<SqlRenameSession | null>({
  create: () => null,
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (effect.is(setRenameSession)) {
        next = effect.value
      }
    }
    if (!next || !tr.docChanged) {
      return next
    }

    // 负 / 正关联让两端各自向外扩展：在范围内部插入时范围跟着变长
    const from = tr.changes.mapPos(next.declarationRange.from, -1)
    const to = tr.changes.mapPos(next.declarationRange.to, 1)
    if (from > to || to > tr.newDoc.length) {
      // 文档被整体替换（如外部 setValue）：映射已失真，直接结束会话
      return null
    }
    return { ...next, declarationRange: { from, to } }
  },
  provide: field => EditorView.decorations.from(field, session => (session
    ? Decoration.set([
        Decoration.mark({ class: 'cm-rename-active' })
          .range(session.declarationRange.from, session.declarationRange.to),
      ])
    : Decoration.none)),
})

/** 提交：Enter */
function commitRename(view: EditorView, options: SqlRenameViewOptions): boolean {
  const session = sessionOf(view.state)
  if (!session) {
    return false
  }

  const sql = sqlContextFromRuntime(options.runtime(view))
  const dialect = dialectOf(sql?.dbType ?? '')
  const doc = view.state.doc.toString()
  const typed = doc.slice(session.declarationRange.from, session.declarationRange.to)
  const plan = planRenameCommit(session, typed, dialect)

  if (plan.error) {
    options.notify?.({ type: 'warning', message: plan.error })
    return true
  }

  /* 先把声明恢复成原文（不进历史）：这一步让「提交」变成一个自洽的 「原文 → 新名字」事务，撤销一次即全量还原 */
  if (typed !== session.initialDeclaration) {
    view.dispatch({
      changes: {
        from: session.declarationRange.from,
        to: session.declarationRange.to,
        insert: session.initialDeclaration,
      },
      // 这一步只是把文档还原成原文，不该在历史里留下任何痕迹
      annotations: Transaction.addToHistory.of(false),
      effects: setRenameSession.of(null),
    })
  }

  view.dispatch({
    changes: plan.edits,
    selection: { anchor: plan.selection },
    effects: setRenameSession.of(null),
    userEvent: 'input.rename',
  })
  options.notify?.({
    type: 'success',
    message: `已重命名${renameSubjectOf(session.kind, false)}（${plan.edits.length} 处）`,
  })
  return true
}

/** 取消：Esc / 光标移出。还原声明且不进历史 */
function cancelRename(view: EditorView, options: SqlRenameViewOptions, silent = true): boolean {
  const session = sessionOf(view.state)
  if (!session) {
    return false
  }

  const plan = planRenameCancel(session, view.state.doc.toString())
  view.dispatch({
    ...(plan.change ? { changes: plan.change } : {}),
    selection: { anchor: plan.selection },
    effects: setRenameSession.of(null),
    // 取消不产生历史步：Esc 之后不该多出一条「恢复旧名字」的撤销记录
    annotations: Transaction.addToHistory.of(false),
  })
  if (!silent) {
    options.notify?.({ type: 'warning', message: '已取消重命名' })
  }
  return true
}

/** 重命名扩展：状态 + 装饰 + 按键 + 光标守护 */
export function sqlRenameExtension(options: SqlRenameViewOptions): Extension {
  return [
    renameSessionField,
    Prec.highest(keymap.of([
      { key: 'Enter', run: view => commitRename(view, options) },
      { key: 'Escape', run: view => cancelRename(view, options, false) },
      {
        // Ctrl/Cmd+A 在重命名里只选别名本身，不要选中整个文档
        key: 'Mod-a',
        run: (view) => {
          const session = sessionOf(view.state)
          if (!session) {
            return false
          }
          view.dispatch({
            selection: {
              anchor: session.declarationRange.from,
              head: session.declarationRange.to,
            },
          })
          return true
        },
      },
    ])),
    EditorView.updateListener.of((update) => {
      const session = sessionOf(update.state)
      if (!session || !update.selectionSet) {
        return
      }
      const head = update.state.selection.main.head
      if (head < session.declarationRange.from || head > session.declarationRange.to) {
        // 光标离开了别名范围（点击别处 / 方向键走开）：等同 Esc
        cancelRename(update.view, options)
      }
    }),
  ]
}

/** 位置 → 可重命名目标 */
function resolveRenameTarget(
  view: EditorView,
  pos: number,
  options: SqlRenameViewOptions,
): RenameResolution {
  const runtime = options.runtime(view)
  const sql = sqlContextFromRuntime(runtime)
  if (!sql?.connId) {
    return { ok: false, reason: '请先选择数据库连接' }
  }
  const dbType = sql.dbType

  const alias = resolveTableAliasAtPosition(view.state, pos, dbType)
  if (alias) {
    return {
      ok: true,
      kind: alias.kind,
      symbol: alias,
      references: getTableAliasReferences(view.state, alias, dbType),
    }
  }

  const cte = resolveCteAtPosition(view.state, pos, dbType)
  if (cte) {
    return {
      ok: true,
      kind: cte.kind,
      symbol: cte,
      references: getCteReferences(view.state, cte, dbType),
    }
  }

  const metadata = runtime.metadata ?? defaultMetadataProvider
  const plan = planColumnAliasRename({
    state: view.state,
    pos,
    dbType,
    // 与补全同一份元数据缓存：同步返回已有列，缺的由 store 在后台补齐
    columnsOf: ref => metadata.columns(sql.connId, ref.schema || sql.database, ref.table),
  })
  if (!plan) {
    return { ok: false, reason: '这里不是表别名、CTE 名称或列别名，无法重命名' }
  }
  if ('reason' in plan) {
    return { ok: false, reason: plan.reason }
  }
  return { ok: true, kind: plan.symbol.kind, symbol: plan.symbol, references: plan.references }
}

/** 该位置可重命名的对象类型（界面标签用） */
export function renameTargetAt(
  view: EditorView,
  pos: number,
  options: SqlRenameViewOptions,
): RenameTargetKind | null {
  const resolved = resolveRenameTarget(view, pos, options)
  return resolved.ok ? resolved.kind : null
}

/** 在指定位置开始重命名（右键菜单入口） */
export function startRenameAt(
  view: EditorView,
  pos: number,
  options: SqlRenameViewOptions,
): boolean {
  const resolved = resolveRenameTarget(view, pos, options)
  if (!resolved.ok) {
    options.notify?.({ type: 'warning', message: resolved.reason })
    return false
  }

  // 已经在重命名里：先按 Esc 的语义收尾，避免两个会话打架
  cancelRename(view, options)

  const session = createRenameSession(
    resolved.symbol,
    resolved.references,
    view.state.doc.toString(),
  )

  // 全选别名：用户直接输入就能覆盖，敲 Enter 则是「名字没变」的合法提交
  view.dispatch({
    effects: setRenameSession.of(session),
    selection: { anchor: session.declarationRange.from, head: session.declarationRange.to },
  })
  closeCompletion(view)
  view.focus()
  return true
}

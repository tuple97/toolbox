/**
 * 语句运行按钮：编辑器最左侧 gutter 里给**每条语句**一个按钮。
 *
 * 与「当前语句边框」配套——边框划出这条语句的范围，按钮让你直接跑它。
 * 按钮同时兼作状态灯：
 *
 *   ▶ 未执行   ⟳ 执行中   ✓ 成功   ✕ 失败   ⊘ 已取消
 *
 * 状态放在编辑器的 StateField 里、由 StateEffect 更新：调用方在开始/结束执行时
 * 各 dispatch 一次即可，gutter 自己会重绘，不需要外部再通知视图，
 * 也不会因为切标签页（编辑器被 v-show 隐藏）而丢失。
 *
 * **键取语句文本**（trim 后）：语句被改写就自然失配、旧状态不再显示；
 * 而在别处增删语句不会让状态错位（行号、下标都会错位）。
 */
import type { Extension } from '@codemirror/state'
import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import { splitSqlStatements } from '@/utils/sql/sqlStatementRanges'

/** 一条语句的执行状态 */
export type StatementRunState = 'running' | 'success' | 'error' | 'cancelled'

/** 语句文本 → 执行状态 */
export type StatementRunStates = Record<string, StatementRunState>

/** 语句文本 → 状态键（与执行器上报时的取法保持一致） */
export function statementRunKey(sql: string): string {
  return sql.trim()
}

/** 整体替换执行状态（调用方在执行前后 dispatch） */
export const setStatementRunStates = StateEffect.define<StatementRunStates>()

/** 当前执行状态（编辑器里只有一份） */
const runStatesField = StateField.define<StatementRunStates>({
  create: () => ({}),
  update(value, transaction) {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(setStatementRunStates)) {
        next = effect.value
      }
    }
    return next
  },
})

/** 可执行的语句（给调用方足够信息去执行或定位） */
export interface RunnableStatement {
  from: number
  to: number
  sql: string
}

export interface RunGutterOptions {
  /** 方言取值函数（决定语句怎么切分） */
  dbType?: () => string
  /** 点击运行按钮 */
  onRun: (statement: RunnableStatement) => void
}

/*
 * 图标用内联 SVG：gutter marker 返回的是原生 DOM，拿不到 Vue 的图标组件；
 * 颜色统一走 currentColor，由 CSS 按状态着色。
 */
const ICON_RUN = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5.2 3.2v9.6L12.6 8z"/></svg>'
const ICON_RUNNING = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" class="cm-sql-run-spin"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="9 27"/></svg>'
const ICON_SUCCESS = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M3.4 8.6l3 3 6.2-6.4"/></svg>'
const ICON_ERROR = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>'
const ICON_CANCELLED = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M5.7 8h4.6"/></svg>'

const STATE_ICONS: Record<StatementRunState, string> = {
  running: ICON_RUNNING,
  success: ICON_SUCCESS,
  error: ICON_ERROR,
  cancelled: ICON_CANCELLED,
}

const STATE_TITLES: Record<StatementRunState, string> = {
  running: '执行中…',
  success: '执行成功',
  error: '执行失败',
  cancelled: '已取消',
}

/** 运行按钮 */
class RunButtonMarker extends GutterMarker {
  constructor(
    private readonly state: StatementRunState | undefined,
    private readonly statement: RunnableStatement,
    private readonly onRun: (statement: RunnableStatement) => void,
  ) {
    super()
  }

  /**
   * 状态、位置、语句文本都没变才复用 DOM。
   *
   * 三项缺一不可：按钮把语句信息闭包在里面，只要位置或文本变了就必须重建，
   * 否则点击时会拿着旧的偏移或旧的 SQL 去执行。
   */
  eq(other: RunButtonMarker): boolean {
    return this.state === other.state
      && this.statement.from === other.statement.from
      && this.statement.sql === other.statement.sql
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = this.state ? `cm-sql-run-btn is-${this.state}` : 'cm-sql-run-btn'
    button.innerHTML = this.state ? STATE_ICONS[this.state] : ICON_RUN
    const label = this.state ? `${STATE_TITLES[this.state]}，点击重新执行` : '执行这条语句'
    button.title = label
    button.setAttribute('aria-label', label)
    // 按下不抢编辑器焦点，否则执行完还得点回编辑器才能继续改
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.onRun(this.statement)
    })
    return button
  }
}

/** 占位元素：只为撑出与按钮一致的宽度，避免行号左右跳动 */
class RunButtonSpacer extends GutterMarker {
  toDOM(): HTMLElement {
    const spacer = document.createElement('span')
    spacer.className = 'cm-sql-run-spacer'
    return spacer
  }
}

/**
 * 语句运行按钮扩展。
 *
 * 放在行号 gutter **之前**即可显示在行号左边（gutter 按扩展顺序排列）。
 */
export function sqlStatementRunGutter(options: RunGutterOptions): Extension {
  const dialectOf = () => options.dbType?.() ?? ''

  return [
    runStatesField,
    gutter({
      class: 'cm-sql-run-gutter',
      markers(view) {
        const statements = splitSqlStatements(view.state.doc.toString(), dialectOf())
        if (!statements.length) {
          return RangeSet.empty
        }

        const states = view.state.field(runStatesField)
        const markers = statements.map((statement) => {
          const runnable: RunnableStatement = { from: statement.from, to: statement.to, sql: statement.sql }
          const state = states[statementRunKey(statement.sql)]
          // 按钮挂在这条语句的首行上
          return new RunButtonMarker(state, runnable, options.onRun)
            .range(view.state.doc.lineAt(statement.from).from)
        })
        return RangeSet.of(markers, true)
      },
      initialSpacer: () => new RunButtonSpacer(),
    }),
    EditorView.baseTheme({
      '.cm-sql-run-gutter': {
        width: '22px',
      },
      '.cm-sql-run-gutter .cm-gutterElement': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
      },
      '.cm-sql-run-spacer': {
        display: 'inline-block',
        width: '18px',
        height: '18px',
      },
      '.cm-sql-run-btn': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
        padding: '0',
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        // 用主题强调色，让按钮一眼可辨是「可点的动作」而不是行号的一部分
        color: 'var(--brand-color)',
        cursor: 'pointer',
        // 常态略淡，鼠标移到该行才完全显色，避免整屏都是按钮
        opacity: '0.6',
        transition: 'opacity 0.12s ease, background-color 0.12s ease',
      },
      '.cm-sql-run-gutter .cm-gutterElement:hover .cm-sql-run-btn': {
        opacity: '1',
        background: 'var(--hover-bg)',
      },
      '.cm-sql-run-btn.is-running': {
        color: 'var(--brand-color)',
        opacity: '1',
      },
      '.cm-sql-run-btn.is-success': {
        // 走主题的成功色，取不到再退回一个稳妥的绿
        color: 'var(--success-color, #22c55e)',
        opacity: '1',
      },
      '.cm-sql-run-btn.is-error': {
        color: 'var(--danger-color)',
        opacity: '1',
      },
      '.cm-sql-run-btn.is-cancelled': {
        opacity: '1',
      },
      '@keyframes cm-sql-run-rotate': {
        from: { transform: 'rotate(0deg)' },
        to: { transform: 'rotate(360deg)' },
      },
      '.cm-sql-run-spin': {
        animation: 'cm-sql-run-rotate 0.9s linear infinite',
        transformOrigin: '50% 50%',
      },
    }),
  ]
}

/**
 * SQL 补全的触发策略。
 *
 * 三档模式，供「设置 → SQL 提示触发方式」选择：
 *  - `manual`：只在显式触发（Ctrl+Space）时弹出；
 *  - `require-prefix`：打字自动弹，但要求光标前已有标识符前缀（或刚敲下点号）——
 *    避免一敲空格/括号就弹一屏；
 *  - `positional`：默认档。按位置判定：表位 / 列位 / 表达式位 / 关键字位 /
 *    关联条件位等「合理弹窗位」才自动弹，且要求确实输入了内容或结构字符。
 *
 * 说明：本版 CodeMirror 的 `autocompletion.activateOnTyping` 只接受布尔值，
 * 无法按「位置」逐次判定，因此打字触发改由本模块的扩展接管：
 * 关闭 CM 自带打字触发，命中策略时再显式 `startCompletion`。
 *
 * 判定函数是纯函数（只吃 facts），可以在 node 环境下直接测。
 */
import { startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'

/** 触发模式 */
export type SqlTriggerMode = 'manual' | 'require-prefix' | 'positional'

/** 默认模式：位置感知（与设置项默认值保持一致） */
export const DEFAULT_SQL_TRIGGER_MODE: SqlTriggerMode = 'positional'

/** 设置面板用的选项清单（value 与后端 settings 里存的值一致） */
export const SQL_TRIGGER_MODE_OPTIONS: Array<{
  value: SqlTriggerMode
  label: string
  hint: string
}> = [
  {
    value: 'positional',
    label: '位置感知（推荐）',
    hint: '只在表名 / 列名 / 表达式处弹出',
  },
  {
    value: 'require-prefix',
    label: '需要前缀',
    hint: '先输入一个字符',
  },
  {
    value: 'manual',
    label: '仅手动',
    hint: '仅 Ctrl+Space',
  },
]

/** 解析配置值；未知值回退默认档 */
export function parseSqlTriggerMode(raw: string | undefined): SqlTriggerMode {
  return raw === 'manual' || raw === 'require-prefix' ? raw : DEFAULT_SQL_TRIGGER_MODE
}

/** 触发判定所需的全部事实（由调用方（CodeEditor）就地算出） */
export interface TriggerFacts {
  /** 触发来源：显式（Ctrl+Space）还是打字 */
  origin: 'explicit' | 'typing'
  /** 光标前紧邻标识符字符 */
  hasIdentifierPrefix: boolean
  /** 刚敲下点号（`a.`） */
  qualifierTriggered: boolean
  /** 光标在字符串 / 注释内 */
  inCommentOrString: boolean
  /** 当前位置属于「合理弹窗位」（由引擎的位置分类给出，见 contextKindAt） */
  positionalEligible: boolean
  /** 本次输入插入的字符（打字触发时提供，多字符粘贴为 undefined） */
  insertedChar?: string
  /**
   * 光标处于模板片段 `{{ … }}` 内（仅模板编辑器会置真）。
   *
   * 模板里 `'{{ device_no }}'`（引号内插值）是最常见的写法，
   * 片段内既不该被「字符串里不弹」拦掉，也不该被位置判定拦掉。
   */
  inTemplateFragment?: boolean
  /** 预留：以库名限定书写（`db`.`table`）时的库名 */
  useDatabasePrefix?: string | null
}

/**
 * 结构字符：敲下它们之后即使还没有标识符前缀也值得弹候选。
 * 空格放进来是因为输入 `SELECT * FROM ` 这类空档位置时正需要表名候选。
 */
const STRUCTURE_CHARS = new Set(['.', '(', ',', '=', ' ', '\n', '\t'])

/**
 * 是否应该自动弹出补全。
 *
 * 显式触发永远放行（包括字符串 / 注释里——用户主动要候选时不拦），
 * 打字触发则按模式判定；字符串 / 注释内一律不打扰。
 */
export function shouldTriggerCompletion(facts: TriggerFacts, mode: SqlTriggerMode): boolean {
  if (facts.origin === 'explicit') {
    return true
  }
  if (mode === 'manual') {
    return false
  }
  // 模板片段内属于「正在写模板」，不受字符串 / 注释判定影响
  const templateFragment = facts.inTemplateFragment === true

  // 字符串 / 注释里打字不弹（它们是文本，不是 SQL 结构）
  if (facts.inCommentOrString && !templateFragment) {
    return false
  }
  if (mode === 'require-prefix') {
    return facts.hasIdentifierPrefix || facts.qualifierTriggered
  }

  // positional：先看位置，再看「是否真的输入了东西」
  if (!facts.positionalEligible && !templateFragment) {
    return false
  }
  return (
    facts.hasIdentifierPrefix
    || facts.qualifierTriggered
    || STRUCTURE_CHARS.has(facts.insertedChar ?? '')
    // 敲下 `{{` 的第二半就该给变量 / 片段候选
    || (templateFragment && facts.insertedChar === '{')
  )
}

/** 打字触发扩展所需的取值函数（都从编辑器/配置里现读，保持廉价） */
export interface SqlTriggerOptions {
  /** 当前触发模式（读设置项） */
  getMode: () => SqlTriggerMode
  /** 当前位置是否属于合理弹窗位（引擎的位置分类） */
  getPositionalEligible: (state: EditorState) => boolean
  /** 是否处于字符串 / 注释内 */
  getInLiteralOrComment: (state: EditorState) => boolean
  /** 显式触发时用的模式（默认也读 getMode；测试可注入） */
  getExplicitMode?: () => SqlTriggerMode
}

/**
 * 打字触发扩展。
 *
 * 只在「用户敲入单个字符」时判定（粘贴 / 删除 / 组合输入不弹），
 * 命中策略后于下一轮事件循环显式打开补全——更新周期内不允许派发事务。
 */
export function sqlCompletionTrigger(options: SqlTriggerOptions): Extension {
  return EditorView.updateListener.of((update) => {
    // 组合输入（中文/日文输入法）期间不打扰，等上屏后再判
    if (update.view.composing) {
      return
    }
    const mode = options.getMode()
    if (mode === 'manual') {
      return
    }

    const typed = update.transactions.filter(tr => tr.isUserEvent('input.type'))
    if (!typed.length) {
      return
    }

    const inserted = insertedTextOf(update)
    const view = update.view
    const state = view.state
    const pos = state.selection.main.head
    const line = state.doc.lineAt(pos)
    const before = line.text.slice(0, pos - line.from)

    const facts: TriggerFacts = {
      origin: 'typing',
      hasIdentifierPrefix: /[A-Za-z0-9_$]$/.test(before),
      qualifierTriggered: inserted === '.' || /\.$/.test(before),
      inCommentOrString: options.getInLiteralOrComment(state),
      positionalEligible: options.getPositionalEligible(state),
      insertedChar: inserted.length === 1 ? inserted : undefined,
    }

    if (!shouldTriggerCompletion(facts, mode)) {
      return
    }

    setTimeout(() => {
      // 编辑器可能已经被销毁（切标签 / 关标签）
      if (view.dom.isConnected) {
        startCompletion(view)
      }
    }, 0)
  })
}

/** 本次事务插入的文本（多处插入时拼接；用于判断「敲了哪个字符」） */
function insertedTextOf(update: { changes: { iterChanges: (f: (
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
  inserted: { toString: () => string },
) => void) => void } }): string {
  let text = ''
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    text += inserted.toString()
  })
  return text
}

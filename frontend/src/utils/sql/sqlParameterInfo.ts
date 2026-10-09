/**
 * 函数参数提示的位置判定（Ctrl+P 的「我在哪个函数的第几个参数里」）。
 *
 * 只做位置解析，不做 UI：输入纯文本与光标位置，输出「命中的函数元数据 +
 * 当前参数下标 + 左括号位置」，可在 node 环境直接测。UI（浮层）在 CodeEditor。
 *
 * 解析是**反向扫描**（与 sqlCursor 的子句扫描同一套路）：从光标往左走，
 * 维护括号深度、跳过字符串与注释；遇到第一个「深度归零的左括号」就是
 * 当前参数列表的开头，读它左边的标识符查函数目录 —— 不在目录里
 * （`IN (`、`VALUES (`、普通标识符）就不提示，绝不硬猜。
 *
 * 当前参数下标 = 左括号到光标之间的**顶层逗号数**（相对该括号的深度）。
 */
import { skipQuotedBackward } from './sqlCursor'
import { functionDocOf } from './functionCatalog'
import type { SqlFunctionDoc } from './functionCatalog'

/** 一次参数提示的命中 */
export interface SqlParameterInfo {
  /** 命中的函数元数据 */
  doc: SqlFunctionDoc
  /** 当前正在写的参数下标（0 起）；超出参数个数时由 UI 钳到最后一个 */
  argIndex: number
  /** 函数名后那个 `(` 的文档位置（浮层锚点） */
  openParen: number
}

/** 取光标处的参数提示；不在任何受支持函数的参数列表里时返回 null */
export function parameterInfoAt(text: string, pos: number): SqlParameterInfo | null {
  let index = pos
  let depth = 0
  let topLevelCommas = 0

  while (index > 0) {
    const ch = text[index - 1] ?? ''

    if (ch === ')') {
      depth++
      index--
      continue
    }
    if (ch === '(') {
      if (depth === 0) {
        return hitAt(text, index - 1, topLevelCommas)
      }
      depth--
      index--
      continue
    }
    if (ch === ',' && depth === 0) {
      topLevelCommas++
      index--
      continue
    }
    // 字符串 / 引号标识符：整段跳过（里面的括号、逗号都不算结构）
    if (ch === '\'' || ch === '"' || ch === '`') {
      index = skipQuotedBackward(text, index - 1)
      continue
    }
    // 换行：上面那一行若是行注释（-- 或 # 开头），整行跳过 ——
    // 行里的括号与逗号不是结构。按「行」跳是关键：只认 `--` 两个字符的话，
    // 反向扫描会先踩进注释内容（逗号会被误计成参数分隔符）。
    if (ch === '\n') {
      const lineStartAbove = text.lastIndexOf('\n', index - 2) + 1
      if (/^\s*(?:--|#)/.test(text.slice(lineStartAbove, index - 1))) {
        index = lineStartAbove
        continue
      }
      index--
      continue
    }
    // 块注释：从 `*/` 右缘跳到 `/*` 左缘
    if (ch === '/' && text[index - 2] === '*') {
      const blockStart = text.lastIndexOf('/*', index - 3)
      index = blockStart < 0 ? 0 : blockStart
      continue
    }
    // 行注释的 `--` 本身（多数情况已被上面的整行跳过处理，这里兜底）
    if (ch === '-' && text[index - 2] === '-') {
      const lineStart = text.lastIndexOf('\n', index - 1)
      index = lineStart < 0 ? 0 : lineStart
      continue
    }
    index--
  }
  return null
}

/** 左括号在 `at` 位置：读它左边的函数名并查目录，命中返回结论 */
function hitAt(text: string, at: number, topLevelCommas: number): SqlParameterInfo | null {
  let start = at
  while (start > 0 && /[\w$]/.test(text[start - 1] ?? '')) {
    start--
  }
  const name = text.slice(start, at)
  // 空名或以数字开头（更可能是数字字面量后面跟了个括号）不算函数调用
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
    return null
  }
  const doc = functionDocOf(name)
  if (!doc) {
    return null
  }
  return { doc, argIndex: topLevelCommas, openParen: at }
}

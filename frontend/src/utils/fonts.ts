/** 字体选项：默认字体 + 本机已安装字体 */

export interface FontOption {
  /** 配置值：`system` 或 `sys:<字族名>` */
  value: string
  /** 下拉框展示名 */
  label: string
}

/** 字体角色：英文与中文各选一份 */
export type FontRole = 'en' | 'zh'

/** 随包内置的英文字体 */
export const BUILTIN_EN_FONT = 'Maple Mono'

/** 界面默认字体栈 */
export const DEFAULT_UI_FONT_STACK
  = '"Microsoft YaHei", "PingFang SC", "Segoe UI", "Helvetica Neue", Arial, sans-serif'

/** 编辑器默认字体栈 */
export const DEFAULT_EDITOR_FONT_STACK
  = '"Maple Mono", Consolas, "Microsoft YaHei", monospace'

/** 默认字体的配置值 */
export const BUILTIN_FONT_VALUE = 'system'

/** 本机字体的配置值前缀 */
export const SYSTEM_FONT_PREFIX = 'sys:'

/** 默认字体标识 */
export const DEFAULT_FONT = BUILTIN_FONT_VALUE

/** 中文字形漏字时的系统兜底 */
const CJK_FALLBACK = '"Microsoft YaHei", "PingFang SC", sans-serif'

/** 取单个角色的字体栈片段；默认值返回空串，由调用方补默认栈 */
export function fontStackOf(value: string | undefined, role: FontRole): string {
  if (value && value.startsWith(SYSTEM_FONT_PREFIX)) {
    const name = value.slice(SYSTEM_FONT_PREFIX.length)
    if (name) {
      return `"${name}"`
    }
  }
  return ''
}

/** 组合界面字体栈：用户选的字体优先，否则用系统默认栈 */
export function composeUiFontStack(en: string | undefined, zh: string | undefined): string {
  const parts = [fontStackOf(en, 'en'), fontStackOf(zh, 'zh'), CJK_FALLBACK].filter(Boolean)
  return parts.length > 1 ? parts.join(', ') : DEFAULT_UI_FONT_STACK
}

/** 组合编辑器字体栈：英文默认 Maple Mono，中文默认 Consolas */
export function composeEditorFontStack(en: string | undefined, zh: string | undefined): string {
  const enStack = fontStackOf(en, 'en') || `"${BUILTIN_EN_FONT}"`
  const zhStack = fontStackOf(zh, 'zh') || 'Consolas'
  return `${enStack}, ${zhStack}, ${CJK_FALLBACK}`
}

/** 拼出字体下拉选项；默认项标签按用途区分 */
export function buildFontOptions(
  systemFonts: string[],
  role: FontRole,
  defaultLabel = '系统默认字体',
): FontOption[] {
  const label = role === 'en' ? defaultLabel : `${defaultLabel}（中文）`
  const options: FontOption[] = [{ value: BUILTIN_FONT_VALUE, label }]

  for (const name of systemFonts) {
    options.push({ value: `${SYSTEM_FONT_PREFIX}${name}`, label: name })
  }

  return options
}

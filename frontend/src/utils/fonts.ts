/** 字体选项：内置默认字体 + 本机已安装字体 */

export interface FontOption {
  /** 配置中存储的标识：内置为 `system`，本机字体为 `sys:<字族名>` */
  value: string
  /** 下拉框展示名 */
  label: string
}

/** 字体角色：英文（拉丁与符号）与中文各选一份 */
export type FontRole = 'en' | 'zh'

/** 随包内置的默认英文字体（唯一内置字体，文件与许可证见 assets/fonts） */
export const BUILTIN_EN_FONT = 'Maple Mono'

/** 中文字体的默认值：不随包内置，直接用系统自带字体 */
export const DEFAULT_ZH_FAMILY = 'Consolas'

/**
 * 默认字体的配置值。
 *
 * en 档解析为内置的 Maple Mono，zh 档解析为系统默认字族（Consolas）。
 * 沿用 'system' 而不另起新值：历史配置里存的就是它，
 * 因此换内置字体、拆成中英文两档都不会让老配置失效。
 */
export const BUILTIN_FONT_VALUE = 'system'

/** 本机字体的配置值前缀 */
export const SYSTEM_FONT_PREFIX = 'sys:'

/** 默认字体标识 */
export const DEFAULT_FONT = BUILTIN_FONT_VALUE

/** 中文字形漏字时的系统兜底 */
const CJK_FALLBACK = '"Microsoft YaHei", "PingFang SC", sans-serif'

/** 单个角色的字体栈片段：内置字体、系统默认字族或本机字体族 */
export function fontStackOf(value: string | undefined, role: FontRole): string {
  if (value && value.startsWith(SYSTEM_FONT_PREFIX)) {
    const name = value.slice(SYSTEM_FONT_PREFIX.length)
    if (name) {
      return `"${name}"`
    }
  }
  return role === 'en' ? `"${BUILTIN_EN_FONT}"` : `"${DEFAULT_ZH_FAMILY}"`
}

/**
 * 合并英文与中文字体为一个字体栈。
 *
 * 英文在前：拉丁字母与符号一律走它（编辑器里等宽对齐靠这一步）；
 * 中文在后：只负责中文字形，缺失时再落到系统中文兜底。
 */
export function composeFontStack(en: string | undefined, zh: string | undefined): string {
  return `${fontStackOf(en, 'en')}, ${fontStackOf(zh, 'zh')}, ${CJK_FALLBACK}`
}

/** 根据本机字体列表拼出下拉选项（默认字体始终排在最前） */
export function buildFontOptions(systemFonts: string[], role: FontRole): FontOption[] {
  const label = role === 'en' ? `${BUILTIN_EN_FONT}（内置）` : `${DEFAULT_ZH_FAMILY}（系统）`
  const options: FontOption[] = [{ value: BUILTIN_FONT_VALUE, label }]

  for (const name of systemFonts) {
    options.push({ value: `${SYSTEM_FONT_PREFIX}${name}`, label: name })
  }

  return options
}

/** 剪贴板工具：优先 Wails 原生能力，失败则退回浏览器剪贴板 */
import { Clipboard } from '@wailsio/runtime'

/** 写入剪贴板；两条路径都不可用时抛错 */
export async function copyText(text: string): Promise<void> {
  try {
    if (Clipboard?.SetText) {
      await Clipboard.SetText(text)
      return
    }
  }
  catch {
    // 落到浏览器剪贴板
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('当前环境不支持写入剪贴板')
}

/**
 * 读取剪贴板文本。
 *
 * 返回 `null` 表示「读不了」（环境不支持或权限被拒），与「读到了但内容为空」
 * 区分开：前者只能保守地把「粘贴」置灰，后者说明剪贴板确实是空的。
 */
export async function readText(): Promise<string | null> {
  try {
    if (Clipboard?.Text) {
      const text = await Clipboard.Text()
      return typeof text === 'string' ? text : ''
    }
  }
  catch {
    // 落到浏览器剪贴板
  }
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  }
  catch {
    // 权限被拒 / 不支持：读不了
  }
  return null
}

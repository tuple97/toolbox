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

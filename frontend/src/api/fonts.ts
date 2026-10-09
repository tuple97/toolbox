import { ListSystemFonts } from './bindings'

/** 读取本机已安装的字体族名称，异常时返回空列表 */
export async function fetchSystemFonts(): Promise<string[]> {
  try {
    const list = await ListSystemFonts()
    return Array.isArray(list) ? list : []
  }
  catch {
    return []
  }
}

/**
 * 系统文件 / 文件夹选择器。
 *
 * 直接封装 Wails 的 Dialogs：选择结果就是磁盘绝对路径，
 * 可以直接交给后端按路径读取，不必像拖拽那样把内容编码成 base64 传一遍。
 */

import { Dialogs } from '@wailsio/runtime'

/** 文件类型过滤（与 Wails 的 FileFilter 对应；Pattern 为分号分隔的扩展名） */
export interface FileFilterOption {
  DisplayName: string
  Pattern: string
}

/** 用户取消选择时 Wails 返回空串或空数组，这里统一成数组 */
function normalizeSelection(result: string | string[]): string[] {
  const list = Array.isArray(result) ? result : [result]
  return list.filter(item => typeof item === 'string' && item.length > 0)
}

/** 选择文件夹（支持多选）；取消时返回空数组 */
export async function pickDirectories(title: string, buttonText = '选择'): Promise<string[]> {
  try {
    const result = await Dialogs.OpenFile({
      Title: title,
      ButtonText: buttonText,
      CanChooseDirectories: true,
      CanChooseFiles: false,
      AllowsMultipleSelection: true,
    })
    return normalizeSelection(result)
  }
  catch {
    return []
  }
}

/** 选择文件（支持多选，可按扩展名过滤）；取消时返回空数组 */
export async function pickFiles(
  title: string,
  filters: FileFilterOption[] = [],
  buttonText = '选择',
): Promise<string[]> {
  try {
    const result = await Dialogs.OpenFile({
      Title: title,
      ButtonText: buttonText,
      CanChooseDirectories: false,
      CanChooseFiles: true,
      AllowsMultipleSelection: true,
      Filters: filters,
    })
    return normalizeSelection(result)
  }
  catch {
    return []
  }
}

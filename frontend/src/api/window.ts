/** 窗口控制封装 */

import {
  WindowClose,
  WindowIsMaximised,
  WindowMinimise,
  WindowToggleMaximise,
} from './bindings'
import { Window } from '@wailsio/runtime'
import type { ThemeMode } from '@/types'

/** 主题对应的窗口底色 */
const WINDOW_BG_COLORS: Record<ThemeMode, readonly [number, number, number]> = {
  dark: [15, 23, 42], // #0f172a
  midnight: [10, 10, 12], // #0a0a0c
  idea: [43, 43, 43], // #2b2b2b
  light: [241, 245, 249], // #f1f5f9
}

/** 是否运行在 Wails 桌面环境 */
export const isWailsRuntime = typeof window !== 'undefined' && 'runtime' in window

/** 让窗口底色跟随主题，避免重绘时闪黑 / 闪白 */
export function syncWindowBackground(theme: ThemeMode): void {
  const [r, g, b] = WINDOW_BG_COLORS[theme]
  void Window.SetBackgroundColour(r, g, b, 255)
}

export function minimiseWindow(): void {
  void WindowMinimise()
}

export function closeWindow(): void {
  void WindowClose()
}

export function toggleMaximiseWindow(): void {
  void WindowToggleMaximise()
}

/** 打开 WebView 开发者工具，打包版为空实现 */
export function openDevTools(): void {
  void Window.OpenDevTools()
}

export async function isWindowMaximised(): Promise<boolean> {
  return await WindowIsMaximised()
}

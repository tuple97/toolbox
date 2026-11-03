/** 宿主内部 SDK：把宿主的共享内核（stores / api / utils / 业务组件） 聚合成一个按原路径索引的模 */

import * as wailsRuntime from '@wailsio/runtime'

/** 把 Vite 的模块路径转成插件源码里书写的 `@/...` 路径（可能多个别名） */
function toHostKeys(path: string): string[] {
  const rel = path.replace(/^\.\.\//, '')
  const stripped = rel
    .replace(/\.(ts|js|mts|mjs)$/, '')
    .replace(/\/index$/, '')

  const keys = [`@/${stripped}`]
  if (stripped.endsWith('.vue')) {
    keys.push(`@/${stripped.slice(0, -'.vue'.length)}`)
  }
  return keys
}

/** 额外以「裸模块名」登记在模块表里的依存（插件会直接 import 它们） */
function bareModules(): Record<string, unknown> {
  return {
    // Wails 运行时：事件总线必须是宿主同一份实例，否则收发彼此不可见
    '@wailsio/runtime': wailsRuntime,
  }
}

/** 构建宿主模块表 */
export function buildHostModules(): Record<string, unknown> {
  const modules = import.meta.glob(
    [
      '../{stores,api,utils,components,lib,types}/**/*.{ts,vue}',
      // 测试文件不进产物
      '!../**/*.spec.ts',
      '!../**/*.test.ts',
      // ui 原子组件已由 api.ui 暴露，避免重复登记
      '!../components/ui/**',
    ],
    { eager: true },
  ) as Record<string, unknown>

  const out: Record<string, unknown> = { ...bareModules() }
  for (const [path, mod] of Object.entries(modules)) {
    for (const key of toHostKeys(path)) {
      out[key] = mod
    }
  }
  return out
}

/** 宿主模块表的类型（给插件 SDK 的 TS 声明用） */
export type HostModules = Record<string, unknown>

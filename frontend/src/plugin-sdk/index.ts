/**
 * 宿主内部 SDK：把宿主的共享内核（stores / api / utils / 业务组件）
 * 聚合成一个按原路径索引的模块表，注入给插件使用。
 *
 * 为什么不做成独立 npm 包：
 *   这些能力与宿主的数据模型深度绑定（DBConnection、metadata 缓存、
 *   SQL 补全引擎、CodeEditor），复制进每个插件会立刻产生多份实现与
 *   版本漂移。这里以「宿主提供、插件引用」的方式共享，插件的
 *   engines.toolbox 负责声明自己需要的宿主版本。
 *
 * 稳定性契约：
 *   这张表是**官方插件**的稳定接口；宿主重构内部实现时应保持这些
 *   模块的导出签名不变，否则会破坏已发布的官方插件。
 */

import * as wailsRuntime from '@wailsio/runtime'

/**
 * 把 Vite 的模块路径转成插件源码里书写的 `@/...` 路径（可能多个别名）。
 *
 * 脚本后缀一律去掉（TS 源码里通常不写后缀）；
 * **Vue 单文件必须保留 `.vue`** —— 插件源码里导入 SFC 一定要带后缀，
 * 去掉后两边就对不上了（曾因此导致插件加载时报
 * `Cannot read properties of undefined (reading 'default')`）。
 * 同时补一个去掉后缀的别名，两种写法都能命中。
 */
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

/**
 * 构建宿主模块表。
 *
 * 用 import.meta.glob 而不是手写几十行 import：
 * 手写清单会在新增模块时被遗忘，而插件报错往往表现为
 * 「运行时取到 undefined」，排查成本远高于这里多打一次包。
 */
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

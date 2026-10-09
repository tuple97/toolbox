import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 测试配置。
 *
 * 只覆盖纯逻辑（补全候选、模板上下文、SQL 作用域），不渲染组件，
 * 因此用 node 环境即可：CodeMirror 的 EditorState 不依赖 DOM。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@bindings': fileURLToPath(new URL('./bindings', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
})

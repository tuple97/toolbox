import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    /*
     * Tailwind v4：走 Vite 插件（不需要 postcss 配置与 tailwind.config.js，
     * 主题令牌写在 src/styles/tailwind.css 的 @theme 里）。
     */
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Wails v3 的绑定由 wails3 CLI 生成到 ./bindings 下
      '@bindings': fileURLToPath(new URL('./bindings', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    /*
     * 固定绑定 IPv4 地址。
     *
     * 原因：vite 默认 host 为 localhost，Windows 上 Node 可能只绑定
     * IPv6 的 ::1；而 Wails 的资产代理（ExternalAssetHandler）用
     * dial tcp4 127.0.0.1 连接 IPv4。两边栈不一致时会出现
     * "actively refused" 导致窗口显示 HTTP 502。
     * 双方都固定为 127.0.0.1 可彻底消除解析不确定性。
     */
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // CodeMirror 全家桶体积偏大，提高警告阈值避免噪音（已单独拆包，见下）
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
      output: {
        /*
         * 代码编辑器（CodeMirror / Lezer）体积最大且几乎不变动，单独拆包：
         * 首屏只加载业务包，编辑器包走浏览器缓存。
         */
        manualChunks: (id) => {
          return /node_modules[\\/](@codemirror|codemirror|@lezer)[\\/]/.test(id)
            ? 'codemirror'
            : undefined
        },
      },
    },
  },
  optimizeDeps: {
    // 拖拽库为预构建依赖，显式声明可加快冷启动。
    include: ['vue-draggable-plus'],
  },
})

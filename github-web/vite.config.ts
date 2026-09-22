import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * 用 alias 直连阅读器源码，而不是走 node_modules。
 * 原因：pnpm 的 hoisted linker 会把 workspace 包复制进 node_modules，
 * 那样改 packages/reader 的代码不会反映到 dev server，也不会有 HMR。
 */
export default defineConfig({
  // GitHub Pages 的项目页部署在 /<repo>/ 子路径下，Cloudflare Pages 在根路径。
  // 用哈希路由（#/v/...）因此不需要 SPA 回退配置，只需要 base 正确。
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@app/reader/styles.css', replacement: resolve(here('.'), '../packages/reader/src/styles.css') },
      { find: '@app/reader', replacement: resolve(here('.'), '../packages/reader/src/index.ts') },
    ],
  },
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: true,
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // SharedArrayBuffer (yaneuraou pthreads) に必要
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // esbuild に CJS(UMD)→ESM 変換させることで import() の mod.default が factory 関数になる。
    // exclude するとブラウザが ESM として処理し UMD の module.exports 分岐が通らず {} が返る。
    include: ['@mizarjp/yaneuraou.k-p'],
  },
})

// Renderer-only dev server used to verify UI in a normal browser.
// When `window.mouc` is absent the renderer falls back to the in-browser mock API
// (src/renderer/src/mock) so design/interaction work does not require a running main process.
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src/renderer',
  define: { __MOUCX_WEB__: 'true' },
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  server: { port: 5273, strictPort: true },
  build: { outDir: resolve(__dirname, 'dist-web'), emptyOutDir: true }
})

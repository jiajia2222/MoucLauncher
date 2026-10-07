import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'index.js' } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'index.js' } }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [vue()],
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve(__dirname, 'src/renderer/src') }
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})

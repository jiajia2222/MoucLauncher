/// <reference types="vite/client" />
/**
 * Renderer entry.
 *
 * Boot order matters: install the mock when there is no `window.mouc` (browser preview),
 * hydrate locale + theme from settings, then mount. Everything the UI can do goes through
 * the `MoucApi` contract in src/shared/ipc.ts.
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/tokens.css'
import './styles/base.css'
// Ported KAMUCL design system; loaded last so its rules win where they overlap.
import './kamu/styles/kamu.css'
import './kamu/styles/ui-system.css'
import { createMockApi } from './mock/api'
import { setLocale } from './i18n'
import { applyTheme, initTheme, themeMode } from './theme'

async function boot(): Promise<void> {
  if (!window.mouc) {
    // Browser preview (`npm run dev:web`). `?empty` swaps in the zero-state dataset.
    window.mouc = createMockApi({ empty: new URLSearchParams(location.search).has('empty') })
    window.__MOUC_WEB__ = true
  }

  applyTheme(themeMode.value)

  const settings = await window.mouc.settings.get()
  if (settings.ok) {
    setLocale(settings.data.language)
    themeMode.value = settings.data.theme
    applyTheme(settings.data.theme)
  }

  await initTheme()

  createApp(App).use(createPinia()).mount('#app')
}

void boot()

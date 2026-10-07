/**
 * Theme bridge.
 *
 * `data-theme` on <html> is the single switch the token file keys off. The source of
 * truth is `Settings.theme` in the main process; localStorage is only a preview/boot
 * cache so the very first paint is already correct (no light->dark flash).
 */
import { ref, watch, type Ref } from 'vue'
import { EVENTS } from '@shared/ipc'
import type { Settings, ThemeMode } from '@shared/types'

const STORAGE_KEY = 'mouc.theme'

function readCached(): ThemeMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'dark' || raw === 'light' ? raw : null
  } catch {
    return null
  }
}

export const themeMode: Ref<ThemeMode> = ref<ThemeMode>(readCached() ?? 'dark')

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  root.dataset.theme = mode
  root.dataset.themeReady = 'true'
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* storage may be blocked; the attribute above is what matters */
  }
}

export function setTheme(mode: ThemeMode): void {
  themeMode.value = mode
}

export function toggleTheme(): ThemeMode {
  themeMode.value = themeMode.value === 'dark' ? 'light' : 'dark'
  return themeMode.value
}

export function useTheme(): {
  mode: Ref<ThemeMode>
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => ThemeMode
  isDark: Ref<boolean>
} {
  return {
    mode: themeMode,
    setTheme,
    toggleTheme,
    isDark: ref(themeMode.value === 'dark') as Ref<boolean>
  }
}

/** Keeps `isDark` in sync for callers that only need a boolean. */
watch(themeMode, (mode) => {
  const shell = document.getElementById('app')
  if (shell) shell.dataset.dark = String(mode === 'dark')
})

/**
 * Boot order: cache -> settings.get -> subscribe to settings pushes.
 * Safe to call with the browser mock installed.
 */
export async function initTheme(): Promise<void> {
  applyTheme(themeMode.value)

  const api = window.mouc
  if (!api) return

  const res = await api.settings.get()
  if (res.ok) {
    themeMode.value = res.data.theme
    applyTheme(res.data.theme)
  }

  api.on(EVENTS.settings, (payload) => {
    const next = payload as Partial<Settings>
    if (next && (next.theme === 'dark' || next.theme === 'light')) {
      themeMode.value = next.theme
    }
  })

  watch(themeMode, (mode) => {
    applyTheme(mode)
  })
}

/** Called by the status-bar toggle: flips the theme and persists it to settings. */
export async function commitTheme(mode: ThemeMode): Promise<void> {
  setTheme(mode)
  const api = window.mouc
  if (api) await api.settings.set({ theme: mode })
}

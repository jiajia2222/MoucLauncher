/**
 * KAMUCL palette bridge.
 *
 * Upstream keeps its six palettes in `@shared/types.ts` (`THEME_PRESETS`) and paints them
 * as inline custom properties on `<html>` from `App.vue#applyTheme()` — `kamu.css` only
 * carries the no-script fallback for `black-orange`. That is ported here verbatim so the
 * shell renders exactly the upstream glass, and the switcher can offer all six.
 *
 * `Settings.theme` in MoucLauncher is only `'dark' | 'light'`, so the exact palette key
 * lives in localStorage and the tone is what gets persisted through
 * `mouc.settings.set({ theme })`, as the shell contract requires.
 */
import { ref, type Ref } from 'vue'
import type { Language, Settings, ThemeMode } from '@shared/types'
import { setLocale } from '../../i18n'
import { getSettings, saveSettings } from '../api/settings'
import { SHELL_EVENTS, onEvent } from './bridge'

export type PaletteName = 'transparent' | 'blue-white' | 'black-orange' | 'white-pink' | 'black-pink' | 'custom'

export interface PaletteColors {
  accent: string
  bg: string
  card: string
  text: string
  textDim: string
  border: string
  sidebarBg: string
  sidebarText: string
  bannerText: string
}

export interface CustomTheme {
  colors: PaletteColors
  layout: { sidebarWidth: number; bannerHeight: number; radius: number }
}

/** Ported from upstream `@shared/types.ts` THEME_PRESETS (colours copied as-is). */
export const THEME_PRESETS: Record<Exclude<PaletteName, 'custom'>, { colors: PaletteColors }> = {
  transparent: {
    colors: {
      accent: '#9475ed',
      bg: '#212121',
      card: '#292929',
      text: '#f5f5f5',
      textDim: '#b4b4b4',
      border: '#414141',
      sidebarBg: '#171717',
      sidebarText: '#c7c7c7',
      bannerText: '#ffffff'
    }
  },
  'blue-white': {
    colors: {
      accent: '#2563eb',
      bg: '#edf0f7',
      card: '#ffffff',
      text: '#1b2437',
      textDim: '#68718a',
      border: '#d8dfec',
      sidebarBg: '#f5f7fb',
      sidebarText: '#536078',
      bannerText: '#ffffff'
    }
  },
  'black-orange': {
    colors: {
      accent: '#f97316',
      bg: '#0b0b0e',
      card: '#18181f',
      text: '#f4f2ee',
      textDim: '#aaa69f',
      border: '#35353f',
      sidebarBg: '#111116',
      sidebarText: '#aaa69f',
      bannerText: '#ffffff'
    }
  },
  'white-pink': {
    colors: {
      accent: '#ec4899',
      bg: '#fdf2f8',
      card: '#ffffff',
      text: '#4a1d35',
      textDim: '#a06b8a',
      border: '#fbcfe8',
      sidebarBg: '#fce7f3',
      sidebarText: '#4a1d35',
      bannerText: '#ffffff'
    }
  },
  'black-pink': {
    colors: {
      accent: '#f472b6',
      bg: '#171019',
      card: '#211623',
      text: '#f5e8f2',
      textDim: '#a68ba3',
      border: '#3d2740',
      sidebarBg: '#1c1220',
      sidebarText: '#a68ba3',
      bannerText: '#ffffff'
    }
  }
}

/** Upstream DEFAULT_CUSTOM_THEME: the swatch the `custom` palette falls back to. */
export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  colors: {
    accent: '#2563eb',
    bg: '#edf0f7',
    card: '#ffffff',
    text: '#1b2437',
    textDim: '#68718a',
    border: '#e1e6f0',
    sidebarBg: '#f5f7fb',
    sidebarText: '#1b2437',
    bannerText: '#ffffff'
  },
  layout: { sidebarWidth: 208, bannerHeight: 430, radius: 14 }
}

/** Everything the switcher lists, in upstream order (`transparent` is upstream's default). */
export const PALETTES: { name: PaletteName; tone: ThemeMode }[] = [
  { name: 'transparent', tone: 'dark' },
  { name: 'blue-white', tone: 'light' },
  { name: 'black-orange', tone: 'dark' },
  { name: 'white-pink', tone: 'light' },
  { name: 'black-pink', tone: 'dark' },
  { name: 'custom', tone: 'light' }
]

const PALETTE_KEY = 'mouc.kamuPalette'
const CUSTOM_VARS = [
  '--accent',
  '--accent-2',
  '--accent-deep',
  '--accent-grad',
  '--accent-soft',
  '--on-accent',
  '--bg',
  '--bg-2',
  '--card',
  '--card-solid',
  '--card-2',
  '--text',
  '--text-dim',
  '--border',
  '--sidebar-text',
  '--bn-text',
  '--border-strong',
  '--scroll',
  '--hover',
  '--mask',
  '--danger',
  '--danger-soft',
  '--danger-border',
  '--ok',
  '--ok-soft',
  '--cyan',
  '--cyan-soft',
  '--shadow',
  '--shadow-lg',
  '--shell-surface',
  '--glass-blur',
  '--sidebar-w',
  '--banner-h',
  '--radius'
] as const

/** The palette the shell is showing; drives the switcher's tick. */
export const palette: Ref<PaletteName> = ref('transparent')

export function toneOf(name: PaletteName): ThemeMode {
  return PALETTES.find((entry) => entry.name === name)?.tone ?? 'dark'
}

export function isDarkPalette(name: PaletteName): boolean {
  return toneOf(name) === 'dark'
}

export function paletteColors(name: PaletteName): PaletteColors {
  if (name === 'custom') return DEFAULT_CUSTOM_THEME.colors
  return THEME_PRESETS[name]?.colors ?? THEME_PRESETS.transparent.colors
}

/** Ported from upstream `hexLuminance()`: illegal input is treated as dark. */
function hexLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return 0
  const value = parseInt(match[1], 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function clearPaletteVars(): void {
  const style = document.documentElement.style
  for (const name of CUSTOM_VARS) style.removeProperty(name)
}

/**
 * Ported from upstream `applyCustomVars()`. Every theme shares the same glass variables
 * and layout skeleton; only the user palette changes.
 */
function applyPaletteVars(colors: PaletteColors, dark: boolean): void {
  const style = document.documentElement.style
  const accent = colors.accent
  const cardOpacity = dark ? 88 : 94
  const raisedOpacity = dark ? 82 : 91
  const sideOpacity = dark ? 26 : 38
  const accent2 = `color-mix(in srgb, ${accent} ${dark ? 72 : 84}%, ${dark ? 'white' : 'black'})`
  const accentDeep = `color-mix(in srgb, ${accent} 78%, black)`
  style.setProperty('--accent', accent)
  style.setProperty('--accent-2', accent2)
  style.setProperty('--accent-deep', accentDeep)
  style.setProperty('--accent-grad', `linear-gradient(135deg, ${accent2} 0%, ${accent} 55%, ${accentDeep} 100%)`)
  style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 14%, transparent)`)
  style.setProperty('--on-accent', hexLuminance(accent) > 0.6 ? '#1a1208' : '#ffffff')
  style.setProperty('--bg', colors.bg)
  style.setProperty('--card', `color-mix(in srgb, ${colors.card} ${cardOpacity}%, transparent)`)
  style.setProperty('--card-solid', colors.card)
  style.setProperty('--card-2', `color-mix(in srgb, ${colors.card} ${raisedOpacity}%, transparent)`)
  style.setProperty('--text', colors.text)
  style.setProperty('--text-dim', colors.textDim)
  style.setProperty('--border', colors.border)
  style.setProperty('--bg-2', `color-mix(in srgb, ${colors.sidebarBg} ${sideOpacity}%, transparent)`)
  style.setProperty('--sidebar-text', colors.sidebarText)
  style.setProperty('--bn-text', colors.bannerText)
  style.setProperty('--border-strong', `color-mix(in srgb, ${colors.border} 65%, ${colors.text})`)
  style.setProperty('--scroll', `color-mix(in srgb, ${colors.textDim} 32%, transparent)`)
  style.setProperty('--hover', `color-mix(in srgb, ${colors.text} ${dark ? 7 : 5}%, transparent)`)
  style.setProperty('--mask', dark ? 'rgba(2, 5, 6, 0.72)' : 'rgba(27, 36, 55, 0.42)')
  style.setProperty('--danger', dark ? '#ff6b73' : '#dc2626')
  style.setProperty('--danger-soft', dark ? 'rgba(255, 107, 115, 0.13)' : 'rgba(220, 38, 38, 0.08)')
  style.setProperty('--danger-border', dark ? 'rgba(255, 107, 115, 0.34)' : 'rgba(220, 38, 38, 0.3)')
  style.setProperty('--ok', dark ? '#68dc88' : '#168a42')
  style.setProperty('--ok-soft', dark ? 'rgba(104, 220, 136, 0.13)' : 'rgba(22, 138, 66, 0.1)')
  style.setProperty('--cyan', dark ? '#9ed7e9' : '#0e7490')
  style.setProperty('--cyan-soft', dark ? 'rgba(158, 215, 233, 0.13)' : 'rgba(14, 116, 144, 0.1)')
  style.setProperty('--shadow', dark ? '0 2px 8px rgba(0, 0, 0, 0.16)' : '0 2px 8px rgba(31, 50, 85, 0.045)')
  style.setProperty('--shadow-lg', dark ? '0 20px 55px rgba(0, 0, 0, 0.42)' : '0 20px 55px rgba(31, 50, 85, 0.18)')
  style.setProperty('--shell-surface', `color-mix(in srgb, ${colors.bg} ${dark ? 30 : 42}%, transparent)`)
  style.setProperty('--glass-blur', '28px')
  // Upstream: the 图一 layout is the shared skeleton for all themes; the legacy
  // CustomTheme.layout fields no longer reshape it.
  style.setProperty('--sidebar-w', '208px')
  style.setProperty('--banner-h', '430px')
  style.setProperty('--radius', '14px')
}

/** Ported from upstream `applyTheme()`. */
export function applyPalette(name: PaletteName): void {
  const root = document.documentElement
  clearPaletteVars()
  root.dataset.theme = name
  const colors = paletteColors(name)
  // Dark-ness is decided by the background luminance, exactly like upstream.
  applyPaletteVars(colors, hexLuminance(colors.bg) < 0.46)
  root.dataset.tone = toneOf(name)
  palette.value = name
  try {
    localStorage.setItem(PALETTE_KEY, name)
  } catch {
    /* storage may be blocked; the inline variables above are what matters */
  }
}

/** Switcher entry point: paint now, persist tone + palette through the backend. */
export async function commitPalette(name: PaletteName): Promise<void> {
  applyPalette(name)
  try {
    await saveSettings({ theme: toneOf(name) })
  } catch {
    /* the next `settings:get` reconciles; the palette already looks right */
  }
}

/** `data-platform` is what kamu.css keys the traffic-light padding and shell radius off. */
export function applyPlatform(platform: string): void {
  document.documentElement.dataset.platform = platform
}

/** Motion + visibility hints consumed by `ui-system.css` (ported from upstream App.vue). */
function installMotionHints(): void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  const sync = (): void => {
    document.documentElement.dataset.motion = query.matches ? 'reduced' : 'full'
  }
  sync()
  query.addEventListener('change', sync)
  document.addEventListener('visibilitychange', () => {
    document.documentElement.dataset.visibility = document.hidden ? 'hidden' : 'visible'
  })
}

function cachedPalette(): PaletteName | null {
  try {
    const raw = localStorage.getItem(PALETTE_KEY)
    return raw && PALETTES.some((entry) => entry.name === raw) ? (raw as PaletteName) : null
  } catch {
    return null
  }
}

/**
 * Boot order (safe before mount, keeps the first paint in theme): cached palette ->
 * `settings.get()` -> subscribe to `mouc:settings-changed`.
 * The backend only stores the dark/light tone, so a stored tone without an explicit
 * palette choice maps onto that tone's default KAMUCL palette.
 */
export async function initShellTheme(): Promise<void> {
  installMotionHints()
  applyPalette(cachedPalette() ?? 'transparent')

  let settings: Settings
  try {
    settings = await getSettings()
  } catch {
    return
  }
  setLocale(settings.language)
  if (!cachedPalette()) applyPalette(settings.theme === 'light' ? 'blue-white' : 'transparent')

  onEvent(SHELL_EVENTS.settings, (payload) => {
    const next = payload as Partial<Settings>
    if (next?.language) setLocale(next.language as Language)
    if (next?.theme && !cachedPalette()) applyPalette(next.theme === 'light' ? 'blue-white' : 'transparent')
  })
}

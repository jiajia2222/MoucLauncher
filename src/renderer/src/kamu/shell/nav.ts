/**
 * Nav model for the ported shell.
 *
 * `composables/useNav.ts` owns the `ViewId` union, the persisted active id and the
 * `#view=<id>` hash override QA relies on, so this file only re-points the ids at the
 * KAMUCL view files and attaches the upstream inline icons / hotkeys the sidebar renders.
 * It deliberately does not edit `useNav.ts`: the rail is driven by the same `activeId`
 * ref, the same ids, the same hash contract.
 */
import { NAV_ITEMS, NAV_SECTIONS, type NavSection, type ViewId } from '../../composables/useNav'
import type { I18nKey } from '../../i18n'
import { NAV_ICONS } from './icons'

/** `ViewId` -> file under `src/renderer/src/kamu/views/`, resolved through the glob in App.vue. */
export const VIEW_FILES: Record<ViewId, string> = {
  home: 'Home.vue',
  instances: 'Instances.vue',
  versions: 'Versions.vue',
  mods: 'Mods.vue',
  accounts: 'Accounts.vue',
  java: 'Java.vue',
  online: 'Servers.vue',
  settings: 'Settings.vue'
}

export interface ShellNavItem {
  id: ViewId
  /** i18n key from the existing dictionary (`nav.*`). */
  labelKey: I18nKey
  icon: string
  hotkey: string
  /** Glob key handed to App.vue's `import.meta.glob('./kamu/views/*.vue')`. */
  globKey: string
}

export interface ShellNavSection {
  id: string
  labelKey: I18nKey
  items: ShellNavItem[]
}

function toShellItem(id: ViewId): ShellNavItem {
  const source = NAV_ITEMS.find((item) => item.id === id)
  return {
    id,
    labelKey: source?.labelKey ?? 'nav.home',
    icon: NAV_ICONS[id] ?? NAV_ICONS.home,
    hotkey: source?.hotkey ?? '',
    globKey: `./kamu/views/${VIEW_FILES[id]}`
  }
}

/** Grouped rail, same section ids and order as `NAV_SECTIONS`. */
export const SHELL_NAV: ShellNavSection[] = (NAV_SECTIONS as NavSection[]).map((section) => ({
  id: section.id,
  labelKey: section.labelKey,
  items: section.items.map((item) => toShellItem(item.id))
}))

export const SHELL_NAV_ITEMS: ShellNavItem[] = SHELL_NAV.flatMap((section) => section.items)

export function shellNavItem(id: ViewId): ShellNavItem {
  return SHELL_NAV_ITEMS.find((item) => item.id === id) ?? SHELL_NAV_ITEMS[0]!
}

/** Upstream keeps the resource submenu expanded state in localStorage; same idea here. */
const GROUP_OPEN_KEY = 'mouc.navGroups'

export function readOpenGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_OPEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

export function writeOpenGroups(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

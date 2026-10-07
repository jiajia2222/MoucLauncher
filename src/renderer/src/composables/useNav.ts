/**
 * Navigation state for the frameless shell.
 *
 * There is no router in this project: the rail is driven by a single persisted ref
 * holding a `ViewId`. Each id maps to exactly one file the views agent owns
 * (`src/renderer/src/views/<file>`); the shell resolves those files through a glob
 * so a missing view degrades to a placeholder instead of breaking the build.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import type { IconName } from '../components/icons/paths'
import type { I18nKey } from '../i18n'

export type ViewId = 'home' | 'instances' | 'versions' | 'mods' | 'accounts' | 'java' | 'online' | 'settings'

export interface NavItem {
  id: ViewId
  labelKey: I18nKey
  icon: IconName
  /** File name under src/renderer/src/views/. */
  file: string
  /** Alt+<digit> shortcut, shown as MKbd in the rail. */
  hotkey: string
}

export interface NavSection {
  id: string
  labelKey: I18nKey
  items: NavItem[]
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'game',
    labelKey: 'nav.groupGame',
    items: [
      { id: 'home', labelKey: 'nav.home', icon: 'home', file: 'HomeView.vue', hotkey: '1' },
      { id: 'instances', labelKey: 'nav.instances', icon: 'cube', file: 'InstancesView.vue', hotkey: '2' },
      { id: 'versions', labelKey: 'nav.versions', icon: 'layers', file: 'VersionsView.vue', hotkey: '3' }
    ]
  },
  {
    id: 'content',
    labelKey: 'nav.groupContent',
    items: [{ id: 'mods', labelKey: 'nav.mods', icon: 'mod', file: 'ModsView.vue', hotkey: '4' }]
  },
  {
    id: 'env',
    labelKey: 'nav.groupEnv',
    items: [
      { id: 'accounts', labelKey: 'nav.accounts', icon: 'user', file: 'AccountsView.vue', hotkey: '5' },
      { id: 'java', labelKey: 'nav.java', icon: 'beaker', file: 'JavaView.vue', hotkey: '6' }
    ]
  },
  {
    id: 'system',
    labelKey: 'nav.groupSystem',
    items: [
      { id: 'online', labelKey: 'nav.online', icon: 'radio', file: 'OnlineView.vue', hotkey: '7' },
      { id: 'settings', labelKey: 'nav.settings', icon: 'gear', file: 'SettingsView.vue', hotkey: '8' }
    ]
  }
]

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items)

export const DEFAULT_VIEW: ViewId = 'home'

const STORAGE_KEY = 'mouc.nav'

function isViewId(value: string | null): value is ViewId {
  return value !== null && NAV_ITEMS.some((item) => item.id === value)
}

function readStored(): ViewId {
  // `#view=settings` overrides the persisted choice: QA and screenshots need a way to
  // land on one view without clicking through the rail.
  const hash = /^#view=(\w[\w-]*)/i.exec(window.location.hash)
  const candidate = hash ? (hash[1] ?? null) : null
  if (isViewId(candidate)) return candidate
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isViewId(raw)) return raw
  } catch {
    /* ignore */
  }
  return DEFAULT_VIEW
}

const activeId = ref<ViewId>(readStored())

export function navigate(id: ViewId): void {
  activeId.value = id
}

export function activeFileOf(id: ViewId): string {
  return NAV_ITEMS.find((item) => item.id === id)?.file ?? ''
}

export interface UseNav {
  activeId: typeof activeId
  activeItem: ComputedRef<NavItem>
  sections: NavSection[]
  navigate: (id: ViewId) => void
  isGallery: ComputedRef<boolean>
}

export function useNav(): UseNav {
  const activeItem = computed(() => NAV_ITEMS.find((item) => item.id === activeId.value) ?? NAV_ITEMS[0]!)
  const isGallery = computed(() => window.location.hash.toLowerCase() === '#gallery')

  function onKeydown(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.metaKey) return
    const item = NAV_ITEMS.find((entry) => entry.hotkey === event.key)
    if (!item) return
    event.preventDefault()
    if (isGallery.value) window.location.hash = ''
    activeId.value = item.id
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  watch(activeId, (id) => {
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  })

  return { activeId, activeItem, sections: NAV_SECTIONS, navigate, isGallery }
}

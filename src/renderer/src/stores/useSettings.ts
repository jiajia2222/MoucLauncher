/**
 * Settings store.
 *
 * `settings.set()` returns the whole record after the write, and the main process is the
 * only place that validates it — so the stored ref is *replaced* by the returned record on
 * every success, never patched locally. A rejected write leaves the shown values at whatever
 * the process last confirmed.
 */
import { computed, ref, type ComputedRef } from 'vue'
import { EVENTS } from '@shared/ipc'
import type { GameDirStats, MirrorRule, PathInfo, Settings, ThemeMode } from '@shared/types'
import { defineDict, setLocale } from '../i18n'
import { useToast } from '../composables/useToast'

export const settingsText = defineDict({
  loadFailed: ['读取设置失败', 'Could not load settings'],
  saveFailed: ['保存设置失败', 'Could not save that setting'],
  resetFailed: ['恢复默认失败', 'Could not restore defaults'],
  pathsFailed: ['读取目录失败', 'Could not resolve the folders'],
  statsFailed: ['读取目录统计失败', 'Could not measure the game folder'],
  javaScanFailed: ['扫描 Java 失败', 'Could not scan for Java'],
  pickCancelled: ['没有选择目录', 'No folder was chosen'],
  saved: ['设置已保存', 'Settings saved'],
  mirrorsSaved: ['下载源已更新', 'Download sources updated'],
  ruleAdded: ['已添加下载源', 'Mirror added'],
  ruleRemoved: ['已移除下载源', 'Mirror removed'],
  newRule: ['自定义镜像', 'Custom mirror'],
  resetDone: ['已恢复默认设置', 'Defaults restored'],
  themeDark: ['深色', 'Dark'],
  themeLight: ['浅色', 'Light']
})

const record = ref<Settings | null>(null)
const paths = ref<PathInfo | null>(null)
const stats = ref<GameDirStats | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
let subscribed = false

/** Hosts the download engine actually rewrites, across every enabled rule. */
export function activeMirrorMap(rules: MirrorRule[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (!rule.enabled) continue
    for (const [host, mirror] of Object.entries(rule.hosts)) {
      if (mirror.trim().length > 0) merged[host] = mirror.trim()
    }
  }
  return merged
}

export interface SettingsStore {
  record: typeof record
  paths: typeof paths
  stats: typeof stats
  loading: typeof loading
  saving: typeof saving
  error: typeof error
  mirrors: ComputedRef<MirrorRule[]>
  theme: ComputedRef<ThemeMode>
  load: () => Promise<void>
  loadPaths: () => Promise<void>
  loadStats: () => Promise<void>
  /** Writes through the API and adopts the returned record. Returns success. */
  save: (patch: Partial<Settings>) => Promise<boolean>
  saveMirrors: (rules: MirrorRule[]) => Promise<boolean>
  reset: () => Promise<void>
}

export function useSettings(): SettingsStore {
  subscribe()

  const mirrors = computed<MirrorRule[]>(() => record.value?.mirrors ?? [])
  const theme = computed<ThemeMode>(() => record.value?.theme ?? 'dark')

  function subscribe(): void {
    if (subscribed) return
    const api = window.mouc
    if (!api) return
    api.on(EVENTS.settings, (payload) => {
      const next = payload as Settings
      // The process broadcasts the whole record; ignore partial pushes from other senders.
      if (next && typeof next.settingsVersion === 'number') record.value = next
    })
    subscribed = true
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    const res = await window.mouc.settings.get()
    loading.value = false
    if (!res.ok) {
      error.value = res.error.message
      useToast().push({ kind: 'danger', title: settingsText.text('loadFailed'), message: res.error.message })
      return
    }
    record.value = res.data
    setLocale(res.data.language)
  }

  async function loadPaths(): Promise<void> {
    const res = await window.mouc.app.paths()
    if (!res.ok) {
      error.value = res.error.message
      useToast().push({ kind: 'danger', title: settingsText.text('pathsFailed'), message: res.error.message })
      return
    }
    paths.value = res.data
  }

  async function loadStats(): Promise<void> {
    const res = await window.mouc.app.stats()
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: settingsText.text('statsFailed'), message: res.error.message })
      return
    }
    stats.value = res.data
  }

  async function save(patch: Partial<Settings>): Promise<boolean> {
    saving.value = true
    const res = await window.mouc.settings.set(patch)
    saving.value = false
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: settingsText.text('saveFailed'), message: res.error.message })
      // Re-read so the UI snaps back to the record the process actually holds.
      await load()
      return false
    }
    record.value = res.data
    if (patch.language) setLocale(patch.language)
    useToast().push({ kind: 'success', title: settingsText.text('saved') })
    return true
  }

  async function saveMirrors(rules: MirrorRule[]): Promise<boolean> {
    saving.value = true
    const res = await window.mouc.settings.set({ mirrors: rules })
    saving.value = false
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: settingsText.text('saveFailed'), message: res.error.message })
      await load()
      return false
    }
    record.value = res.data
    useToast().push({ kind: 'success', title: settingsText.text('mirrorsSaved') })
    return true
  }

  async function reset(): Promise<void> {
    const res = await window.mouc.settings.reset()
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: settingsText.text('resetFailed'), message: res.error.message })
      return
    }
    record.value = res.data
    setLocale(res.data.language)
    useToast().push({ kind: 'info', title: settingsText.text('resetDone') })
  }

  return {
    record,
    paths,
    stats,
    loading,
    saving,
    error,
    mirrors,
    theme,
    load,
    loadPaths,
    loadStats,
    save,
    saveMirrors,
    reset
  }
}

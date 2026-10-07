/**
 * Version manifest store for VersionsView.
 *
 * The manifest is big (hundreds of entries) and changes rarely, so it is fetched once and
 * kept in a module-level ref; `installed()` is re-read after every install/repair/uninstall
 * because that is the only way the renderer learns the truth.
 */
import { computed, ref, type ComputedRef } from 'vue'
import type { VersionInstallRequest } from '@shared/ipc'
import type { DownloadJob, VersionRef, VersionType } from '@shared/types'
import { defineDict, t, type I18nKey } from '../i18n'
import { useToast } from '../composables/useToast'

export const versionsText = defineDict({
  loadFailed: ['读取版本清单失败', 'Could not load the version manifest'],
  refreshFailed: ['刷新版本清单失败', 'Could not refresh the manifest'],
  refreshDone: ['清单已更新，共 {n} 个版本', 'Manifest updated — {n} versions'],
  installedLoadFailed: ['读取已安装版本失败', 'Could not read installed versions'],
  installStarted: ['开始下载 {id}', 'Downloading {id}'],
  installFailed: ['安装版本失败', 'Could not install the version'],
  repairStarted: ['开始校验修复 {id}', 'Verifying {id}'],
  repairFailed: ['校验修复失败', 'Could not verify that version'],
  uninstalled: ['已卸载 {id}', 'Uninstalled {id}'],
  uninstallFailed: ['卸载失败', 'Could not uninstall'],
  uninstallHint: ['只删除 versions 目录下的 json 与 jar，库文件保留。', 'Removes the json and jar under versions/; libraries stay.'],
  all: ['全部', 'All'],
  emptyTitle: ['清单是空的', 'The manifest is empty'],
  emptyDesc: ['点击刷新，从 Mojang 拉取 version_manifest_v2。', 'Hit refresh to fetch version_manifest_v2 from Mojang.'],
  noMatch: ['没有符合筛选的版本', 'No version matches the filters'],
  mirrorNote: ['当前下载源', 'Active download source'],
  mirrorOfficial: ['官方源（未启用镜像）', 'Official endpoints (no mirror enabled)']
})

const manifest = ref<VersionRef[]>([])
const installedIds = ref<string[]>([])
const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
const loadedOnce = ref(false)

export interface VersionsStore {
  manifest: typeof manifest
  installedIds: typeof installedIds
  loading: typeof loading
  refreshing: typeof refreshing
  error: typeof error
  isInstalled: (id: string) => boolean
  latestRelease: ComputedRef<VersionRef | null>
  latestSnapshot: ComputedRef<VersionRef | null>
  counts: ComputedRef<Record<VersionType, number>>
  load: (force?: boolean) => Promise<void>
  refresh: () => Promise<void>
  install: (req: VersionInstallRequest) => Promise<DownloadJob | null>
  repair: (id: string) => Promise<DownloadJob | null>
  uninstall: (id: string) => Promise<boolean>
}

const TYPE_KEYS: Record<VersionType, I18nKey> = {
  release: 'version.type.release',
  snapshot: 'version.type.snapshot',
  old_beta: 'version.type.old_beta',
  old_alpha: 'version.type.old_alpha'
}

export function typeLabel(type: VersionType): string {
  return t(TYPE_KEYS[type])
}

export function useVersions(): VersionsStore {
  const installedSet = computed<Set<string>>(() => new Set(installedIds.value))

  function isInstalled(id: string): boolean {
    return installedSet.value.has(id)
  }

  const latestRelease = computed<VersionRef | null>(
    () => manifest.value.find((entry) => entry.type === 'release') ?? null
  )
  const latestSnapshot = computed<VersionRef | null>(
    () => manifest.value.find((entry) => entry.type === 'snapshot') ?? null
  )

  const counts = computed<Record<VersionType, number>>(() => {
    const base: Record<VersionType, number> = { release: 0, snapshot: 0, old_beta: 0, old_alpha: 0 }
    for (const entry of manifest.value) base[entry.type] += 1
    return base
  })

  async function loadInstalled(): Promise<void> {
    const res = await window.mouc.version.installed()
    if (res.ok) installedIds.value = res.data
    else useToast().push({ kind: 'danger', title: versionsText.text('installedLoadFailed'), message: res.error.message })
  }

  async function load(force = false): Promise<void> {
    if (loadedOnce.value && !force) return
    loading.value = true
    error.value = ''
    const [list, installed] = await Promise.all([window.mouc.version.list(), window.mouc.version.installed()])
    loading.value = false
    loadedOnce.value = true
    if (!list.ok) {
      error.value = list.error.message
      useToast().push({ kind: 'danger', title: versionsText.text('loadFailed'), message: list.error.message })
      return
    }
    manifest.value = list.data
    if (installed.ok) installedIds.value = installed.data
    else useToast().push({ kind: 'danger', title: versionsText.text('installedLoadFailed'), message: installed.error.message })
  }

  async function refresh(): Promise<void> {
    refreshing.value = true
    // `version.refresh()` takes no arguments in `MoucApi`; it always re-reads the manifest.
    const res = await window.mouc.version.refresh()
    refreshing.value = false
    if (!res.ok) {
      error.value = res.error.message
      useToast().push({ kind: 'danger', title: versionsText.text('refreshFailed'), message: res.error.message })
      return
    }
    manifest.value = res.data
    error.value = ''
    loadedOnce.value = true
    await loadInstalled()
    useToast().push({ kind: 'success', title: versionsText.text('refreshDone', { n: res.data.length }) })
  }

  async function install(req: VersionInstallRequest): Promise<DownloadJob | null> {
    const res = await window.mouc.version.install(req)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: versionsText.text('installFailed'), message: res.error.message })
      return null
    }
    installedIds.value = [...installedIds.value, req.id]
    useToast().push({ kind: 'info', title: versionsText.text('installStarted', { id: req.id }) })
    return res.data
  }

  async function repair(id: string): Promise<DownloadJob | null> {
    const res = await window.mouc.version.repair(id)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: versionsText.text('repairFailed'), message: res.error.message })
      return null
    }
    useToast().push({ kind: 'info', title: versionsText.text('repairStarted', { id }) })
    return res.data
  }

  async function uninstall(id: string): Promise<boolean> {
    const res = await window.mouc.version.uninstall(id)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: versionsText.text('uninstallFailed'), message: res.error.message })
      return false
    }
    installedIds.value = installedIds.value.filter((entry) => entry !== id)
    useToast().push({ kind: 'info', title: versionsText.text('uninstalled', { id }) })
    return true
  }

  return {
    manifest,
    installedIds,
    loading,
    refreshing,
    error,
    isInstalled,
    latestRelease,
    latestSnapshot,
    counts,
    load,
    refresh,
    install,
    repair,
    uninstall
  }
}

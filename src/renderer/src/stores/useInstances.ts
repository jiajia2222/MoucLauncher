/**
 * Instance store for the launch screen and the instance grid.
 *
 * Module-level refs shared by both views, so a create/rename/delete in InstancesView is
 * immediately visible in HomeView's picker without re-fetching. The "current instance"
 * choice is only a renderer concept, so it is persisted to localStorage.
 */
import { computed, ref, type ComputedRef } from 'vue'
import type { InstanceCreateRequest } from '@shared/ipc'
import type { Instance, InstanceSummary, InstanceState, LoaderId } from '@shared/types'
import type { IconName } from '../components/icons/paths'
import { defineDict, t } from '../i18n'
import { useToast } from '../composables/useToast'
import type { SelectOption } from '../components/ui/types'

export const instancesText = defineDict({
  stateNotInstalled: ['尚未安装', 'Not installed'],
  loaded: ['实例列表已更新', 'Instance list refreshed'],
  loadFailed: ['读取实例失败', 'Could not load instances'],
  created: ['已创建 {name}', 'Created {name}'],
  createFailed: ['创建实例失败', 'Could not create the instance'],
  saved: ['已保存 {name}', 'Saved {name}'],
  saveFailed: ['保存实例失败', 'Could not save the instance'],
  renamed: ['已重命名', 'Renamed'],
  duplicated: ['已复制为 {name}', 'Duplicated as {name}'],
  duplicateFailed: ['复制实例失败', 'Could not duplicate the instance'],
  removed: ['已删除 {name}', 'Deleted {name}'],
  removeFailed: ['删除实例失败', 'Could not delete the instance'],
  openFailed: ['打开目录失败', 'Could not open the folder'],
  imported: ['正在导入 {name}', 'Importing {name}'],
  importFailed: ['导入整合包失败', 'Could not import the modpack'],
  importNeedFile: ['没有选择整合包文件', 'No modpack file was chosen'],
  exportStarted: ['开始导出 {name}', 'Exporting {name}'],
  exportFailed: ['导出整合包失败', 'Could not export the modpack'],
  exportNeedFile: ['没有选择导出位置', 'No export location was chosen'],
  'loader.vanilla': ['原版', 'Vanilla'],
  'loader.fabric': ['Fabric', 'Fabric'],
  'loader.legacy-fabric': ['Legacy Fabric', 'Legacy Fabric'],
  'loader.quilt': ['Quilt', 'Quilt'],
  'loader.forge': ['Forge', 'Forge'],
  'loader.neoforge': ['NeoForge', 'NeoForge'],
  'loader.optifine': ['OptiFine', 'OptiFine'],
  'loader.liteloader': ['LiteLoader', 'LiteLoader'],
  'loader.cleanroom': ['Cleanroom', 'Cleanroom'],
  sizeLabel: ['{size} · {checked} 检查', '{size} · checked {checked}']
})

/** Instance ids are minted by the main process; the icon field is a free-form key. */
const LOADER_ICONS: Record<string, IconName> = {
  vanilla: 'cube',
  fabric: 'mod',
  'legacy-fabric': 'mod',
  quilt: 'layers',
  forge: 'beaker',
  neoforge: 'beaker',
  optifine: 'shader',
  liteloader: 'image',
  cleanroom: 'shield'
}

export function iconFor(source: string | undefined): IconName {
  if (!source) return 'cube'
  return LOADER_ICONS[source] ?? 'cube'
}

/** Loader ids are also display names for the well-known ones (`loader.<id>` dict keys). */
export function loaderLabel(loader: LoaderId | string): string {
  const key = `loader.${loader}`
  const known = (instancesText.keys as readonly string[]).includes(key)
  return known ? instancesText.text(key as LoaderDictKey) : String(loader)
}

type LoaderDictKey = Extract<(typeof instancesText.keys)[number], `loader.${string}`>

export type StateTone = 'success' | 'warning' | 'danger' | 'neutral'
export interface StateBadge {
  tone: StateTone
  icon: IconName
  label: string
}

export function badgeFor(state: InstanceState): StateBadge {
  if (!state.installed) return { tone: 'neutral', icon: 'download', label: instancesText.text('stateNotInstalled') }
  if (!state.versionResolved || !state.clientJarOk) {
    return { tone: 'danger', icon: 'warning', label: t('instance.stateBroken') }
  }
  if (state.missingCount > 0) {
    return { tone: 'warning', icon: 'warning', label: t('instance.stateMissing', { n: state.missingCount }) }
  }
  return { tone: 'success', icon: 'check', label: t('instance.stateOk') }
}

const EMPTY_STATE: InstanceState = {
  installed: false,
  versionResolved: false,
  clientJarOk: false,
  assetsOk: false,
  librariesOk: false,
  loaderOk: false,
  missingCount: 0,
  sizeBytes: 0,
  lastCheckedAt: 0
}

const ACTIVE_KEY = 'mouc.instance.active'

function readStoredActive(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? ''
  } catch {
    return ''
  }
}

const summaries = ref<InstanceSummary[]>([])
const loading = ref(false)
const error = ref('')
const activeId = ref<string>(readStoredActive())

export interface InstancesStore {
  summaries: typeof summaries
  loading: typeof loading
  error: typeof error
  activeId: typeof activeId
  current: ComputedRef<InstanceSummary | null>
  ordered: ComputedRef<InstanceSummary[]>
  pickerOptions: ComputedRef<SelectOption[]>
  load: () => Promise<void>
  /** Re-reads one instance's on-disk state (after a repair/import job lands). */
  refreshState: (id: string) => Promise<void>
  setActive: (id: string) => void
  create: (req: InstanceCreateRequest) => Promise<Instance | null>
  patch: (patch: Partial<Instance> & { id: string }) => Promise<Instance | null>
  duplicate: (id: string, name: string) => Promise<Instance | null>
  remove: (id: string, deleteFiles: boolean) => Promise<boolean>
  openDir: (id: string) => Promise<void>
  importModpack: (file: string, format: 'mrpack' | 'zip-multimc' | 'curse-zip', name: string) => Promise<boolean>
  exportModpack: (id: string, target: string, format: 'mrpack' | 'zip') => Promise<boolean>
}

export function useInstances(): InstancesStore {
  const ordered = computed<InstanceSummary[]>(() =>
    [...summaries.value].sort((a, b) => (b.instance.lastPlayedAt ?? 0) - (a.instance.lastPlayedAt ?? 0))
  )

  const current = computed<InstanceSummary | null>(() => {
    const byId = summaries.value.find((entry) => entry.instance.id === activeId.value)
    if (byId) return byId
    return ordered.value[0] ?? null
  })

  const pickerOptions = computed<SelectOption[]>(() =>
    ordered.value.map((entry) => ({
      value: entry.instance.id,
      label: entry.instance.name,
      hint: `${entry.instance.gameVersion} · ${loaderLabel(entry.instance.loader)}`
    }))
  )

  function setActive(id: string): void {
    activeId.value = id
    try {
      localStorage.setItem(ACTIVE_KEY, id)
    } catch {
      /* storage may be blocked; the in-memory choice still works */
    }
  }

  function upsert(instance: Instance): void {
    const index = summaries.value.findIndex((entry) => entry.instance.id === instance.id)
    if (index === -1) {
      summaries.value = [
        ...summaries.value,
        { instance, state: { ...EMPTY_STATE, lastCheckedAt: Date.now() }, modCount: 0 }
      ]
      return
    }
    summaries.value[index] = { ...summaries.value[index], instance }
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    const res = await window.mouc.instance.list()
    loading.value = false
    if (!res.ok) {
      error.value = res.error.message
      useToast().push({ kind: 'danger', title: instancesText.text('loadFailed'), message: res.error.message })
      return
    }
    summaries.value = res.data
    if (!summaries.value.some((entry) => entry.instance.id === activeId.value)) {
      const newest = [...res.data].sort((a, b) => (b.instance.lastPlayedAt ?? 0) - (a.instance.lastPlayedAt ?? 0))[0]
      if (newest) setActive(newest.instance.id)
    }
  }

  async function refreshState(id: string): Promise<void> {
    const res = await window.mouc.instance.state(id)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('loadFailed'), message: res.error.message })
      return
    }
    const index = summaries.value.findIndex((entry) => entry.instance.id === id)
    if (index === -1) {
      summaries.value = [...summaries.value, res.data]
      return
    }
    summaries.value[index] = res.data
  }

  async function create(req: InstanceCreateRequest): Promise<Instance | null> {
    const res = await window.mouc.instance.create(req)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('createFailed'), message: res.error.message })
      return null
    }
    await load()
    setActive(res.data.id)
    useToast().push({ kind: 'success', title: instancesText.text('created', { name: res.data.name }) })
    return res.data
  }

  async function patch(next: Partial<Instance> & { id: string }): Promise<Instance | null> {
    const res = await window.mouc.instance.update(next)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('saveFailed'), message: res.error.message })
      return null
    }
    upsert(res.data)
    useToast().push({ kind: 'success', title: instancesText.text('saved', { name: res.data.name }) })
    return res.data
  }

  async function duplicate(id: string, name: string): Promise<Instance | null> {
    const res = await window.mouc.instance.duplicate(id, name)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('duplicateFailed'), message: res.error.message })
      return null
    }
    await load()
    setActive(res.data.id)
    useToast().push({ kind: 'success', title: instancesText.text('duplicated', { name: res.data.name }) })
    return res.data
  }

  async function remove(id: string, deleteFiles: boolean): Promise<boolean> {
    const name = summaries.value.find((entry) => entry.instance.id === id)?.instance.name ?? id
    const res = await window.mouc.instance.remove(id, deleteFiles)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('removeFailed'), message: res.error.message })
      return false
    }
    summaries.value = summaries.value.filter((entry) => entry.instance.id !== id)
    if (activeId.value === id) {
      const next = ordered.value[0]
      setActive(next ? next.instance.id : '')
    }
    useToast().push({ kind: 'info', title: instancesText.text('removed', { name }) })
    return true
  }

  async function openDir(id: string): Promise<void> {
    const res = await window.mouc.instance.openDir(id)
    if (!res.ok) useToast().push({ kind: 'danger', title: instancesText.text('openFailed'), message: res.error.message })
  }

  async function importModpack(
    file: string,
    format: 'mrpack' | 'zip-multimc' | 'curse-zip',
    name: string
  ): Promise<boolean> {
    const res = await window.mouc.instance.importModpack({ file, format, name })
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('importFailed'), message: res.error.message })
      return false
    }
    await load()
    useToast().push({ kind: 'success', title: instancesText.text('imported', { name: res.data.manifest.name }) })
    return true
  }

  async function exportModpack(id: string, target: string, format: 'mrpack' | 'zip'): Promise<boolean> {
    const name = summaries.value.find((entry) => entry.instance.id === id)?.instance.name ?? id
    const res = await window.mouc.instance.exportModpack(id, target, format)
    if (!res.ok) {
      useToast().push({ kind: 'danger', title: instancesText.text('exportFailed'), message: res.error.message })
      return false
    }
    useToast().push({ kind: 'info', title: instancesText.text('exportStarted', { name }) })
    return true
  }

  return {
    summaries,
    loading,
    error,
    activeId,
    current,
    ordered,
    pickerOptions,
    load,
    refreshState,
    setActive,
    create,
    patch,
    duplicate,
    remove,
    openDir,
    importModpack,
    exportModpack
  }
}

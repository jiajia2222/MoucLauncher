/**
 * useMods — shared state for ModsView (`已安装` + `浏览`).
 *
 * Module-level refs, not pinia: the shell re-creates a view on every nav change, so the
 * instance selection, the installed list and the browse results have to live outside the
 * component. One subscription per push event is installed lazily and kept for the life of
 * the renderer (same lifetime semantics as `useToast`).
 */
import { computed, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import { EVENTS, type ModInstallRequest } from '@shared/ipc'
import type {
  AppErrorPayload,
  DownloadJob,
  DownloadProgress,
  InstanceSummary,
  InstalledMod,
  JobStatus,
  LoaderId,
  ModFile,
  ModProject,
  ProjectKind,
  ProjectProvider,
  ProjectVersion,
  SearchQuery,
  Settings
} from '@shared/types'
import { defineDict, t } from '../i18n'
import { useToast } from '../composables/useToast'

/** A download job reduced to what a view prints next to the action that started it. */
export interface JobState {
  id: string
  title: string
  status: JobStatus
  percent: number
  bytesDone: number
  bytesTotal: number
  speedBps: number
  etaSeconds: number
  done: number
  total: number
  error?: AppErrorPayload
}

const PAGE_SIZE = 12
const MODABLE_KINDS: ProjectKind[] = ['mod', 'resourcepack', 'shader', 'modpack']

const copy = defineDict({
  removed: ['已删除模组', 'Mod removed'],
  installedFromDisk: ['已从本地文件安装', 'Installed from local file'],
  installQueued: ['安装任务已开始', 'Install queued'],
  updatesStarted: ['开始更新 {n} 个模组', 'Updating {n} mods'],
  noUpdateFile: ['该项目没有可安装的文件', 'No installable file for this project']
})

/* ---------------------------------------------------------------- module state */
const instances: Ref<InstanceSummary[]> = ref([])
const instancesLoading: Ref<boolean> = ref(false)
const instancesError: Ref<AppErrorPayload | null> = ref(null)
const instanceId: Ref<string> = ref('')

const mods: Ref<InstalledMod[]> = ref([])
const modsLoading: Ref<boolean> = ref(false)
const modsError: Ref<AppErrorPayload | null> = ref(null)
const checkingUpdates: Ref<boolean> = ref(false)
const updating: Ref<boolean> = ref(false)
const diskKind: Ref<ProjectKind> = ref('mod')

const provider: Ref<ProjectProvider> = ref('modrinth')
const kind: Ref<ProjectKind> = ref('mod')
const keyword: Ref<string> = ref('')
const versionFilter: Ref<string> = ref('')
const loaderFilter: Ref<string> = ref('')
const sort: Ref<NonNullable<SearchQuery['sort']>> = ref('relevance')
const results: Ref<ModProject[]> = ref([])
const total: Ref<number> = ref(0)
const offset: Ref<number> = ref(0)
const searching: Ref<boolean> = ref(false)
const searchError: Ref<AppErrorPayload | null> = ref(null)
const hasSearched: Ref<boolean> = ref(false)

const versionProject: Ref<ModProject | null> = ref(null)
const versions: Ref<ProjectVersion[]> = ref([])
const versionsLoading: Ref<boolean> = ref(false)
const versionsError: Ref<AppErrorPayload | null> = ref(null)

const settings: Ref<Settings | null> = ref(null)
const jobs: Ref<JobState[]> = ref([])

let attached = false
/** Only jobs this view started belong in its progress card; the shell owns the rest. */
const ownJobs = new Set<string>()

/* ------------------------------------------------------------------- plumbing */
function reportError(payload: AppErrorPayload): void {
  useToast().push({ kind: 'danger', title: payload.message, message: payload.detail, duration: 6000 })
}

function describeError(error: AppErrorPayload): string {
  return error.detail ? `${error.message} — ${error.detail}` : error.message
}

/** Progress is global; every job id a view started is folded into `jobs`. */
function upsertProgress(payload: DownloadProgress): void {
  if (!ownJobs.has(payload.jobId)) return
  const at = jobs.value.findIndex((entry) => entry.id === payload.jobId)
  const next: JobState = {
    id: payload.jobId,
    title: jobs.value[at]?.title ?? (payload.currentLabel.split(' · ')[0] ?? payload.currentLabel),
    status: payload.status,
    percent: payload.percent,
    bytesDone: payload.bytesDone,
    bytesTotal: payload.bytesTotal,
    speedBps: payload.speedBps,
    etaSeconds: payload.etaSeconds,
    done: payload.done,
    total: payload.total,
    error: jobs.value[at]?.error
  }
  if (at === -1) jobs.value = [next, ...jobs.value]
  else jobs.value.splice(at, 1, next)
  if (jobs.value.length > 8) jobs.value = jobs.value.slice(0, 8)
}

function attach(): void {
  if (attached) return
  attached = true
  const api = window.mouc
  api.on(EVENTS.progress, (payload) => upsertProgress(payload as DownloadProgress))
  api.on(EVENTS.jobFinished, (payload) => {
    const job = payload as DownloadJob
    if (!ownJobs.has(job.id)) return
    const at = jobs.value.findIndex((entry) => entry.id === job.id)
    if (at === -1) return
    const previous = jobs.value[at]!
    jobs.value.splice(at, 1, {
      ...previous,
      status: job.status,
      title: job.title,
      percent: job.bytesTotal > 0 ? Math.round((job.bytesDone / job.bytesTotal) * 1000) / 10 : 100,
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      speedBps: 0,
      etaSeconds: 0,
      done: job.done,
      total: job.total,
      error: job.error
    })
    if (job.status === 'error') reportError(job.error ?? { code: 'internal', message: t('status.jobFailed') })
    if (job.status === 'done') void loadMods()
  })
  api.on(EVENTS.settings, (payload) => {
    settings.value = payload as Settings
  })
}

/* ------------------------------------------------------------------ selectors */
const currentInstance: ComputedRef<InstanceSummary | null> = computed(
  () => instances.value.find((entry) => entry.instance.id === instanceId.value) ?? null
)

const instanceOptions: ComputedRef<{ value: string; label: string; hint?: string }[]> = computed(() =>
  instances.value.map((entry) => ({
    value: entry.instance.id,
    label: entry.instance.name,
    hint: `${entry.instance.gameVersion} · ${entry.instance.loader}`
  }))
)

/** Game versions worth filtering by: the ones the user actually owns. */
const gameVersionOptions: ComputedRef<string[]> = computed(() => {
  const set = new Set<string>()
  for (const entry of instances.value) set.add(entry.instance.gameVersion)
  return [...set].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
})

const loaderOptions: ComputedRef<LoaderId[]> = computed(() => {
  const set = new Set<LoaderId>()
  for (const entry of instances.value) if (entry.instance.loader !== 'vanilla') set.add(entry.instance.loader)
  for (const project of results.value) for (const entry of project.loaders) set.add(entry)
  return [...set]
})

const updatable: ComputedRef<InstalledMod[]> = computed(() => mods.value.filter((entry) => entry.updateAvailable !== undefined))
const activeJobs: ComputedRef<JobState[]> = computed(() => jobs.value.filter((entry) => entry.status === 'running' || entry.status === 'queued'))
const curseForgeReady: ComputedRef<boolean> = computed(() => (settings.value?.curseForgeApiKey ?? '').trim().length > 0)
const modTotalBytes: ComputedRef<number> = computed(() => mods.value.reduce((acc, entry) => acc + entry.size, 0))

/* -------------------------------------------------------------------- actions */
async function loadSettings(): Promise<void> {
  const res = await window.mouc.settings.get()
  if (res.ok) settings.value = res.data
  else reportError(res.error)
}

async function loadInstances(preferredId?: string): Promise<void> {
  attach()
  instancesLoading.value = true
  instancesError.value = null
  const res = await window.mouc.instance.list()
  if (res.ok) {
    instances.value = res.data
    const wanted = preferredId ?? instanceId.value
    if (!res.data.some((entry) => entry.instance.id === wanted)) {
      instanceId.value = res.data[0]?.instance.id ?? ''
    } else {
      instanceId.value = wanted
    }
  } else {
    instancesError.value = res.error
    reportError(res.error)
  }
  instancesLoading.value = false
}

async function loadMods(): Promise<void> {
  if (!instanceId.value) {
    mods.value = []
    return
  }
  modsLoading.value = true
  modsError.value = null
  const res = await window.mouc.mod.installed(instanceId.value)
  if (res.ok) mods.value = res.data
  else modsError.value = res.error
  modsLoading.value = false
}

/** `checkUpdates` re-answers the whole list; only the update badge is merged in. */
async function checkUpdates(): Promise<boolean> {
  if (!instanceId.value) return false
  checkingUpdates.value = true
  const res = await window.mouc.mod.checkUpdates(instanceId.value)
  checkingUpdates.value = false
  if (!res.ok) {
    modsError.value = res.error
    reportError(res.error)
    return false
  }
  const byFile = new Map(res.data.map((entry) => [entry.fileName, entry]))
  mods.value = mods.value.map((entry) => {
    const fresh = byFile.get(entry.fileName)
    return fresh && fresh.updateAvailable ? { ...entry, updateAvailable: fresh.updateAvailable } : entry
  })
  return true
}

async function toggleMod(mod: InstalledMod, disabled: boolean): Promise<boolean> {
  const res = await window.mouc.mod.toggle(instanceId.value, mod.fileName, disabled)
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  const at = mods.value.findIndex((entry) => entry.fileName === mod.fileName)
  if (at !== -1) mods.value.splice(at, 1, res.data)
  return true
}

async function removeMod(mod: InstalledMod): Promise<boolean> {
  const res = await window.mouc.mod.remove(instanceId.value, mod.fileName)
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  mods.value = mods.value.filter((entry) => entry.fileName !== mod.fileName)
  useToast().push({ kind: 'success', title: copy.text('removed'), message: mod.name ?? mod.fileName })
  return true
}

/** `pickFile` resolving to undefined means the user cancelled: not an error. */
async function installFromDisk(): Promise<boolean> {
  if (!instanceId.value) {
    useToast().push({ kind: 'warning', titleKey: 'launch.noInstance' })
    return false
  }
  const picked = await window.mouc.app.pickFile(t('mod.localFile'), [
    { name: 'Minecraft', extensions: ['jar', 'zip'] }
  ])
  if (!picked.ok) {
    reportError(picked.error)
    return false
  }
  const source = picked.data
  if (!source) return false
  const res = await window.mouc.mod.localFile(instanceId.value, diskKind.value, source)
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  mods.value = [res.data, ...mods.value]
  useToast().push({ kind: 'success', title: copy.text('installedFromDisk'), message: res.data.fileName })
  return true
}

async function installRequest(request: ModInstallRequest): Promise<DownloadJob | null> {
  // `file` usually comes out of reactive state; the main process serialises the request,
  // so a Proxy would be structured-clone failure. toRaw() hands over the plain object.
  const res = await window.mouc.mod.install({ ...request, file: toRaw(request.file) })
  if (!res.ok) {
    reportError(res.error)
    return null
  }
  ownJobs.add(res.data.id)
  upsertProgress({
    jobId: res.data.id,    status: res.data.status,
    total: res.data.total,
    done: res.data.done,
    failed: res.data.failed,
    bytesTotal: res.data.bytesTotal,
    bytesDone: res.data.bytesDone,
    speedBps: 0,
    etaSeconds: 0,
    currentLabel: res.data.title,
    percent: 0
  })
  return res.data
}

function primaryFileOf(version: ProjectVersion | undefined, fallbackName: string): ModFile | null {
  const file = version ? (version.files.find((entry) => entry.primary) ?? version.files[0]) : undefined
  if (file) return file
  useToast().push({ kind: 'warning', title: copy.text('noUpdateFile'), message: fallbackName })
  return null
}

/** Bulk update: one install job per mod that has a newer published version. */
async function updateAll(withDependencies: boolean): Promise<number> {
  if (!instanceId.value || updatable.value.length === 0) return 0
  updating.value = true
  let started = 0
  for (const mod of updatable.value) {
    const file = primaryFileOf(mod.updateAvailable, mod.name ?? mod.fileName)
    if (!file) continue
    const job = await installRequest({ instanceId: instanceId.value, kind: 'mod', file, withDependencies })
    if (job) started += 1
  }
  updating.value = false
  if (started > 0) useToast().push({ kind: 'info', title: copy.text('updatesStarted', { n: started }) })
  return started
}

async function search(nextOffset = 0): Promise<void> {
  if (!curseForgeReady.value && provider.value === 'curseforge') {
    // Upstream answers 403 / `unsupported` without a key — skip the request, show the notice.
    results.value = []
    total.value = 0
    searchError.value = null
    hasSearched.value = true
    return
  }
  searching.value = true
  searchError.value = null
  offset.value = nextOffset
  const query: SearchQuery = {
    provider: provider.value,
    kind: kind.value,
    keyword: keyword.value,
    offset: nextOffset,
    limit: PAGE_SIZE,
    sort: sort.value
  }
  if (versionFilter.value) query.gameVersion = versionFilter.value
  if (loaderFilter.value) query.loader = loaderFilter.value as LoaderId
  const res = await window.mouc.mod.search(query)
  searching.value = false
  hasSearched.value = true
  if (res.ok) {
    results.value = res.data.items
    total.value = res.data.total
  } else {
    results.value = []
    total.value = 0
    searchError.value = res.error
  }
}

async function openVersions(project: ModProject): Promise<void> {
  versionProject.value = project
  versions.value = []
  versionsError.value = null
  versionsLoading.value = true
  const res = await window.mouc.mod.versions(
    project.provider,
    project.id,
    versionFilter.value || currentInstance.value?.instance.gameVersion,
    loaderFilter.value || undefined
  )
  versionsLoading.value = false
  if (res.ok) versions.value = res.data
  else versionsError.value = res.error
}

function closeVersions(): void {
  versionProject.value = null
  versions.value = []
  versionsError.value = null
}

async function installVersion(file: ModFile, withDependencies: boolean, installKind: ProjectKind): Promise<boolean> {
  if (!instanceId.value) {
    useToast().push({ kind: 'warning', titleKey: 'launch.noInstance' })
    return false
  }
  const job = await installRequest({ instanceId: instanceId.value, kind: installKind, file, withDependencies })
  if (!job) return false
  useToast().push({ kind: 'info', title: copy.text('installQueued'), message: file.fileName })
  return true
}

export interface ModsStore {
  instances: Ref<InstanceSummary[]>
  instancesLoading: Ref<boolean>
  instancesError: Ref<AppErrorPayload | null>
  instanceId: Ref<string>
  currentInstance: ComputedRef<InstanceSummary | null>
  instanceOptions: ComputedRef<{ value: string; label: string; hint?: string }[]>
  gameVersionOptions: ComputedRef<string[]>
  loaderOptions: ComputedRef<LoaderId[]>

  mods: Ref<InstalledMod[]>
  modsLoading: Ref<boolean>
  modsError: Ref<AppErrorPayload | null>
  checkingUpdates: Ref<boolean>
  updating: Ref<boolean>
  updatable: ComputedRef<InstalledMod[]>
  modTotalBytes: ComputedRef<number>
  diskKind: Ref<ProjectKind>

  provider: Ref<ProjectProvider>
  kind: Ref<ProjectKind>
  keyword: Ref<string>
  versionFilter: Ref<string>
  loaderFilter: Ref<string>
  sort: Ref<NonNullable<SearchQuery['sort']>>
  results: Ref<ModProject[]>
  total: Ref<number>
  offset: Ref<number>
  searching: Ref<boolean>
  searchError: Ref<AppErrorPayload | null>
  hasSearched: Ref<boolean>
  curseForgeReady: ComputedRef<boolean>
  modableKinds: ProjectKind[]

  versionProject: Ref<ModProject | null>
  versions: Ref<ProjectVersion[]>
  versionsLoading: Ref<boolean>
  versionsError: Ref<AppErrorPayload | null>

  settings: Ref<Settings | null>
  jobs: Ref<JobState[]>
  activeJobs: ComputedRef<JobState[]>

  describeError: (error: AppErrorPayload) => string
  loadSettings: () => Promise<void>
  loadInstances: (preferredId?: string) => Promise<void>
  loadMods: () => Promise<void>
  checkUpdates: () => Promise<boolean>
  toggleMod: (mod: InstalledMod, disabled: boolean) => Promise<boolean>
  removeMod: (mod: InstalledMod) => Promise<boolean>
  installFromDisk: () => Promise<boolean>
  updateAll: (withDependencies: boolean) => Promise<number>
  search: (nextOffset?: number) => Promise<void>
  openVersions: (project: ModProject) => Promise<void>
  closeVersions: () => void
  installVersion: (file: ModFile, withDependencies: boolean, installKind: ProjectKind) => Promise<boolean>
}

export function useMods(): ModsStore {
  attach()
  return {
    instances,
    instancesLoading,
    instancesError,
    instanceId,
    currentInstance,
    instanceOptions,
    gameVersionOptions,
    loaderOptions,
    mods,
    modsLoading,
    modsError,
    checkingUpdates,
    updating,
    updatable,
    modTotalBytes,
    diskKind,
    provider,
    kind,
    keyword,
    versionFilter,
    loaderFilter,
    sort,
    results,
    total,
    offset,
    searching,
    searchError,
    hasSearched,
    curseForgeReady,
    modableKinds: MODABLE_KINDS,
    versionProject,
    versions,
    versionsLoading,
    versionsError,
    settings,
    jobs,
    activeJobs,
    describeError,
    loadSettings,
    loadInstances,
    loadMods,
    checkUpdates,
    toggleMod,
    removeMod,
    installFromDisk,
    updateAll,
    search,
    openVersions,
    closeVersions,
    installVersion
  }
}

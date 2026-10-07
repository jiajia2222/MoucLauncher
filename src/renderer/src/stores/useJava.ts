/**
 * useJava — shared state for JavaView.
 *
 * Two independent concerns live here: the runtime inventory (`java.scan`/`list`, with
 * provisioning progress folded in from the global download events) and the per-instance
 * answer to "which runtime will be used" (`java.resolve`). Resolving every instance is
 * done in parallel and each failure is kept per row, so one broken instance cannot hide
 * the others.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { EVENTS } from '@shared/ipc'
import type {
  AppErrorPayload,
  DownloadJob,
  DownloadProgress,
  Instance,
  InstanceSummary,
  JavaRuntime,
  JobStatus,
  Settings
} from '@shared/types'
import { defineDict } from '../i18n'
import { useToast } from '../composables/useToast'

const copy = defineDict({
  removed: ['运行时已移除', 'Runtime removed'],
  provisionStarted: ['开始下载 Java {major}', 'Downloading Java {major}'],
  provisionDone: ['Java {major} 已就绪', 'Java {major} ready'],
  pathSaved: ['自定义路径已保存', 'Custom path saved'],
  majorsHint: ['Adoptium 与 Mojang 组件当前提供的 LTS 大版本', 'LTS majors currently offered by Adoptium and the Mojang components']
})

/** Majors the download sources serve; the required set is unioned with instance needs. */
const RECOMMENDED_MAJORS = [8, 17, 21, 25]

export interface JobState {
  id: string
  title: string
  status: JobStatus
  percent: number
  bytesDone: number
  bytesTotal: number
  speedBps: number
  etaSeconds: number
  error?: AppErrorPayload
}

export interface ResolveEntry {
  instance: Instance
  major: number
  runtime: JavaRuntime | null
  error: AppErrorPayload | null
}

const instances: Ref<InstanceSummary[]> = ref([])
const runtimes: Ref<JavaRuntime[]> = ref([])
const loading: Ref<boolean> = ref(false)
const scanning: Ref<boolean> = ref(false)
const error: Ref<AppErrorPayload | null> = ref(null)
const busyId: Ref<string> = ref('')
const resolved: Ref<Record<string, ResolveEntry>> = ref({})
const resolving: Ref<boolean> = ref(false)
const settings: Ref<Settings | null> = ref(null)
const jobs: Ref<JobState[]> = ref([])

let attached = false
/** Only the jobs started from this view are shown; the shell's status bar owns the rest. */
const ownJobs = new Set<string>()
/**
 * `java.provision` answers with the runtime, not the job it started, so a freshly
 * requested major is matched to the first progress event whose title mentions it.
 */
const pendingMajors = new Set<number>()

function claimPendingMajor(payload: DownloadProgress): void {
  if (ownJobs.has(payload.jobId) || pendingMajors.size === 0) return
  for (const major of pendingMajors) {
    if (payload.currentLabel.includes(`Java ${major}`) || payload.currentLabel.includes(`java ${major}`)) {
      ownJobs.add(payload.jobId)
      pendingMajors.delete(major)
      return
    }
  }
}

function reportError(payload: AppErrorPayload): void {
  useToast().push({ kind: 'danger', title: payload.message, message: payload.detail, duration: 6000 })
}

function describeError(payload: AppErrorPayload): string {
  return payload.detail ? `${payload.message} — ${payload.detail}` : payload.message
}

function upsert(entry: JobState): void {
  const at = jobs.value.findIndex((item) => item.id === entry.id)
  if (at === -1) jobs.value = [entry, ...jobs.value]
  else jobs.value.splice(at, 1, entry)
  if (jobs.value.length > 6) jobs.value = jobs.value.slice(0, 6)
}

function attach(): void {
  if (attached) return
  attached = true
  const api = window.mouc
  api.on(EVENTS.progress, (payload) => {
    const next = payload as DownloadProgress
    claimPendingMajor(next)
    const known = jobs.value.find((item) => item.id === next.jobId)
    if (!known && !ownJobs.has(next.jobId)) return
    upsert({
      id: next.jobId,
      title: known?.title ?? (next.currentLabel.split(' · ')[0] ?? next.currentLabel),
      status: next.status,
      percent: next.percent,
      bytesDone: next.bytesDone,
      bytesTotal: next.bytesTotal,
      speedBps: next.speedBps,
      etaSeconds: next.etaSeconds,
      error: known?.error
    })
  })
  api.on(EVENTS.jobFinished, (payload) => {
    const job = payload as DownloadJob
    const known = jobs.value.find((item) => item.id === job.id)
    if (!known || !ownJobs.has(job.id)) return
    upsert({
      ...known,
      title: job.title,
      status: job.status,
      percent: job.status === 'done' ? 100 : known.percent,
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      speedBps: 0,
      etaSeconds: 0,
      error: job.error
    })
    if (job.status === 'done') void loadRuntimes()
    if (job.status === 'error' && job.error) reportError(job.error)
  })
  api.on(EVENTS.settings, (payload) => {
    settings.value = payload as Settings
  })
}

/* ------------------------------------------------------------------ selectors */
const sortedRuntimes: ComputedRef<JavaRuntime[]> = computed(() =>
  [...runtimes.value].sort((a, b) => a.major - b.major || a.path.localeCompare(b.path))
)

const broken: ComputedRef<JavaRuntime[]> = computed(() => runtimes.value.filter((entry) => entry.broken))

const resolveList: ComputedRef<ResolveEntry[]> = computed(() =>
  instances.value.map((entry) => resolved.value[entry.instance.id]).filter((entry): entry is ResolveEntry => entry !== undefined)
)

const missingEntries: ComputedRef<ResolveEntry[]> = computed(() => resolveList.value.filter((entry) => entry.runtime === null))

/** Majors worth offering for download: what the instances demand + the LTS ladder. */
const majors: ComputedRef<number[]> = computed(() => {
  const set = new Set<number>(RECOMMENDED_MAJORS)
  for (const entry of resolveList.value) set.add(entry.major)
  return [...set].sort((a, b) => a - b)
})

const installedMajors: ComputedRef<Set<number>> = computed(
  () => new Set(runtimes.value.filter((entry) => !entry.broken).map((entry) => entry.major))
)

const provisionRunning: ComputedRef<boolean> = computed(() => jobs.value.some((entry) => entry.status === 'running'))

/* -------------------------------------------------------------------- actions */
async function loadSettings(): Promise<void> {
  const res = await window.mouc.settings.get()
  if (res.ok) settings.value = res.data
  else reportError(res.error)
}

async function saveSettings(patch: Partial<Settings>): Promise<boolean> {
  const res = await window.mouc.settings.set(patch)
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  settings.value = res.data
  useToast().push({ kind: 'success', titleKey: 'settings.saved' })
  void resolveInstances()
  return true
}

async function loadInstances(): Promise<void> {
  const res = await window.mouc.instance.list()
  if (!res.ok) {
    reportError(res.error)
    return
  }
  instances.value = res.data
  await resolveInstances()
}

async function loadRuntimes(): Promise<void> {
  attach()
  loading.value = true
  error.value = null
  const res = await window.mouc.java.list()
  if (res.ok) runtimes.value = res.data
  else error.value = res.error
  loading.value = false
}

async function scan(): Promise<void> {
  attach()
  scanning.value = true
  error.value = null
  const res = await window.mouc.java.scan()
  scanning.value = false
  if (res.ok) runtimes.value = res.data
  else {
    error.value = res.error
    reportError(res.error)
  }
  await resolveInstances()
}

async function resolveInstances(): Promise<void> {
  if (instances.value.length === 0) return
  resolving.value = true
  const next: Record<string, ResolveEntry> = {}
  await Promise.all(
    instances.value.map(async (summary) => {
      const id = summary.instance.id
      const res = await window.mouc.java.resolve(id)
      next[id] = {
        instance: summary.instance,
        major: res.ok ? res.data.major : (summary.instance.java.major ?? 0),
        runtime: res.ok ? res.data.runtime : null,
        error: res.ok ? null : res.error
      }
    })
  )
  resolved.value = next
  resolving.value = false
}

async function provision(major: number): Promise<boolean> {
  attach()
  const res = await window.mouc.java.provision({ major })
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  if (res.data.fromCache) {
    useToast().push({ kind: 'info', title: copy.text('provisionDone', { major }) })
    await loadRuntimes()
    await resolveInstances()
    return true
  }
  pendingMajors.add(major)
  useToast().push({ kind: 'info', title: copy.text('provisionStarted', { major }) })
  return true
}

async function removeRuntime(runtime: JavaRuntime): Promise<boolean> {
  busyId.value = runtime.id
  const res = await window.mouc.java.remove(runtime.id)
  busyId.value = ''
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  runtimes.value = runtimes.value.filter((entry) => entry.id !== runtime.id)
  useToast().push({ kind: 'success', title: copy.text('removed'), message: `Java ${runtime.major}` })
  await resolveInstances()
  return true
}

/** Writes `settings.customJavaPath`; the main process uses it when javaMode = custom. */
async function pickCustomJava(): Promise<boolean> {
  const picked = await window.mouc.app.pickFile(copy.text('pathSaved'), [
    { name: 'javaw.exe', extensions: ['exe'] }
  ])
  if (!picked.ok) {
    reportError(picked.error)
    return false
  }
  const path = picked.data
  if (path === undefined) return false // cancelled, not an error
  const res = await window.mouc.settings.set({ customJavaPath: path, javaMode: 'custom' })
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  settings.value = res.data
  useToast().push({ kind: 'success', title: copy.text('pathSaved'), message: path })
  await resolveInstances()
  return true
}

export interface JavaStore {
  instances: Ref<InstanceSummary[]>
  runtimes: Ref<JavaRuntime[]>
  sortedRuntimes: ComputedRef<JavaRuntime[]>
  broken: ComputedRef<JavaRuntime[]>
  loading: Ref<boolean>
  scanning: Ref<boolean>
  error: Ref<AppErrorPayload | null>
  busyId: Ref<string>
  resolved: Ref<Record<string, ResolveEntry>>
  resolveList: ComputedRef<ResolveEntry[]>
  missingEntries: ComputedRef<ResolveEntry[]>
  resolving: Ref<boolean>
  settings: Ref<Settings | null>
  jobs: Ref<JobState[]>
  majors: ComputedRef<number[]>
  installedMajors: ComputedRef<Set<number>>
  provisionRunning: ComputedRef<boolean>
  recommendedMajors: number[]
  majorsHintText: string
  describeError: (payload: AppErrorPayload) => string
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<boolean>
  loadInstances: () => Promise<void>
  loadRuntimes: () => Promise<void>
  resolveInstances: () => Promise<void>
  scan: () => Promise<void>
  provision: (major: number) => Promise<boolean>
  removeRuntime: (runtime: JavaRuntime) => Promise<boolean>
  pickCustomJava: () => Promise<boolean>
}

export function useJava(): JavaStore {
  attach()
  return {
    instances,
    runtimes,
    sortedRuntimes,
    broken,
    loading,
    scanning,
    error,
    busyId,
    resolved,
    resolveList,
    missingEntries,
    resolving,
    settings,
    jobs,
    majors,
    installedMajors,
    provisionRunning,
    recommendedMajors: RECOMMENDED_MAJORS,
    majorsHintText: copy.text('majorsHint'),
    describeError,
    loadSettings,
    saveSettings,
    loadInstances,
    loadRuntimes,
    resolveInstances,
    scan,
    provision,
    removeRuntime,
    pickCustomJava
  }
}

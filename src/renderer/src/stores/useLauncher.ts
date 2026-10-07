/**
 * Launcher runtime state shared by the four views.
 *
 * Module-level refs, the same pattern `composables/useNav` uses: the main process pushes
 * progress / job-finished / game-exit events whether or not a view happens to be mounted,
 * so the subscriptions live here and survive view switches. `window.mouc` is only touched
 * lazily — in the browser preview the mock is installed after module evaluation.
 */
import { computed, ref, type ComputedRef } from 'vue'
import { EVENTS } from '@shared/ipc'
import type {
  DownloadJob,
  DownloadProgress,
  GameExitInfo,
  GameProcessInfo,
  JobStatus,
  LaunchRequest
} from '@shared/types'
import { defineDict, t, type I18nKey } from '../i18n'
import { useToast } from '../composables/useToast'

export const launcherText = defineDict({
  cancelJob: ['取消任务', 'Cancel job'],
  jobCancelled: ['已取消 {title}', 'Cancelled {title}'],
  jobFailed: ['下载任务失败', 'Download job failed'],
  retrySent: ['已重新排队 {title}', 'Requeued {title}'],
  retryFailed: ['无法重试该任务', 'Could not retry that job'],
  cancelFailed: ['无法取消该任务', 'Could not cancel that job'],
  loadJobsFailed: ['读取下载任务失败', 'Could not load download jobs'],
  loadRunningFailed: ['读取运行中的游戏失败', 'Could not read running games'],
  clearDone: ['已清空任务记录', 'Job history cleared'],
  clearFailed: ['清空任务记录失败', 'Could not clear the job history'],
  launched: ['已启动 {name}', 'Launched {name}'],
  launchFailed: ['启动失败', 'Launch failed'],
  killed: ['已结束 {name} 的进程', 'Stopped the process of {name}'],
  killFailed: ['结束进程失败', 'Could not stop the process'],
  exitNormal: ['游戏已正常退出', 'Game exited cleanly'],
  'status.queued': ['排队中', 'Queued'],
  'status.cancelled': ['已取消', 'Cancelled'],
  files: ['{done}/{total} 个文件', '{done}/{total} files'],
  eta: ['剩余 {time}', '{time} left']
})

const jobs = ref<DownloadJob[]>([])
const progress = ref<Record<string, DownloadProgress>>({})
const running = ref<GameProcessInfo[]>([])
const lastExit = ref<GameExitInfo | null>(null)
const launchingId = ref<string | null>(null)
/** One shared 1s clock so "已运行 3m 12s" does not need a timer per view. */
const clock = ref(Date.now())

let subscribed = false
let clockTimer: ReturnType<typeof setInterval> | null = null

const JOB_ORDER: Record<JobStatus, number> = {
  running: 0,
  paused: 1,
  queued: 2,
  error: 3,
  cancelled: 4,
  done: 5
}

/** Job statuses the shell already has copy for; only queued/cancelled are new. */
const STATUS_KEYS: Partial<Record<JobStatus, I18nKey>> = {
  running: 'status.jobRunning',
  paused: 'status.jobPaused',
  done: 'status.jobDone',
  error: 'status.jobFailed'
}

function toast(): ReturnType<typeof useToast> {
  return useToast()
}

function danger(title: string, message?: string): void {
  toast().push({ kind: 'danger', title, message })
}

function onProgress(payload: unknown): void {
  const next = payload as DownloadProgress
  progress.value[next.jobId] = next
  const known = jobs.value.find((job) => job.id === next.jobId)
  if (!known) {
    // A job can start from another view; adopt it so the panel is never blind.
    jobs.value = [
      ...jobs.value,
      {
        id: next.jobId,
        title: next.currentLabel.split(' · ')[0] ?? next.currentLabel,
        kind: 'misc',
        status: next.status,
        total: next.total,
        done: next.done,
        failed: next.failed,
        skipped: 0,
        bytesTotal: next.bytesTotal,
        bytesDone: next.bytesDone,
        startedAt: Date.now()
      }
    ]
    return
  }
  known.status = next.status
  known.total = next.total
  known.done = next.done
  known.failed = next.failed
  known.bytesTotal = next.bytesTotal
  known.bytesDone = next.bytesDone
}

function onJobFinished(payload: unknown): void {
  const finished = payload as DownloadJob
  const index = jobs.value.findIndex((job) => job.id === finished.id)
  if (index === -1) jobs.value = [...jobs.value, finished]
  else jobs.value[index] = finished
  delete progress.value[finished.id]
  if (finished.status === 'error') danger(launcherText.text('jobFailed'), finished.error?.message ?? finished.title)
}

function onGameExit(payload: unknown): void {
  const exit = payload as GameExitInfo
  lastExit.value = exit
  running.value = running.value.filter((entry) => entry.instanceId !== exit.instanceId)
  if (!exit.analysis && exit.code === 0) toast().push({ kind: 'info', title: launcherText.text('exitNormal') })
}

/** Subscribes once for the whole session; safe to call from every view. */
export function useLauncherEvents(): void {
  if (subscribed) return
  const api = window.mouc
  if (!api) return
  api.on(EVENTS.progress, onProgress)
  api.on(EVENTS.jobFinished, onJobFinished)
  api.on(EVENTS.gameExit, onGameExit)
  subscribed = true
  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      clock.value = Date.now()
    }, 1_000)
  }
}

export interface ActiveJob {
  job: DownloadJob
  live: DownloadProgress | null
  percent: number
  statusLabel: string
}

function percentOf(job: DownloadJob, live: DownloadProgress | null): number {
  if (live) return live.percent
  if (job.bytesTotal > 0) return Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 1000) / 10)
  if (job.total > 0) return Math.min(100, Math.round((job.done / job.total) * 1000) / 10)
  return 0
}

export interface LauncherStore {
  jobs: typeof jobs
  activeJobs: ComputedRef<ActiveJob[]>
  finishedJobs: ComputedRef<ActiveJob[]>
  hasJob: ComputedRef<boolean>
  progressOf: (jobId: string) => DownloadProgress | null
  statusLabel: (status: JobStatus) => string
  running: typeof running
  runningOf: (instanceId: string) => GameProcessInfo | null
  isRunning: (instanceId: string) => boolean
  lastExit: typeof lastExit
  launchingId: typeof launchingId
  clock: typeof clock
  refreshJobs: () => Promise<void>
  refreshRunning: () => Promise<void>
  launch: (req: LaunchRequest, name: string) => Promise<boolean>
  kill: (instanceId: string, name: string) => Promise<boolean>
  cancelJob: (jobId: string) => Promise<void>
  retryJob: (jobId: string) => Promise<void>
  clearFinished: () => Promise<void>
  clearExit: () => void
}

export function useLauncher(): LauncherStore {
  useLauncherEvents()

  const sorted = computed<DownloadJob[]>(() =>
    [...jobs.value].sort((a, b) => JOB_ORDER[a.status] - JOB_ORDER[b.status] || b.startedAt - a.startedAt)
  )

  const activeJobs = computed<ActiveJob[]>(() =>
    sorted.value
      .filter((job) => job.status === 'running' || job.status === 'queued' || job.status === 'paused')
      .map((job) => toActive(job))
  )

  const finishedJobs = computed<ActiveJob[]>(() =>
    sorted.value
      .filter((job) => job.status !== 'running' && job.status !== 'queued' && job.status !== 'paused')
      .slice(0, 6)
      .map((job) => toActive(job))
  )

  function toActive(job: DownloadJob): ActiveJob {
    const live = progress.value[job.id] ?? null
    return { job, live, percent: percentOf(job, live), statusLabel: statusLabel(job.status) }
  }

  function statusLabel(status: JobStatus): string {
    const shellKey = STATUS_KEYS[status]
    if (shellKey) return t(shellKey)
    return launcherText.text(status === 'queued' ? 'status.queued' : 'status.cancelled')
  }

  function progressOf(jobId: string): DownloadProgress | null {
    return progress.value[jobId] ?? null
  }

  async function refreshJobs(): Promise<void> {
    const api = window.mouc
    if (!api) return
    const res = await api.download.jobs()
    if (res.ok) jobs.value = res.data
    else danger(launcherText.text('loadJobsFailed'), res.error.message)
  }

  async function refreshRunning(): Promise<void> {
    const api = window.mouc
    if (!api) return
    const res = await api.game.running()
    if (res.ok) running.value = res.data
    else danger(launcherText.text('loadRunningFailed'), res.error.message)
  }

  function runningOf(instanceId: string): GameProcessInfo | null {
    return running.value.find((entry) => entry.instanceId === instanceId) ?? null
  }

  function isRunning(instanceId: string): boolean {
    return runningOf(instanceId) !== null
  }

  async function launch(req: LaunchRequest, name: string): Promise<boolean> {
    const api = window.mouc
    if (!api) return false
    launchingId.value = req.instanceId
    try {
      const res = await api.game.launch(req)
      if (!res.ok) {
        danger(launcherText.text('launchFailed'), res.error.detail || res.error.message)
        return false
      }
      running.value = [...running.value, res.data]
      toast().push({ kind: 'success', title: launcherText.text('launched', { name }) })
      return true
    } finally {
      launchingId.value = null
    }
  }

  async function kill(instanceId: string, name: string): Promise<boolean> {
    const api = window.mouc
    if (!api) return false
    const res = await api.game.kill(instanceId)
    if (!res.ok) {
      danger(launcherText.text('killFailed'), res.error.message)
      return false
    }
    running.value = running.value.filter((entry) => entry.instanceId !== instanceId)
    toast().push({ kind: 'info', title: launcherText.text('killed', { name }) })
    return true
  }

  async function cancelJob(jobId: string): Promise<void> {
    const api = window.mouc
    if (!api) return
    const res = await api.download.cancel(jobId)
    if (!res.ok) {
      danger(launcherText.text('cancelFailed'), res.error.message)
      return
    }
    const job = jobs.value.find((entry) => entry.id === jobId)
    if (job) job.status = 'cancelled'
    delete progress.value[jobId]
    toast().push({ kind: 'info', title: launcherText.text('jobCancelled', { title: job?.title ?? '' }) })
  }

  async function retryJob(jobId: string): Promise<void> {
    const api = window.mouc
    if (!api) return
    const res = await api.download.retry(jobId)
    if (!res.ok) {
      danger(launcherText.text('retryFailed'), res.error.message)
      return
    }
    const index = jobs.value.findIndex((job) => job.id === jobId)
    if (index !== -1) jobs.value[index] = res.data
    toast().push({ kind: 'info', title: launcherText.text('retrySent', { title: res.data.title }) })
  }

  async function clearFinished(): Promise<void> {
    const api = window.mouc
    if (!api) return
    const res = await api.download.clear()
    if (!res.ok) {
      danger(launcherText.text('clearFailed'), res.error.message)
      return
    }
    jobs.value = jobs.value.filter((job) => job.status === 'running' || job.status === 'queued' || job.status === 'paused')
    toast().push({ kind: 'info', title: launcherText.text('clearDone') })
  }

  return {
    jobs,
    activeJobs,
    finishedJobs,
    hasJob: computed(() => activeJobs.value.length > 0),
    progressOf,
    statusLabel,
    running,
    runningOf,
    isRunning,
    lastExit,
    launchingId,
    clock,
    refreshJobs,
    refreshRunning,
    launch,
    kill,
    cancelJob,
    retryJob,
    clearFinished,
    clearExit: () => {
      lastExit.value = null
    }
  }
}

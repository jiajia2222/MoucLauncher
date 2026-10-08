/**
 * Shell store — the slice of upstream `store.ts` the chrome needs.
 *
 * Upstream keeps download tasks, notices, launch state and health in one module-level
 * reactive object fed by IPC events. MoucX's backend already owns that state
 * (`mouc.download.jobs()` + `mouc:progress` / `mouc:job-finished` / `mouc:game-exit`),
 * so this is a thin projection of it: a `tasks` view-model over jobs and the latest
 * progress payload, a local notice list (there is no notice API in `MoucApi`), and the
 * window/version facts the top bar and status bar render.
 */
import { computed, reactive, ref, shallowRef } from 'vue'
import type { WindowState } from '@shared/ipc'
import type {
  DownloadJob,
  DownloadProgress,
  GameDirStats,
  GameExitInfo,
  GameProcessInfo,
  InstanceSummary,
  JobStatus,
  LauncherStatus,
  PathInfo
} from '@shared/types'
import {
  SHELL_EVENTS,
  cancelJob,
  errorText,
  killGame,
  onEvent,
  readInstances,
  readJobs,
  readPaths,
  readRunningGames,
  readStats,
  readStatus,
  readVersion,
  readWindowState,
  toggleMaximize as requestToggleMaximize,
  winClose,
  winMinimize
} from './bridge'
import { copy } from './copy'
import { useToast } from '../../composables/useToast'
import { useModal } from '../../composables/useModal'
import { formatBytes } from '../../composables/format'

const toast = useToast()
const modal = useModal()

/* ------------------------------------------------------------------ notices */

export interface ShellNotice {
  id: number
  type: 'info' | 'success' | 'error'
  text: string
  time: number
}

let noticeSeq = 0
const MAX_NOTICES = 30

/* --------------------------------------------------------------------- state */

const jobs = shallowRef<DownloadJob[]>([])
const progressOf = reactive<Record<string, DownloadProgress>>({})
const dismissed = ref<Set<string>>(new Set())
const running = shallowRef<GameProcessInfo[]>([])
const summaries = ref<InstanceSummary[]>([])
const notices = ref<ShellNotice[]>([])
const noticesUnread = ref(0)
const status = ref<LauncherStatus | null>(null)
const paths = ref<PathInfo | null>(null)
const stats = ref<GameDirStats | null>(null)
const versionText = ref('')
const windowState = ref<WindowState>({ maximized: false, fullscreen: false, alwaysOnTop: false })
const lastLaunchError = ref('')
let offSubscribers: Array<() => void> = []

/* -------------------------------------------------------------------- tasks */

export interface ShellTask {
  id: string
  title: string
  status: JobStatus
  total: number
  done: number
  percent: number
  indeterminate: boolean
  speed: number
  etaSeconds: number
  bytesDone: number
  bytesTotal: number
  currentLabel: string
  error: string
}

/** `DownloadJob` + the live `mouc:progress` payload merged into upstream's task shape. */
function toTask(job: DownloadJob): ShellTask {
  const live = progressOf[job.id]
  const bytesTotal = live?.bytesTotal ?? job.bytesTotal
  const bytesDone = live?.bytesDone ?? job.bytesDone
  const indeterminate = bytesTotal <= 0
  const byBytes = indeterminate ? 0 : (bytesDone / bytesTotal) * 100
  const byCount = job.total > 0 ? (job.done / job.total) * 100 : 0
  return {
    id: job.id,
    title: job.title,
    status: live?.status ?? job.status,
    total: live?.total ?? job.total,
    done: live?.done ?? job.done,
    percent: Math.round((live?.percent ?? Math.max(byBytes, byCount)) * 10) / 10,
    indeterminate,
    speed: live?.speedBps ?? 0,
    etaSeconds: live?.etaSeconds ?? 0,
    bytesDone,
    bytesTotal,
    currentLabel: live?.currentLabel ?? job.title,
    error: live ? '' : (job.error?.message ?? '')
  }
}

const allTasks = computed<ShellTask[]>(() =>
  jobs.value
    .filter((job) => !dismissed.value.has(job.id))
    .map(toTask)
    .sort((a, b) => rank(b.status) - rank(a.status))
)

function rank(value: JobStatus): number {
  if (value === 'running') return 3
  if (value === 'queued' || value === 'paused' || value === 'cancelled') return 2
  if (value === 'error') return 1
  return 0
}

const tasks = computed(() => allTasks.value)
const activeTaskCount = computed(() => allTasks.value.filter((item) => item.status === 'running' || item.status === 'paused' || item.status === 'queued').length)
/** The job the status bar shows: the newest running one, else the newest known. */
const activeTask = computed<ShellTask | null>(() => allTasks.value[0] ?? null)

export const shell = {
  jobs,
  tasks,
  activeTask,
  activeTaskCount,
  running,
  summaries,
  notices,
  noticesUnread,
  status,
  paths,
  stats,
  versionText,
  windowState,
  lastLaunchError
}

/** Top-level refs so templates unwrap them (a ref inside `shell` would not unwrap). */
export {
  windowState,
  notices,
  noticesUnread,
  running,
  jobs,
  summaries,
  versionText,
  tasks,
  activeTask,
  activeTaskCount
}

/* ------------------------------------------------------------------ health */

export const launcherHealth = computed<{ tone: 'ok' | 'busy' | 'error'; text: string }>(() => {
  if (lastLaunchError.value || status.value?.activeJob?.status === 'error') {
    return { tone: 'error', text: copy.text('healthError') }
  }
  if (!status.value?.online) return { tone: 'busy', text: copy.text('healthOffline') }
  if (activeTaskCount.value) return { tone: 'busy', text: copy.text('healthBusy', { count: activeTaskCount.value }) }
  return { tone: 'ok', text: copy.text('healthOk') }
})

export const runningGame = computed<GameProcessInfo | null>(() => running.value[0] ?? null)

export const runningGameName = computed<string>(() => {
  const game = runningGame.value
  if (!game) return ''
  const match = summaries.value.find((entry) => entry.instance.id === game.instanceId)
  return match?.instance.name ?? game.instanceId
})

export const gameRootText = computed<string>(() => paths.value?.gameRoot ?? status.value?.gameRoot ?? '')

export const statsText = computed<string>(() => {
  const value = stats.value
  if (!value || !value.exists) return ''
  return `${copy.text('statsLine', { size: formatBytes(value.sizeBytes), files: value.fileCount })} · ${copy.text('statInstances', { count: value.instances })} · ${copy.text('statVersions', { count: value.versions })}`
})

/* ------------------------------------------------------------------ notices */

function pushNotice(type: ShellNotice['type'], text: string): void {
  notices.value = [{ id: (noticeSeq += 1), type, text, time: Date.now() }, ...notices.value].slice(0, MAX_NOTICES)
  noticesUnread.value += 1
}

export function markNoticesRead(): void {
  noticesUnread.value = 0
}

export function clearNotices(): void {
  notices.value = []
  noticesUnread.value = 0
}

/* ------------------------------------------------------------------ window */

export function minimizeWindow(): void {
  winMinimize()
}

export async function toggleMaximize(): Promise<void> {
  const next = await requestToggleMaximize()
  if (next) windowState.value = next
}

/**
 * Upstream behaviour ported: closing while a game runs says so once first (the game must
 * survive the launcher), otherwise the window closes straight away.
 */
let closeHintShown = false
export async function closeWindow(): Promise<void> {
  if (runningGame.value && !closeHintShown) {
    closeHintShown = true
    pushNotice('info', copy.text('closeHint'))
    toast.push({ kind: 'info', title: copy.text('closeHint') })
    window.setTimeout(() => winClose(), 1300)
    return
  }
  winClose()
}

/* --------------------------------------------------------------- job actions */

/**
 * `MoucApi.download` has no per-job removal, so "移除记录" only hides the finished row
 * locally; the main process keeps its history until `download.clear()`.
 */
export function dismissTask(jobId: string): void {
  dismissed.value = new Set([...dismissed.value, jobId])
}

export async function cancelTask(jobId: string): Promise<void> {
  const target = jobs.value.find((job) => job.id === jobId)
  if (!target) return
  const done = await cancelJob(jobId)
  if (!done) {
    toast.push({ kind: 'warning', title: copy.text('noTasks') })
    return
  }
  await refreshJobs()
}

export async function stopRunningGame(): Promise<void> {
  const game = runningGame.value
  if (!game) return
  const name = runningGameName.value || game.instanceId
  const confirmed = await modal.confirm({
    titleKey: 'game.kill',
    text: copy.text('killGameConfirm', { name }),
    confirmKey: 'common.confirm',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  await killGame(game.instanceId)
}

/* ------------------------------------------------------------------ events */

function adoptJob(job: DownloadJob): void {
  const next = jobs.value.filter((entry) => entry.id !== job.id)
  jobs.value = [job, ...next]
  dismissed.value = new Set([...dismissed.value].filter((id) => id !== job.id))
}

function onProgress(payload: unknown): void {
  const live = payload as DownloadProgress
  progressOf[live.jobId] = live
  if (!jobs.value.some((job) => job.id === live.jobId)) {
    adoptJob({
      id: live.jobId,
      title: live.currentLabel.split(' · ')[0] ?? '',
      kind: 'misc',
      status: live.status,
      total: live.total,
      done: live.done,
      failed: live.failed,
      skipped: 0,
      bytesTotal: live.bytesTotal,
      bytesDone: live.bytesDone,
      startedAt: Date.now()
    })
  }
}

function onJobFinished(payload: unknown): void {
  const job = payload as DownloadJob
  adoptJob(job)
  delete progressOf[job.id]
  if (job.status === 'done') {
    const text = copy.text('jobDoneToast', { title: job.title })
    pushNotice('success', text)
    toast.push({ kind: 'success', title: text })
  } else if (job.status === 'error') {
    const text = copy.text('jobFailedToast', { message: job.error?.message ?? copy.text('unknownError') })
    lastLaunchError.value = job.error?.message ?? ''
    pushNotice('error', text)
    toast.push({ kind: 'danger', title: text })
  }
}

function onGameExit(payload: unknown): void {
  const exit = payload as GameExitInfo
  running.value = running.value.filter((entry) => entry.instanceId !== exit.instanceId || entry.pid !== exit.pid)
  const name = summaries.value.find((entry) => entry.instance.id === exit.instanceId)?.instance.name ?? exit.instanceId
  if (exit.code !== 0 && exit.code !== null) {
    const suggestion = exit.analysis?.suggestion ?? ''
    const text = `${name} · ${suggestion || copy.text('healthError')}`
    lastLaunchError.value = text
    pushNotice('error', text)
    toast.push({ kind: 'danger', title: text })
  } else {
    pushNotice('info', `${name} · ${copy.text('gameStoppedNotice')}`)
  }
}

function onWindowState(payload: unknown): void {
  windowState.value = payload as WindowState
}

/* ------------------------------------------------------------------- loads */

export async function refreshJobs(): Promise<void> {
  jobs.value = await readJobs()
}

async function loadEverything(): Promise<void> {
  const [statusValue, pathsValue, statsValue, version, jobList, runningList, winState, instances] = await Promise.all([
    readStatus(),
    readPaths(),
    readStats(),
    readVersion(),
    readJobs(),
    readRunningGames(),
    readWindowState(),
    readInstances()
  ])
  status.value = statusValue
  paths.value = pathsValue
  stats.value = statsValue
  versionText.value = version
  jobs.value = jobList
  running.value = runningList
  if (winState) windowState.value = winState
  summaries.value = instances
  if (statusValue?.runningGame && runningList.length === 0) running.value = [statusValue.runningGame]
}

/** Subscribe + first load. Called once from App.vue's `onMounted`. */
export async function startShell(): Promise<void> {
  offSubscribers = [
    onEvent(SHELL_EVENTS.progress, onProgress),
    onEvent(SHELL_EVENTS.jobFinished, onJobFinished),
    onEvent(SHELL_EVENTS.gameExit, onGameExit),
    onEvent(SHELL_EVENTS.windowState, onWindowState)
  ]
  try {
    await loadEverything()
  } catch (error) {
    const text = errorText(error)
    pushNotice('error', text)
  }
}

export function stopShell(): void {
  for (const off of offSubscribers) off()
  offSubscribers = []
}

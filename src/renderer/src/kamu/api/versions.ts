/**
 * Version catalog + download-job data layer for the ported KAMUCL version views.
 *
 * Upstream splits this across `api.ts` (`getManifest`, `installVersion`, …) and
 * `src/shared/versionPicker.ts` (category filter). Both are re-implemented here on top of
 * `window.mouc`; the jobs half exists because every install / repair / modpack transfer
 * returns a `DownloadJob` and pushes progress through `mouc.on('mouc:progress')`.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { EVENTS } from '@shared/ipc'
import type { EventName, LoaderOption, VersionInstallRequest } from '@shared/ipc'
import type {
  DownloadJob,
  DownloadProgress,
  ResolvedVersion,
  VersionRef,
  VersionType
} from '@shared/types'
import { api, call, plain } from './core'

/* ------------------------------------------------------------ catalog */

export async function listVersions(types?: VersionType[]): Promise<VersionRef[]> {
  const all = await call(api().version.list())
  return types && types.length ? all.filter((entry) => types.includes(entry.type)) : all
}

export async function installedVersionIds(): Promise<string[]> {
  return call(api().version.installed())
}

/** Re-fetch the manifest from the (possibly mirrored) metadata endpoint. */
export async function refreshVersions(): Promise<VersionRef[]> {
  return call(api().version.refresh())
}

export async function installVersion(req: VersionInstallRequest): Promise<DownloadJob> {
  return call(api().version.install(plain(req)))
}

export async function repairVersion(id: string): Promise<DownloadJob> {
  return call(api().version.repair(id))
}

export async function uninstallVersion(id: string): Promise<boolean> {
  return call(api().version.uninstall(id))
}

export async function resolvedVersion(id: string): Promise<ResolvedVersion> {
  return call(api().version.resolved(id))
}

export async function loaderOptions(gameVersion: string): Promise<LoaderOption[]> {
  if (!gameVersion) return []
  return call(api().loader.options(gameVersion))
}

/* ------------------------------------------------------ category filter */

export type VersionCategory = 'release' | 'preview' | 'snapshot' | 'old' | 'all'

/** Port of upstream `versionCategories`; `all` is the escape hatch the picker footer uses. */
export const versionCategories: Array<{ value: VersionCategory; label: string }> = [
  { value: 'release', label: '正式版' },
  { value: 'preview', label: '预发布 / 候选' },
  { value: 'snapshot', label: '快照' },
  { value: 'old', label: '远古版' },
  { value: 'all', label: '全部' }
]

const PREVIEW_PATTERN = /(?:[-\s](?:pre|rc)(?:[-\s]?\d|release)|pre-release|release candidate)/i

export function versionCategory(version: VersionRef): VersionCategory {
  if (version.type === 'release') return 'release'
  if (version.type === 'old_alpha' || version.type === 'old_beta') return 'old'
  return PREVIEW_PATTERN.test(version.id) ? 'preview' : 'snapshot'
}

export function categoryLabel(category: VersionCategory): string {
  return versionCategories.find((entry) => entry.value === category)?.label ?? '其他'
}

export function filterVersions(
  versions: VersionRef[],
  category: VersionCategory,
  query: string
): VersionRef[] {
  const needle = query.trim().toLowerCase()
  return versions
    .filter((entry) => (category === 'all' || versionCategory(entry) === category) && entry.id.toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime))
}

export const typeText: Record<VersionType, string> = {
  release: '正式版',
  snapshot: '快照',
  old_beta: 'Beta 旧版',
  old_alpha: 'Alpha 旧版'
}

/** release gold / snapshot cyan / old dim, exactly upstream's `typeTagClass`. */
export function typeTagClass(type: VersionType): string {
  return type === 'release' ? 'tag-gold' : type === 'snapshot' ? 'tag-cyan' : ''
}

export function releaseDateOf(version: VersionRef): Date {
  const stamp = version.releaseTime || version.time
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(0)
}

export function latestRelease(versions: VersionRef[]): VersionRef | undefined {
  return versions.filter((entry) => entry.type === 'release')[0]
}

/* ----------------------------------------------------------- job feed */

export async function downloadJobs(): Promise<DownloadJob[]> {
  return call(api().download.jobs())
}

export async function cancelDownload(jobId: string): Promise<boolean> {
  return call(api().download.cancel(jobId))
}

export async function retryDownload(jobId: string): Promise<DownloadJob> {
  return call(api().download.retry(jobId))
}

export async function clearFinishedDownloads(): Promise<boolean> {
  return call(api().download.clear())
}

export interface ProgressHandlers {
  onProgress: (payload: DownloadProgress) => void
  onJobFinished: (payload: DownloadJob) => void
}

/**
 * Subscribe to the main-process progress pushes. Returns a single disposer for both
 * channels, so a view that unmounts mid-download cannot leak listeners into the mock bus.
 */
export function subscribeDownloads(handlers: ProgressHandlers): () => void {
  const bridge = api()
  const channel: EventName = EVENTS.progress
  const finished: EventName = EVENTS.jobFinished
  const offProgress = bridge.on(channel, (payload: unknown) => {
    handlers.onProgress(payload as DownloadProgress)
  })
  const offFinished = bridge.on(finished, (payload: unknown) => {
    handlers.onJobFinished(payload as DownloadJob)
  })
  return () => {
    offProgress()
    offFinished()
  }
}

export const jobStatusText: Record<DownloadJob['status'], string> = {
  queued: '排队中',
  running: '下载中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  cancelled: '已取消'
}

export function jobStatusTone(status: DownloadJob['status']): 'tag-success' | 'tag-danger' | 'tag-gold' | '' {
  if (status === 'done') return 'tag-success'
  if (status === 'error') return 'tag-danger'
  if (status === 'cancelled' || status === 'queued' || status === 'paused') return 'tag-gold'
  return ''
}

/** Whether a job is one of the transfers this view can still act on. */
export function jobIsActive(job: DownloadJob): boolean {
  return job.status === 'queued' || job.status === 'running' || job.status === 'paused'
}

export function jobPercent(job: DownloadJob, progress?: DownloadProgress): number {
  if (progress) return Math.max(0, Math.min(100, Math.round(progress.percent)))
  if (job.bytesTotal > 0) return Math.max(0, Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100)))
  if (job.total > 0) return Math.max(0, Math.min(100, Math.round((job.done / job.total) * 100)))
  return 0
}

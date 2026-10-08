/**
 * Download / background-task adapters for the ported KAMUCL views.
 *
 * Upstream pushed one `ProgressEvent` per stage through `IPC_EVENT.progress`; MoucX
 * pushes a `DownloadProgress` per job plus a terminal `DownloadJob` on `job-finished`, so
 * the home view keeps a map of live jobs instead of a single progress slot.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL) — see /THIRD_PARTY_NOTICES.md.
 */
import { EVENTS } from '@shared/ipc'
import type { DownloadJob, DownloadProgress } from '@shared/types'
import { api, call } from './core'

export function downloadJobs(): Promise<DownloadJob[]> {
  return call(api().download.jobs())
}

export function cancelDownload(jobId: string): Promise<boolean> {
  return call(api().download.cancel(jobId))
}

export function retryDownload(jobId: string): Promise<DownloadJob> {
  return call(api().download.retry(jobId))
}

/** Drop every finished job from the main-process registry. */
export function clearDownloads(): Promise<boolean> {
  return call(api().download.clear())
}

export function isLiveJob(job: DownloadJob): boolean {
  return job.status === 'queued' || job.status === 'running' || job.status === 'paused'
}

/** Live progress for the running jobs (`mouc:progress`). */
export function onProgress(handler: (progress: DownloadProgress) => void): () => void {
  return api().on(EVENTS.progress, (payload) => handler(payload as DownloadProgress))
}

/** One-shot terminal notification per job (`mouc:job-finished`). */
export function onJobFinished(handler: (job: DownloadJob) => void): () => void {
  return api().on(EVENTS.jobFinished, (payload) => handler(payload as DownloadJob))
}

/** 0-100, byte-weighted: a file-count percent jumps around while one big jar downloads. */
export function jobPercent(job: DownloadJob, progress?: DownloadProgress): number {
  if (progress && progress.jobId === job.id) return Math.round(progress.percent)
  if (job.bytesTotal > 0) return Math.round((job.bytesDone / job.bytesTotal) * 100)
  if (job.total > 0) return Math.round((job.done / job.total) * 100)
  return 0
}

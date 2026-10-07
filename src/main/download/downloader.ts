/**
 * Download engine. Streams every transfer into `<target>.part`, resumes with
 * Range when it is provably safe, verifies the whole-file sha1, renames
 * atomically and drives per-job progress events.
 */
import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError, cancelled, networkError, notFound } from '@shared/errors'
import type {
  AppErrorPayload,
  DownloadItem,
  DownloadJob,
  DownloadKind,
  DownloadPlan,
  DownloadProgress,
  PathInfo,
  Settings
} from '@shared/types'
import { clamp, percent, sleep, uid } from '@shared/utils'
import * as fsx from '../core/fsx'
import type { DownloadResult, Downloader, HttpClient } from '../core/contracts'
import type { Logger } from '../core/log'
import { candidateUrls } from './mirror'

const RETRY_BASE_MS = 200
const MAX_RETRIES = 3
const PROGRESS_MIN_MS = 100
const PROGRESS_MIN_PERCENT = 0.5
const SPEED_WINDOW_MS = 3000

export interface DownloaderDeps {
  http: HttpClient
  settings: () => Settings
  paths: () => PathInfo
  log: Logger
  onProgress(p: DownloadProgress): void
}

type TransferType = 'fetched' | 'cached' | 'skipped'

interface DedupResult {
  type: TransferType
  bytes: number
}

interface TransferHooks {
  onBytes(delta: number): void
  onRestart(): void
  onSizeKnown(total: number): void
  onLabel(label: string): void
}

interface TransferContext {
  signal: AbortSignal
  hooks: TransferHooks
}

interface ItemState {
  countedBytes: number
  countedTotal: number
}

interface JobRecord {
  job: DownloadJob
  plan: DownloadPlan
  controller: AbortController
  /** item.id -> failure, insertion-ordered; `run()` throws the first one. */
  failures: Map<string, { item: DownloadItem; error: AppError; payload: AppErrorPayload }>
  states: Map<string, ItemState>
  samples: { t: number; b: number }[]
  ema: number
  lastEmitAt: number
  lastPercent: number
  currentLabel: string
  active: boolean
  cancelRequested: boolean
  strictAborted: boolean
  completion: Promise<JobRecord>
  settle: (record: JobRecord) => void
}

const NOOP_HOOKS: TransferHooks = {
  onBytes: () => undefined,
  onRestart: () => undefined,
  onSizeKnown: () => undefined,
  onLabel: () => undefined
}

/** `httpStatusError` keeps the code in its message; we need it for the 404 rule. */
function statusOf(error: unknown): number | undefined {
  if (error instanceof AppError && error.code === 'http-status') {
    const match = /HTTP (\d{3})/.exec(error.message)
    if (match) return Number(match[1])
  }
  return undefined
}

function unlinkQuiet(file: string): Promise<void> {
  return fs.promises.unlink(file).catch(() => undefined)
}

export function createDownloader(deps: DownloaderDeps): Downloader {
  const { http, log } = deps
  const jobs = new Map<string, JobRecord>()
  const transfers = new Map<string, Promise<DedupResult>>()
  const subscribers = new Set<(p: DownloadProgress) => void>()

  /* ----------------------------- core ----------------------------- */

  function resolveTarget(item: DownloadItem): string {
    return path.isAbsolute(item.target)
      ? path.normalize(item.target)
      : path.resolve(deps.paths().gameRoot, item.target)
  }

  function dedupKey(target: string): string {
    return process.platform === 'win32' ? target.toLowerCase() : target
  }

  /** Stream the response body into the `.part` file, reporting byte deltas. */
  async function pipeToPart(
    response: Response,
    part: string,
    append: boolean,
    signal: AbortSignal,
    hooks: TransferHooks
  ): Promise<void> {
    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
    const source = response.body
      ? Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
      : Readable.from([])
    source.on('data', (chunk: Buffer) => hooks.onBytes(chunk.length))
    try {
      await pipeline(source, out)
    } catch (error) {
      // keep the partial `.part` so the next attempt can resume from it
      throw toTransportError(error, signal)
    }
  }

  function toTransportError(error: unknown, signal: AbortSignal): AppError {
    if (signal.aborted) return cancelled('下载请求')
    if (error instanceof AppError) return error
    const code = (error as { code?: string })?.code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || /premature|reset|aborted/i.test(message)) {
      return networkError('下载中断', message)
    }
    if (/terminated/i.test(message)) return networkError('响应提前结束', message)
    return AppError.from(error)
  }

  /**
   * One GET attempt against one candidate URL. Leaves a usable `.part` behind
   * for a later resume (or deletes it when resuming is not possible).
   */
  async function streamOnce(item: DownloadItem, target: string, url: string, ctx: TransferContext): Promise<void> {
    const hooks = ctx.hooks
    const part = `${target}.part`
    const resumeEnabled = deps.settings().resumeDownloads
    let partSize = await fsx.sizeOf(part)

    let resumeFrom = 0
    if (partSize > 0) {
      if (!resumeEnabled) {
        await unlinkQuiet(part)
        partSize = 0
        hooks.onRestart()
      } else if (item.size !== undefined && partSize >= item.size) {
        if (partSize === item.size) {
          // the part already holds every byte; checksum verification follows
          hooks.onSizeKnown(item.size)
          return
        }
        await unlinkQuiet(part)
        partSize = 0
        hooks.onRestart()
      } else {
        const info = await http.head(url, { signal: ctx.signal })
        const expected = info.size
        if (expected !== undefined && expected > 0) {
          hooks.onSizeKnown(expected)
          if (expected === partSize) return
          if (expected < partSize) {
            await unlinkQuiet(part)
            partSize = 0
            hooks.onRestart()
          } else if (info.acceptsRanges) {
            resumeFrom = partSize
          }
        }
        // size unknown or ranges unsupported -> fresh full GET (truncate)
      }
    }

    const headers: Record<string, string> = {}
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`
    const response = await http.fetch(url, { headers, signal: ctx.signal })
    const isPartial = response.status === 206 && resumeFrom > 0
    let writtenFrom = 0
    if (!isPartial && partSize > 0) {
      // server ignored the Range (or we never sent one): rewrite from zero
      hooks.onRestart()
      await unlinkQuiet(part)
    }
    writtenFrom = isPartial ? resumeFrom : 0
    const lenRaw = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(lenRaw) && lenRaw > 0) hooks.onSizeKnown(writtenFrom + lenRaw)
    await pipeToPart(response, part, isPartial, ctx.signal, hooks)
  }

  /** Whole-file sha1 over the `.part`, deleting it on mismatch. */
  async function verifyChecksum(item: DownloadItem, part: string): Promise<boolean> {
    if (!item.sha1) return true
    if (!(await fsx.isFile(part))) return false
    const actual = await fsx.streamSha1(part)
    return actual === item.sha1.toLowerCase()
  }

  /** Full transfer for one URL candidate: stream -> verify -> (one refetch) -> rename. */
  async function fetchVia(item: DownloadItem, target: string, url: string, ctx: TransferContext): Promise<void> {
    const part = `${target}.part`
    for (let checksumAttempt = 0; ; checksumAttempt += 1) {
      await streamOnce(item, target, url, ctx)
      if (await verifyChecksum(item, part)) {
        if (item.size !== undefined) {
          const finalSize = await fsx.sizeOf(part)
          if (finalSize !== item.size) throw networkError('文件大小与预期不符', url)
        }
        if (await fsx.isFile(part)) await fsx.rename(part, target)
        return
      }
      await unlinkQuiet(part)
      ctx.hooks.onRestart()
      if (checksumAttempt >= 1) {
        throw new AppError('checksum-mismatch', '校验失败 (sha1)', url)
      }
      log.warn(`sha1 校验失败，自动重新下载: ${item.label ?? target}`)
    }
  }

  /** Try every candidate once per pass; the caller retries whole passes. */
  async function runPass(item: DownloadItem, target: string, ctx: TransferContext): Promise<void> {
    const candidates = candidateUrls(item.url, item.fallbackUrls, deps.settings().mirrors ?? [])
    let lastError: AppError | undefined
    for (const url of candidates) {
      if (ctx.signal.aborted) throw cancelled('下载请求')
      ctx.hooks.onLabel(item.label ?? path.basename(target))
      try {
        await fetchVia(item, target, url, ctx)
        return
      } catch (error) {
        const app = AppError.from(error)
        if (app.code === 'cancelled') throw app
        lastError = app
      }
    }
    throw lastError ?? networkError('没有可用的下载地址', item.url)
  }

  /**
   * Transfer one item with retries and cross-caller de-duplication on the
   * resolved target path.
   */
  async function transfer(
    item: DownloadItem,
    target: string,
    controller: AbortController,
    hooks: TransferHooks
  ): Promise<DedupResult> {
    const key = dedupKey(target)
    const joined = transfers.get(key)
    if (joined) {
      // shares the owner's bytes; the caller counts the whole file on settle
      return await joined
    }
    const ctx: TransferContext = { signal: controller.signal, hooks }
    const promise = (async (): Promise<DedupResult> => {
      if (!item.overwrite && (await fsx.fileMatches(target, item.sha1, item.size))) {
        return { type: 'cached', bytes: await fsx.sizeOf(target) }
      }
      await fsx.ensureDir(path.dirname(target))
      let attempt = 0
      for (;;) {
        try {
          await runPass(item, target, ctx)
          return { type: 'fetched', bytes: await fsx.sizeOf(target) }
        } catch (error) {
          if (controller.signal.aborted) throw cancelled('下载请求')
          const app = AppError.from(error)
          if (app.code === 'cancelled') throw app
          if (statusOf(app) === 404 && item.optional) {
            return { type: 'skipped', bytes: 0 }
          }
          if (app.retryable && attempt < MAX_RETRIES) {
            attempt += 1
            const delay = RETRY_BASE_MS * 2 ** (attempt - 1)
            log.debug(`第 ${attempt} 次重试 (${delay}ms): ${item.label ?? item.id}`)
            try {
              await sleep(delay, controller.signal)
            } catch {
              throw cancelled('下载请求')
            }
            continue
          }
          throw app
        }
      }
    })()
    transfers.set(key, promise)
    try {
      return await promise
    } finally {
      // only the owner clears the entry; joiners already hold the promise
      if (transfers.get(key) === promise) transfers.delete(key)
    }
  }

  /* --------------------------- progress --------------------------- */

  function computeSpeed(record: JobRecord, now: number): number {
    record.samples.push({ t: now, b: record.job.bytesDone })
    const cutoff = now - SPEED_WINDOW_MS
    while (record.samples.length > 0 && record.samples[0]!.t < cutoff) record.samples.shift()
    const oldest = record.samples[0]!
    const newest = record.samples[record.samples.length - 1]!
    const dt = newest.t - oldest.t
    if (dt <= 0) return record.ema
    const windowSpeed = Math.max(0, (newest.b - oldest.b) / (dt / 1000))
    const alpha = clamp(dt / SPEED_WINDOW_MS, 0.05, 1)
    record.ema = record.ema > 0 ? record.ema + (windowSpeed - record.ema) * alpha : windowSpeed
    return Math.round(record.ema)
  }

  function buildProgress(record: JobRecord): DownloadProgress {
    const job = record.job
    const remaining = Math.max(0, job.bytesTotal - job.bytesDone)
    const speed = computeSpeed(record, Date.now())
    const etaSeconds = speed > 0 && remaining > 0 ? Math.round(remaining / speed) : 0
    const byBytes = job.bytesTotal > 0 ? percent(job.bytesDone, job.bytesTotal) : 0
    const byFiles = job.total > 0 ? percent(job.done + job.skipped + job.failed, job.total) : 0
    return {
      jobId: job.id,
      status: job.status,
      total: job.total,
      done: job.done,
      failed: job.failed,
      bytesTotal: job.bytesTotal,
      bytesDone: job.bytesDone,
      speedBps: speed,
      etaSeconds,
      currentLabel: record.currentLabel,
      currentUrl: undefined,
      percent: job.bytesTotal > 0 ? byBytes : byFiles
    }
  }

  function emit(record: JobRecord, force: boolean): void {
    const now = Date.now()
    const progress = buildProgress(record)
    if (!force) {
      const percentChanged = Math.abs(progress.percent - record.lastPercent) >= PROGRESS_MIN_PERCENT
      if (now - record.lastEmitAt < PROGRESS_MIN_MS && !percentChanged) return
    }
    record.lastEmitAt = now
    record.lastPercent = progress.percent
    for (const handler of [deps.onProgress, ...subscribers]) {
      try {
        handler(progress)
      } catch (error) {
        log.error(`进度回调异常 job=${record.job.id}`, error)
      }
    }
  }

  /* ------------------------- job bookkeeping ----------------------- */

  function itemState(record: JobRecord, item: DownloadItem): ItemState {
    let state = record.states.get(item.id)
    if (!state) {
      state = { countedBytes: 0, countedTotal: item.size ?? 0 }
      record.states.set(item.id, state)
    }
    return state
  }

  function jobHooks(record: JobRecord, item: DownloadItem): TransferHooks {
    const state = itemState(record, item)
    return {
      onBytes: (delta) => {
        state.countedBytes += delta
        record.job.bytesDone += delta
      },
      onRestart: () => {
        record.job.bytesDone = Math.max(0, record.job.bytesDone - state.countedBytes)
        state.countedBytes = 0
      },
      onSizeKnown: (total) => {
        if (total > state.countedTotal) {
          record.job.bytesTotal += total - state.countedTotal
          state.countedTotal = total
        }
      },
      onLabel: (label) => {
        record.currentLabel = label
        emit(record, true)
      }
    }
  }

  function settleItem(record: JobRecord, item: DownloadItem, result: DedupResult): void {
    const state = itemState(record, item)
    const delta = Math.max(0, result.bytes - state.countedBytes)
    state.countedBytes += delta
    record.job.bytesDone += delta
    if (result.type === 'skipped') record.job.skipped += 1
    record.job.done += 1
  }

  function failItem(record: JobRecord, item: DownloadItem, error: AppError): void {
    record.failures.set(item.id, { item, error, payload: error.toPayload() })
    record.job.failed += 1
    if (deps.settings().strictDownload) {
      record.job.error = error.toPayload()
      record.strictAborted = true
      record.controller.abort()
    }
  }

  async function processItem(record: JobRecord, item: DownloadItem): Promise<void> {
    if (record.controller.signal.aborted) return
    const target = resolveTarget(item)
    try {
      const result = await transfer(item, target, record.controller, jobHooks(record, item))
      settleItem(record, item, result)
      emit(record, true)
    } catch (error) {
      const app = AppError.from(error)
      if (app.code === 'cancelled' || record.controller.signal.aborted) return
      log.error(`下载失败 ${item.label ?? item.id}: ${app.message}`, app.detail ?? '')
      failItem(record, item, app)
      emit(record, true)
    }
  }

  function finalize(record: JobRecord): void {
    record.active = false
    const job = record.job
    job.finishedAt = Date.now()
    if (record.cancelRequested) {
      job.status = 'cancelled'
    } else if (record.failures.size > 0) {
      job.status = 'error'
      const first = record.failures.values().next().value
      if (first) job.error = first.payload
    } else {
      job.status = 'done'
    }
    emit(record, true)
    record.settle(record)
  }

  function start(record: JobRecord, items: DownloadItem[]): void {
    record.active = true
    record.job.status = 'running'
    emit(record, true)
    void (async () => {
      const limit = Math.max(1, Math.round(deps.settings().maxConcurrentDownloads || 1))
      let index = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          if (record.controller.signal.aborted) return
          const i = index
          index += 1
          if (i >= items.length) return
          await processItem(record, items[i]!)
        }
      }
      const workers: Promise<void>[] = []
      for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker())
      await Promise.all(workers)
      finalize(record)
    })().catch((error: unknown) => {
      log.error(`任务调度异常 job=${record.job.id}`, error)
      record.active = false
      record.settle(record)
    })
  }

  function createRecord(plan: DownloadPlan): JobRecord {
    const bytesTotal = plan.items.reduce((sum, item) => sum + (item.size ?? 0), 0)
    const record: JobRecord = {
      job: {
        id: uid('job'),
        title: plan.title,
        kind: plan.kind,
        status: 'queued',
        total: plan.items.length,
        done: 0,
        failed: 0,
        skipped: 0,
        bytesTotal,
        bytesDone: 0,
        startedAt: Date.now()
      },
      plan,
      controller: new AbortController(),
      failures: new Map(),
      states: new Map(),
      samples: [{ t: Date.now(), b: 0 }],
      ema: 0,
      lastEmitAt: 0,
      lastPercent: -1,
      currentLabel: plan.title,
      active: false,
      cancelRequested: false,
      strictAborted: false,
      completion: Promise.resolve({}) as Promise<JobRecord>,
      settle: () => undefined
    }
    record.completion = new Promise<JobRecord>((resolve) => {
      record.settle = resolve
    })
    return record
  }

  function snapshot(record: JobRecord): DownloadJob {
    return { ...record.job }
  }

  /* -------------------------- public API --------------------------- */

  const downloader: Downloader = {
    async enqueue(plan: DownloadPlan): Promise<DownloadJob> {
      const record = createRecord(plan)
      jobs.set(record.job.id, record)
      start(record, plan.items)
      return snapshot(record)
    },

    async run(plan: DownloadPlan): Promise<DownloadJob> {
      const record = createRecord(plan)
      jobs.set(record.job.id, record)
      start(record, plan.items)
      const settled = await record.completion
      const first = settled.failures.values().next().value
      if (first) throw first.error
      return snapshot(settled)
    },

    async ensure(item: DownloadItem): Promise<DownloadResult> {
      const target = resolveTarget(item)
      const controller = new AbortController()
      const result = await transfer(item, target, controller, NOOP_HOOKS)
      return { item, fetched: result.type === 'fetched' }
    },

    async ensureMany(items: DownloadItem[], title: string, kind: DownloadKind): Promise<DownloadJob> {
      const record = createRecord({ title, kind, items, after: 'none' })
      jobs.set(record.job.id, record)
      start(record, items)
      const settled = await record.completion
      const first = settled.failures.values().next().value
      if (first) throw first.error
      return snapshot(settled)
    },

    async cancel(jobId: string): Promise<boolean> {
      const record = jobs.get(jobId)
      if (!record || !record.active) return false
      record.cancelRequested = true
      record.job.status = 'cancelled'
      record.job.finishedAt = Date.now()
      record.controller.abort()
      emit(record, true)
      return true
    },

    async retry(jobId: string): Promise<DownloadJob> {
      const record = jobs.get(jobId)
      if (!record) throw notFound('下载任务', jobId)
      if (record.active) return snapshot(record)
      if (record.failures.size === 0) return snapshot(record)
      const failedItems = [...record.failures.values()].map((entry) => entry.item)
      record.job.failed = Math.max(0, record.job.failed - failedItems.length)
      record.failures.clear()
      delete record.job.error
      record.cancelRequested = false
      record.strictAborted = false
      record.controller = new AbortController()
      start(record, failedItems)
      return snapshot(record)
    },

    clear(): void {
      // Finished history only; running/queued jobs stay addressable so cancel still works.
      for (const [id, record] of jobs) {
        if (!record.active) jobs.delete(id)
      }
    },

    jobs(): DownloadJob[] {
      return [...jobs.values()].map(snapshot)
    },

    job(id: string): DownloadJob | undefined {
      const record = jobs.get(id)
      return record ? snapshot(record) : undefined
    },

    failures(id: string): DownloadItem[] {
      const record = jobs.get(id)
      if (!record) return []
      return [...record.failures.values()].map((entry) => entry.item)
    },

    subscribe(handler: (progress: DownloadProgress) => void): () => void {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },

    async cachedBytes(dir: string): Promise<number> {
      const target = dir && dir.length > 0 ? dir : deps.paths().gameRoot
      const stats = await fsx.dirSize(target)
      return stats.bytes
    }
  }

  return downloader
}

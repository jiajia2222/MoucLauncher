import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HeadInfo, HttpClient, HttpInit, Downloader } from '../../src/main/core/contracts'
import type { DownloadJob, DownloadPlan, PathInfo } from '@shared/types'
import type { Settings } from '@shared/types'
import { buildPaths } from '../../src/main/core/paths'
import type { Logger } from '../../src/main/core/log'

const FIXTURES = path.resolve(__dirname, '../fixtures')

export function readFixtureText(rel: string): string {
  return fs.readFileSync(path.join(FIXTURES, rel), 'utf8')
}

export function readFixtureJson<T>(rel: string): T {
  return JSON.parse(readFixtureText(rel)) as T
}

export function readFixtureBuffer(rel: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, rel))
}

/**
 * Stub HttpClient that answers from a URL->value resolver. The resolver returns either a
 * parsed JSON value, a text string, or throws (to simulate an unreachable provider).
 */
export type UrlResolver = (url: string) => unknown

export function makeStubHttp(resolver: UrlResolver): HttpClient {
  const resolve = (url: string): unknown => {
    const out = resolver(url)
    if (out instanceof Error) throw out
    return out
  }
  return {
    async json<T>(url: string): Promise<T> {
      return resolve(url) as T
    },
    async text(url: string): Promise<string> {
      const value = resolve(url)
      return typeof value === 'string' ? value : JSON.stringify(value)
    },
    async buffer(url: string): Promise<Buffer> {
      const value = resolve(url)
      return Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    },
    async head(): Promise<HeadInfo> {
      return { status: 200, acceptsRanges: false }
    },
    async fetch(url: string, _init?: HttpInit): Promise<Response> {
      return new Response(JSON.stringify(resolve(url)), { status: 200 })
    }
  }
}

/** Downloader stub: records plans, resolves jobs immediately, never touches the network. */
export interface RecordingDownloader extends Downloader {
  plans: DownloadPlan[]
}

export function makeFakeJob(plan: DownloadPlan): DownloadJob {
  return {
    id: `job-${plan.title}`,
    title: plan.title,
    kind: plan.kind,
    status: 'done',
    total: plan.items.length,
    done: plan.items.length,
    failed: 0,
    skipped: 0,
    bytesTotal: 0,
    bytesDone: 0,
    startedAt: Date.now()
  }
}

export function makeRecordingDownloader(): RecordingDownloader {
  const plans: DownloadPlan[] = []
  const self: RecordingDownloader = {
    plans,
    async run(plan) {
      plans.push(plan)
      return makeFakeJob(plan)
    },
    async enqueue(plan) {
      plans.push(plan)
      return makeFakeJob(plan)
    },
    async ensure(item) {
      // The test pre-places any file the code must read back (e.g. a Forge installer jar).
      return { item, fetched: true }
    },
    async ensureMany(items, title, kind) {
      const plan: DownloadPlan = { title, kind, items }
      plans.push(plan)
      return makeFakeJob(plan)
    },
    async cancel() {
      return true
    },
    async retry() {
      return makeFakeJob({ title: '', kind: 'misc', items: [] })
    },
    jobs: () => [],
    job: () => undefined,
    failures: () => [],
    subscribe: () => () => undefined,
    clear: () => undefined,
    async cachedBytes() {
      return 0
    }
  }
  return self
}

export function fakeLogger(): Logger {
  const noop = (): void => undefined
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => fakeLogger(), tail: () => [], on: () => noop, close: noop, filePath: () => '', scope: 'test' } as unknown as Logger
}

export function fakeSettings(overrides: Partial<Settings> = {}): { get(): Settings } {
  const base = {
    curseForgeApiKey: '',
    customJavaPath: '',
    modrinthBaseUrl: 'https://api.modrinth.com/v2',
    gameRoot: ''
  } as unknown as Settings
  return { get: () => ({ ...base, ...overrides }) }
}

export interface TempWorkspace {
  appData: string
  gameRoot: string
  paths: PathInfo
  cleanup: () => void
}

export function makeTempWorkspace(prefix = 'mouc'): TempWorkspace {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${prefix}-`))
  const appData = path.join(base, 'appdata')
  const gameRoot = path.join(base, 'gameroot')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(gameRoot, { recursive: true })
  const paths = buildPaths(appData, gameRoot)
  fs.mkdirSync(paths.instancesDir, { recursive: true })
  fs.mkdirSync(path.join(gameRoot, '.mouc'), { recursive: true })
  fs.mkdirSync(path.join(paths.appData, 'logs'), { recursive: true })
  return { appData, gameRoot, paths, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

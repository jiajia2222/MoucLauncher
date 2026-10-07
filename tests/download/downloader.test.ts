import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DownloadItem, DownloadPlan, DownloadProgress, Settings } from '@shared/types'
import { AppError } from '@shared/errors'
import { createHttpClient } from '../../src/main/download/httpClient'
import { createDownloader } from '../../src/main/download/downloader'
import {
  makeLogger,
  makeMirrorRule,
  makePaths,
  makeSettings,
  makeTempDir,
  notFoundResponse,
  serveBuffer,
  startHttpOrigin,
  until,
  type OriginFixture,
  type TempDir
} from './fixtures'

function sha1(content: Buffer): string {
  return createHash('sha1').update(content).digest('hex')
}

interface Harness {
  settingsRef: { current: Settings }
  downloader: ReturnType<typeof createDownloader>
  emissions: DownloadProgress[]
  tmp: TempDir
  cleanup(): Promise<void>
}

function harness(patch: Partial<Settings> = {}): Harness {
  const tmp = makeTempDir()
  const gameRoot = path.join(tmp.dir, 'game')
  fs.mkdirSync(gameRoot, { recursive: true })
  const settingsRef = { current: makeSettings({ gameRoot, ...patch }) }
  const logger = makeLogger(tmp)
  const http = createHttpClient({ settings: () => settingsRef.current, log: logger })
  const emissions: DownloadProgress[] = []
  const downloader = createDownloader({
    http,
    settings: () => settingsRef.current,
    paths: () => makePaths(tmp, settingsRef.current.gameRoot),
    log: logger,
    onProgress: (p) => emissions.push(p)
  })
  return {
    settingsRef,
    downloader,
    emissions,
    tmp,
    async cleanup() {
      logger.close()
      tmp.cleanup()
    }
  }
}

const openFixtures: OriginFixture[] = []

function track(fixture: OriginFixture): OriginFixture {
  openFixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  while (openFixtures.length > 0) await openFixtures.pop()!.close()
})

/** simple file-store origin */
function startStore(files: Map<string, Buffer>): Promise<OriginFixture> {
  return startHttpOrigin((req, res) => {
    const content = files.get(req.url ?? '')
    if (!content) {
      notFoundResponse(res)
      return
    }
    serveBuffer(req, res, content)
  })
}

function item(origin: OriginFixture, name: string, content: Buffer, dir: string, extra: Partial<DownloadItem> = {}): DownloadItem {
  const target = path.join(dir, `${name}.bin`)
  return {
    id: target,
    url: `${origin.origin}/${name}`,
    target,
    sha1: sha1(content),
    size: content.length,
    kind: 'misc',
    label: name,
    ...extra
  }
}

function plan(items: DownloadItem[], title = '测试任务'): DownloadPlan {
  return { title, kind: 'misc', items, after: 'none' }
}

describe('downloader happy paths', () => {
  it('downloads a file, verifies the sha1 and completes the job', async () => {
    const h = harness()
    const content = Buffer.from('minecraft-client-jar-bytes')
    const store = track(await startStore(new Map([['/good', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const result = await h.downloader.run(plan([item(store, 'good', content, dir)]))
    expect(result.status).toBe('done')
    expect(result.done).toBe(1)
    expect(result.bytesDone).toBe(content.length)
    expect(fs.readFileSync(path.join(dir, 'good.bin'))).toEqual(content)
    expect(fs.existsSync(path.join(dir, 'good.bin.part'))).toBe(false)
    expect(store.count('GET', '/good')).toBe(1)
    // no HEAD is issued when there is nothing to resume
    expect(store.count('HEAD', '/good')).toBe(0)
    const final = h.emissions[h.emissions.length - 1]!
    expect(final.status).toBe('done')
    expect(final.percent).toBe(100)
    expect(final.currentLabel).toBe('good')
    await h.cleanup()
  })

  it('ensure() re-fetches once and then reports the file as cached', async () => {
    const h = harness()
    const content = Buffer.alloc(2048, 0x33)
    const store = track(await startStore(new Map([['/once', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const first = await h.downloader.ensure(item(store, 'once', content, dir))
    expect(first.fetched).toBe(true)
    const second = await h.downloader.ensure(item(store, 'once', content, dir))
    expect(second.fetched).toBe(false)
    expect(store.count('GET', '/once')).toBe(1)
    await h.cleanup()
  })

  it('de-duplicates two concurrent requests for the same target', async () => {
    const h = harness()
    const content = Buffer.alloc(4096, 0x7a)
    const store = track(await startStore(new Map([['/dup', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const one = item(store, 'dup', content, dir)
    const [a, b] = await Promise.all([h.downloader.ensure(one), h.downloader.ensure(one)])
    expect(a.fetched).toBe(true)
    expect(b.fetched).toBe(true)
    expect(store.count('GET', '/dup')).toBe(1)
    await h.cleanup()
  })

  it('falls back to fallbackUrls when the primary url 404s', async () => {
    const h = harness()
    const content = Buffer.from('fallback-content')
    const store = track(await startStore(new Map([['/real', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const it = item(store, 'primary', content, dir)
    it.url = `${store.origin}/primary` // 404
    it.fallbackUrls = [`${store.origin}/real`]
    const result = await h.downloader.run(plan([it]))
    expect(result.status).toBe('done')
    expect(fs.readFileSync(path.join(dir, 'primary.bin'))).toEqual(content)
    await h.cleanup()
  })

  it('ensureMany returns a completed job for many items', async () => {
    const h = harness()
    const dir = path.join(h.tmp.dir, 'bulk')
    const files = new Map<string, Buffer>()
    for (let i = 0; i < 5; i += 1) files.set(`/a${i}`, Buffer.from(`asset-${i}`.repeat(10)))
    const store = track(await startStore(files))
    const items = [...files.entries()].map(([urlName, content]) => item(store, urlName.slice(1), content, dir))
    const job = await h.downloader.ensureMany(items, '批量', 'asset')
    expect(job.status).toBe('done')
    expect(job.done).toBe(5)
    await h.cleanup()
  })
})

describe('downloader integrity', () => {
  it('deletes the .part and refetches automatically when the bytes are corrupted', async () => {
    const h = harness()
    const good = Buffer.from('gooddata!')
    const bad = Buffer.from('CORRUPTED')
    let hits = 0
    const store = track(
      await startHttpOrigin((req, res) => {
        if (req.url !== '/tricky' || req.method === 'HEAD') {
          notFoundResponse(res)
          return
        }
        hits += 1
        serveBuffer(req, res, hits === 1 ? bad : good)
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    const result = await h.downloader.run(plan([item(store, 'tricky', good, dir)]))
    expect(result.status).toBe('done')
    expect(hits).toBe(2)
    expect(fs.readFileSync(path.join(dir, 'tricky.bin'))).toEqual(good)
    await h.cleanup()
  })

  it('throws checksum-mismatch when every attempt is corrupted', async () => {
    const h = harness()
    const expected = Buffer.from('gooddata!')
    const store = track(
      await startHttpOrigin((req, res) => {
        serveBuffer(req, res, Buffer.from('bad-bytes'))
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    const error = await h.downloader.run(plan([item(store, 'evil', expected, dir)])).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('checksum-mismatch')
    expect(fs.existsSync(path.join(dir, 'evil.bin'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'evil.bin.part'))).toBe(false)
    expect(store.count('GET', '/evil')).toBe(2) // initial + one automatic refetch
    const job = h.downloader.jobs().at(-1)
    expect(job?.status).toBe('error')
    await h.cleanup()
  })

  it('resumes a torn stream with a Range request and re-checks the whole file', async () => {
    const h = harness()
    const content = Buffer.alloc(5000, 0x42)
    let bigGets = 0
    const store = track(
      await startHttpOrigin((req, res) => {
        const url = req.url ?? ''
        if (url !== '/big') {
          notFoundResponse(res)
          return
        }
        if (req.method === 'HEAD') {
          serveBuffer(req, res, content)
          return
        }
        bigGets += 1
        if (bigGets === 1) {
          // stall mid-stream: headers + first 1000 bytes (flushed), then drop the connection
          res.writeHead(200, { 'content-length': content.length, 'accept-ranges': 'bytes' })
          res.write(content.subarray(0, 1000), () => setTimeout(() => req.socket.destroy(), 30))
          return
        }
        serveBuffer(req, res, content)
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    const result = await h.downloader.run(plan([item(store, 'big', content, dir)]))
    expect(result.status).toBe('done')
    expect(fs.readFileSync(path.join(dir, 'big.bin'))).toEqual(content)
    expect(store.count('HEAD', '/big')).toBe(1)
    const resumed = store.entries('GET', '/big').find((entry) => entry.headers.range)
    expect(resumed?.headers.range).toMatch(/^bytes=\d+-$/)
    expect(result.bytesDone).toBe(content.length)
    await h.cleanup()
  })

  it('does not resume when the server does not accept ranges', async () => {
    const h = harness()
    const content = Buffer.alloc(3000, 0x24)
    const dir = path.join(h.tmp.dir, 'out')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'nores.bin.part'), content.subarray(0, 500))
    let gotRange = false
    const store = track(
      await startHttpOrigin((req, res) => {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-length': content.length, 'accept-ranges': 'none' })
          res.end()
          return
        }
        gotRange = req.headers.range !== undefined
        serveBuffer(req, res, content)
      })
    )
    const result = await h.downloader.run(plan([item(store, 'nores', content, dir)]))
    expect(result.status).toBe('done')
    expect(gotRange).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'nores.bin'))).toEqual(content)
    await h.cleanup()
  })
})

describe('downloader failures', () => {
  it('counts a 404 on an optional item as skipped', async () => {
    const h = harness()
    const content = Buffer.from('present')
    const store = track(await startStore(new Map([['/present', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const optional = item(store, 'missing', content, dir, { optional: true })
    const good = item(store, 'present', content, dir)
    const result = await h.downloader.run(plan([optional, good]))
    expect(result.status).toBe('done')
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    await h.cleanup()
  })

  it('a 404 on a non-optional item is a job error', async () => {
    const h = harness()
    const store = track(await startStore(new Map()))
    const dir = path.join(h.tmp.dir, 'out')
    const error = await h.downloader.run(plan([item(store, 'gone', Buffer.from('x'), dir)])).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('http-status')
    const job = h.downloader.jobs().at(-1)!
    expect(job.status).toBe('error')
    expect(h.downloader.failures(job.id)).toHaveLength(1)
    expect(h.downloader.failures(job.id)[0]?.id).toBe(path.join(dir, 'gone.bin'))
    await h.cleanup()
  })

  it('strictDownload aborts the rest of the job on the first failure', async () => {
    const h = harness({ strictDownload: true, maxConcurrentDownloads: 1 })
    const content = Buffer.from('present')
    const store = track(await startStore(new Map([['/present', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const bad = item(store, 'missing', content, dir)
    bad.url = `${store.origin}/missing`
    const good = item(store, 'present', content, dir)
    await expect(h.downloader.run(plan([bad, good]))).rejects.toBeInstanceOf(AppError)
    expect(store.count('GET', '/present')).toBe(0)
    const job = h.downloader.jobs().at(-1)!
    expect(job.status).toBe('error')
    await h.cleanup()
  })

  it('retries retryable failures with backoff and gives up after three', async () => {
    const h = harness()
    let hits = 0
    const store = track(
      await startHttpOrigin((_req, res) => {
        hits += 1
        res.writeHead(503, { 'content-length': 0 })
        res.end()
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    await expect(h.downloader.run(plan([item(store, 'down', Buffer.from('a'), dir)]))).rejects.toMatchObject({
      code: 'http-status'
    })
    expect(hits).toBe(4) // initial pass + 3 retries
    await h.cleanup()
  })
})

describe('downloader jobs', () => {
  it('never exceeds the configured concurrency', async () => {
    const h = harness({ maxConcurrentDownloads: 2 })
    const files = new Map<string, Buffer>()
    const dir = path.join(h.tmp.dir, 'out')
    for (let i = 0; i < 6; i += 1) files.set(`/slow${i}`, Buffer.alloc(512, i))
    const store = track(
      await startHttpOrigin((req, res) => {
        const content = files.get(req.url ?? '')
        if (!content) {
          notFoundResponse(res)
          return
        }
        setTimeout(() => serveBuffer(req, res, content), 120)
      })
    )
    const items = [...files.keys()].map((key) => {
      const name = key.slice(1)
      return item(store, name, files.get(key)!, dir)
    })
    const job = await h.downloader.run(plan(items))
    expect(job.status).toBe('done')
    expect(job.done).toBe(6)
    expect(store.inflightPeak).toBeGreaterThanOrEqual(2)
    expect(store.inflightPeak).toBeLessThanOrEqual(2)
    await h.cleanup()
  })

  it('cancel marks the job cancelled within a tick and stops new items', async () => {
    const h = harness({ maxConcurrentDownloads: 1 })
    const content = Buffer.from('second')
    const store = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/hold') {
          res.writeHead(200, { 'content-length': 100000 })
          res.write('start!')
          const timer = setInterval(() => undefined, 50)
          res.once('close', () => clearInterval(timer))
          return
        }
        serveBuffer(req, res, content)
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    const held = item(store, 'hold', content, dir)
    held.url = `${store.origin}/hold`
    held.size = undefined
    held.sha1 = undefined
    const queued = item(store, 'second', content, dir)
    const job = await h.downloader.enqueue(plan([held, queued]))
    expect(job.status).not.toBe('done')
    await until(() => store.count('GET', '/hold') === 1, 'hold request')
    const cancelledNow = await h.downloader.cancel(job.id)
    expect(cancelledNow).toBe(true)
    expect(h.downloader.job(job.id)?.status).toBe('cancelled')
    const entry = store.entries('GET', '/hold')[0]!
    await until(() => entry.closed, 'in-flight transfer aborted')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(store.count('GET', '/second')).toBe(0)
    expect(h.downloader.job(job.id)?.status).toBe('cancelled')
    await h.cleanup()
  })

  it('retry re-fetches only the failed items', async () => {
    const h = harness()
    const good = Buffer.from('good-item')
    const fixable = Buffer.from('fixable!')
    let failA = true
    const store = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/a' && failA) {
          notFoundResponse(res)
          return
        }
        const content = req.url === '/a' ? fixable : req.url === '/b' ? good : undefined
        if (!content) {
          notFoundResponse(res)
          return
        }
        serveBuffer(req, res, content)
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    const a = item(store, 'a', fixable, dir)
    const b = item(store, 'b', good, dir)
    const job = await h.downloader.enqueue(plan([a, b]))
    await until(() => h.downloader.job(job.id)?.status === 'error', 'first run fails')
    expect(h.downloader.failures(job.id).map((f) => f.id)).toEqual([path.join(dir, 'a.bin')])
    expect(h.downloader.job(job.id)?.done).toBe(1)
    failA = false
    await h.downloader.retry(job.id)
    await until(() => h.downloader.job(job.id)?.status === 'done', 'retry succeeds', 15000)
    expect(store.count('GET', '/b')).toBe(1) // never re-requested
    expect(store.count('GET', '/a')).toBe(2) // 404 then the successful retry
    expect(h.downloader.failures(job.id)).toHaveLength(0)
    await h.cleanup()
  })

  it('throttles progress below the per-chunk rate', async () => {
    const h = harness()
    const chunk = Buffer.alloc(100, 0x31)
    const total = chunk.length * 1000
    const store = track(
      await startHttpOrigin((_req, res) => {
        res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes' })
        for (let i = 0; i < 1000; i += 1) res.write(chunk)
        res.end()
      })
    )
    const dir = path.join(h.tmp.dir, 'out')
    const content = Buffer.concat(Array.from({ length: 1000 }, () => chunk))
    const result = await h.downloader.run(plan([item(store, 'stream', content, dir)]))
    expect(result.status).toBe('done')
    expect(result.bytesDone).toBe(total)
    expect(h.emissions.length).toBeGreaterThan(3)
    expect(h.emissions.length).toBeLessThan(1000)
    const last = h.emissions[h.emissions.length - 1]!
    expect(last.percent).toBe(100)
    expect(last.speedBps).toBeGreaterThanOrEqual(0)
    await h.cleanup()
  })

  it('cachedBytes sums the bytes under a directory via fsx.dirSize', async () => {
    const h = harness()
    const dir = path.join(h.tmp.dir, 'stats')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'one.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(dir, 'sub', 'two.bin'), Buffer.alloc(24))
    expect(await h.downloader.cachedBytes(dir)).toBe(1024)
    await h.cleanup()
  })

  it('supports subscribe / unsubscribe for progress', async () => {
    const h = harness()
    const content = Buffer.from('observable')
    const store = track(await startStore(new Map([['/obs', content]])))
    const dir = path.join(h.tmp.dir, 'out')
    const seen: DownloadProgress[] = []
    const unsubscribe = h.downloader.subscribe((p) => seen.push(p))
    await h.downloader.run(plan([item(store, 'obs', content, dir)]))
    unsubscribe()
    expect(seen.length).toBeGreaterThan(0)
    const before = seen.length
    await h.downloader.ensure(item(store, 'obs', content, dir)) // cached, no new traffic
    expect(seen.length).toBe(before)
    await h.cleanup()
  })

  it('downloads through a mirror rule that 500s, falling back to the official url', async () => {
    const h = harness()
    const content = Buffer.from('library-jar-bytes')
    const official = track(await startStore(new Map([['/lib', content]])))
    const mirror = track(
      await startHttpOrigin((_req, res) => {
        res.writeHead(500, { 'content-length': 0 })
        res.end()
      })
    )
    h.settingsRef.current = makeSettings({
      gameRoot: h.settingsRef.current.gameRoot,
      mirrors: [makeMirrorRule({ [`127.0.0.1:${official.port}`]: `127.0.0.1:${mirror.port}` })]
    })
    const dir = path.join(h.tmp.dir, 'out')
    const result = await h.downloader.run(plan([item(official, 'lib', content, dir, { label: 'lib.jar' })]))
    expect(result.status).toBe('done')
    // the mirror must have been tried first; the official url rescued the item
    expect(mirror.count('GET', '/lib')).toBe(1)
    expect(official.count('GET', '/lib')).toBe(1)
    expect(mirror.log[0]!.at).toBeLessThanOrEqual(official.log[0]!.at)
    expect(fs.readFileSync(path.join(dir, 'lib.bin'))).toEqual(content)
    await h.cleanup()
  })
})

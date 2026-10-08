import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Settings } from '@shared/types'
import { AppError } from '@shared/errors'
import { createHttpClient } from '../../src/main/download/httpClient'
import {
  makeLogger,
  makeSettings,
  makeTempDir,
  notFoundResponse,
  serveBuffer,
  startHttpOrigin,
  startHttpsOrigin,
  startProxy,
  until,
  type OriginFixture,
  type ProxyFixture,
  type TempDir
} from './fixtures'

const openFixtures: (OriginFixture | ProxyFixture)[] = []
const tempDirs: TempDir[] = []

function harness(proxyUrl = ''): { settings: { current: Settings }; http: ReturnType<typeof createHttpClient>; tmp: TempDir } {
  const tmp = makeTempDir()
  tempDirs.push(tmp)
  const settings = { current: makeSettings({ proxyUrl }) }
  const http = createHttpClient({ settings: () => settings.current, log: makeLogger(tmp) })
  return { settings, http, tmp }
}

function track<T extends OriginFixture | ProxyFixture>(fixture: T): T {
  openFixtures.push(fixture)
  return fixture
}

beforeAll(() => {
  // self-signed fixture certificate
  process.env.MOUCX_TLS_INSECURE = '1'
})

afterAll(() => {
  delete process.env.MOUCX_TLS_INSECURE
})

afterEach(async () => {
  while (openFixtures.length > 0) await openFixtures.pop()!.close()
  tempDirs.pop()?.cleanup()
})

describe('httpClient basics', () => {
  it('GETs text/json/buffer with the launcher user agent and identity encoding', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/text') res.end('hello')
        else if (req.url === '/json') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, n: 7 }))
        } else if (req.url === '/bin') serveBuffer(req, res, Buffer.from([1, 2, 3, 4]))
        else notFoundResponse(res)
      })
    )
    const { http } = harness()
    expect(await http.text(`${origin.origin}/text`)).toBe('hello')
    expect(await http.json<{ ok: boolean; n: number }>(`${origin.origin}/json`)).toEqual({ ok: true, n: 7 })
    expect([...(await http.buffer(`${origin.origin}/bin`))]).toEqual([1, 2, 3, 4])
    const seen = origin.log[0]!.headers
    // Read from package.json rather than a literal: the shipped User-Agent is built from a
    // version constant that has to be kept in sync by hand, and silent drift there has
    // already broken a release once.
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
    expect(seen['user-agent']).toBe(`MoucX/${pkg.version}`)
    expect(seen['accept-encoding']).toBe('identity')
  })

  it('POSTs a body and reads the echo back', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => res.end(Buffer.concat(chunks)))
      })
    )
    const { http } = harness()
    expect(await http.text(`${origin.origin}/echo`, { method: 'POST', body: 'ping' })).toBe('ping')
  })

  it('throws http-status AppErrors on 4xx/5xx with retryable flags', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/gone') notFoundResponse(res)
        else {
          res.writeHead(503, { 'content-length': 0 })
          res.end()
        }
      })
    )
    const { http } = harness()
    await expect(http.text(`${origin.origin}/gone`)).rejects.toMatchObject({
      name: 'AppError',
      code: 'http-status',
      retryable: false
    })
    const error = await http.buffer(`${origin.origin}/boom`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).message).toContain('HTTP 503')
    expect((error as AppError).retryable).toBe(true)
  })

  it('follows up to 5 redirect hops manually', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        const match = /^\/h(\d)$/.exec(req.url ?? '')
        if (match && Number(match[1]) < 4) {
          res.writeHead(302, { location: `/h${Number(match[1]) + 1}`, 'content-length': 0 })
          res.end()
        } else if (match && Number(match[1]) === 4) {
          res.writeHead(301, { location: '/final', 'content-length': 0 })
          res.end()
        } else res.end('arrived')
      })
    )
    const { http } = harness()
    expect(await http.text(`${origin.origin}/h0`)).toBe('arrived')
    expect(origin.log.map((entry) => entry.url)).toEqual(['/h0', '/h1', '/h2', '/h3', '/h4', '/final'])
  })

  it('gives up after more than 5 hops', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        const n = Number((req.url ?? '').slice(3))
        res.writeHead(302, { location: `/step/${n + 1}`, 'content-length': 0 })
        res.end()
      })
    )
    const { http } = harness()
    const error = await http.text(`${origin.origin}/step/0`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('network')
    expect((error as AppError).message).toContain('重定向')
  })

  it('returns the 3xx untouched when redirect is disabled', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/one') {
          res.writeHead(302, { location: '/two', 'content-length': 0 })
          res.end()
        } else res.end('two')
      })
    )
    const { http } = harness()
    const response = await http.fetch(`${origin.origin}/one`, { redirect: false })
    expect(response.status).toBe(302)
    expect(origin.count('GET', '/one')).toBe(1)
  })

  it('re-applies the Range header across a redirect', async () => {
    const content = Buffer.from('0123456789'.repeat(10))
    const origin = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/move') {
          res.writeHead(302, { location: '/file', 'content-length': 0 })
          res.end()
        } else serveBuffer(req, res, content, { etag: '"v1"' })
      })
    )
    const { http } = harness()
    const body = await http.buffer(`${origin.origin}/move`, { headers: { Range: 'bytes=4-9' } })
    expect(body.toString()).toBe('456789')
    const final = origin.entries('GET', '/file')[0]!
    expect(final.headers.range).toBe('bytes=4-9')
  })

  it('head() reports size, etag and accept-ranges without throwing on 404', async () => {
    const content = Buffer.alloc(1234, 0x61)
    const origin = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/file') serveBuffer(req, res, content, { etag: '"abc"' })
        else notFoundResponse(res)
      })
    )
    const { http } = harness()
    const info = await http.head(`${origin.origin}/file`)
    expect(info.status).toBe(200)
    expect(info.size).toBe(1234)
    expect(info.etag).toBe('"abc"')
    expect(info.acceptsRanges).toBe(true)
    const missing = await http.head(`${origin.origin}/gone`)
    expect(missing.status).toBe(404)
    expect(missing.acceptsRanges).toBe(false)
  })

  it('honours an already-aborted signal and a mid-stream abort', async () => {
    const origin = track(
      await startHttpOrigin((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('first ')
        // keep the response open; only a client abort ends it
        const timer = setInterval(() => res.write('.'), 30)
        res.once('close', () => clearInterval(timer))
      })
    )
    const { http } = harness()
    const pre = new AbortController()
    pre.abort()
    await expect(http.text(`${origin.origin}/stream`, { signal: pre.signal })).rejects.toMatchObject({
      code: 'cancelled'
    })
    const mid = new AbortController()
    const pending = http.text(`${origin.origin}/stream`, { signal: mid.signal })
    await until(() => origin.count('GET', '/stream') >= 1, 'stream request')
    mid.abort()
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('cancelled')
  })

  it('rejects with a retryable network error on timeout', async () => {
    const origin = track(
      await startHttpOrigin(() => {
        /* never respond on purpose */
      })
    )
    const { http } = harness()
    const error = await http.text(`${origin.origin}/silence`, { timeoutMs: 200 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('network')
    expect((error as AppError).retryable).toBe(true)
  })
})

describe('httpClient proxy', () => {
  it('tunnels https targets through a real CONNECT proxy', async () => {
    const origin = track(
      await startHttpsOrigin((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ secure: true }))
      })
    )
    const proxy = track(await startProxy())
    const { http } = harness(proxy.proxyUrl)
    const data = await http.json<{ secure: boolean }>(`${origin.origin}/secret`)
    expect(data).toEqual({ secure: true })
    expect(proxy.connects).toHaveLength(1)
    expect(proxy.connects[0]!.target).toBe(`127.0.0.1:${origin.port}`)
    expect(proxy.connects[0]!.established).toBe(true)
    expect(origin.count('GET', '/secret')).toBe(1)
  })

  it('sends Basic proxy auth parsed from the proxy URL userinfo', async () => {
    const origin = track(await startHttpsOrigin((_req, res) => res.end('ok')))
    const proxy = track(await startProxy({ auth: 'jiamou:s3cret' }))
    const { http } = harness(`http://jiamou:s3cret@127.0.0.1:${proxy.port}`)
    expect(await http.text(`${origin.origin}/authed`)).toBe('ok')
    const seen = proxy.connects[0]!.headers['proxy-authorization']
    const expected = `Basic ${Buffer.from('jiamou:s3cret', 'utf8').toString('base64')}`
    expect(seen).toBe(expected)
  })

  it('fails with a network error when the proxy rejects CONNECT', async () => {
    const origin = track(await startHttpsOrigin((_req, res) => res.end('ok')))
    const proxy = track(await startProxy({ auth: 'need:user' }))
    const { http } = harness(proxy.proxyUrl) // no credentials configured
    const error = await http.text(`${origin.origin}/nope`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('network')
    expect((error as AppError).message).toContain('407')
  })

  it('forwards plain http targets as absolute-URI requests', async () => {
    const origin = track(
      await startHttpOrigin((req, res) => {
        if (req.url === '/plain') res.end('plaintext')
        else notFoundResponse(res)
      })
    )
    const proxy = track(await startProxy())
    const { http } = harness(proxy.proxyUrl)
    expect(await http.text(`${origin.origin}/plain`)).toBe('plaintext')
    expect(proxy.log).toHaveLength(1)
    expect(proxy.log[0]!.url).toBe(`${origin.origin}/plain`)
    expect(origin.count('GET', '/plain')).toBe(1)
  })

  it('works without a proxy against https and http origins (direct mode)', async () => {
    const httpsOrigin = track(await startHttpsOrigin((_req, res) => res.end('direct-tls')))
    const httpOrigin = track(await startHttpOrigin((_req, res) => res.end('direct-plain')))
    const { http } = harness('')
    expect(await http.text(`${httpsOrigin.origin}/t`)).toBe('direct-tls')
    expect(await http.text(`${httpOrigin.origin}/t`)).toBe('direct-plain')
  })

  it('resumes a download over the tunnel with a Range header', async () => {
    const content = Buffer.from('abcdefghij'.repeat(8))
    const origin = track(
      await startHttpsOrigin((req, res) => {
        if (req.url === '/resume') serveBuffer(req, res, content)
        else notFoundResponse(res)
      })
    )
    const proxy = track(await startProxy())
    const { http } = harness(proxy.proxyUrl)
    const body = await http.buffer(`${origin.origin}/resume`, { headers: { Range: 'bytes=50-' } })
    expect(body.length).toBe(content.length - 50)
    expect(body.toString()).toBe(content.subarray(50).toString())
    expect(origin.entries('GET', '/resume')[0]!.headers.range).toBe('bytes=50-')
    expect(proxy.connects.length).toBeGreaterThanOrEqual(1)
  })
})

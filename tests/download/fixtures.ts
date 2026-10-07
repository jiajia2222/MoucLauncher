/**
 * Offline test fixtures: a node:http/https origin with Range support, a
 * hand-rolled HTTP proxy (absolute-form forwarding + CONNECT tunneling),
 * temp dirs, and settings/logger helpers. Everything binds 127.0.0.1:0.
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SETTINGS_VERSION } from '@shared/types'
import type { DownloadItem, MirrorRule, Settings } from '@shared/types'
import { buildPaths } from '../../src/main/core/paths'
import { Logger } from '../../src/main/core/log'

export interface ReqEntry {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  at: number
  closed: boolean
}

export type OriginHandler = (req: http.IncomingMessage, res: http.ServerResponse, entry: ReqEntry) => void

export interface OriginFixture {
  port: number
  origin: string
  log: ReqEntry[]
  inflight: number
  inflightPeak: number
  count(method: string, urlPath: string): number
  entries(method: string, urlPath: string): ReqEntry[]
  close(): Promise<void>
}

function attach(server: http.Server | https.Server, handler: OriginHandler): OriginFixture {
  const fixture: Omit<OriginFixture, 'count' | 'entries' | 'close'> = {
    port: 0,
    origin: '',
    log: [],
    inflight: 0,
    inflightPeak: 0
  }
  const full: OriginFixture = Object.assign(fixture as OriginFixture, {
    count(method: string, urlPath: string): number {
      return full.log.filter((entry) => entry.method === method && entry.url === urlPath).length
    },
    entries(method: string, urlPath: string): ReqEntry[] {
      return full.log.filter((entry) => entry.method === method && entry.url === urlPath)
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
    }
  })
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('request', (req, res) => {
    const entry: ReqEntry = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      at: Date.now(),
      closed: false
    }
    full.log.push(entry)
    full.inflight += 1
    full.inflightPeak = Math.max(full.inflightPeak, full.inflight)
    res.once('close', () => {
      entry.closed = true
      full.inflight -= 1
    })
    handler(req, res, entry)
  })
  return full
}

export async function startHttpOrigin(handler: OriginHandler): Promise<OriginFixture> {
  const server = http.createServer()
  const fixture = attach(server, handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  fixture.port = address.port
  fixture.origin = `http://127.0.0.1:${address.port}`
  return fixture
}

const here = path.dirname(fileURLToPath(import.meta.url))

export async function startHttpsOrigin(handler: OriginHandler): Promise<OriginFixture> {
  const server = https.createServer({
    key: fs.readFileSync(path.join(here, 'fixtures/server-key.pem')),
    cert: fs.readFileSync(path.join(here, 'fixtures/server-cert.pem'))
  })
  const fixture = attach(server, handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  fixture.port = address.port
  fixture.origin = `https://127.0.0.1:${address.port}`
  return fixture
}

/** Serves `content` with proper HEAD/Range support when `range` is enabled. */
export function serveBuffer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  content: Buffer,
  opts: { range?: boolean; etag?: string } = {}
): void {
  const total = content.length
  const head = req.method === 'HEAD'
  const extra: Record<string, string> = {}
  if (opts.etag) extra.ETag = opts.etag
  const rangeHeader = opts.range === false ? undefined : req.headers.range
  const match = typeof rangeHeader === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(rangeHeader) : null
  if (match) {
    const start = Number(match[1])
    const rawEnd = match[2] && match[2].length > 0 ? Number(match[2]) : total - 1
    if (start >= total || rawEnd < start) {
      res.writeHead(416, { 'content-range': `bytes */${total}`, ...extra })
      res.end()
      return
    }
    const end = Math.min(rawEnd, total - 1)
    const chunk = content.subarray(start, end + 1)
    res.writeHead(206, {
      'content-length': chunk.length,
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      ...extra
    })
    res.end(head ? undefined : chunk)
    return
  }
  res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes', ...extra })
  res.end(head ? undefined : content)
}

export function notFoundResponse(res: http.ServerResponse): void {
  res.writeHead(404, { 'content-length': 0 })
  res.end()
}

/* ----------------------------- proxy ----------------------------- */

export interface ConnectEntry {
  target: string
  headers: http.IncomingHttpHeaders
  established: boolean
}

export interface ProxyFixture {
  port: number
  proxyUrl: string
  connects: ConnectEntry[]
  log: ReqEntry[]
  inflightPeak: number
  close(): Promise<void>
}

/**
 * Real-enough proxy for tests: absolute-form http forwarding plus CONNECT
 * tunneling. When `auth` is given (as `user:pass`) every request must carry the
 * matching Basic Proxy-Authorization header or it is rejected with 407.
 */
export async function startProxy(opts: { auth?: string } = {}): Promise<ProxyFixture> {
  const expected = opts.auth ? `Basic ${Buffer.from(opts.auth, 'utf8').toString('base64')}` : undefined
  const sockets = new Set<net.Socket>()
  const fixture: ProxyFixture = {
    port: 0,
    proxyUrl: '',
    connects: [],
    log: [],
    inflightPeak: 0,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
    }
  }
  const server = http.createServer((req, res) => {
    const entry: ReqEntry = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      at: Date.now(),
      closed: false
    }
    fixture.log.push(entry)
    const absolute = /^https?:\/\//.test(entry.url)
    if (!absolute) {
      res.writeHead(400)
      res.end()
      return
    }
    if (expected && req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'content-length': 0 })
      res.end()
      return
    }
    const target = new URL(entry.url)
    const upstream = http.request(
      {
        agent: false,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: entry.method,
        headers: { ...req.headers, host: target.host }
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502, { 'content-length': 0 })
      res.end()
    })
    req.pipe(upstream)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? ''
    const entry: ConnectEntry = { target, headers: { ...req.headers }, established: false }
    fixture.connects.push(entry)
    if (expected && req.headers['proxy-authorization'] !== expected) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const [host, portRaw] = target.split(':')
    const upstream = net.connect(Number(portRaw ?? 443), host ?? '127.0.0.1')
    upstream.once('connect', () => {
      entry.established = true
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.once('error', () => clientSocket.destroy())
    clientSocket.once('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  fixture.port = address.port
  fixture.proxyUrl = `http://127.0.0.1:${address.port}`
  return fixture
}

/* --------------------------- environment --------------------------- */

export interface TempDir {
  dir: string
  cleanup(): void
}

export function makeTempDir(): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-dl-'))
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4 })
      } catch {
        /* windows lock; ignore */
      }
    }
  }
}

export function makeSettings(patch: Partial<Settings> = {}): Settings {
  const base: Settings = {
    settingsVersion: SETTINGS_VERSION,
    language: 'zh-CN',
    theme: 'dark',
    gameRoot: path.join(os.tmpdir(), 'mouc-dl-game'),
    maxConcurrentDownloads: 4,
    resumeDownloads: true,
    strictDownload: false,
    mirrors: [],
    javaMode: 'adoptium',
    customJavaPath: '',
    javaScanDirs: [],
    defaultMemoryMb: 4096,
    defaultResolution: { width: 854, height: 480, fullscreen: false },
    extraJvmArgs: '',
    closeAction: 'ask',
    showGameConsole: true,
    hideOnLaunch: false,
    curseForgeApiKey: '',
    modrinthBaseUrl: 'https://api.modrinth.com/v2',
    relayServerUrl: '',
    proxyUrl: '',
    microsoftClientId: '',
    autoCheckUpdate: true,
    lastSeenVersion: ''
  }
  return { ...base, ...patch }
}

/** Log files live outside the per-test temp dirs; the Logger stream would race dir deletion. */
const persistentLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-dl-logs-'))

export function makeLogger(_tmp?: TempDir): Logger {
  return new Logger('test-download', path.join(persistentLogRoot, 'logs'))
}

export function makePaths(tmp: TempDir, gameRoot: string): ReturnType<typeof buildPaths> {
  return buildPaths(path.join(tmp.dir, 'appdata'), gameRoot)
}

export function makeMirrorRule(hosts: Record<string, string>, priority = 1, enabled = true): MirrorRule {
  return { id: `rule-${priority}`, label: `rule ${priority}`, enabled, hosts, priority }
}

export function makeItem(url: string, target: string, content?: Buffer, extra: Partial<DownloadItem> = {}): DownloadItem {
  const item: DownloadItem = {
    id: target,
    url,
    target,
    kind: 'misc',
    ...extra
  }
  if (content) {
    item.sha1 = createHash('sha1').update(content).digest('hex')
    item.size = content.length
  }
  return item
}

export async function until(check: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
  const startAt = Date.now()
  while (!check()) {
    if (Date.now() - startAt > timeoutMs) throw new Error(`until timed out: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

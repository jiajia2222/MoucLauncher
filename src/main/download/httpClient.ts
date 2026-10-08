/**
 * Main-process HTTP transport built ONLY on node:http / node:https / node:net /
 * node:tls. Electron's main process cannot import `undici`/ProxyAgent, so proxy
 * support is hand-rolled: absolute-form requests for http targets, and a
 * CONNECT tunnel (node:net) followed by tls.connect for https targets.
 *
 * Guarantees:
 *  - `Accept-Encoding: identity` everywhere so byte accounting stays exact.
 *  - `User-Agent: MoucX/<version>`.
 *  - Manual redirect following, max 5 hops, so Range headers survive redirects.
 *  - 4xx/5xx throw `httpStatusError(status, url)` (head() reports instead).
 *  - AbortSignal honoured during connect, tunnel, headers and body streaming.
 *
 * Test hook: setting `MOUCX_TLS_INSECURE=1` disables TLS verification so the
 * offline test-suite can use a self-signed fixture certificate. Never set it
 * in production.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { DEFAULT_SETTINGS_CONST } from '@shared/constants'
import { AppError, cancelled, httpStatusError, networkError } from '@shared/errors'
import type { Settings } from '@shared/types'
import type { HeadInfo, HttpClient, HttpInit } from '../core/contracts'
import type { Logger } from '../core/log'

const MAX_REDIRECT_HOPS = 5
/** Short OPEN-tunnel read window; a dead tunnel is still caught by the TLS handshake. */
const LIVENESS_PROBE_MS = 250
/** Keep in sync with package.json; the frozen factory signature cannot read appInfo. */
const APP_VERSION = '1.1.0'
const TLS_INSECURE_ENV = 'MOUCX_TLS_INSECURE'

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Resolves on `connect`/`secureConnect`; all listeners are removed on the first signal. */
function socketEstablished(socket: net.Socket | tls.TLSSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeListener('connect', onOk)
      socket.removeListener('secureConnect', onOk)
      socket.removeListener('error', onErr)
      socket.removeListener('close', onClosed)
    }
    const onOk = (): void => {
      cleanup()
      resolve()
    }
    const onErr = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClosed = (): void => {
      cleanup()
      reject(new Error('socket closed'))
    }
    socket.once('connect', onOk)
    socket.once('secureConnect', onOk)
    socket.once('error', onErr)
    socket.once('close', onClosed)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string, url: string, cleanup?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup?.()
      reject(networkError(message, url))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function parseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw networkError(`无效的地址: ${url}`, url)
  }
}

function portOf(target: URL, isHttps: boolean): number {
  if (target.port) return Number(target.port)
  return isHttps ? 443 : 80
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function errorNodeCode(error: unknown): string {
  return (error as { code?: string } | undefined)?.code ?? ''
}

function sanitizeStatusText(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return /^[\x20-\x7e\x80-\xff]*$/.test(raw) ? raw : undefined
}

interface ProxyConfig {
  host: string
  port: number
  /** base64 of `user:pass` when userinfo is present. */
  basic?: string
}

function parseProxy(proxyUrl: string): ProxyConfig | undefined {
  const raw = proxyUrl.trim()
  if (raw.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return undefined
  }
  const host = parsed.hostname
  if (!host) return undefined
  const port = parsed.port ? Number(parsed.port) : 80
  const config: ProxyConfig = { host, port }
  if (parsed.username) {
    const userinfo = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
    config.basic = Buffer.from(userinfo, 'utf8').toString('base64')
  }
  return config
}

/** Maps low-level failures into the shared AppError taxonomy. */
function toAppError(error: unknown, url: string, signal?: AbortSignal): AppError {
  if (error instanceof AppError) return error
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled('下载请求')
  const code = errorNodeCode(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || message.includes('aborted')) {
    return networkError('连接被中断', url)
  }
  if (code.startsWith('ECONN') || code.startsWith('ETIMEDOUT') || code.startsWith('ENOTFOUND') || code === 'EPIPE') {
    return networkError(`无法连接 (${code})`, url)
  }
  if (error instanceof Error && (error.name === 'TypeError' || /fetch failed/i.test(message))) {
    return networkError(message, url)
  }
  return AppError.from(error)
}

/* ------------------------------------------------------------------ */
/* factory                                                             */
/* ------------------------------------------------------------------ */

export interface HttpClientDeps {
  settings: () => Settings
  log: Logger
  /** Sent in the User-Agent; defaults to the version this file was built against. */
  version?: string
}

export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const { settings, log } = deps
  const version = deps.version ?? APP_VERSION
  /**
   * Test-only escape hatch for the offline suite's self-signed fixture cert, and it
   * is clamped to loopback: a stray env var in a user's shell must never disable
   * verification of a real download host.
   */
  const insecureTls = (host: string): boolean =>
    process.env[TLS_INSECURE_ENV] === '1' && (host === '127.0.0.1' || host === 'localhost' || host === '::1')

  const readTimeout = (): number => DEFAULT_SETTINGS_CONST.defaultReadTimeoutMs
  const connectTimeout = (): number => DEFAULT_SETTINGS_CONST.defaultConnectTimeoutMs

  function currentProxy(): ProxyConfig | undefined {
    return parseProxy(settings().proxyUrl ?? '')
  }

  function baseHeaders(init: HttpInit | undefined, proxy: ProxyConfig | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': `MoucX/${version}`,
      'Accept-Encoding': 'identity'
    }
    if (proxy?.basic) headers['Proxy-Authorization'] = `Basic ${proxy.basic}`
    for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key] = value
    return headers
  }

  /* --------------------------- tunnel ---------------------------- */

  /**
   * Read a little without committing: an OPEN socket answers nothing, so we wait
   * for a bounded idle window (errors are captured, then re-checked and surfaced)
   * before handing the socket to tls.connect.
   */
  async function probeSocketLiveness(socket: net.Socket, target: URL, signal: AbortSignal): Promise<void> {
    let tunnelError: Error | undefined
    const onErr = (error: Error): void => {
      tunnelError = error
    }
    socket.on('error', onErr)
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          socket.removeListener('timeout', onTimeout)
          signal.removeEventListener('abort', onAbort)
        }
        const onTimeout = (): void => {
          cleanup()
          resolve()
        }
        const onAbort = (): void => {
          cleanup()
          reject(cancelled('下载请求'))
        }
        if (signal.aborted) {
          reject(cancelled('下载请求'))
          return
        }
        socket.setTimeout(LIVENESS_PROBE_MS, onTimeout)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    } finally {
      socket.setTimeout(0)
      socket.removeListener('error', onErr)
    }
    if (tunnelError) throw networkError('代理隧道已断开', target.href)
    socket.once('error', () => {
      /* placeholder; the request itself reports the failure */
    })
    socket.resume()
  }

  async function openTunnel(
    target: URL,
    proxy: ProxyConfig,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<tls.TLSSocket> {
    const port = portOf(target, true)
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    const abort = (): void => {
      socket.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    let buffered = Buffer.alloc(0)
    try {
      await withTimeout(
        socketEstablished(socket),
        connectTimeout(),
        '代理连接超时',
        `${proxy.host}:${proxy.port}`,
        () => socket.destroy()
      )
      if (signal.aborted) throw cancelled('下载请求')
      socket.write(
        `CONNECT ${target.hostname}:${port} HTTP/1.1\r\n` +
          `Host: ${target.hostname}:${port}\r\n` +
          (headers['Proxy-Authorization'] ? `Proxy-Authorization: ${headers['Proxy-Authorization']}\r\n` : '') +
          '\r\n'
      )
      const response = await withTimeout(
        new Promise<Buffer>((resolve, reject) => {
          const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk])
            const end = buffered.indexOf('\r\n\r\n')
            if (end >= 0) {
              socket.removeListener('data', onData)
              socket.removeListener('error', onErr)
              resolve(buffered.subarray(0, end + 4))
              if (buffered.length > end + 4) socket.push(buffered.subarray(end + 4))
              return
            }
            if (buffered.length > 16384) {
              socket.removeListener('data', onData)
              socket.removeListener('error', onErr)
              reject(networkError('代理 CONNECT 响应异常', target.href))
            }
          }
          const onErr = (error: Error): void => {
            socket.removeListener('data', onData)
            reject(toAppError(error, target.href, signal))
          }
          socket.on('data', onData)
          socket.once('error', onErr)
        }),
        connectTimeout(),
        '代理 CONNECT 超时',
        `${proxy.host}:${proxy.port}`,
        () => socket.destroy()
      )
      const statusLine = response.toString('latin1').split('\r\n')[0] ?? ''
      const status = Number(statusLine.split(' ')[1] ?? '0')
      if (status !== 200) {
        throw networkError(`代理 CONNECT 失败 (HTTP ${status})`, `${proxy.host}:${proxy.port}`)
      }
      await probeSocketLiveness(socket, target, signal)
      const secure = tls.connect({
        socket,
        // SNI needs a hostname; raw IPs must not send one.
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        rejectUnauthorized: !insecureTls(target.hostname)
      })
      await withTimeout(
        socketEstablished(secure),
        connectTimeout() * 2,
        '代理 TLS 握手超时',
        target.href,
        () => secure.destroy()
      )
      secure.setTimeout(0)
      return secure
    } catch (error) {
      // destroying the raw socket tears down any tls socket wrapping it as well
      socket.destroy()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /* --------------------------- request --------------------------- */

  /** One request, one hop. Resolves with the raw IncomingMessage. */
  async function sendOnce(url: string, init: HttpInit): Promise<http.IncomingMessage> {
    const target = parseUrl(url)
    const signal = init.signal ?? new AbortController().signal
    if (init.signal?.aborted) throw cancelled('下载请求')
    const method = init.method ?? 'GET'
    const proxy = currentProxy()
    const headers = baseHeaders(init, proxy)
    const body = init.body
    if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body))
    const timeoutMs = init.timeoutMs ?? readTimeout()

    const isHttps = target.protocol === 'https:'
    let socket: tls.TLSSocket | undefined
    if (isHttps && proxy) {
      socket = await openTunnel(target, proxy, headers, signal)
    }

    const transport = isHttps ? https : http
    const options: https.RequestOptions = isHttps
      ? {
          ...(socket ? { createConnection: (): tls.TLSSocket => socket } : {}),
          agent: false,
          hostname: target.hostname,
          port: portOf(target, true),
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          servername: net.isIP(target.hostname) ? undefined : target.hostname,
          rejectUnauthorized: !insecureTls(target.hostname),
          setHost: true
        }
      : proxy
        ? {
            // http-over-proxy: the absolute-form URI goes straight to the proxy
            agent: false,
            hostname: proxy.host,
            port: proxy.port,
            path: target.href,
            method,
            headers,
            setHost: false
          }
        : {
            agent: false,
            hostname: target.hostname,
            port: portOf(target, false),
            path: `${target.pathname}${target.search}`,
            method,
            headers,
            setHost: true
          }
    if (!isHttps && proxy) headers['Host'] = `${target.host}`

    return await new Promise<http.IncomingMessage>((resolve, reject) => {
      let settled = false
      let timedOut = false
      const request = transport.request(options, (response) => {
        settled = true
        resolve(response)
      })
      request.once('error', (error) => {
        if (settled) return
        settled = true
        if (timedOut) {
          reject(networkError(`请求超时 (${timeoutMs}ms)`, url))
          return
        }
        reject(toAppError(error, url, init.signal))
      })
      const onAbortSignal = (): void => {
        request.destroy()
        if (!settled) {
          settled = true
          reject(cancelled('下载请求'))
        }
      }
      signal.addEventListener('abort', onAbortSignal, { once: true })
      // the listener must survive header-resolution so an abort can kill the body stream,
      // but it must not pile up on long-lived job signals
      request.once('close', () => signal.removeEventListener('abort', onAbortSignal))
      request.setTimeout(timeoutMs, () => {
        timedOut = true
        request.destroy()
      })
      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  /** Follow redirects manually (max 5 hops), re-applying the original headers. */
  async function requestFollowed(
    url: string,
    init: HttpInit
  ): Promise<{ message: http.IncomingMessage; url: string }> {
    let current = url
    let method = init.method ?? 'GET'
    let body = init.body
    let hops = 0
    for (;;) {
      const message = await sendOnce(current, { ...init, method, body })
      const status = message.statusCode ?? 0
      const location = message.headers.location
      const wantsRedirect = init.redirect !== false && isRedirect(status) && typeof location === 'string'
      if (!wantsRedirect) return { message, url: current }
      // drain so the socket can be released
      message.resume()
      if (hops >= MAX_REDIRECT_HOPS) throw networkError('重定向次数过多', current)
      hops += 1
      const next = new URL(location, current)
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw networkError('重定向目标协议不支持', next.href)
      }
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      // Range lives in init.headers and is therefore re-applied on every hop.
      current = next.toString()
    }
  }

  function toResponseHeaders(message: http.IncomingMessage): Headers {
    const headers = new Headers()
    for (const [key, value] of Object.entries(message.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else headers.append(key, value)
    }
    return headers
  }

  function emptyBody(status: number): boolean {
    return status === 204 || status === 205 || status === 304
  }

  /** Raw transport call returning a WHATWG Response whose body streams from node. */
  async function fetchRaw(url: string, init: HttpInit = {}): Promise<Response> {
    const { message, url: finalUrl } = await requestFollowed(url, init)
    const status = message.statusCode ?? 0
    if (status >= 400) {
      message.destroy()
      throw httpStatusError(status, finalUrl)
    }
    const headers = toResponseHeaders(message)
    const statusText = sanitizeStatusText(message.statusMessage)
    if (emptyBody(status)) {
      message.resume()
      return new Response(null, { status: Math.min(Math.max(status, 200), 599), statusText, headers })
    }
    const stream = Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { status, statusText, headers })
  }

  /* ---------------------------- head ----------------------------- */

  async function head(url: string, init: HttpInit = {}): Promise<HeadInfo> {
    // HttpInit.method has no 'HEAD' member (frozen contract); the transport accepts any method string.
    const headInit: HttpInit = { ...init, method: 'HEAD' as unknown as HttpInit['method'] }
    const { message, url: finalUrl } = await requestFollowed(url, headInit)
    const status = message.statusCode ?? 0
    const info: HeadInfo = { status, acceptsRanges: false }
    const acceptRanges = message.headers['accept-ranges']
    if (typeof acceptRanges === 'string' && acceptRanges.toLowerCase() !== 'none') {
      info.acceptsRanges = true
    }
    const rawLength = message.headers['content-length']
    if (typeof rawLength === 'string' && rawLength.length > 0) {
      const size = Number(rawLength)
      if (Number.isFinite(size) && size >= 0) info.size = size
    }
    const etag = message.headers.etag
    if (typeof etag === 'string') info.etag = etag
    message.resume()
    if (status === 0) throw networkError('HEAD 无响应', finalUrl)
    return info
  }

  /* -------------------------- public API -------------------------- */

  async function readText(url: string, init: HttpInit): Promise<string> {
    const response = await fetchRaw(url, init)
    return await response.text().catch((error: unknown) => {
      throw toAppError(error, url, init.signal)
    })
  }

  const client: HttpClient = {
    async json<T>(url: string, init?: HttpInit): Promise<T> {
      const text = await readText(url, init ?? {})
      try {
        return JSON.parse(text) as T
      } catch {
        log.warn(`json 解析失败: ${url}`)
        throw networkError('响应不是合法 JSON', url)
      }
    },
    async text(url: string, init?: HttpInit): Promise<string> {
      return readText(url, init ?? {})
    },
    async buffer(url: string, init?: HttpInit): Promise<Buffer> {
      const response = await fetchRaw(url, init ?? {})
      const array = await response.arrayBuffer().catch((error: unknown) => {
        throw toAppError(error, url, init?.signal)
      })
      return Buffer.from(array)
    },
    head,
    async fetch(url: string, init?: HttpInit): Promise<Response> {
      return fetchRaw(url, init ?? {})
    }
  }
  return client
}

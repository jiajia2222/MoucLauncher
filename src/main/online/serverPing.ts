/**
 * Minecraft Java `status` (server list ping) over `node:net`.
 *
 * Request (https://zh.minecraft.wiki/w/Java%E7%89%88%E7%BD%91%E7%BB%9C%E5%8D%8F%E8%AE%AE,
 * verified 2026-10-07):
 *   handshake  : [varint len][0x00][varint protocolId][string host][uint16 port][varint nextState=1]
 *   status_req : [varint len][0x00]
 * Response:
 *   status_resp: [varint len][varint packetId=0x00][varint jsonLength][json utf-8]
 *
 * `PROTOCOL.pingProtocol` is -1 on purpose: it means "version unknown" and every
 * real server answers it, so we never have to pin a per-version protocol id.
 */

import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { DEFAULT_SETTINGS_CONST, PROTOCOL } from '@shared/constants'
import { AppError } from '@shared/errors'
import { parseServerAddress, plainMotd } from '@shared/utils'
import type { AppErrorPayload, ServerPingResult } from '@shared/types'
import {
  MAX_PACKET_BYTES,
  encodeString,
  encodeVarInt,
  framePacket,
  readString,
  readVarInt,
  writeUnsignedShort
} from './varint'

export const HANDSHAKE_PACKET_ID = 0x00
export const STATUS_REQUEST_PACKET_ID = 0x00
export const STATUS_RESPONSE_PACKET_ID = 0x00
/** Vanilla default; `parseServerAddress` uses the same fallback. */
export const DEFAULT_PING_PORT = 25565

export interface PingOptions {
  /** When given it wins over a port written into `address`. */
  port?: number
  timeoutMs?: number
  protocolId?: number
  signal?: AbortSignal
}

interface StatusJson {
  version?: { name?: unknown; protocol?: unknown }
  players?: { max?: unknown; online?: unknown; sample?: unknown }
  description?: unknown
  motd?: unknown
  favicon?: unknown
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

export function buildHandshake(
  host: string,
  port: number,
  protocolId: number = PROTOCOL.pingProtocol,
  nextState: number = PROTOCOL.handshakeNext
): Buffer {
  const body = Buffer.concat([
    encodeVarInt(HANDSHAKE_PACKET_ID),
    encodeVarInt(protocolId),
    encodeString(host),
    writeUnsignedShort(port),
    encodeVarInt(nextState)
  ])
  return framePacket(body)
}

export function buildStatusRequest(): Buffer {
  return framePacket(encodeVarInt(STATUS_REQUEST_PACKET_ID))
}

/** The two packets a status ping sends, in order. */
export function buildPingRequest(
  host: string,
  port: number,
  protocolId: number = PROTOCOL.pingProtocol
): Buffer {
  const handshake = buildHandshake(host, port, protocolId)
  const status = buildStatusRequest()
  return Buffer.concat([handshake, status], handshake.length + status.length)
}

/* ------------------------------------------------------------------ */
/* Response framing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Incremental decoder for the response. `feed` returns the JSON body once the
 * whole packet has arrived, `undefined` while it is still incomplete, and
 * throws an {@link AppError} for anything that cannot be a valid packet — so a
 * truncated or garbage answer becomes a typed error instead of a crash.
 */
export class StatusResponseDecoder {
  private buffer = Buffer.alloc(0)

  get received(): number {
    return this.buffer.length
  }

  feed(chunk: Buffer): string | undefined {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_PACKET_BYTES + 5) {
      throw new AppError('invalid-input', 'status 响应超过 8 MiB', String(this.buffer.length))
    }
    const header = readVarInt(this.buffer, 0)
    if (header.kind === 'error') throw new AppError('invalid-input', header.message)
    if (header.kind === 'incomplete') return undefined
    const packetLength = header.value
    if (packetLength < 0 || packetLength > MAX_PACKET_BYTES) {
      throw new AppError('invalid-input', 'status 响应长度非法', String(packetLength))
    }
    if (this.buffer.length < header.bytes + packetLength) return undefined

    const packet = this.buffer.subarray(header.bytes, header.bytes + packetLength)
    this.buffer = Buffer.alloc(0)
    return this.decodePacket(packet)
  }

  private decodePacket(packet: Buffer): string {
    const id = readVarInt(packet, 0)
    if (id.kind === 'error') throw new AppError('invalid-input', id.message)
    if (id.kind === 'incomplete') throw new AppError('invalid-input', 'status 响应被截断', 'packet id 缺失')
    if (id.value !== STATUS_RESPONSE_PACKET_ID) {
      throw new AppError('invalid-input', 'status 响应包类型错误', `packetId=${id.value}`)
    }
    const text = readString(packet, id.bytes)
    if (text.kind === 'error') throw new AppError('invalid-input', text.message)
    if (text.kind === 'incomplete') throw new AppError('invalid-input', 'status 响应被截断', 'JSON 不完整')
    return text.value
  }
}

/* ------------------------------------------------------------------ */
/* JSON -> ServerPingResult                                            */
/* ------------------------------------------------------------------ */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return undefined
}

/** Raw description: a chat component object is kept as its JSON text. */
function rawDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

export function resultFromStatusJson(
  json: string,
  host: string,
  port: number,
  latencyMs: number
): ServerPingResult {
  let payload: StatusJson
  try {
    payload = JSON.parse(json) as StatusJson
  } catch (error) {
    throw new AppError('invalid-input', 'status 响应不是合法 JSON', String((error as Error).message ?? error))
  }
  const description = rawDescription(payload.description ?? payload.motd)
  const result: ServerPingResult = {
    address: host,
    port,
    online: true,
    latencyMs,
    motdPlain: description ? plainMotd(description) : ''
  }
  if (description !== undefined) result.motdJson = description
  const versionName = asString(payload.version?.name)
  if (versionName !== undefined) result.versionName = versionName
  const protocol = asNumber(payload.version?.protocol)
  if (protocol !== undefined) result.protocol = protocol
  const maxPlayers = asNumber(payload.players?.max)
  if (maxPlayers !== undefined) result.maxPlayers = maxPlayers
  const onlinePlayers = asNumber(payload.players?.online)
  if (onlinePlayers !== undefined) result.onlinePlayers = onlinePlayers
  const sample = Array.isArray(payload.players?.sample) ? (payload.players?.sample as unknown[]) : undefined
  if (sample) {
    const names = sample
      .map((entry) => (entry && typeof entry === 'object' ? asString((entry as { name?: unknown }).name) : asString(entry)))
      .filter((name): name is string => name !== undefined)
    result.samplePlayers = names
  }
  // Kept verbatim, including the `data:image/png;base64,` prefix the server sent.
  const favicon = asString(payload.favicon)
  if (favicon !== undefined) result.iconPngBase64 = favicon
  return result
}

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL'])

/** Socket/system error -> the launcher's typed payload so the UI can explain it. */
export function mapSocketError(error: unknown, endpoint: string): AppErrorPayload {
  if (error instanceof AppError) {
    const payload = error.toPayload()
    if (!payload.detail) payload.detail = endpoint
    return payload
  }
  const errno = (error as NodeJS.ErrnoException)?.code ?? ''
  const message = (error as Error)?.message ?? String(error)
  if (errno === 'ECONNREFUSED') {
    return new AppError('network', '服务器拒绝连接（端口未开放或被防火墙拦截）', endpoint, true).toPayload()
  }
  if (DNS_CODES.has(errno)) {
    return new AppError('network', '域名解析失败', `${endpoint}: ${errno}`, true).toPayload()
  }
  if (errno === 'ETIMEDOUT' || message.toLowerCase().includes('timeout')) {
    return new AppError('network', '连接超时', endpoint, true).toPayload()
  }
  if (errno === 'ECONNRESET' || errno === 'EPIPE' || errno === 'ECONNABORTED') {
    return new AppError('network', '连接被服务器中断', `${endpoint}: ${errno}`, true).toPayload()
  }
  if (errno === 'EHOSTUNREACH' || errno === 'ENETUNREACH' || errno === 'ENETDOWN') {
    return new AppError('network', '网络不可达', `${endpoint}: ${errno}`, true).toPayload()
  }
  return new AppError('network', `Ping 失败: ${message}`, endpoint, true).toPayload()
}

function offlineResult(address: string, port: number, error: AppErrorPayload): ServerPingResult {
  return { address, port, online: false, latencyMs: 0, motdPlain: '', error }
}

/* ------------------------------------------------------------------ */
/* The ping itself                                                     */
/* ------------------------------------------------------------------ */

/**
 * Never rejects for a network reason: the outcome is carried by
 * `ServerPingResult.online` + `error`. The socket is destroyed on every path,
 * including a half-read response.
 */
export function pingServer(input: string, options: PingOptions = {}): Promise<ServerPingResult> {
  const parsed = parseServerAddress(input, DEFAULT_PING_PORT)
  const host = parsed?.host ?? ''
  const port = options.port ?? parsed?.port ?? DEFAULT_PING_PORT
  if (!parsed || host.length === 0) {
    return Promise.resolve(
      offlineResult(
        input,
        port,
        new AppError('invalid-input', '服务器地址无效', input).toPayload()
      )
    )
  }
  const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_SETTINGS_CONST.defaultConnectTimeoutMs)
  const endpoint = `${host}:${port}`

  return new Promise<ServerPingResult>((resolve) => {
    const decoder = new StatusResponseDecoder()
    const startedAt = performance.now()
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const socket = new net.Socket()

    const finish = (result: ServerPingResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(result)
    }
    const failWith = (error: unknown): void => {
      finish(offlineResult(host, port, mapSocketError(error, endpoint)))
    }
    const onAbort = (): void => {
      finish(offlineResult(host, port, new AppError('cancelled', 'Ping 已取消', endpoint).toPayload()))
    }

    const arm = (label: string): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        failWith(new AppError('network', `${label}超时 (${timeoutMs}ms)`, endpoint, true))
      }, timeoutMs)
      timer.unref?.()
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    arm('连接')
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      failWith(new AppError('network', `读取超时 (${timeoutMs}ms)`, endpoint, true))
    })
    socket.on('error', failWith)
    socket.on('close', () => {
      failWith(new AppError('network', '连接已关闭且没有收到完整响应', endpoint, true))
    })

    socket.connect(port, host, () => {
      arm('等待响应')
      socket.write(buildPingRequest(host, port, options.protocolId ?? PROTOCOL.pingProtocol))
    })

    socket.on('data', (chunk: Buffer) => {
      let json: string | undefined
      try {
        json = decoder.feed(chunk)
      } catch (error) {
        failWith(error)
        return
      }
      if (json === undefined) return
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
      try {
        finish(resultFromStatusJson(json, host, port, latencyMs))
      } catch (error) {
        failWith(error)
      }
    })
  })
}

/** Convenience for `ServerService.ping(address, port)`. */
export function pingHost(address: string, port?: number, options: Omit<PingOptions, 'port'> = {}): Promise<ServerPingResult> {
  return pingServer(address, { ...options, ...(port === undefined ? {} : { port }) })
}

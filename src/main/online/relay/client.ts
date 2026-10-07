/**
 * Cross-network ("虚拟局域网") play: a byte tunnel between a local Minecraft
 * server/client and a room on a self-hosted relay.
 *
 * Two roles, one WebSocket connection to the relay per role:
 * - `host(targetPort, room, password)` — registers the room, opens a loopback
 *   `node:net` server on 127.0.0.1 (targetPort when it is free, otherwise an
 *   ephemeral port) and forwards every remote player the relay announces to the
 *   local game: if the game already owns `targetPort` we dial it, if we own it we
 *   pair the peer with a socket that connects in.
 * - `join(room, password)` — listens on 127.0.0.1 (25565, falling back to an
 *   ephemeral port reported through `RelayStatus.localPort`) and tunnels each
 *   locally accepted connection into the room's host.
 *
 * `globalThis.WebSocket` is used, which Electron 44's Node runtime provides, so
 * no dependency is added; tests inject their own transport through
 * `deps.WebSocket`. Failures never reject silently: they surface as
 * `RelayStatus.state === 'error'` plus an `AppErrorPayload`, and an empty
 * `settings.relayServerUrl` means "feature off" with an explanatory message.
 */

import net from 'node:net'
import { AppError } from '@shared/errors'
import type { AppErrorPayload, ErrorCode, RelayPeer, RelayStatus, Settings } from '@shared/types'
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  decode,
  encodeControl,
  encodeData,
  isValidRoomName,
  isValidPeerId,
  type ControlFrame,
  type RelayErrorCode,
  type RelayPeerInfo
} from './framing'

/* ------------------------------------------------------------------ */
/* Injectable WebSocket surface                                        */
/* ------------------------------------------------------------------ */

export interface WebSocketLike {
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener?(type: 'open' | 'message' | 'close' | 'error', listener: (event: WsEvent) => void): void
  onopen?: ((event?: WsEvent) => void) | null
  onmessage?: ((event: WsEvent) => void) | null
  onclose?: ((event?: WsEvent) => void) | null
  onerror?: ((event?: WsEvent) => void) | null
}

export interface WsEvent {
  data?: unknown
  code?: number
  reason?: string
  message?: string
}

export type WebSocketFactory = (url: string) => WebSocketLike

export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

/** The launcher's join port: what a vanilla client types as "server address". */
export const DEFAULT_JOIN_PORT = 25565

export interface RelayLogger {
  debug?(text: string): void
  info(text: string): void
  warn(text: string): void
  error(text: string, error?: unknown): void
}

export interface RelayClientDeps {
  /** Read on every action so a settings change takes effect without a restart. */
  settings: { get(): Settings }
  log: RelayLogger
  onStatus?: (status: RelayStatus) => void
  /** Injected in tests; defaults to `globalThis.WebSocket`. */
  WebSocket?: WebSocketFactory
  connectTimeoutMs?: number
  registerTimeoutMs?: number
  reconnectDelayMs?: number
  keepAliveMs?: number
  now?: () => number
}

export interface RelayClient {
  host(targetPort: number, room?: string, password?: string): Promise<RelayStatus>
  join(room: string, password?: string): Promise<RelayStatus>
  stop(): Promise<RelayStatus>
  status(): RelayStatus
  subscribe(handler: (status: RelayStatus) => void): () => void
  /** Container `dispose()` hook: same as stop(), but never throws. */
  dispose(): Promise<void>
}

type Mode = 'idle' | 'host' | 'join'

interface Waiter {
  type: ControlFrame['t']
  resolve: (frame: ControlFrame) => void
  reject: (error: unknown) => void
  timer?: NodeJS.Timeout
}

interface Tunnel {
  peerId: string
  name: string
  socket: net.Socket
  bytes: number
  openedAt: number
  closed: boolean
}

const ERROR_CODES: Record<RelayErrorCode, ErrorCode> = {
  'bad-request': 'invalid-input',
  'bad-password': 'auth',
  'no-room': 'not-found',
  'no-host': 'not-found',
  'room-exists': 'busy',
  full: 'busy',
  protocol: 'unsupported',
  internal: 'internal'
}

export function randomRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/** Relay error code -> the launcher's typed payload. */
export function relayErrorPayload(code: RelayErrorCode, message: string, detail?: string): AppErrorPayload {
  const error = new AppError(ERROR_CODES[code] ?? 'internal', message || '中继服务器返回错误', detail, code === 'full')
  return error.toPayload()
}

function missingUrlPayload(): AppErrorPayload {
  return new AppError(
    'invalid-input',
    '跨网联机未启用：请先在 设置 → 联机 → 中继服务器 填写 ws:// 或 wss:// 地址',
    'settings.relayServerUrl'
  ).toPayload()
}

/** Normalises the payload a WebSocket implementation hands the message event. */
function messageData(event: WsEvent | unknown): unknown {
  if (event && typeof event === 'object' && 'data' in (event as Record<string, unknown>)) {
    return (event as { data?: unknown }).data
  }
  return event
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createRelayClient(deps: RelayClientDeps): RelayClient {
  const log = deps.log
  const now = deps.now ?? Date.now
  const connectTimeoutMs = deps.connectTimeoutMs ?? 15_000
  const registerTimeoutMs = deps.registerTimeoutMs ?? 15_000
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1500
  const keepAliveMs = deps.keepAliveMs ?? 20_000
  const factory = deps.WebSocket ?? defaultWebSocketFactory()

  const listeners = new Set<(status: RelayStatus) => void>()
  const waiters = new Set<Waiter>()
  const tunnels = new Map<string, Tunnel>()
  /** Host role: peers announced before a local socket existed. */
  const pendingPeers: RelayPeerInfo[] = []
  /** Host role: local sockets that arrived before the relay announced a peer. */
  const pendingSockets: net.Socket[] = []

  let status: RelayStatus = { state: 'idle', peers: [], message: '未连接中继服务器' }
  let mode: Mode = 'idle'
  let socket: WebSocketLike | undefined
  let server: net.Server | undefined
  let localPort = 0
  /** Null when our own loopback listener owns the target port (never dial it). */
  let upstreamPort: number | null = null
  let room = ''
  let password = ''
  let myPeerId = ''
  let token = ''
  let relayUrl = ''
  let latencyMs = 0
  let keepAlive: NodeJS.Timeout | undefined
  let reconnectTimer: NodeJS.Timeout | undefined
  let reconnectUsed = false
  let stopping = false

  /* --------------------------- status --------------------------- */

  function publish(patch: Partial<RelayStatus>): RelayStatus {
    status = { ...status, ...patch, peers: patch.peers ?? peerList() }
    for (const listener of listeners) {
      try {
        listener(status)
      } catch (error) {
        log.warn(`中继状态回调异常: ${String(error)}`)
      }
    }
    deps.onStatus?.(status)
    return status
  }

  function peerList(): RelayPeer[] {
    return [...tunnels.values()].map((tunnel) => ({
      id: tunnel.peerId,
      name: tunnel.name,
      latencyMs,
      bytesForwarded: tunnel.bytes,
      connectedAt: tunnel.openedAt
    }))
  }

  function errorOut(payload: AppErrorPayload, message = '中继连接失败'): RelayStatus {
    log.error(`${message}: ${payload.message}`, payload.detail)
    return publish({ state: 'error', message, error: payload })
  }

  /* ---------------------------- framing -------------------------- */

  function writeFrame(bytes: Buffer | undefined): boolean {
    if (!bytes) return false
    if (!socket || socket.readyState !== WS_OPEN) return false
    try {
      socket.send(bytes)
      return true
    } catch (error) {
      log.error('中继帧发送失败', error)
      return false
    }
  }

  /** Sends a control frame; false means the connection is not usable. */
  function send(control: ControlFrame): boolean {
    const bytes = encodeControl(control)
    if (!bytes) {
      log.warn(`中继控制帧无法编码: ${control.t}`)
      return false
    }
    return writeFrame(bytes)
  }

  /** Sends one payload chunk tagged with the peer it belongs to. */
  function sendData(peerId: string, payload: Buffer): boolean {
    const bytes = encodeData(peerId, payload)
    if (!bytes) {
      log.warn(`中继数据帧无法编码: peer=${peerId} bytes=${payload.length}`)
      return false
    }
    return writeFrame(bytes)
  }

  function waitFor(type: ControlFrame['t'], timeoutMs: number, label: string): Promise<ControlFrame> {
    return new Promise<ControlFrame>((resolve, reject) => {
      const waiter: Waiter = { type, resolve, reject }
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new AppError('network', `${label}超时 (${timeoutMs}ms)`, relayUrl, true))
      }, timeoutMs)
      waiter.timer.unref?.()
      waiters.add(waiter)
    })
  }

  function settleWaiters(frame: ControlFrame): boolean {
    for (const waiter of [...waiters]) {
      if (waiter.type !== frame.t) continue
      waiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(frame)
      return true
    }
    return false
  }

  function rejectWaiters(error: unknown): void {
    for (const waiter of [...waiters]) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.reject(error)
    }
  }

  /* --------------------------- tunnels --------------------------- */

  /**
   * Wires a local socket to a relay peer. `queued` flushes bytes that arrived
   * before the relay had assigned the peer id (a Minecraft client speaks first
   * thing after connecting).
   */
  function bindTunnel(peerId: string, name: string, local: net.Socket, queued: Buffer[] = []): void {
    if (tunnels.has(peerId)) closeTunnel(peerId)
    const tunnel: Tunnel = { peerId, name, socket: local, bytes: 0, openedAt: now(), closed: false }
    tunnels.set(peerId, tunnel)
    local.setNoDelay(true)
    for (const chunk of queued.splice(0)) {
      tunnel.bytes += chunk.length
      if (!sendData(peerId, chunk)) {
        closeTunnel(peerId)
        return
      }
    }

    local.on('data', (chunk: Buffer) => {
      tunnel.bytes += chunk.length
      if (!sendData(peerId, chunk)) closeTunnel(peerId)
    })
    local.on('end', () => closeTunnel(peerId))
    local.on('error', (error: Error) => {
      log.debug?.(`中继隧道 ${peerId} 本地套接字错误: ${error.message}`)
      closeTunnel(peerId)
    })
    local.on('close', () => closeTunnel(peerId))
    publish({ message: modeMessage() })
  }

  function closeTunnel(peerId: string): void {
    const tunnel = tunnels.get(peerId)
    if (!tunnel) return
    tunnel.closed = true
    tunnels.delete(peerId)
    try {
      tunnel.socket.destroy()
    } catch {
      /* already gone */
    }
    if (mode === 'host') send({ t: 'peer-close', peer: peerId })
    publish({ message: modeMessage() })
  }

  function onDataFrame(peerId: string, payload: Buffer): void {
    const tunnel = tunnels.get(peerId)
    if (!tunnel || tunnel.closed) return
    tunnel.bytes += payload.length
    try {
      tunnel.socket.write(payload)
    } catch (error) {
      log.debug?.(`中继隧道 ${peerId} 写入失败: ${String(error)}`)
      closeTunnel(peerId)
    }
  }

  function modeMessage(): string {
    const count = tunnels.size
    if (mode === 'host') {
      return `房间 ${room} 已开放，中继端口 ${localPort}，在线 ${count} 人`
    }
    if (mode === 'join') {
      return `已连接房间 ${room}，本地端口 ${localPort}，隧道 ${count} 条`
    }
    return '未连接中继服务器'
  }

  /* ------------------------ host role plumbing -------------------- */

  /**
   * Opens the loopback rendezvous server. `preferred` is used when free, so the
   * documented port matches the game; otherwise the OS assigns one and the
   * caller reads it back from `RelayStatus.localPort`.
   */
  function listenLoopback(preferred: number): Promise<number> {
    const existing = server
    return new Promise<number>((resolve, reject) => {
      const listener = existing ?? net.createServer((local) => onLocalConnection(local))
      if (!existing) server = listener

      let settled = false
      const onError = (error: NodeJS.ErrnoException): void => {
        if (settled) return
        if (error.code === 'EADDRINUSE' && preferred !== 0) {
          // The game owns `preferred`: fall back to an ephemeral rendezvous port
          // and dial the game's port for every relay peer. The `listening` handler
          // below is still attached, so it must stay unfired for that resolve to land.
          listener.off('error', onError)
          listener.once('error', (late: NodeJS.ErrnoException) => {
            if (settled) return
            settled = true
            reject(new AppError('network', '本地端口不可用', `${preferred}: ${late.code ?? late.message}`, false))
          })
          listener.listen({ port: 0, host: '127.0.0.1' })
          return
        }
        settled = true
        reject(new AppError('network', '本地端口不可用', `${preferred}: ${error.code ?? error.message}`, false))
      }
      listener.once('error', onError)
      listener.once('listening', () => {
        if (settled) return
        settled = true
        listener.off('error', onError)
        const address = listener.address()
        const port = typeof address === 'object' && address ? address.port : preferred
        resolve(port)
      })
      if (listener.listening) {
        const address = listener.address()
        settled = true
        listener.off('error', onError)
        resolve(typeof address === 'object' && address ? address.port : preferred)
        return
      }
      listener.listen({ port: preferred, host: '127.0.0.1' })
    })
  }

  function onLocalConnection(local: net.Socket): void {
    // Join role: the local Minecraft client is the tunnel's near end.
    if (mode === 'join') {
      void openJoinTunnel(local)
      return
    }
    if (mode !== 'host') {
      local.destroy()
      return
    }
    // Host role with our listener owning the target port: pair the socket with
    // the next remote player the relay announces.
    const peer = pendingPeers.shift()
    if (peer) {
      bindTunnel(peer.id, peer.name, local)
      return
    }
    pendingSockets.push(local)
  }

  function onPeerAnnounced(info: RelayPeerInfo): void {
    if (!isValidPeerId(info.id)) {
      log.warn(`中继声明了非法的对端编号，已忽略: ${String(info.id)}`)
      return
    }
    const queued = pendingSockets.shift()
    if (queued) {
      bindTunnel(info.id, info.name, queued)
      return
    }
    if (upstreamPort === null) {
      pendingPeers.push(info)
      return
    }
    const dial = net.connect({ host: '127.0.0.1', port: upstreamPort })
    dial.once('error', (error: Error) => {
      log.debug?.(`中继隧道拨号失败: ${error.message}`)
      send({ t: 'peer-close', peer: info.id })
      publish({ message: `${modeMessage()}（本地端口 ${upstreamPort} 无响应）` })
    })
    dial.once('connect', () => bindTunnel(info.id, info.name, dial))
  }

  async function openJoinTunnel(local: net.Socket): Promise<void> {
    if (mode !== 'join' || room.length === 0) {
      local.destroy()
      return
    }
    // The local Minecraft client starts its handshake immediately; hold anything
    // that arrives before the relay has answered with a peer id.
    const queued: Buffer[] = []
    const collect = (chunk: Buffer): void => {
      queued.push(chunk)
    }
    local.on('data', collect)
    const pending = waitFor('opened', registerTimeoutMs, '房间隧道分配')
    if (!send({ t: 'open', room })) {
      rejectWaiters(new AppError('network', '中继连接已断开', relayUrl, true))
      local.destroy()
      return
    }
    try {
      const frame = await pending
      if (frame.t !== 'opened') return
      local.off('data', collect)
      bindTunnel(frame.peer, `${room}@${relayHost()}#${myPeerId || '?'}`, local, queued)
    } catch (error) {
      local.destroy()
      log.warn(`房间隧道分配失败: ${String((error as Error).message ?? error)}`)
    }
  }

  function relayHost(): string {
    try {
      return new URL(relayUrl).host
    } catch {
      return relayUrl
    }
  }

  /* -------------------------- ws lifecycle ------------------------- */

  function defaultWebSocketFactory(): WebSocketFactory {
    const ctor = (globalThis as { WebSocket?: unknown }).WebSocket
    if (typeof ctor !== 'function') {
      return () => {
        throw new AppError(
          'unsupported',
          '当前运行环境没有 WebSocket 实现，无法使用跨网联机',
          'globalThis.WebSocket'
        )
      }
    }
    const Ctor = ctor as new (url: string) => WebSocketLike
    return (url: string) => new Ctor(url)
  }

  function attachSocket(ws: WebSocketLike): void {
    const handle = (type: 'open' | 'message' | 'close' | 'error', listener: (event: WsEvent) => void): void => {
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener(type, listener)
        return
      }
      const slot = ws as unknown as Record<string, ((event: WsEvent) => void) | undefined>
      slot[`on${type}`] = listener
    }
    handle('message', (event) => onFrame(messageData(event)))
    handle('close', () => {
      if (stopping) return
      if (mode !== 'idle') dropConnection(new AppError('network', '中继连接已断开', relayUrl, true))
    })
    handle('error', (event) => {
      log.debug?.(`中继 WebSocket 错误: ${String(event?.message ?? '')}`)
    })
  }

  function onFrame(raw: unknown): void {
    const frame = decode(raw)
    if (!frame) {
      log.warn('收到无法解析的中继帧，已忽略')
      return
    }
    if (frame.kind === 'data') {
      onDataFrame(frame.peerId, frame.payload)
      return
    }
    const control = frame.control
    if (control.t === 'ping') {
      send({ t: 'pong', ts: control.ts })
      return
    }
    if (control.t === 'pong') {
      latencyMs = Math.max(0, now() - control.ts)
      publish({})
      return
    }
    if (control.t === 'peer-open') {
      onPeerAnnounced({ id: control.peer, name: control.name ?? control.peer })
      return
    }
    if (control.t === 'peer-close') {
      closeTunnel(control.peer)
      const queued = pendingPeers.findIndex((peer) => peer.id === control.peer)
      if (queued >= 0) pendingPeers.splice(queued, 1)
      return
    }
    if (control.t === 'error') {
      const payload = relayErrorPayload(control.code, control.message, relayUrl)
      // An in-flight `ok`/`opened` request must fail immediately with this
      // payload instead of timing out — that is what keeps a wrong password from
      // looking like a hang.
      if (waiters.size > 0) {
        rejectWaiters(new AppError(payload.code, payload.message, payload.detail ?? relayUrl, payload.retryable === true))
      } else {
        errorOut(payload, '中继服务器拒绝了请求')
      }
      return
    }
    if (control.t === 'close') {
      dropConnection(new AppError('network', '中继服务器关闭了连接', control.reason ?? relayUrl, true))
      return
    }
    settleWaiters(control)
  }

  /** Opens (or reuses) the relay connection and resolves once it is usable. */
  async function ensureConnected(): Promise<void> {
    if (socket && socket.readyState === WS_OPEN) return
    const ws = factory(relayUrl)
    socket = ws
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError('network', `连接中继服务器超时 (${connectTimeoutMs}ms)`, relayUrl, true))
      }, connectTimeoutMs)
      timer.unref?.()
      const fail = (error: unknown): void => {
        clearTimeout(timer)
        reject(AppError.from(error, 'network'))
      }
      const ok = (): void => {
        clearTimeout(timer)
        resolve()
      }
      if (ws.readyState === WS_OPEN) {
        ok()
        return
      }
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', () => ok())
        ws.addEventListener('error', (event) =>
          fail(new AppError('network', '无法连接中继服务器', `${relayUrl}: ${String(event?.message ?? '')}`, true))
        )
        ws.addEventListener('close', () => fail(new AppError('network', '中继服务器拒绝了连接', relayUrl, true)))
      } else {
        ws.onopen = () => ok()
        ws.onerror = (event?: WsEvent) =>
          fail(new AppError('network', '无法连接中继服务器', `${relayUrl}: ${String(event?.message ?? '')}`, true))
        ws.onclose = () => fail(new AppError('network', '中继服务器拒绝了连接', relayUrl, true))
      }
    })
    attachSocket(ws)
    await opened
    // Identifies the client and the protocol revision before any room work.
    send({ t: 'hello', client: PROTOCOL_NAME, protocol: PROTOCOL_VERSION })
  }

  function dropConnection(error: AppError): void {
    // `closeSocket()` makes the transport fire `close` at us again; without this
    // guard the re-entrant call would take the "give up" branch instead.
    if (!socket) return
    closeSocket()
    for (const tunnel of [...tunnels.keys()]) closeTunnel(tunnel)
    if (reconnectUsed || mode === 'idle' || stopping) {
      errorOut(error.toPayload(), '中继连接中断')
      return
    }
    reconnectUsed = true
    publish({ message: '中继连接中断，正在重连…' })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void reRegister().catch((retryError: unknown) => {
        errorOut(AppError.from(retryError, 'network').toPayload(), '重连失败')
      })
    }, reconnectDelayMs)
    reconnectTimer.unref?.()
  }

  async function reRegister(): Promise<void> {
    await ensureConnected()
    await registerFrame()
    publish({ state: mode === 'host' ? 'hosting' : 'connected', message: modeMessage(), error: undefined })
    log.info(`中继重连成功，房间 ${room}`)
  }

  /** Sends the role's registration frame and waits for the relay's `ok`. */
  function registerFrame(): Promise<ControlFrame> {
    const pending = waitFor('ok', registerTimeoutMs, '房间注册')
    const frame: ControlFrame =
      mode === 'host'
        ? {
            t: 'host',
            room,
            ...(password ? { password } : {}),
            targetPort: upstreamPort ?? localPort,
            listen: true
          }
        : { t: 'join', room, ...(password ? { password } : {}), ...(token ? { token } : {}) }
    if (!send(frame)) {
      const error = new AppError('network', '中继连接已断开', relayUrl, true)
      rejectWaiters(error)
      return Promise.reject(error)
    }
    return pending
  }

  function closeSocket(): void {
    const ws = socket
    socket = undefined
    myPeerId = ''
    if (!ws) return
    try {
      ws.close(1000, 'mouc-relay stop')
    } catch {
      /* ignore */
    }
  }

  async function teardown(): Promise<void> {
    stopping = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    if (keepAlive) clearInterval(keepAlive)
    keepAlive = undefined
    rejectWaiters(new AppError('cancelled', '中继任务已停止', relayUrl))
    for (const peerId of [...tunnels.keys()]) closeTunnel(peerId)
    pendingPeers.length = 0
    for (const local of pendingSockets.splice(0)) local.destroy()
    closeSocket()
    if (server) {
      const closing = server
      server = undefined
      await new Promise<void>((done) => {
        if (!closing.listening) {
          done()
          return
        }
        // Every accepted socket was already destroyed above, so `close()` can settle.
        closing.close(() => done())
        closing.unref()
      })
    }
    localPort = 0
    upstreamPort = null
    mode = 'idle'
    room = ''
    password = ''
    token = ''
    latencyMs = 0
    stopping = false
  }

  function startKeepAlive(): void {
    if (keepAlive) clearInterval(keepAlive)
    keepAlive = setInterval(() => {
      if (socket && socket.readyState === WS_OPEN) send({ t: 'ping', ts: now() })
    }, keepAliveMs)
    keepAlive.unref?.()
  }

  /* ---------------------------- public ---------------------------- */

  async function host(targetPort: number, wantedRoom?: string, wantedPassword?: string): Promise<RelayStatus> {
    relayUrl = deps.settings.get().relayServerUrl?.trim() ?? ''
    if (!relayUrl) {
      await teardown()
      return errorOut(missingUrlPayload(), '跨网联机未启用')
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return publish({ state: 'idle', message: '目标端口无效', error: new AppError('invalid-input', '目标端口无效', String(targetPort)).toPayload() })
    }
    const code = wantedRoom && wantedRoom.length > 0 ? wantedRoom : randomRoomCode()
    if (!isValidRoomName(code)) {
      return publish({ state: 'idle', message: '房间号无效', error: new AppError('invalid-input', '房间号无效', code).toPayload() })
    }
    await teardown()
    mode = 'host'
    room = code
    password = wantedPassword ?? ''
    reconnectUsed = false
    publish({ state: 'hosting', room, message: `正在连接中继服务器 ${relayHost()}…`, error: undefined })

    try {
      await ensureConnected()
      localPort = await listenLoopback(targetPort)
      upstreamPort = localPort === targetPort ? null : targetPort
      const reply = await registerFrame()
      if (reply.t === 'ok') {
        myPeerId = reply.peer
        if (reply.token) token = reply.token
      }
      startKeepAlive()
      return publish({
        state: 'hosting',
        room,
        localPort,
        endpoint: `${relayHost()} ${room}`,
        message: modeMessage()
      })
    } catch (error) {
      const payload = AppError.from(error, 'network').toPayload()
      await teardown()
      return errorOut(payload, '开启房间失败')
    }
  }

  async function join(wantedRoom: string, wantedPassword?: string): Promise<RelayStatus> {
    relayUrl = deps.settings.get().relayServerUrl?.trim() ?? ''
    if (!relayUrl) {
      await teardown()
      return errorOut(missingUrlPayload(), '跨网联机未启用')
    }
    if (!isValidRoomName(wantedRoom)) {
      return publish({ state: 'idle', message: '房间号无效', error: new AppError('invalid-input', '房间号无效', wantedRoom).toPayload() })
    }
    await teardown()
    mode = 'join'
    room = wantedRoom
    password = wantedPassword ?? ''
    reconnectUsed = false
    publish({ state: 'joining', room, message: `正在加入房间 ${room}…`, error: undefined })

    try {
      await ensureConnected()
      const reply = await registerFrame()
      if (reply.t === 'ok') {
        myPeerId = reply.peer
        if (reply.token) token = reply.token
      }
      localPort = await listenLoopback(DEFAULT_JOIN_PORT)
      startKeepAlive()
      return publish({
        state: 'connected',
        room,
        localPort,
        endpoint: `${relayHost()} ${room}`,
        message: modeMessage()
      })
    } catch (error) {
      const payload = AppError.from(error, 'network').toPayload()
      await teardown()
      return errorOut(payload, '加入房间失败')
    }
  }

  async function stop(): Promise<RelayStatus> {
    await teardown()
    return publish({
      state: 'idle',
      room: undefined,
      localPort: undefined,
      endpoint: undefined,
      peers: [],
      message: '已断开中继连接',
      error: undefined
    })
  }

  return {
    host,
    join,
    stop,
    // Peer counters move faster than publishes; always answer from live tunnels so the
    // UI never shows a frozen "bytes forwarded".
    status: () => ({ ...status, peers: peerList() }),
    subscribe(handler): () => void {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    async dispose(): Promise<void> {
      try {
        await stop()
      } catch (error) {
        log.warn(`中继清理失败: ${String(error)}`)
      }
    }
  }
}

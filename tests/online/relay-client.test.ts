import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { RelayStatus, Settings } from '@shared/types'
import {
  DEFAULT_JOIN_PORT,
  WS_CLOSED,
  WS_CONNECTING,
  WS_OPEN,
  createRelayClient,
  randomRoomCode,
  relayErrorPayload,
  type RelayClient,
  type WebSocketFactory,
  type WebSocketLike,
  type WsEvent
} from '../../src/main/online/relay/client'
import {
  decode,
  encode,
  type ControlFrame,
  type Frame
} from '../../src/main/online/relay/framing'

/* ------------------------------------------------------------------ */
/* In-process fake WebSocket transport + relay behaviour              */
/* ------------------------------------------------------------------ */

class FakeSocket implements WebSocketLike {
  readyState = WS_CONNECTING
  readonly sent: Frame[] = []
  private readonly handlers: Record<string, Array<(event: WsEvent) => void>> = {
    open: [],
    message: [],
    close: [],
    error: []
  }

  constructor(
    readonly url: string,
    private readonly relay: FakeRelay
  ) {
    setTimeout(() => {
      if (this.readyState !== WS_CONNECTING) return
      this.readyState = WS_OPEN
      this.fire('open', {})
    }, 0)
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WsEvent) => void): void {
    this.handlers[type].push(listener)
  }

  send(data: string | Uint8Array): void {
    const frame = decode(data)
    if (!frame) throw new Error('fake relay received a frame it cannot decode')
    this.sent.push(frame)
    this.relay.receive(this, frame)
  }

  close(): void {
    if (this.readyState === WS_CLOSED) return
    this.readyState = WS_CLOSED
    this.fire('close', { code: 1000 })
  }

  fire(type: 'open' | 'message' | 'close' | 'error', event: WsEvent): void {
    for (const listener of this.handlers[type]) listener(event)
  }

  /** Simulates the relay pushing a frame to the launcher. */
  push(frame: Frame): void {
    const bytes = encode(frame)
    if (!bytes) throw new Error('cannot encode the frame the test wanted to push')
    this.fire('message', { data: bytes })
  }

  controls(type: ControlFrame['t']): ControlFrame[] {
    return this.sent
      .filter((frame): frame is { kind: 'control'; control: ControlFrame } => frame.kind === 'control')
      .map((frame) => frame.control)
      .filter((control) => control.t === type)
  }

  bytesFor(peerId: string): Buffer {
    return Buffer.concat(
      this.sent
        .filter((frame): frame is { kind: 'data'; peerId: string; payload: Buffer } => frame.kind === 'data' && frame.peerId === peerId)
        .map((frame) => frame.payload)
    )
  }
}

class FakeRelay {
  readonly sockets: FakeSocket[] = []
  hostPassword = 'pw'
  readonly closedPeers: string[] = []
  pings = 0
  /** Refuses the next `ok` reply, used to drive the reconnect paths. */
  refuseNext = false

  readonly factory: WebSocketFactory = (url: string) => {
    const socket = new FakeSocket(url, this)
    this.sockets.push(socket)
    return socket
  }

  get latest(): FakeSocket {
    const socket = this.sockets[this.sockets.length - 1]
    if (!socket) throw new Error('the client never opened a socket')
    return socket
  }

  receive(socket: FakeSocket, frame: Frame): void {
    if (frame.kind === 'data') return
    const control = frame.control
    setTimeout(() => {
      if (socket.readyState !== WS_OPEN) return
      switch (control.t) {
        case 'hello':
          return
        case 'host': {
          if (control.password && control.password !== this.hostPassword) {
            socket.push({ kind: 'control', control: { t: 'error', code: 'bad-password', message: '房间口令不正确' } })
            return
          }
          if (this.refuseNext) {
            this.refuseNext = false
            socket.push({ kind: 'control', control: { t: 'error', code: 'room-exists', message: '房间号已被占用' } })
            return
          }
          socket.push({ kind: 'control', control: { t: 'ok', role: 'host', room: control.room, peer: 'host-1', token: 'tok' } })
          return
        }
        case 'join': {
          if (control.password && control.password !== this.hostPassword) {
            socket.push({ kind: 'control', control: { t: 'error', code: 'bad-password', message: '房间口令不正确' } })
            return
          }
          socket.push({ kind: 'control', control: { t: 'ok', role: 'joiner', room: control.room, peer: 'joiner-1' } })
          return
        }
        case 'open':
          socket.push({ kind: 'control', control: { t: 'opened', peer: `p${this.sockets.length}-${socket.sent.length}` } })
          return
        case 'peer-close':
          this.closedPeers.push(control.peer)
          return
        case 'ping':
          this.pings += 1
          socket.push({ kind: 'control', control: { t: 'pong', ts: control.ts } })
          return
        default:
          return
      }
    }, 0)
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const silence = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} }

function settingsWith(relayServerUrl: string): { get(): Settings } {
  const settings = { relayServerUrl } as unknown as Settings
  return { get: () => settings }
}

function makeClient(relay: FakeRelay, relayServerUrl = 'ws://relay.example:8758/ws'): RelayClient {
  return createRelayClient({
    settings: settingsWith(relayServerUrl),
    log: silence,
    WebSocket: relay.factory,
    connectTimeoutMs: 1000,
    registerTimeoutMs: 1000,
    reconnectDelayMs: 25,
    keepAliveMs: 20
  })
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function listenEphemeral(onConnection: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return listenOnPort(0, onConnection)
}

function listenOnPort(
  port: number,
  onConnection: (socket: net.Socket) => void = () => {}
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          })
      })
    })
  })
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('relay client', () => {
  it('hosts a room, pairs a remote player with the local game and stops', async () => {
    const relay = new FakeRelay()
    const gameSockets: net.Socket[] = []
    const toRelay: Buffer[] = []
    const game = await listenEphemeral((socket) => {
      gameSockets.push(socket)
      socket.on('data', (chunk) => toRelay.push(chunk))
    })
    const client = makeClient(relay)
    const updates: RelayStatus[] = []
    client.subscribe((status) => updates.push(status))

    expect(client.status().state).toBe('idle')
    // The game owns `game.port`, so the client must fall back to an ephemeral
    // loopback port and dial the game instead of binding it.
    const result = await client.host(game.port, 'ROOM1', 'pw')
    expect(result.state).toBe('hosting')
    expect(result.room).toBe('ROOM1')
    expect(result.localPort).toBeGreaterThan(0)
    expect(result.localPort).not.toBe(game.port)
    expect(result.error).toBeUndefined()
    expect(updates.map((status) => status.state)).toContain('hosting')

    const socket = relay.latest
    expect(socket.controls('hello')).toEqual([{ t: 'hello', client: 'mouc-relay', protocol: 1 }])
    expect(socket.controls('host')).toEqual([{ t: 'host', room: 'ROOM1', password: 'pw', targetPort: game.port, listen: true }])

    socket.push({ kind: 'control', control: { t: 'peer-open', peer: 'p1', name: 'friend' } })
    await waitFor('the client to dial the game', () => gameSockets.length === 1)
    expect(client.status().peers.map((peer) => peer.id)).toEqual(['p1'])

    gameSockets[0]!.write(Buffer.from([0x00, 0x66, 0x0a]))
    await waitFor('the game bytes to reach the relay', () => socket.bytesFor('p1').length === 3)
    expect([...socket.bytesFor('p1')]).toEqual([0x00, 0x66, 0x0a])
    expect(client.status().peers[0]).toMatchObject({ id: 'p1', name: 'friend', bytesForwarded: 3 })

    socket.push({ kind: 'data', peerId: 'p1', payload: Buffer.from('MCPING') })
    await waitFor('the remote bytes to reach the game', () => toRelay.length > 0)
    expect(Buffer.concat(toRelay).toString()).toBe('MCPING')

    socket.push({ kind: 'control', control: { t: 'peer-close', peer: 'p1' } })
    await waitFor('the peer list to empty', () => client.status().peers.length === 0)
    // The fake relay answers on a `setTimeout(0)`, so the echo needs a macrotask to land.
    await waitFor('the relay to record the peer-close echo', () => relay.closedPeers.includes('p1'))

    const stopped = await client.stop()
    expect(stopped.state).toBe('idle')
    expect(stopped.peers).toEqual([])
    expect(socket.readyState).toBe(WS_CLOSED)
    await game.close()
    await expectConnectRefused(result.localPort!)
  })

  it('joins a room, listens locally and tunnels both directions', async () => {
    const relay = new FakeRelay()
    const client = makeClient(relay)
    const result = await client.join('ROOM2', 'pw')
    expect(result.state).toBe('connected')
    expect(result.room).toBe('ROOM2')
    const localPort = result.localPort!
    expect(localPort).toBeGreaterThanOrEqual(1)

    const socket = relay.latest
    expect(socket.controls('join')).toEqual([{ t: 'join', room: 'ROOM2', password: 'pw' }])

    const local = net.connect(localPort, '127.0.0.1')
    const received: Buffer[] = []
    local.on('data', (chunk) => received.push(chunk))
    await new Promise((resolve) => local.once('connect', resolve))
    local.write(Buffer.from([0x7f]))

    // The relay answers `open` with `opened` plus the peer id every byte frame
    // is tagged with; the client must wire the local socket to that id.
    await waitFor('the client to ask the relay for a tunnel', () => socket.controls('open').length === 1)
    expect(socket.controls('open')[0]).toEqual({ t: 'open', room: 'ROOM2' })
    await waitFor('the tunnel to be bound', () => client.status().peers.length === 1)
    const peerId = client.status().peers[0]!.id
    expect(peerId.length).toBeGreaterThan(0)
    expect(client.status().peers[0]).toMatchObject({ bytesForwarded: 1 })

    await waitFor('the local byte to reach the relay', () => socket.bytesFor(peerId).length === 1)
    expect([...socket.bytesFor(peerId)]).toEqual([0x7f])

    socket.push({ kind: 'data', peerId, payload: Buffer.from('SERVER-KISS') })
    await waitFor('the remote bytes to reach the local client', () => received.length > 0)
    expect(Buffer.concat(received).toString()).toBe('SERVER-KISS')

    // Keepalive frames flow, so the relay can drop a dead launcher.
    await waitFor('a keepalive ping', () => relay.pings > 0)

    local.destroy()
    const stopped = await client.stop()
    expect(stopped.state).toBe('idle')
    await expectConnectRefused(localPort)
  })

  it('binds the preferred join port when it is free and falls back when it is not', async () => {
    // Squat on the port the join role prefers, so the first bind must fail and
    // the client has to report the ephemeral port it ended up with.
    let squatter: { port: number; close: () => Promise<void> } | undefined
    try {
      squatter = await listenOnPort(DEFAULT_JOIN_PORT)
    } catch {
      squatter = undefined
    }
    const relay = new FakeRelay()
    const client = makeClient(relay)
    const status = await client.join('ROOM3')
    expect(status.state).toBe('connected')
    expect(status.localPort!).toBeGreaterThan(0)
    if (squatter) {
      expect(status.localPort).not.toBe(DEFAULT_JOIN_PORT)
    } else {
      expect(status.localPort).toBe(DEFAULT_JOIN_PORT)
    }
    await client.stop()
    await squatter?.close()
  })

  it('surfaces a wrong password as an auth error instead of hanging', async () => {
    const relay = new FakeRelay()
    const client = makeClient(relay)
    const startedAt = Date.now()
    const status = await client.host(25565, 'ROOM4', 'nope')
    expect(status.state).toBe('error')
    expect(status.error?.code).toBe('auth')
    expect(Date.now() - startedAt).toBeLessThan(1500)
    await client.stop()
  })

  it('surfaces a busy room and an unreachable relay as typed errors', async () => {
    const relay = new FakeRelay()
    relay.refuseNext = true
    const client = makeClient(relay)
    const status = await client.host(25565, 'ROOM5', 'pw')
    expect(status.state).toBe('error')
    expect(status.error?.code).toBe('busy')
    await client.stop()

    const noTransport = createRelayClient({
      settings: settingsWith('ws://127.0.0.1:1/ws'),
      log: silence,
      connectTimeoutMs: 300,
      registerTimeoutMs: 300
    })
    const unreachable = await noTransport.host(25565, 'ROOM6')
    expect(unreachable.state).toBe('error')
    expect(['network', 'unsupported']).toContain(unreachable.error?.code)
    await noTransport.stop()
  })

  it('treats an empty relayServerUrl as "feature off", with a message', async () => {
    const relay = new FakeRelay()
    const client = makeClient(relay, '')
    const status = await client.host(25565, 'ROOM7', 'pw')
    expect(status.state).toBe('error')
    expect(status.error?.code).toBe('invalid-input')
    expect(status.error?.message).toContain('未启用')
    expect(status.error?.detail).toBe('settings.relayServerUrl')
    expect(relay.sockets).toHaveLength(0)
  })

  it('rejects an invalid room code or target port without touching the network', async () => {
    const relay = new FakeRelay()
    const client = makeClient(relay)
    expect((await client.host(0)).error?.code).toBe('invalid-input')
    expect((await client.host(25565, 'x'.repeat(80))).error?.code).toBe('invalid-input')
    expect((await client.join('')).error?.code).toBe('invalid-input')
    expect(relay.sockets).toHaveLength(0)
  })

  it('reconnects exactly once, then reports the drop as an error', async () => {
    const relay = new FakeRelay()
    const game = await listenEphemeral(() => {})
    const client = makeClient(relay)
    await client.host(game.port, 'ROOM8', 'pw')
    expect(relay.sockets).toHaveLength(1)

    relay.sockets[0]!.fire('close', { code: 1006 })
    expect(client.status().message).toContain('重连')
    await waitFor('the second connection to register', () => relay.sockets.length === 2)
    // `state` stays 'hosting' across the drop (only the message changes), so waiting on
    // it would return immediately and race the 25ms reconnect timer. Wait for the frame.
    await waitFor('the re-registration to complete', () => relay.sockets[1]!.controls('host').length === 1)
    expect(client.status().state).toBe('hosting')
    expect(client.status().room).toBe('ROOM8')

    relay.sockets[1]!.fire('close', { code: 1006 })
    await waitFor('the failure to surface', () => client.status().state === 'error')
    expect(client.status().error?.code).toBe('network')
    expect(relay.sockets).toHaveLength(2) // no second retry
    await client.stop()
    await game.close()
  })

  it('ignores unparsable frames and unknown peers instead of crashing', async () => {
    const relay = new FakeRelay()
    const client = makeClient(relay)
    await client.join('ROOM9')
    const socket = relay.latest
    socket.fire('message', { data: Buffer.from('complete junk') })
    socket.fire('message', { data: Buffer.alloc(0) })
    socket.push({ kind: 'data', peerId: 'ghost', payload: Buffer.from('nobody is listening') })
    socket.push({ kind: 'control', control: { t: 'peer-close', peer: 'ghost' } })
    expect(client.status().state).toBe('connected')
    expect(client.status().peers).toEqual([])
    await client.stop()
  })

  it('exposes status() snapshots and stops idempotently', async () => {
    const relay = new FakeRelay()
    const client = makeClient(relay)
    const first = await client.host(25565, undefined, 'pw')
    expect(first.room).toMatch(/^[A-Z2-9]{6}$/)
    expect(randomRoomCode()).toMatch(/^[A-Z2-9]{6}$/)
    await client.stop()
    const second = await client.stop()
    expect(second.state).toBe('idle')
    await client.dispose()
    expect(client.status().state).toBe('idle')
    expect(relayErrorPayload('no-room', '没有这个房间').code).toBe('not-found')
  })
})

/** Nothing to build: the join role's preferred port is a module constant. */

async function expectConnectRefused(port: number): Promise<void> {
  const socket = net.connect(port, '127.0.0.1')
  const failed = await new Promise<boolean>((resolve) => {
    socket.once('connect', () => resolve(false))
    socket.once('error', () => resolve(true))
  })
  socket.destroy()
  expect(failed).toBe(true)
}

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { ErrorCode } from '@shared/types'
import { buildPingRequest, pingHost, pingServer, resultFromStatusJson } from '../../src/main/online/serverPing'

/* ------------------------------------------------------------------ */
/* Independent reference codec (deliberately not the module under test) */
/* ------------------------------------------------------------------ */

function refVarInt(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining & 0x7f)
  return Buffer.from(bytes)
}

function refReadVarInt(buffer: Buffer, at: number): { value: number; bytes: number } | undefined {
  let value = 0
  let shift = 0
  let used = 0
  for (let i = 0; i < 5; i += 1) {
    if (at + used >= buffer.length) return undefined
    const byte = buffer[at + used]!
    used += 1
    value |= (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value: value | 0, bytes: used }
    shift += 7
  }
  return undefined
}

function refFrame(bodyParts: Buffer[]): Buffer {
  const body = Buffer.concat(bodyParts)
  return Buffer.concat([refVarInt(body.length), body])
}

interface SeenHandshake {
  protocol: number
  host: string
  port: number
  state: number
}

interface FakeServer {
  port: number
  handshake(): SeenHandshake | undefined
  close(): Promise<void>
}

type Responder = (handshake: SeenHandshake) => Buffer[]

/**
 * A minimal `status` server: parses the handshake the way vanilla does and
 * writes back whatever the test's responder produced.
 */
async function startFakeServer(responder: Responder, options: { endAfterReply?: boolean } = {}): Promise<FakeServer> {
  let handshake: SeenHandshake | undefined

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (handshake) return
      const length = refReadVarInt(buffer, 0)
      if (!length || buffer.length < length.bytes + length.value) return
      const packet = buffer.subarray(length.bytes, length.bytes + length.value)
      buffer = buffer.subarray(length.bytes + length.value)

      const id = refReadVarInt(packet, 0)
      const protocol = id ? refReadVarInt(packet, id.bytes) : undefined
      const hostLength = protocol ? refReadVarInt(packet, id!.bytes + protocol!.bytes) : undefined
      if (!id || !protocol || !hostLength) return

      const hostStart = id.bytes + protocol.bytes + hostLength.bytes
      const host = packet.toString('utf8', hostStart, hostStart + hostLength.value)
      const portOffset = hostStart + hostLength.value
      if (packet.length < portOffset + 3) return
      const port = packet.readUInt16BE(portOffset)
      const state = refReadVarInt(packet, portOffset + 2)
      handshake = { protocol: protocol.value, host, port, state: state?.value ?? -1 }
      for (const part of responder(handshake)) socket.write(part)
      // Half a packet plus a hang-up is the "server died mid-response" case; the
      // client must notice the close instead of waiting for its timeout.
      if (options.endAfterReply) socket.end()
    })
    socket.on('error', () => {
      /* the client hangs up; nothing to do */
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  return {
    port: address.port,
    handshake: () => handshake,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const STATUS_JSON = JSON.stringify({
  version: { name: 'Paper 1.21.4', protocol: 765 },
  players: { max: 120, online: 7, sample: [{ id: 'x', name: 'jiamou' }, { id: 'y', name: 'Steve' }] },
  description: {
    text: '§a欢迎来到',
    extra: [{ text: ' 测试服务器' }, { text: '§7 | ' }, '§bpaper']
  },
  favicon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg'
})

function respondOk(json = STATUS_JSON): Responder {
  const text = Buffer.from(json, 'utf8')
  return () => [refFrame([refVarInt(0x00), refVarInt(text.length), text])]
}

describe('serverPing', () => {
  it('completes a real status handshake and maps every field', async () => {
    const server = await startFakeServer(respondOk())
    try {
      const result = await pingServer('127.0.0.1', { port: server.port, timeoutMs: 5000 })
      const seen = server.handshake()
      expect(seen).toBeDefined()
      expect(seen?.protocol).toBe(-1) // PROTOCOL.pingProtocol: "version unknown"
      expect(seen?.state).toBe(1) // next state = status
      expect(seen?.host).toBe('127.0.0.1')
      expect(seen?.port).toBe(server.port)

      expect(result.online).toBe(true)
      expect(result.address).toBe('127.0.0.1')
      expect(result.port).toBe(server.port)
      expect(result.latencyMs).toBeGreaterThan(0)
      expect(result.motdPlain).toBe('欢迎来到 测试服务器 | paper')
      expect(result.motdJson).toContain('"extra"')
      expect(result.versionName).toBe('Paper 1.21.4')
      expect(result.protocol).toBe(765)
      expect(result.maxPlayers).toBe(120)
      expect(result.onlinePlayers).toBe(7)
      expect(result.samplePlayers).toEqual(['jiamou', 'Steve'])
      expect(result.iconPngBase64).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg')
      expect(result.error).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('accepts host:port in the address and a plain string MOTD', async () => {
    const json = JSON.stringify({ version: { name: '1.20.4', protocol: 763 }, players: { max: 20, online: 0 }, description: '§e只用文字' })
    const server = await startFakeServer(respondOk(json))
    try {
      const result = await pingHost(`127.0.0.1:${server.port}`)
      expect(result.online).toBe(true)
      expect(result.port).toBe(server.port)
      expect(result.motdPlain).toBe('只用文字')
      expect(result.samplePlayers).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('turns a truncated response into a typed error, not a crash', async () => {
    const text = Buffer.from(STATUS_JSON, 'utf8')
    const framed = refFrame([refVarInt(0x00), refVarInt(text.length), text])
    const server = await startFakeServer(() => [framed.subarray(0, Math.floor(framed.length / 2))], { endAfterReply: true })
    try {
      const result = await pingServer('127.0.0.1', { port: server.port, timeoutMs: 3000 })
      expect(result.online).toBe(false)
      const codes: ErrorCode[] = ['network', 'invalid-input']
      expect(codes).toContain(result.error?.code)
      expect(result.error?.message.length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('rejects a wrong packet id and a non-JSON body with invalid-input', async () => {
    const wrongId = await startFakeServer(() => [refFrame([refVarInt(0x09), refVarInt(2), Buffer.from('{}')])], { endAfterReply: true })
    try {
      const result = await pingServer('127.0.0.1', { port: wrongId.port, timeoutMs: 3000 })
      expect(result.online).toBe(false)
      expect(result.error?.code).toBe('invalid-input')
    } finally {
      await wrongId.close()
    }

    const notJson = await startFakeServer(respondOk('this is not json'), { endAfterReply: true })
    try {
      const result = await pingServer('127.0.0.1', { port: notJson.port, timeoutMs: 3000 })
      expect(result.online).toBe(false)
      expect(result.error?.code).toBe('invalid-input')
    } finally {
      await notJson.close()
    }

    const garbage = await startFakeServer(() => [Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])], { endAfterReply: true })
    try {
      const result = await pingServer('127.0.0.1', { port: garbage.port, timeoutMs: 800 })
      expect(result.online).toBe(false)
      expect(['invalid-input', 'network']).toContain(result.error?.code)
    } finally {
      await garbage.close()
    }
  })

  it('reports refused connections and timeouts as network errors', async () => {
    // Bind then close to obtain a port nothing is listening on any more.
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const deadPort = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const refused = await pingHost('127.0.0.1', deadPort, { timeoutMs: 2000 })
    expect(refused.online).toBe(false)
    expect(refused.error?.code).toBe('network')

    const silent = await startFakeServer(() => [])
    try {
      const timedOut = await pingServer('127.0.0.1', { port: silent.port, timeoutMs: 400 })
      expect(timedOut.online).toBe(false)
      expect(timedOut.error?.code).toBe('network')
      expect(timedOut.error?.message).toContain('超时')
    } finally {
      await silent.close()
    }
  })

  it('maps a DNS failure to a typed network error without opening a socket', async () => {
    const result = await pingHost('no-such-host.invalid', 25565, { timeoutMs: 3000 })
    expect(result.online).toBe(false)
    expect(result.error?.code).toBe('network')
  })

  it('rejects an empty address up front', async () => {
    const result = await pingServer('   ')
    expect(result.online).toBe(false)
    expect(result.error?.code).toBe('invalid-input')
  })

  it('builds the exact two request packets', () => {
    const request = buildPingRequest('mc.example.com', 25565)
    const host = Buffer.from('mc.example.com', 'utf8')
    // handshake body = id(1) + protocol(-1 as 5 bytes) + hostLenVarint(1) + host + port(2) + state(1)
    const bodyLength = 1 + 5 + 1 + host.length + 2 + 1
    const portOffset = 1 + 1 + 5 + 1 + host.length
    expect(request.readUInt8(0)).toBe(bodyLength)
    expect(request.readUInt8(1)).toBe(0x00)
    expect([...request.subarray(2, 7)]).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f])
    expect(request.readUInt8(7)).toBe(host.length)
    expect(request.toString('utf8', 8, 8 + host.length)).toBe('mc.example.com')
    expect(request.readUInt16BE(portOffset)).toBe(25565)
    expect(request.readUInt8(portOffset + 2)).toBe(1)
    // then the status request: [len=1][id=0]
    expect([...request.subarray(bodyLength + 1)]).toEqual([0x01, 0x00])
    expect(
      resultFromStatusJson('{"description":"ok","version":{"name":"1.21","protocol":767}}', 'h', 1, 5)
    ).toMatchObject({ address: 'h', port: 1, online: true, latencyMs: 5, motdPlain: 'ok', versionName: '1.21' })
  })
})

/**
 * Relay tunnel framing — the byte codec shared by the launcher client and the
 * standalone relay server. It is pure (no sockets, no timers) and total:
 * every function accepts any input and reports impossibility with `undefined`
 * instead of throwing, so a corrupt frame can never crash a tunnel.
 *
 * Two frame families travel over one WebSocket connection:
 * - control frames: UTF-8 JSON objects (`{ "t": "<type>", ... }`). A JSON text
 *   frame always starts with `{` (0x7b), never with the data marker, so the two
 *   families are unambiguously distinguishable.
 * - data frames: `[0x01][uint16 BE peerIdLen][peerId utf-8][payload]`.
 *
 * See docs/relay-protocol.md for the full protocol.
 */

export const PROTOCOL_NAME = 'moucx-relay'
export const PROTOCOL_VERSION = 1

/** First byte of a data frame; JSON control frames can never start with it. */
export const DATA_MARKER = 0x01
/** marker (1) + uint16 peer-id length (2). */
export const DATA_HEADER_BYTES = 3
export const MAX_PEER_ID_BYTES = 64
export const MAX_CONTROL_BYTES = 64 * 1024
export const MAX_DATA_PAYLOAD_BYTES = 256 * 1024

export type RelayRole = 'host' | 'joiner'

export type RelayErrorCode =
  | 'bad-request'
  | 'bad-password'
  | 'no-room'
  | 'no-host'
  | 'room-exists'
  | 'full'
  | 'protocol'
  | 'internal'

export interface RelayPeerInfo {
  id: string
  name: string
}

/** Discriminated union of every control frame the protocol defines. */
export type ControlFrame =
  | { t: 'hello'; client: string; protocol: number }
  | { t: 'host'; room: string; password?: string; targetPort?: number; listen?: boolean }
  | { t: 'join'; room: string; password?: string; token?: string }
  | { t: 'ok'; role: RelayRole; room: string; peer: string; token?: string; peers?: RelayPeerInfo[] }
  | { t: 'open'; room: string }
  | { t: 'opened'; peer: string }
  | { t: 'peer-open'; peer: string; name?: string }
  | { t: 'peer-close'; peer: string }
  | { t: 'peers'; peers: RelayPeerInfo[] }
  | { t: 'error'; code: RelayErrorCode; message: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  | { t: 'close'; reason?: string }

export type ControlType = ControlFrame['t']

export type Frame =
  | { kind: 'control'; control: ControlFrame }
  | { kind: 'data'; peerId: string; payload: Buffer }

const CONTROL_TYPES: readonly string[] = [
  'hello',
  'host',
  'join',
  'ok',
  'open',
  'opened',
  'peer-open',
  'peer-close',
  'peers',
  'error',
  'ping',
  'pong',
  'close'
]

/* ------------------------------------------------------------------ */
/* Input normalisation (WebSocket implementations differ)              */
/* ------------------------------------------------------------------ */

/** Buffers a `ws`/`WebSocket` message payload into bytes. Total. */
export function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength)
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView
    return Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
  }
  return Buffer.alloc(0)
}

export function isValidPeerId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_PEER_ID_BYTES) return false
  // Peer ids are minted by the relay: keep them to printable ASCII so a frame
  // never contains something a text-frames-only transport could not carry.
  return /^[\x21-\x7e]+$/.test(value)
}

export function isValidRoomName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

/* ------------------------------------------------------------------ */
/* Control frames                                                      */
/* ------------------------------------------------------------------ */

/** JSON text bytes; `undefined` when the frame is not a valid control frame. */
export function encodeControl(frame: ControlFrame): Buffer | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  if (!CONTROL_TYPES.includes((frame as ControlFrame).t)) return undefined
  let text: string
  try {
    text = JSON.stringify(frame)
  } catch {
    return undefined
  }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_CONTROL_BYTES) return undefined
  return bytes
}

/**
 * Parses a control frame. Unknown keys are dropped (the union decides what the
 * protocol means); malformed or untagged input yields `undefined`.
 */
export function decodeControl(raw: Buffer | string | Uint8Array | ArrayBuffer): ControlFrame | undefined {
  const bytes = toBuffer(raw)
  if (bytes.length === 0 || bytes.length > MAX_CONTROL_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  return normaliseControl(parsed)
}

function normaliseControl(value: unknown): ControlFrame | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const type = record.t
  if (typeof type !== 'string' || !CONTROL_TYPES.includes(type)) return undefined
  switch (type) {
    case 'hello': {
      const client = typeof record.client === 'string' ? record.client : ''
      const protocol = numberOr(record.protocol, 0)
      return { t: 'hello', client, protocol }
    }
    case 'host': {
      if (!isValidRoomName(record.room)) return undefined
      return {
        t: 'host',
        room: record.room,
        ...(typeof record.password === 'string' ? { password: record.password } : {}),
        ...(record.targetPort !== undefined ? { targetPort: numberOr(record.targetPort, 0) } : {}),
        ...(record.listen === true ? { listen: true } : {})
      }
    }
    case 'join': {
      if (!isValidRoomName(record.room)) return undefined
      return {
        t: 'join',
        room: record.room,
        ...(typeof record.password === 'string' ? { password: record.password } : {}),
        ...(typeof record.token === 'string' ? { token: record.token } : {})
      }
    }
    case 'ok': {
      if (record.role !== 'host' && record.role !== 'joiner') return undefined
      if (!isValidRoomName(record.room) || !isValidPeerId(record.peer)) return undefined
      const peers = peerInfos(record.peers)
      return {
        t: 'ok',
        role: record.role,
        room: record.room,
        peer: String(record.peer),
        ...(typeof record.token === 'string' ? { token: record.token } : {}),
        ...(peers ? { peers } : {})
      }
    }
    case 'open': {
      if (!isValidRoomName(record.room)) return undefined
      return { t: 'open', room: record.room }
    }
    case 'opened': {
      if (!isValidPeerId(record.peer)) return undefined
      return { t: 'opened', peer: String(record.peer) }
    }
    case 'peer-close': {
      if (!isValidPeerId(record.peer)) return undefined
      return { t: 'peer-close', peer: String(record.peer) }
    }
    case 'peer-open': {
      if (!isValidPeerId(record.peer)) return undefined
      const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined
      return name ? { t: 'peer-open', peer: String(record.peer), name } : { t: 'peer-open', peer: String(record.peer) }
    }
    case 'peers': {
      const peers = peerInfos(record.peers)
      if (!peers) return undefined
      return { t: 'peers', peers }
    }
    case 'error': {
      const code = typeof record.code === 'string' ? (record.code as RelayErrorCode) : 'internal'
      const message = typeof record.message === 'string' ? record.message : ''
      return { t: 'error', code, message }
    }
    case 'ping': {
      return { t: 'ping', ts: numberOr(record.ts, 0) }
    }
    case 'pong': {
      return { t: 'pong', ts: numberOr(record.ts, 0) }
    }
    case 'close': {
      const reason = typeof record.reason === 'string' ? record.reason : undefined
      return reason ? { t: 'close', reason } : { t: 'close' }
    }
    default:
      return undefined
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function peerInfos(value: unknown): RelayPeerInfo[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: RelayPeerInfo[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined
    const record = entry as Record<string, unknown>
    if (!isValidPeerId(record.id)) return undefined
    out.push({ id: String(record.id), name: typeof record.name === 'string' ? record.name : String(record.id) })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Data frames                                                         */
/* ------------------------------------------------------------------ */

/**
 * `[0x01][uint16 BE peerIdLen][peerId][payload]`.
 * `undefined` for an unusable peer id or an oversized frame — never a throw.
 */
export function encodeData(peerId: string, payload: Buffer): Buffer | undefined {
  if (!isValidPeerId(peerId)) return undefined
  const id = Buffer.from(peerId, 'utf8')
  if (id.length > MAX_PEER_ID_BYTES) return undefined
  const body = Buffer.isBuffer(payload) ? payload : toBuffer(payload)
  if (body.length > MAX_DATA_PAYLOAD_BYTES) return undefined
  const out = Buffer.allocUnsafe(DATA_HEADER_BYTES + id.length + body.length)
  out.writeUInt8(DATA_MARKER, 0)
  out.writeUInt16BE(id.length, 1)
  id.copy(out, DATA_HEADER_BYTES)
  body.copy(out, DATA_HEADER_BYTES + id.length)
  return out
}

/** Splits a data frame; `undefined` unless the bytes are exactly one. */
export function decodeData(raw: Buffer): { peerId: string; payload: Buffer } | undefined {
  const bytes = toBuffer(raw)
  if (bytes.length < DATA_HEADER_BYTES) return undefined
  if (bytes.readUInt8(0) !== DATA_MARKER) return undefined
  const idLength = bytes.readUInt16BE(1)
  if (idLength === 0 || idLength > MAX_PEER_ID_BYTES) return undefined
  if (bytes.length < DATA_HEADER_BYTES + idLength) return undefined
  const peerId = bytes.toString('utf8', DATA_HEADER_BYTES, DATA_HEADER_BYTES + idLength)
  if (!isValidPeerId(peerId)) return undefined
  const payload = bytes.subarray(DATA_HEADER_BYTES + idLength)
  if (payload.length > MAX_DATA_PAYLOAD_BYTES) return undefined
  return { peerId, payload: Buffer.from(payload) }
}

/* ------------------------------------------------------------------ */
/* One entry point                                                     */
/* ------------------------------------------------------------------ */

export function isDataFrame(raw: unknown): boolean {
  const bytes = toBuffer(raw)
  return bytes.length >= DATA_HEADER_BYTES && bytes.readUInt8(0) === DATA_MARKER
}

/** Encodes either family. Total: `undefined` when the frame is not encodable. */
export function encode(frame: Frame): Buffer | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  if (frame.kind === 'data') return encodeData(frame.peerId, frame.payload)
  return encodeControl(frame.control)
}

/** Decodes any transport payload into a typed frame. Total: never throws. */
export function decode(raw: unknown): Frame | undefined {
  const bytes = toBuffer(raw)
  if (bytes.length === 0) return undefined
  if (bytes.readUInt8(0) === DATA_MARKER) {
    const data = decodeData(bytes)
    return data ? { kind: 'data', ...data } : undefined
  }
  const control = decodeControl(bytes)
  return control ? { kind: 'control', control } : undefined
}

/** Convenience for building a frame object. */
export function controlFrame(control: ControlFrame): Frame {
  return { kind: 'control', control }
}

export function dataFrame(peerId: string, payload: Buffer): Frame {
  return { kind: 'data', peerId, payload }
}

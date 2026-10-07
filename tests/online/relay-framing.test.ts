import { describe, expect, it } from 'vitest'
import {
  DATA_HEADER_BYTES,
  DATA_MARKER,
  MAX_DATA_PAYLOAD_BYTES,
  MAX_PEER_ID_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  controlFrame,
  dataFrame,
  decode,
  decodeControl,
  decodeData,
  encode,
  encodeControl,
  encodeData,
  isDataFrame,
  isValidPeerId,
  isValidRoomName,
  toBuffer,
  type ControlFrame,
  type Frame
} from '../../src/main/online/relay/framing'

const ALL_CONTROLS: ControlFrame[] = [
  { t: 'hello', client: PROTOCOL_NAME, protocol: PROTOCOL_VERSION },
  { t: 'host', room: 'ABC123', password: 's3cret', targetPort: 25565, listen: true },
  { t: 'host', room: 'ABC123' },
  { t: 'join', room: 'ABC123', password: 's3cret' },
  { t: 'join', room: 'ABC123', token: 'tok' },
  { t: 'ok', role: 'host', room: 'ABC123', peer: 'p1', token: 'tok', peers: [{ id: 'p2', name: 'friend' }] },
  { t: 'ok', role: 'joiner', room: 'ABC123', peer: 'p2' },
  { t: 'open', room: 'ABC123' },
  { t: 'opened', peer: 'p3' },
  { t: 'peer-open', peer: 'p3', name: 'notch' },
  { t: 'peer-open', peer: 'p3' },
  { t: 'peer-close', peer: 'p3' },
  { t: 'peers', peers: [{ id: 'a', name: 'a' }] },
  { t: 'error', code: 'bad-password', message: '口令不正确' },
  { t: 'ping', ts: 1234 },
  { t: 'pong', ts: 4321 },
  { t: 'close', reason: 'bye' },
  { t: 'close' }
]

describe('relay framing: control frames', () => {
  it('round-trips every control frame through JSON', () => {
    for (const control of ALL_CONTROLS) {
      const bytes = encodeControl(control)
      expect(Buffer.isBuffer(bytes)).toBe(true)
      expect(bytes![0]).not.toBe(DATA_MARKER)
      expect(decodeControl(bytes!)).toEqual(control)
      expect(decode(bytes!)).toEqual({ kind: 'control', control })
    }
  })

  it('keeps the text readable for a wire dump', () => {
    const bytes = encodeControl({ t: 'join', room: 'ROOM', password: 'pw' })!
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ t: 'join', room: 'ROOM', password: 'pw' })
  })

  it('is total: junk in, undefined out', () => {
    expect(decodeControl(Buffer.alloc(0))).toBeUndefined()
    expect(decodeControl(Buffer.from(''))).toBeUndefined()
    expect(decodeControl(Buffer.from('{'))).toBeUndefined()
    expect(decodeControl(Buffer.from('not json at all'))).toBeUndefined()
    expect(decodeControl(Buffer.from('[]'))).toBeUndefined()
    expect(decodeControl(Buffer.from('"a string"'))).toBeUndefined()
    expect(decodeControl(Buffer.from('{"noType":1}'))).toBeUndefined()
    expect(decodeControl(Buffer.from('{"t":"teleport"}'))).toBeUndefined()
    expect(decodeControl(Buffer.from('{"t":"host"}'))).toBeUndefined() // room missing
    expect(decodeControl(Buffer.from('{"t":"opened"}'))).toBeUndefined() // peer missing
    expect(decodeControl(Buffer.from('{"t":"ok","role":"wizard","room":"a","peer":"p"}'))).toBeUndefined()
    expect(encodeControl({ t: 'teleport' } as unknown as ControlFrame)).toBeUndefined()
    expect(encodeControl(null as unknown as ControlFrame)).toBeUndefined()
  })

  it('drops unknown keys but keeps the declared ones', () => {
    const parsed = decodeControl(Buffer.from('{"t":"ping","ts":9,"extra":{"a":1},"when":"x"}'))
    expect(parsed).toEqual({ t: 'ping', ts: 9 })
  })
})

describe('relay framing: data frames', () => {
  it('writes the documented [0x01][uint16 len][peerId][payload] layout', () => {
    const bytes = encodeData('p1', Buffer.from([0x01, 0x02, 0x03]))!
    expect([...bytes]).toEqual([DATA_MARKER, 0x00, 0x02, 0x70, 0x31, 0x01, 0x02, 0x03])
    expect(bytes.length).toBe(DATA_HEADER_BYTES + 2 + 3)
  })

  it('round-trips payloads byte for byte, including an empty one', () => {
    const payloads: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from([0x00]),
      Buffer.from([0xff, 0xfe, 0x01, 0x7f]),
      Buffer.from(' handshake-ish \u0000 bytes', 'utf8'),
      Buffer.alloc(4096, 0xab)
    ]
    for (const payload of payloads) {
      for (const peerId of ['p1', 'host-42', 'a'.repeat(MAX_PEER_ID_BYTES), 'µ§']) {
        if (!isValidPeerId(peerId)) continue
        const encoded = encodeData(peerId, payload)
        expect(encoded).toBeDefined()
        const decoded = decodeData(encoded!)
        expect(decoded?.peerId).toBe(peerId)
        expect(decoded?.payload.equals(payload)).toBe(true)
        expect(decode(encoded!)).toEqual({ kind: 'data', peerId, payload })
      }
    }
  })

  it('refuses to encode what the format cannot carry', () => {
    expect(encodeData('', Buffer.from('x'))).toBeUndefined()
    expect(encodeData('x'.repeat(MAX_PEER_ID_BYTES + 1), Buffer.from('x'))).toBeUndefined()
    expect(encodeData('has space', Buffer.from('x'))).toBeUndefined()
    expect(encodeData('p1', Buffer.alloc(MAX_DATA_PAYLOAD_BYTES + 1))).toBeUndefined()
    expect(encode({ kind: 'data', peerId: '', payload: Buffer.alloc(0) })).toBeUndefined()
    expect(encode(null as unknown as Frame)).toBeUndefined()
  })

  it('decodes malformed data frames as undefined instead of throwing', () => {
    const truncatedHeader = Buffer.from([DATA_MARKER, 0x00])
    const truncatedId = Buffer.from([DATA_MARKER, 0x00, 0x05, 0x70])
    const zeroLengthId = Buffer.from([DATA_MARKER, 0x00, 0x00, 0x70])
    const hugeId = Buffer.from([DATA_MARKER, 0xff, 0xff, 0x70])
    const wrongMarker = Buffer.from([0x02, 0x00, 0x01, 0x70])
    const markerOnly = Buffer.from([DATA_MARKER])
    const emptyIdPayload = Buffer.concat([Buffer.from([DATA_MARKER, 0x00, 0x01]), Buffer.from([0x20]), Buffer.from('x')])
    for (const raw of [
      Buffer.alloc(0),
      truncatedHeader,
      truncatedId,
      zeroLengthId,
      hugeId,
      wrongMarker,
      markerOnly,
      Buffer.from('{"t":"ping"}'),
      Buffer.from([0x00])
    ]) {
      expect(decodeData(raw)).toBeUndefined()
    }
    // Control bytes inside a peer id are not allowed; the frame is rejected.
    expect(decodeData(emptyIdPayload)).toBeUndefined()
    // A data frame with an empty payload is legal (a keep-alive).
    expect(decodeData(encodeData('p9', Buffer.alloc(0))!)).toEqual({ peerId: 'p9', payload: Buffer.alloc(0) })
  })
})

describe('relay framing: dispatch', () => {
  it('tells the two families apart from the first byte', () => {
    const data = encode({ kind: 'data', peerId: 'p1', payload: Buffer.from('hello') })!
    const control = encode(controlFrame({ t: 'pong', ts: 1 }))!
    expect(isDataFrame(data)).toBe(true)
    expect(isDataFrame(control)).toBe(false)
    expect(isDataFrame('{"t":"pong","ts":1}')).toBe(false)
    expect(isDataFrame(null)).toBe(false)
    expect(decode(data)).toEqual(dataFrame('p1', Buffer.from('hello')))
    expect(decode(control)).toEqual({ kind: 'control', control: { t: 'pong', ts: 1 } })
    expect(decode(Buffer.alloc(0))).toBeUndefined()
    expect(decode(undefined)).toBeUndefined()
    expect(decode('')).toBeUndefined()
  })

  it('normalises every transport payload shape', () => {
    const bytes = encodeData('p1', Buffer.from([7]))!
    const view = new Uint8Array(bytes)
    const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
    expect(toBuffer(bytes)).toBe(bytes)
    expect(toBuffer(view)).toBeInstanceOf(Buffer)
    expect(toBuffer(buffer)).toBeInstanceOf(Buffer)
    expect(toBuffer('abc').toString()).toBe('abc')
    expect(toBuffer(42).length).toBe(0)
    expect(toBuffer(undefined).length).toBe(0)
    expect(decode(view)).toBeDefined()
    expect(decode(buffer)).toBeDefined()
    expect(decode(bytes.toString('utf8'))).toBeDefined()
  })

  it('validates room and peer ids the same way the relay server does', () => {
    expect(isValidRoomName('ABC123')).toBe(true)
    expect(isValidRoomName('')).toBe(false)
    expect(isValidRoomName('x'.repeat(65))).toBe(false)
    expect(isValidPeerId('p1')).toBe(true)
    expect(isValidPeerId('p 1')).toBe(false)
    expect(isValidPeerId('µ')).toBe(false)
    expect(isValidPeerId(7 as unknown as string)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  MAX_VARINT_BYTES,
  decodeString,
  decodeVarInt,
  encodeString,
  encodeVarInt,
  framePacket,
  readString,
  readUnsignedShort,
  readVarInt,
  varIntSize,
  writeUnsignedShort,
  writeVarInt
} from '../../src/main/online/varint'

/** Reference encoding written straight from the LEB128 description. */
function referenceVarInt(value: number): number[] {
  const out: number[] = []
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  out.push(remaining & 0x7f)
  return out
}

describe('varint', () => {
  it('encodes the documented edge values', () => {
    expect([...encodeVarInt(0)]).toEqual([0x00])
    expect([...encodeVarInt(127)]).toEqual([0x7f])
    expect([...encodeVarInt(128)]).toEqual([0x80, 0x01])
    expect([...encodeVarInt(255)]).toEqual([0xff, 0x01])
    expect([...encodeVarInt(2097151)]).toEqual([0xff, 0xff, 0x7f])
    expect([...encodeVarInt(2147483647)]).toEqual([0xff, 0xff, 0xff, 0xff, 0x07])
    // Java writes the signed -1 as five bytes of 0xff followed by 0x0f.
    expect([...encodeVarInt(-1)]).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f])
    expect([...encodeVarInt(-2147483648)]).toEqual([0x80, 0x80, 0x80, 0x80, 0x08])
  })

  it('matches the reference encoder across the range', () => {
    const values = [0, 1, 63, 64, 127, 128, 255, 256, 16383, 16384, 2097151, 268435455, 2147483647, -1, -128, -2147483648]
    for (const value of values) {
      expect([...encodeVarInt(value)]).toEqual(referenceVarInt(value))
      expect(varIntSize(value)).toBe(referenceVarInt(value).length)
      expect(decodeVarInt(encodeVarInt(value))).toBe(value)
    }
  })

  it('reports a continuation bit at end of buffer as incomplete, not corrupt', () => {
    expect(readVarInt(Buffer.from([0x80]))).toEqual({ kind: 'incomplete', bytes: 1 })
    expect(readVarInt(Buffer.from([0x80, 0x80]))).toEqual({ kind: 'incomplete', bytes: 2 })
    expect(readVarInt(Buffer.alloc(0))).toEqual({ kind: 'incomplete', bytes: 0 })
    expect(readVarInt(Buffer.from([0xff, 0xff, 0x7f]))).toEqual({ kind: 'ok', value: 2097151, bytes: 3 })
    // A prefix followed by unrelated bytes still decodes the prefix only.
    expect(decodeVarInt(Buffer.from([0x05, 0x99]))).toBe(5)
  })

  it('rejects a varint longer than 5 bytes', () => {
    const tooLong = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])
    expect(readVarInt(tooLong)).toEqual({ kind: 'error', message: 'VarInt 超过 5 字节' })
    let thrown: AppError | undefined
    try {
      decodeVarInt(tooLong)
    } catch (error) {
      thrown = error instanceof AppError ? error : undefined
    }
    expect(thrown?.code).toBe('invalid-input')
  })

  it('throws a typed error when a one-shot decode is truncated', () => {
    expect(() => decodeVarInt(Buffer.from([0x80, 0x80]))).toThrowError(/截断/)
    expect(() => decodeVarInt(Buffer.from([0xff]))).toThrowError(AppError)
    expect(MAX_VARINT_BYTES).toBe(5)
  })

  it('writes into a caller supplied buffer without overrunning it', () => {
    const target = Buffer.alloc(8, 0xaa)
    const written = writeVarInt(target, 2, 300)
    expect(written).toBe(2)
    expect([...target]).toEqual([0xaa, 0xaa, 0xac, 0x02, 0xaa, 0xaa, 0xaa, 0xaa])
    expect(() => writeVarInt(Buffer.alloc(1), 0, 2097151)).toThrowError(AppError)
  })

  it('reads and writes protocol strings', () => {
    for (const text of ['', 'a', 'mc.hypixel.net', '中文 §a MOTD', '🙂 emoji']) {
      const bytes = encodeString(text)
      expect(readString(bytes)).toEqual({ kind: 'ok', value: text, bytes: bytes.length })
      expect(decodeString(bytes)).toBe(text)
    }
    const truncated = encodeString('hello').subarray(0, 4)
    expect(readString(truncated).kind).toBe('incomplete')
    expect(() => decodeString(truncated)).toThrowError(AppError)
  })

  it('frames packets and handles unsigned shorts', () => {
    const body = Buffer.from([0x00])
    expect([...framePacket(body)]).toEqual([0x01, 0x00])
    expect([...writeUnsignedShort(25565)]).toEqual([0x63, 0xdd])
    expect(readUnsignedShort(Buffer.from([0x63, 0xdd]), 0)).toBe(25565)
    expect(() => writeUnsignedShort(70000)).toThrowError(/范围/)
    expect(() => writeUnsignedShort(-1)).toThrowError(AppError)
    expect(() => readUnsignedShort(Buffer.from([0x01]), 0)).toThrowError(AppError)
  })
})

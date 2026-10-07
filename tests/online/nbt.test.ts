import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { AppError } from '@shared/errors'
import {
  Tag,
  big,
  childTag,
  decodeJavaUtf8,
  encodeJavaUtf8,
  listTag,
  nbtList,
  num,
  read,
  toGzip,
  withTags,
  write,
  writeNode,
  type NbtCompound
} from '../../src/main/online/nbt'

/** A compound holding one value of every tag, with the tags pinned explicitly. */
function everyTag(): NbtCompound {
  const inner = withTags({ deep: Tag.Int, text: Tag.String }, { deep: 7, text: '内层' })
  return withTags(
    {
      b: Tag.Byte,
      s: Tag.Short,
      i: Tag.Int,
      l: Tag.Long,
      f: Tag.Float,
      d: Tag.Double,
      ba: Tag.ByteArray,
      str: Tag.String,
      list: Tag.List,
      comp: Tag.Compound,
      ia: Tag.IntArray,
      la: Tag.LongArray,
      elist: Tag.List,
      nlist: Tag.List
    },
    {
      b: -5,
      s: 300,
      i: -1000,
      l: 9007199254740993n,
      f: 1.5,
      d: 3.141592653589793,
      ba: Buffer.from([1, 2, 253]),
      str: 'héllo \u0000 world',
      list: nbtList(['a', 'b'], Tag.String),
      comp: inner,
      ia: [10, -20],
      la: [1n, -2n, 9007199254740993n],
      elist: nbtList([], Tag.End),
      nlist: nbtList([withTags({ x: Tag.Byte }, { x: 1 })], Tag.Compound)
    }
  )
}

function errorOf(fn: () => unknown): AppError | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof AppError ? error : undefined
  }
}

describe('nbt wire format', () => {
  it('writes the documented big-endian layout for scalar tags', () => {
    const buffer = write(
      withTags({ b: Tag.Byte, s: Tag.Short, i: Tag.Int, l: Tag.Long, str: Tag.String }, { b: -5, s: 300, i: -1000, l: 5n, str: 'hi' })
    )
    const expected = [
      0x0a, 0x00, 0x00, // TAG_Compound, name length 0
      0x01, 0x00, 0x01, 0x62, 0xfb, // Byte "b" = -5
      0x02, 0x00, 0x01, 0x73, 0x01, 0x2c, // Short "s" = 300
      0x03, 0x00, 0x01, 0x69, 0xff, 0xff, 0xfc, 0x18, // Int "i" = -1000
      0x04, 0x00, 0x01, 0x6c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, // Long "l" = 5
      0x08, 0x00, 0x03, 0x73, 0x74, 0x72, 0x00, 0x02, 0x68, 0x69, // String "str" = "hi"
      0x00 // TAG_End
    ]
    expect([...buffer]).toEqual(expected)
  })

  it('round-trips every tag byte for byte, uncompressed', () => {
    const first = write(everyTag(), '根节点')
    const parsed = read(first)
    expect(parsed.name).toBe('根节点')
    const again = writeNode(parsed)
    expect(again.equals(first)).toBe(true)
    // And the values survive a second pass unchanged.
    expect(read(again).value).toEqual(parsed.value)
  })

  it('keeps Long as bigint and coerces numbers on read', () => {
    const parsed = read(write(everyTag()))
    const value = parsed.value as NbtCompound
    expect(typeof value.l).toBe('bigint')
    expect(value.l).toBe(9007199254740993n)
    expect(num(value.l)).toBe(Number(9007199254740993n))
    expect(big(value.i)).toBe(-1000n)
    expect(num(value.b)).toBe(-5)
    expect(Buffer.isBuffer(value.ba)).toBe(true)
    expect((value.ba as Buffer).equals(Buffer.from([1, 2, 253]))).toBe(true)
    expect(Array.isArray(value.ia)).toBe(true)
    expect(value.la).toEqual([1n, -2n, 9007199254740993n])
    expect(childTag(value, 'b')).toBe(Tag.Byte)
    expect(childTag(value, 's')).toBe(Tag.Short)
    expect(childTag(value, 'f')).toBe(Tag.Float)
    expect(listTag(value.list)).toBe(Tag.String)
  })

  it('inflates gzip and zlib input automatically', () => {
    const raw = write(everyTag())
    const gzipped = toGzip(raw)
    expect(gzipped.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    const zipped = deflateSync(raw)
    expect(zipped[0]).toBe(0x78)
    const fromGzip = read(gzipped)
    const fromZlib = read(zipped)
    expect(fromGzip.value).toEqual(fromZlib.value)
    expect(writeNode(fromGzip).equals(raw)).toBe(true)
  })

  it('encodes names and payloads as Java modified UTF-8', () => {
    expect([...encodeJavaUtf8('a\u0000b')]).toEqual([0x61, 0xc0, 0x80, 0x62])
    expect(decodeJavaUtf8(Buffer.from([0xc0, 0x80]))).toBe('\u0000')
    // Supplementary characters are two three-byte surrogate halves in Java.
    const emoji = '\u{1f600}'
    const encoded = encodeJavaUtf8(emoji)
    expect(encoded.length).toBe(6)
    expect(decodeJavaUtf8(encoded)).toBe(emoji)
    const doc = withTags({ t: Tag.String }, { t: emoji })
    expect((read(write(doc)).value as NbtCompound).t).toBe(emoji)
  })

  it('rejects truncated or unknown-tag input with a typed AppError', () => {
    const raw = write(everyTag())
    expect(errorOf(() => read(raw.subarray(0, raw.length - 6)))?.code).toBe('invalid-input')
    expect(errorOf(() => read(Buffer.from([0x0a, 0x00, 0x02, 0x78, 0x79])))).toBeDefined()
    expect(errorOf(() => read(Buffer.from([0x64, 0x00, 0x00, 0x00])))).toBeDefined()
    // A list claiming 100k strings inside 4 bytes must not hang or over-read.
    const liar = Buffer.from([0x0a, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x01, 0x0a, 0x00, 0x00])
    expect(errorOf(() => read(liar))?.code).toBe('invalid-input')
  })

  it('writes an empty list with the declared element tag', () => {
    const doc = withTags({ list: Tag.List }, { list: nbtList([], Tag.Int) })
    const bytes = write(doc)
    expect([...bytes]).toEqual([0x0a, 0x00, 0x00, 0x09, 0x00, 0x04, 0x6c, 0x69, 0x73, 0x74, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00])
    expect(listTag((read(bytes).value as NbtCompound).list)).toBe(Tag.Int)
  })
})

/**
 * NBT (Named Binary Tag) codec.
 *
 * Implemented from the public byte layout described at
 * https://minecraft.wiki/w/Nbt_format (verified 2026-10-07): every multi-byte
 * number is big-endian, a named tag is `[tagId][name-length:uint16][name][payload]`,
 * strings use Java "modified UTF-8", compounds terminate with tag 0 (End) and
 * lists prefix their payload with the element tag id plus an int32 count.
 * Nothing is copied from another project: only the wire format is reused.
 *
 * Type fidelity:
 * - `Long` / `LongArray` use `bigint`, everything else numeric is a `number`.
 * - `Byte`/`Short`/`Int`/`Float` cannot be told apart once they are JS numbers,
 *   so the tag id each value was read with is remembered in a hidden,
 *   non-enumerable symbol property on the containing compound/list. That is what
 *   makes `write(read(bytes))` byte-identical and what lets `servers.dat`
 *   rewrite `acceptTextures` as a real Byte.
 * - Values you build yourself can be tagged explicitly with {@link withTags}
 *   and {@link nbtList}.
 */

import { gunzipSync, gzipSync, inflateSync } from 'node:zlib'
import { AppError } from '@shared/errors'

export const Tag = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12
} as const

export type TagId = (typeof Tag)[keyof typeof Tag]

/** An interface (not a mapped type) so `NbtValue` can recurse without a cycle. */
export interface NbtCompound {
  [key: string]: NbtValue
}
export type NbtList = NbtValue[]
export type NbtValue = number | bigint | string | Buffer | NbtList | NbtCompound

/** What {@link read} returns: the (possibly empty) root name plus its payload. */
export interface NbtNode {
  name: string
  value: NbtValue
}

export interface ReadOptions {
  /** Do not transparently inflate gzip/zlib payloads. */
  noDecompress?: boolean
  maxDepth?: number
  maxBytes?: number
}

const TAG_HINTS = Symbol.for('mouc.nbt.tagHints')
const DEFAULT_MAX_DEPTH = 256
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const MAX_ARRAY_ITEMS = 16 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* Java modified UTF-8                                                 */
/* ------------------------------------------------------------------ */

/**
 * `DataOutput.writeUTF`: U+0000 becomes the two-byte `C0 80` form and
 * supplementary characters are written as two three-byte surrogate halves,
 * which is why this is not plain UTF-8.
 */
export function encodeJavaUtf8(text: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0) {
      out.push(0xc0, 0x80)
    } else if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return Buffer.from(out)
}

export function decodeJavaUtf8(bytes: Buffer): string {
  let out = ''
  let pendingHigh = -1
  let i = 0
  while (i < bytes.length) {
    const first = bytes[i]!
    let code: number
    if ((first & 0x80) === 0) {
      code = first
      i += 1
    } else if ((first & 0xe0) === 0xc0) {
      code = ((first & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f)
      i += 2
    } else {
      code = ((first & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f)
      i += 3
    }
    if (pendingHigh >= 0 && code >= 0xdc00 && code <= 0xdfff) {
      out += String.fromCharCode(pendingHigh, code)
      pendingHigh = -1
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      pendingHigh = code
      continue
    }
    out += String.fromCharCode(code)
  }
  if (pendingHigh >= 0) out += String.fromCharCode(pendingHigh)
  return out
}

/* ------------------------------------------------------------------ */
/* Tag hints (type fidelity)                                           */
/* ------------------------------------------------------------------ */

type Hints = Map<string, TagId> | TagId

function attachHints(container: object, hints: Hints): void {
  Object.defineProperty(container, TAG_HINTS, {
    value: hints,
    enumerable: false,
    configurable: true,
    writable: true
  })
}

/** Which tag id `container[key]` was read from (or should be written as). */
export function childTag(container: NbtValue | undefined, key: string): TagId | undefined {
  const hints = rawHints(container)
  return hints instanceof Map ? hints.get(key) : undefined
}

/** Element tag of a list that was read from (or built for) the wire. */
export function listTag(list: NbtValue | undefined): TagId | undefined {
  const hints = rawHints(list)
  return typeof hints === 'number' ? hints : undefined
}

function rawHints(container: unknown): Hints | undefined {
  if (!container || typeof container !== 'object') return undefined
  return (container as Record<symbol, Hints | undefined>)[TAG_HINTS]
}

function compoundHints(container: unknown): Map<string, TagId> | undefined {
  const hints = rawHints(container)
  return hints instanceof Map ? hints : undefined
}

/** Declares tag ids for a compound's fields so {@link write} keeps them narrow. */
export function withTags(tags: Partial<Record<string, TagId>>, value: NbtCompound): NbtCompound {
  const pairs = Object.entries(tags).filter((entry): entry is [string, TagId] => entry[1] !== undefined)
  attachHints(value, new Map<string, TagId>(pairs))
  return value
}

/** Builds a list whose element tag is known up front (required for empty lists). */
export function nbtList(items: NbtValue[], elementTag: TagId): NbtList {
  attachHints(items, elementTag)
  return items
}

/** Adds the tag ids of `source` onto `target` for the given keys, merging. */
export function carryTags(source: NbtCompound, target: NbtCompound, keys: string[]): void {
  const hints = compoundHints(source)
  if (!hints) return
  const merged = new Map<string, TagId>(compoundHints(target) ?? [])
  for (const key of keys) {
    const tag = hints.get(key)
    if (tag !== undefined && Object.prototype.hasOwnProperty.call(target, key)) merged.set(key, tag)
  }
  if (merged.size > 0) attachHints(target, merged)
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

export function isCompound(value: NbtValue | undefined): value is NbtCompound {
  return typeof value === 'object' && value !== null && !Buffer.isBuffer(value) && !Array.isArray(value)
}

export function isList(value: NbtValue | undefined): value is NbtList {
  return Array.isArray(value)
}

/** Coerces a value read from NBT into a `number` (Longs arrive as bigint). */
export function num(value: NbtValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : undefined
  }
  return undefined
}

/** Coerces a value read from NBT into a `bigint`. */
export function big(value: NbtValue | undefined): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

export function asCompound(value: NbtValue | undefined): NbtCompound | undefined {
  return isCompound(value) ? value : undefined
}

export function asList(value: NbtValue | undefined): NbtList | undefined {
  return isList(value) ? value : undefined
}

export function asString(value: NbtValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Case-insensitive compound lookup (`MOTD` / `motd`, `Port` / `port`). */
export function lookup(compound: NbtCompound | undefined, ...keys: string[]): NbtValue | undefined {
  if (!compound) return undefined
  const wanted = keys.map((key) => key.toLowerCase())
  for (const [key, value] of Object.entries(compound)) {
    if (wanted.includes(key.toLowerCase())) return value
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function invalid(message: string, detail?: string): AppError {
  return new AppError('invalid-input', message, detail)
}

class ByteReader {
  offset = 0
  readonly buffer: Buffer

  constructor(buffer: Buffer, maxBytes: number) {
    if (buffer.length > maxBytes) throw invalid('NBT 数据过大', `${buffer.length} bytes`)
    this.buffer = buffer
  }

  private need(bytes: number, what: string): void {
    if (this.buffer.length - this.offset < bytes) {
      throw invalid(`NBT 数据不完整：读取${what}时越界`, `offset=${this.offset}, need=${bytes}`)
    }
  }

  u8(): number {
    this.need(1, '字节')
    return this.buffer[this.offset++]!
  }

  i8(): number {
    this.need(1, 'Byte')
    return this.buffer.readInt8(this.offset++)
  }

  i16(): number {
    this.need(2, 'Short')
    const value = this.buffer.readInt16BE(this.offset)
    this.offset += 2
    return value
  }

  i32(): number {
    this.need(4, 'Int')
    const value = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  i64(): bigint {
    this.need(8, 'Long')
    const value = this.buffer.readBigInt64BE(this.offset)
    this.offset += 8
    return value
  }

  f32(): number {
    this.need(4, 'Float')
    const value = this.buffer.readFloatBE(this.offset)
    this.offset += 4
    return value
  }

  f64(): number {
    this.need(8, 'Double')
    const value = this.buffer.readDoubleBE(this.offset)
    this.offset += 8
    return value
  }

  bytes(length: number): Buffer {
    this.need(length, '字节串')
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  u16(): number {
    this.need(2, '名称长度')
    const value = this.buffer.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  javaString(): string {
    const length = this.u16()
    return decodeJavaUtf8(this.bytes(length))
  }

  /** Reads an element count and pre-checks that the fixed-width payload fits. */
  count(itemBytes: number, what: string): number {
    const value = this.i32()
    if (value < 0 || value > MAX_ARRAY_ITEMS) throw invalid(`NBT ${what} 长度非法`, String(value))
    if (itemBytes > 0) this.need(value * itemBytes, what)
    return value
  }

  byteRange(): Buffer {
    return Buffer.from(this.bytes(this.count(1, 'ByteArray')))
  }

  intRange(): number[] {
    const total = this.count(4, 'IntArray')
    const out: number[] = []
    for (let i = 0; i < total; i += 1) out.push(this.i32())
    return out
  }

  longRange(): bigint[] {
    const total = this.count(8, 'LongArray')
    const out: bigint[] = []
    for (let i = 0; i < total; i += 1) out.push(this.i64())
    return out
  }
}

function tagSize(tag: number): number {
  switch (tag) {
    case Tag.Byte:
      return 1
    case Tag.Short:
      return 2
    case Tag.Int:
    case Tag.Float:
      return 4
    case Tag.Long:
    case Tag.Double:
      return 8
    default:
      return 0
  }
}

function readValue(reader: ByteReader, tag: number, depth: number, maxDepth: number): NbtValue {
  switch (tag) {
    case Tag.End:
      return 0
    case Tag.Byte:
      return reader.i8()
    case Tag.Short:
      return reader.i16()
    case Tag.Int:
      return reader.i32()
    case Tag.Long:
      return reader.i64()
    case Tag.Float:
      return reader.f32()
    case Tag.Double:
      return reader.f64()
    case Tag.ByteArray:
      return reader.byteRange()
    case Tag.String:
      return reader.javaString()
    case Tag.List:
      return readList(reader, depth, maxDepth)
    case Tag.Compound:
      return readCompound(reader, depth, maxDepth)
    case Tag.IntArray:
      return reader.intRange()
    case Tag.LongArray:
      return reader.longRange()
    default:
      throw invalid('NBT 标签未知', `tag=${tag}`)
  }
}

function readCompound(reader: ByteReader, depth: number, maxDepth: number): NbtCompound {
  if (depth > maxDepth) throw invalid('NBT 嵌套过深', String(depth))
  const out: NbtCompound = {}
  const hints = new Map<string, TagId>()
  for (;;) {
    const tag = reader.u8()
    if (tag === Tag.End) break
    if (tag > Tag.LongArray) throw invalid('NBT 标签未知', `tag=${tag}`)
    const name = reader.javaString()
    out[name] = readValue(reader, tag, depth + 1, maxDepth)
    hints.set(name, tag as TagId)
  }
  attachHints(out, hints)
  return out
}

function readList(reader: ByteReader, depth: number, maxDepth: number): NbtList {
  if (depth > maxDepth) throw invalid('NBT 嵌套过深', String(depth))
  const elementTag = reader.u8()
  if (elementTag > Tag.LongArray) throw invalid('NBT List 元素标签未知', `tag=${elementTag}`)
  const total = reader.count(tagSize(elementTag), 'List')
  const items: NbtValue[] = []
  for (let i = 0; i < total; i += 1) items.push(readValue(reader, elementTag, depth + 1, maxDepth))
  attachHints(items, elementTag as TagId)
  return items
}

/**
 * Sniffs the two compressions Minecraft writes NBT with: gzip starts with
 * `0x1f 0x8b`, zlib with a `0x78` CMF byte. An uncompressed document always
 * starts with a tag id (0..12), so the sniff cannot be ambiguous.
 */
export function decompressSniff(buffer: Buffer): Buffer {
  if (buffer.length < 2) return buffer
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return gunzipSync(buffer)
    } catch (error) {
      throw invalid('NBT gzip 数据损坏', String((error as Error).message ?? error))
    }
  }
  if (buffer[0] === 0x78) {
    try {
      return inflateSync(buffer)
    } catch {
      return buffer
    }
  }
  return buffer
}

/** Reads a whole NBT document, transparently inflating gzip/zlib input. */
export function read(buffer: Buffer, options: ReadOptions = {}): NbtNode {
  if (!Buffer.isBuffer(buffer)) throw invalid('NBT 输入必须是 Buffer')
  const raw = options.noDecompress ? buffer : decompressSniff(buffer)
  const reader = new ByteReader(raw, options.maxBytes ?? DEFAULT_MAX_BYTES)
  const rootTag = reader.u8()
  if (rootTag !== Tag.Compound && rootTag !== Tag.End) {
    throw invalid('NBT 根节点必须是 Compound', `tag=${rootTag}`)
  }
  const name = reader.javaString()
  const value = readValue(reader, rootTag, 0, options.maxDepth ?? DEFAULT_MAX_DEPTH)
  return { name, value }
}

/** True when the bytes look like (possibly compressed) NBT. */
export function looksLikeNbt(buffer: Buffer): boolean {
  if (buffer.length < 3) return false
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return true
  if (buffer[0] === 0x78) return true
  return buffer[0] === Tag.Compound || buffer[0] === Tag.End
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

class ByteWriter {
  private chunks: Buffer[] = []
  private length = 0

  push(buffer: Buffer): void {
    this.chunks.push(buffer)
    this.length += buffer.length
  }

  u8(value: number): void {
    const b = Buffer.allocUnsafe(1)
    b.writeUInt8(value & 0xff)
    this.push(b)
  }

  u16(value: number): void {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16BE(value & 0xffff)
    this.push(b)
  }

  i8(value: number): void {
    const b = Buffer.allocUnsafe(1)
    b.writeInt8(checkRange(value, -0x80, 0x7f, 'Byte'))
    this.push(b)
  }

  i16(value: number): void {
    const b = Buffer.allocUnsafe(2)
    b.writeInt16BE(checkRange(value, -0x8000, 0x7fff, 'Short'))
    this.push(b)
  }

  i32(value: number): void {
    const b = Buffer.allocUnsafe(4)
    b.writeInt32BE(checkRange(value, -0x8000_0000, 0x7fff_ffff, 'Int'))
    this.push(b)
  }

  i64(value: bigint): void {
    const b = Buffer.allocUnsafe(8)
    b.writeBigInt64BE(value)
    this.push(b)
  }

  f32(value: number): void {
    const b = Buffer.allocUnsafe(4)
    b.writeFloatBE(value)
    this.push(b)
  }

  f64(value: number): void {
    const b = Buffer.allocUnsafe(8)
    b.writeDoubleBE(value)
    this.push(b)
  }

  javaString(text: string): void {
    const bytes = encodeJavaUtf8(text)
    if (bytes.length > 0xffff) throw invalid('NBT 字符串超过 65535 字节', `${bytes.length}`)
    this.u16(bytes.length)
    this.push(bytes)
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length)
  }
}

function checkRange(value: number, min: number, max: number, what: string): number {
  if (!Number.isFinite(value)) throw invalid(`NBT ${what} 不是有限数字`, String(value))
  const int = Math.trunc(value)
  if (int < min || int > max) throw invalid(`NBT ${what} 超出范围`, String(value))
  return int
}

function toInt(value: NbtValue): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw invalid('NBT 数值非法', String(value))
  return Math.trunc(parsed)
}

function toBig(value: NbtValue): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw invalid('NBT Long 需要整数', String(value))
    return BigInt(value)
  }
  return BigInt(toInt(value))
}

/** The tag id a bare JS value maps to when no hint is available. */
export function guessTag(value: NbtValue): TagId {
  if (typeof value === 'bigint') return Tag.Long
  if (typeof value === 'string') return Tag.String
  if (typeof value === 'boolean') return Tag.Byte
  if (Buffer.isBuffer(value)) return Tag.ByteArray
  if (Array.isArray(value)) return Tag.List
  if (typeof value === 'number') return Number.isInteger(value) ? Tag.Int : Tag.Double
  return Tag.Compound
}

function listElementTag(list: NbtList): TagId {
  const declared = listTag(list)
  if (declared !== undefined) return declared
  const first = list[0]
  if (first === undefined) return Tag.End
  if (Array.isArray(first)) return Tag.List
  if (isCompound(first)) return Tag.Compound
  return guessTag(first)
}

function writePayload(writer: ByteWriter, value: NbtValue, tag: TagId, depth: number): void {
  if (depth > DEFAULT_MAX_DEPTH) throw invalid('NBT 嵌套过深', String(depth))
  switch (tag) {
    case Tag.Byte:
      writer.i8(toInt(value))
      return
    case Tag.Short:
      writer.i16(toInt(value))
      return
    case Tag.Int:
      writer.i32(toInt(value))
      return
    case Tag.Long:
      writer.i64(toBig(value))
      return
    case Tag.Float:
      writer.f32(Number(value))
      return
    case Tag.Double:
      writer.f64(Number(value))
      return
    case Tag.String:
      writer.javaString(typeof value === 'string' ? value : String(value))
      return
    case Tag.ByteArray: {
      const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(((value as number[]) ?? []).map((item) => toInt(item) & 0xff))
      writer.i32(bytes.length)
      writer.push(bytes)
      return
    }
    case Tag.IntArray: {
      const items = Array.isArray(value) ? (value as unknown as number[]) : []
      writer.i32(items.length)
      for (const item of items) writer.i32(toInt(item))
      return
    }
    case Tag.LongArray: {
      const items = Array.isArray(value) ? (value as unknown as bigint[]) : []
      writer.i32(items.length)
      for (const item of items) writer.i64(toBig(item))
      return
    }
    case Tag.List: {
      const list = Array.isArray(value) ? value : []
      const elementTag = listElementTag(list)
      writer.u8(elementTag)
      writer.i32(list.length)
      if (elementTag === Tag.End) return
      for (const item of list) writePayload(writer, item, elementTag, depth + 1)
      return
    }
    case Tag.Compound:
      writeCompoundInto(writer, (isCompound(value) ? value : {}) as NbtCompound)
      return
    default:
      throw invalid('NBT 标签无法写出', `tag=${tag}`)
  }
}

function writeNamed(writer: ByteWriter, name: string, value: NbtValue, tag: TagId): void {
  writer.u8(tag)
  writer.javaString(name)
  writePayload(writer, value, tag, 1)
}

function writeCompoundInto(writer: ByteWriter, compound: NbtCompound): void {
  const hints = compoundHints(compound)
  for (const [key, value] of Object.entries(compound)) {
    if (value === undefined) continue
    writeNamed(writer, key, value, hints?.get(key) ?? guessTag(value))
  }
  writer.u8(Tag.End)
}

/**
 * Serialises `root` uncompressed, in Java's `DataOutput` order (tag id, name,
 * payload). {@link read} re-inflates gzip/zlib input, so a
 * `write(read(bytes))` pair is byte-identical for any uncompressed document.
 */
export function write(root: NbtValue, name = ''): Buffer {
  const writer = new ByteWriter()
  const tag: TagId = isCompound(root) ? Tag.Compound : guessTag(root)
  writer.u8(tag)
  writer.javaString(name)
  if (tag === Tag.End) return writer.toBuffer()
  writePayload(writer, root, tag, 0)
  return writer.toBuffer()
}

/** Writes a `{ name, value }` node exactly as {@link read} returned it. */
export function writeNode(node: NbtNode): Buffer {
  return write(node.value, node.name)
}

/** Gzip form of {@link write}, for the files Minecraft stores compressed. */
export function toGzip(buffer: Buffer, level = 9): Buffer {
  return gzipSync(buffer, { level })
}

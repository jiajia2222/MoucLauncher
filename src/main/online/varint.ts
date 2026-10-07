/**
 * Minecraft's VarInt: LEB128 without the sign extension, little-endian groups,
 * at most 5 bytes, values are 32-bit (sign-extended on read, which is what
 * Java's `readVarInt`/`writeVarInt` do).
 *
 * Wire facts from https://zh.minecraft.wiki/w/Java%E7%89%88%E7%BD%91%E7%BB%9C%E5%8D%8F%E8%AE%AE
 * (verified 2026-10-07). Written from the description only, no code copied.
 */

import { AppError } from '@shared/errors'

export const MAX_VARINT_BYTES = 5
/** Packet length limit the vanilla codec enforces; larger frames are rejected. */
export const MAX_PACKET_BYTES = 8 * 1024 * 1024

export type VarIntResult =
  | { kind: 'ok'; value: number; bytes: number }
  /** More bytes are needed before a decision can be made (streaming read). */
  | { kind: 'incomplete'; bytes: number }
  | { kind: 'error'; message: string }

function error(message: string, detail?: string): AppError {
  return new AppError('invalid-input', message, detail)
}

/** Number of bytes {@link encodeVarInt} needs for `value`. */
export function varIntSize(value: number): number {
  let remaining = value | 0
  let size = 1
  while ((remaining &= ~0x7f) !== 0) {
    remaining >>>= 7
    size += 1
  }
  return size
}

/**
 * Encodes into a fresh buffer. `value` is truncated to 32 bits, matching Java;
 * -1 therefore becomes `FF FF FF FF 0F`.
 */
export function encodeVarInt(value: number): Buffer {
  const out = Buffer.allocUnsafe(varIntSize(value))
  writeVarInt(out, 0, value)
  return out
}

/** Writes into `target` at `offset`, returns the bytes written (never overruns). */
export function writeVarInt(target: Buffer, offset: number, value: number): number {
  let remaining = value | 0
  let at = offset
  for (let position = 0; position < MAX_VARINT_BYTES; position += 1) {
    if (at >= target.length) throw error('VarInt 目标缓冲区不足', `need>${target.length}`)
    const last = position === MAX_VARINT_BYTES - 1 || (remaining >>> 7) === 0
    target.writeUInt8(last ? remaining & 0x7f : (remaining & 0x7f) | 0x80, at)
    at += 1
    if (last) break
    remaining >>>= 7
  }
  return at - offset
}

/**
 * Total decoder: never throws, never reads past `buffer.length`.
 * A continuation bit at the end of the buffer is `incomplete`, not an error, so
 * a streaming parser can wait for the next TCP chunk.
 */
export function readVarInt(buffer: Buffer, offset = 0): VarIntResult {
  let value = 0
  let at = offset
  for (let position = 0; position < MAX_VARINT_BYTES; position += 1) {
    if (at >= buffer.length) return { kind: 'incomplete', bytes: at - offset }
    const byte = buffer[at]!
    at += 1
    value |= (byte & 0x7f) << (position * 7)
    if ((byte & 0x80) === 0) return { kind: 'ok', value: value | 0, bytes: at - offset }
  }
  return { kind: 'error', message: 'VarInt 超过 5 字节' }
}

/** Throws {@link AppError} instead of reporting `incomplete`; for one-shot buffers. */
export function decodeVarInt(buffer: Buffer, offset = 0): number {
  const result = readVarInt(buffer, offset)
  if (result.kind === 'ok') return result.value
  if (result.kind === 'error') throw error(result.message)
  throw error('VarInt 被截断', `offset=${offset}, length=${buffer.length}`)
}

/** Same as {@link decodeVarInt} but also reports how many bytes the value used. */
export function decodeVarIntAt(buffer: Buffer, offset = 0): { value: number; bytes: number } {
  const result = readVarInt(buffer, offset)
  if (result.kind === 'ok') return { value: result.value, bytes: result.bytes }
  if (result.kind === 'error') throw error(result.message)
  throw error('VarInt 被截断', `offset=${offset}, length=${buffer.length}`)
}

/** `[varint length][utf-8 bytes]`, the protocol's string encoding. */
export function encodeString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  const header = encodeVarInt(bytes.length)
  return Buffer.concat([header, bytes], header.length + bytes.length)
}

export type StringResult =
  | { kind: 'ok'; value: string; bytes: number }
  | { kind: 'incomplete'; bytes: number }
  | { kind: 'error'; message: string }

export function readString(buffer: Buffer, offset = 0, maxBytes = MAX_PACKET_BYTES): StringResult {
  const header = readVarInt(buffer, offset)
  if (header.kind !== 'ok') return header.kind === 'incomplete' ? header : { kind: 'error', message: header.message }
  const length = header.value
  if (length < 0 || length > maxBytes) return { kind: 'error', message: `字符串长度非法: ${length}` }
  const start = offset + header.bytes
  if (buffer.length - start < length) return { kind: 'incomplete', bytes: start - offset }
  return { kind: 'ok', value: buffer.toString('utf8', start, start + length), bytes: header.bytes + length }
}

export function decodeString(buffer: Buffer, offset = 0): string {
  const result = readString(buffer, offset)
  if (result.kind === 'ok') return result.value
  if (result.kind === 'error') throw error(result.message)
  throw error('字符串被截断', `offset=${offset}`)
}

/** Unsigned 16-bit big-endian short, the handshake's port field. */
export function writeUnsignedShort(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw error('uint16 超出范围', String(value))
  }
  const out = Buffer.allocUnsafe(2)
  out.writeUInt16BE(value)
  return out
}

export function readUnsignedShort(buffer: Buffer, offset: number): number {
  if (buffer.length - offset < 2) throw error('uint16 被截断', `offset=${offset}`)
  return buffer.readUInt16BE(offset)
}

/**
 * Wraps a packet body as the protocol expects:
 * `[varint total-length][body]`.
 */
export function framePacket(body: Buffer): Buffer {
  const header = encodeVarInt(body.length)
  return Buffer.concat([header, body], header.length + body.length)
}

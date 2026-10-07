import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { inflateSync, unzipSync, zipSync } from 'fflate'
import { AppError } from '@shared/errors'

/**
 * Minimal ZIP reader that only inflates the entries it is asked for: mod jars are
 * hundreds of MB and we usually want one small JSON member.
 * Supports stored (0) and deflate (8) methods, ZIP64 is rejected with a clear error.
 */
export interface ZipEntryInfo {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export interface ZipReader {
  entries: Map<string, ZipEntryInfo>
  names(): string[]
  has(name: string): boolean
  read(name: string): Promise<Buffer>
  readSync(name: string): Buffer
  extractTo(dir: string, exclude?: (name: string) => boolean): Promise<string[]>
  close(): Promise<void>
}

const EOCD_SIGNATURE = 0x02014b50
const CENTRAL_END = 0x06054b50

export async function openZip(file: string): Promise<ZipReader> {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    const tailLength = Math.min(stat.size, 66_000)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, stat.size - tailLength)

    const eocd = findEOCD(tail, stat.size)
    const { entryCount, centralOffset, eocdAbsolute } = eocd
    // The central directory ends exactly where the EOCD starts; entryCount*46 would
    // truncate it because every entry also carries name/extra/comment bytes.
    const centralLength = Math.max(0, Math.min(eocdAbsolute - centralOffset, stat.size - centralOffset))
    const central = Buffer.alloc(centralLength)
    await handle.read(central, 0, central.length, centralOffset)

    const entries = new Map<string, ZipEntryInfo>()
    let cursor = 0
    for (let i = 0; i < entryCount; i += 1) {
      if (central.readUInt32LE(cursor) !== EOCD_SIGNATURE) break
      const method = central.readUInt16LE(cursor + 10)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const uncompressedSize = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const localHeaderOffset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset })
      cursor += 46 + nameLength + extraLength + commentLength
    }

    const readSync = (name: string): Buffer => {
      const info = entries.get(name)
      if (!info) throw new AppError('not-found', `ZIP 中没有 ${name}`, file)
      const header = Buffer.alloc(30)
      fs.readSync(handle.fd, header, 0, 30, info.localHeaderOffset)
      if (header.readUInt32LE(0) !== 0x04034b50) {
        throw new AppError('internal', 'ZIP 本地文件头损坏', `${file}#${name}`)
      }
      const nameLen = header.readUInt16LE(26)
      const extraLen = header.readUInt16LE(28)
      const dataStart = info.localHeaderOffset + 30 + nameLen + extraLen
      const raw = Buffer.alloc(info.compressedSize)
      fs.readSync(handle.fd, raw, 0, raw.length, dataStart)
      if (info.method === 0) return raw
      if (info.method === 8) return Buffer.from(inflateSync(raw))
      throw new AppError('unsupported', `不支持的压缩方式 (${info.method})`, `${file}#${name}`)
    }

    return {
      entries,
      names: () => [...entries.keys()],
      has: (name) => entries.has(name),
      read: async (name: string) => {
        const info = entries.get(name)
        if (!info) throw new AppError('not-found', `ZIP 中没有 ${name}`, file)
        const header = Buffer.alloc(30)
        await handle.read(header, 0, 30, info.localHeaderOffset)
        const nameLen = header.readUInt16LE(26)
        const extraLen = header.readUInt16LE(28)
        const raw = Buffer.alloc(info.compressedSize)
        await handle.read(raw, 0, raw.length, info.localHeaderOffset + 30 + nameLen + extraLen)
        return info.method === 8 ? Buffer.from(inflateSync(raw)) : raw
      },
      readSync,
      extractTo: async (dir: string, exclude?: (name: string) => boolean) => {
        const written: string[] = []
        for (const info of entries.values()) {
          if (info.name.endsWith('/') || /^[a-z]:|^\//.test(info.name)) continue
          if (exclude?.(info.name)) continue
          const target = path.join(dir, info.name)
          // Directory traversal guard: a crafted jar must not write outside `dir`.
          const rel = path.relative(path.resolve(dir), path.resolve(target))
          if (rel.startsWith('..') || path.isAbsolute(rel)) continue
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.writeFile(target, readSync(info.name))
          written.push(target)
        }
        return written
      },
      close: () => handle.close()
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function findEOCD(
  tail: Buffer,
  total: number
): { entryCount: number; centralOffset: number; eocdAbsolute: number } {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== CENTRAL_END) continue
    const entryCount = tail.readUInt16LE(i + 10)
    const centralOffset = tail.readUInt32LE(i + 16)
    const eocdAbsolute = total - tail.length + i
    if (entryCount === 0xffff || centralOffset === 0xffffffff || centralOffset >= eocdAbsolute) {
      throw new AppError('unsupported', '暂不支持 ZIP64 归档', `entries=${entryCount}`)
    }
    return { entryCount, centralOffset, eocdAbsolute }
  }
  throw new AppError('internal', '不是有效的 ZIP 文件（找不到结束记录）')
}

/** Reads every entry into memory. Only for small archives (mrpack model.json + index). */
export function unzipAll(buffer: Buffer): Record<string, Uint8Array> {
  return unzipSync(buffer) as Record<string, Uint8Array>
}

export function zipAll(files: Record<string, Uint8Array | string>, level = 6): Uint8Array {
  const input: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(files)) {
    input[name] = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  }
  return zipSync(input, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 })
}

/** Walks a directory and returns a flat map for `zipAll`. */
export async function collectDir(root: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {}
  const stack: { dir: string; rel: string }[] = [{ dir: root, rel: prefix }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const name = rel.length > 0 ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        stack.push({ dir: full, rel: name })
        continue
      }
      if (entry.isFile()) out[name] = new Uint8Array(await fsp.readFile(full))
    }
  }
  return out
}

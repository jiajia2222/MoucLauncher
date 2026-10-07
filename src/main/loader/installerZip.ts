import fsp from 'node:fs/promises'
import { inflateSync } from 'fflate'
import { AppError } from '@shared/errors'

/**
 * A correct, minimal ZIP member reader for Forge/NeoForge installer archives.
 *
 * WHY not `core/zip.openZip`: that reader sizes the central directory buffer as
 * `entryCount * 46 + 8`, which is only the fixed 46-byte header per entry and ignores
 * the variable-length file name / extra / comment fields. Real archives (a Forge
 * installer has 356 named entries) exceed that bound, so its parser silently truncates
 * and cannot find `install_profile.json`. Here we allocate the true remaining length
 * (`stat.size - centralOffset`), which fixes it without editing the frozen core module.
 *
 * Only the members that are asked for are inflated, so a ~30MB installer embedding a full
 * Maven repo is never expanded in memory.
 */
interface CentralEntry {
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

export interface InstallerZip {
  names: string[]
  has(name: string): boolean
  read(name: string): Promise<Buffer>
  close(): Promise<void>
}

export async function openInstallerZip(file: string): Promise<InstallerZip> {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    const tailLength = Math.min(stat.size, 66_000)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, stat.size - tailLength)

    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new AppError('internal', '不是有效的 ZIP 归档（找不到结束记录）', file)
    const entryCount = tail.readUInt16LE(eocd + 10)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (entryCount === 0xffff || centralOffset === 0xffffffff) {
      throw new AppError('unsupported', '暂不支持 ZIP64 归档', file)
    }

    const centralLength = stat.size - centralOffset
    const central = Buffer.alloc(centralLength)
    await handle.read(central, 0, centralLength, centralOffset)

    const entries = new Map<string, CentralEntry>()
    let cursor = 0
    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > central.length) break
      if (central.readUInt32LE(cursor) !== CENTRAL_SIG) break
      const method = central.readUInt16LE(cursor + 10)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const uncompressedSize = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const localHeaderOffset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset })
      cursor += 46 + nameLength + extraLength + commentLength
    }

    const read = async (name: string): Promise<Buffer> => {
      const info = entries.get(name)
      if (!info) throw new AppError('not-found', `ZIP 中没有 ${name}`, file)
      const header = Buffer.alloc(30)
      await handle.read(header, 0, 30, info.localHeaderOffset)
      const nameLen = header.readUInt16LE(26)
      const extraLen = header.readUInt16LE(28)
      const raw = Buffer.alloc(info.compressedSize)
      await handle.read(raw, 0, raw.length, info.localHeaderOffset + 30 + nameLen + extraLen)
      if (info.method === 0) return raw
      if (info.method === 8) return Buffer.from(inflateSync(raw))
      throw new AppError('unsupported', `不支持的压缩方式 (${info.method})`, `${file}#${name}`)
    }

    return {
      names: [...entries.keys()],
      has: (name) => entries.has(name),
      read,
      close: () => handle.close()
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

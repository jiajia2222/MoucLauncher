/**
 * Modpack format detection.
 *
 * The `ModpackService.detect()` contract is synchronous, so the sniffing path reads
 * only the ZIP central directory (plus the single small manifest member it needs to
 * look inside) with `node:fs` — never the whole archive. `detectWithZip()` is the
 * async twin that goes through `core/zip.openZip`; the importers use that one.
 *
 * Verified on 2026-10-07 against a real Modrinth pack
 * (https://cdn.modrinth.com/data/1KVo5zza/versions/YGtw3YsK/Fabulously.Optimized-v8.1.0.mrpack,
 * 82015 bytes, sha1 37ba494b5c2fb9f1783ec4fc2eed270ac6582c2e): its member list is
 * `modrinth.index.json` + `overrides/...`. `mrmodpack.json` is the early name of the
 * same document, kept as an accepted alias — a detector that only looked for it would
 * reject every real pack.
 */
import fs from 'node:fs'
import { inflateSync } from 'fflate'
import type { ModpackFormat } from '@shared/types'
import { openZip, type ZipReader } from '../core/zip'
import { CURSE_MANIFEST_NAME, MRPACK_INDEX_NAMES, MULTIMC_INSTANCE_NAME, MULTIMC_PACK_NAME, normalizeMember } from './common'

const CENTRAL_END = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_TAIL = 66_000
/** Above this a manifest is not worth inflating just to guess a format. */
const MAX_SNIFF_BYTES = 2 * 1024 * 1024

export interface MemberInfo {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** Reads the central directory only. Undefined = not a ZIP we can read. */
export function listMembers(file: string): MemberInfo[] | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const total = fs.fstatSync(fd).size
    if (total < 22) return undefined
    const tailLength = Math.min(total, MAX_TAIL)
    const tail = Buffer.alloc(tailLength)
    fs.readSync(fd, tail, 0, tailLength, total - tailLength)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === CENTRAL_END) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return undefined
    const entryCount = tail.readUInt16LE(eocd + 10)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    // ZIP64 is rejected by core/zip too; stay consistent instead of half-reading it.
    if (entryCount === 0xffff || centralOffset === 0xffffffff) return undefined
    // The directory ends where the EOCD starts: every record carries name/extra/comment
    // bytes beyond its fixed 46, so sizing it as entryCount*46 truncates real packs.
    const centralLength = Math.max(0, Math.min(total - tail.length + eocd - centralOffset, total - centralOffset))
    const central = Buffer.alloc(centralLength)
    fs.readSync(fd, central, 0, central.length, centralOffset)

    const out: MemberInfo[] = []
    let cursor = 0
    for (let i = 0; i < entryCount; i += 1) {
      if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
      const method = central.readUInt16LE(cursor + 10)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const uncompressedSize = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const localHeaderOffset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      out.push({ name: normalizeMember(name), method, compressedSize, uncompressedSize, localHeaderOffset })
      cursor += 46 + nameLength + extraLength + commentLength
    }
    return out
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Inflates one member (stored or deflate); used for the small manifest files only. */
export function readMember(file: string, member: MemberInfo): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(30)
    fs.readSync(fd, header, 0, 30, member.localHeaderOffset)
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) return undefined
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const raw = Buffer.alloc(member.compressedSize)
    fs.readSync(fd, raw, 0, raw.length, member.localHeaderOffset + 30 + nameLength + extraLength)
    if (member.method === 0) return raw
    if (member.method === 8) return Buffer.from(inflateSync(raw))
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * A member counts as "at the pack root" when it has no slash, or exactly one slash when
 * the whole instance was zipped inside a single folder (what MultiMC's export does).
 * Returns the real member name so the caller can read it back.
 */
export function findMember(members: readonly string[], name: string): string | undefined {
  const wanted = normalizeMember(name)
  const direct = members.find((m) => normalizeMember(m) === wanted)
  if (direct) return direct
  const depthOne = members.filter((m) => {
    const n = normalizeMember(m)
    return n.split('/').length === 2 && n.endsWith(`/${wanted}`)
  })
  return depthOne.length === 1 ? depthOne[0] : undefined
}

export function hasMember(members: readonly string[], name: string): boolean {
  return findMember(members, name) !== undefined
}

/**
 * Pure decision: name list + a reader for small text members.
 * Order matters — a pack could legitimately carry several of these files.
 */
export function chooseFormat(members: readonly string[], readText: (name: string) => string | undefined): ModpackFormat | undefined {
  if (MRPACK_INDEX_NAMES.some((name) => hasMember(members, name))) return 'mrpack'
  if (curseManifestShape(members, readText)) return 'curse-zip'
  if (hasMember(members, MULTIMC_INSTANCE_NAME) || hasMember(members, MULTIMC_PACK_NAME)) return 'zip-multimc'
  return undefined
}

/** `manifest.json` only counts as CurseForge when its file entries carry projectID/fileID. */
function curseManifestShape(members: readonly string[], readText: (name: string) => string | undefined): boolean {
  const name = findMember(members, CURSE_MANIFEST_NAME)
  if (!name) return false
  const raw = readText(name)
  if (!raw) return false
  return curseFileEntries(raw).length > 0
}

/** `manifest.json` -> `[{projectID, fileID}, ...]`, tolerant of both shapes. */
export function curseFileEntries(text: string): { projectID: number; fileID: number; required?: boolean }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return []
  }
  const root = parsed as { files?: unknown; mods?: unknown } | unknown[] | null
  const list = Array.isArray(root)
    ? root
    : Array.isArray((root as { files?: unknown })?.files)
      ? (root as { files: unknown[] }).files
      : Array.isArray((root as { mods?: unknown })?.mods)
        ? (root as { mods: unknown[] }).mods
        : []
  const out: { projectID: number; fileID: number; required?: boolean }[] = []
  for (const entry of list) {
    const item = entry as { projectID?: unknown; fileID?: unknown; required?: unknown }
    if (typeof item?.projectID !== 'number' || typeof item.fileID !== 'number') continue
    out.push({ projectID: item.projectID, fileID: item.fileID, required: typeof item.required === 'boolean' ? item.required : undefined })
  }
  return out
}

/** Synchronous detection used by the `ModpackService.detect` contract. */
export function detect(file: string, members?: MemberInfo[]): ModpackFormat | undefined {
  const list = members ?? listMembers(file)
  if (!list || list.length === 0) return undefined
  const names = list.map((m) => m.name)
  const byName = new Map(list.map((m) => [m.name, m]))
  return chooseFormat(names, (name) => {
    const found = findMember(names, name)
    const info = found ? byName.get(found) : undefined
    if (!info || info.uncompressedSize > MAX_SNIFF_BYTES) return undefined
    const buffer = readMember(file, info)
    return buffer ? buffer.toString('utf8') : undefined
  })
}

/** Async twin through `core/zip`; used by the importers. */
export async function detectWithZip(file: string): Promise<ModpackFormat | undefined> {
  let zip: ZipReader | undefined
  try {
    zip = await openZip(file)
    return chooseFormatFromReader(zip)
  } catch {
    return undefined
  } finally {
    await zip?.close().catch(() => undefined)
  }
}

/** Same decision, but reading members through an already-opened `core/zip` reader. */
export function chooseFormatFromReader(zip: ZipReader): ModpackFormat | undefined {
  const names = zip.names()
  return chooseFormat(names, (name) => {
    const found = findMember(names, name)
    const info = found ? zip.entries.get(found) : undefined
    if (!info || info.uncompressedSize > MAX_SNIFF_BYTES) return undefined
    try {
      // Only the few-KB manifests reach here, so a synchronous inflate is acceptable.
      return found ? zip.readSync(found).toString('utf8') : undefined
    } catch {
      return undefined
    }
  })
}

/** Reads one small member as text; rejects when the archive does not carry it. */
export async function readTextMember(zip: ZipReader, name: string): Promise<string> {
  const found = findMember(zip.names(), name)
  if (!found) throw new Error(`归档中没有 ${name}`)
  return (await zip.read(found)).toString('utf8')
}

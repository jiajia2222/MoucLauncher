/**
 * Modpack export.
 *
 * `mrpack`: a real Modrinth index (`modrinth.index.json`, formatVersion 1) whose
 * `files[]` come from the instance's `mods/` folder — sha1 via `fsx.streamSha1` so a
 * 300 MB mod never lands in memory twice — plus `overrides/**` for everything else.
 * Download URLs are reconstructed only when the mod carries Modrinth provenance
 * (`InstalledMod.provider/projectId/versionId`); files without it are exported with an
 * empty `downloads[]` and reported, because inventing a URL would be worse.
 *
 * `zip`: the raw instance folder as a portable zip (mods included, shared game dirs
 * excluded), which is what a "copy this instance to a friend" button needs.
 *
 * Overrides rule (documented, since the formats disagree): overrides = the instance dir
 * minus `mods/` (those become manifest entries) minus our own `.mouc-instance.json`
 * marker minus the shared/noisy roots (`versions`, `libraries`, `assets`, `logs`,
 * `crash-reports`, `natives*`, `run`, `screenshots`, `.mouc`). `saves/` and `options.txt`
 * DO travel — that is what makes a re-import playable — while for the raw `zip` export
 * `screenshots/` stays in as well.
 *
 * Caps: at most `MAX_EXPORT_FILES` entries and nothing bigger than
 * `MAX_EXPORT_ENTRY_BYTES` (200 MB), because `core/zip.zipAll` holds the whole archive
 * in memory. Skipped entries are counted in `job.skipped` and logged, never silent.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DownloadJob, LoaderId } from '@shared/types'
import { AppError } from '@shared/errors'
import { streamSha1, sizeOf, readdirSafe } from '../core/fsx'
import { zipAll } from '../core/zip'
import { MAX_EXPORT_ENTRY_BYTES, MAX_EXPORT_FILES, localJob } from './common'
import type { ModpackServiceDeps } from './types'

/** Roots that are shared or regenerable, so they are never part of a pack. */
export const SHARED_DIRS = ['versions', 'libraries', 'assets', 'logs', 'crash-reports', 'run', '.mouc', 'natives-windows', 'natives-linux', 'natives-macos']

/** Extra exclusions for the mrpack `overrides/` tree (screenshots stay out too). */
export const MRPACK_EXTRA_EXCLUSIONS = ['screenshots']

const MOD_SUFFIXES = /\.(jar|zip|litemod|js\.zip)$/i
const DISABLED_SUFFIX = /\.disabled$/i

export interface CollectedEntry {
  relative: string
  absolute: string
  size: number
}

export interface CollectResult {
  entries: CollectedEntry[]
  skipped: { relative: string; reason: string }[]
  truncated: boolean
}

/**
 * Depth-first walk with the exclusions + caps applied *before* any bytes are read —
 * this is why we do not reuse `core/zip.collectDir`, which reads everything upfront.
 */
export async function collectTree(
  root: string,
  options: { excludeTop?: string[]; excludeRel?: (relative: string) => boolean; limit?: number } = {}
): Promise<CollectResult> {
  const limit = options.limit ?? MAX_EXPORT_FILES
  const excludeTop = new Set((options.excludeTop ?? []).map((d) => d.toLowerCase()))
  const entries: CollectedEntry[] = []
  const skipped: { relative: string; reason: string }[] = []
  const stack: { dir: string; rel: string }[] = [{ dir: root, rel: '' }]
  let truncated = false
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!
    for (const name of await readdirSafe(dir)) {
      const relative = rel.length > 0 ? `${rel}/${name}` : name
      if (rel.length === 0 && excludeTop.has(name.toLowerCase())) continue
      if (options.excludeRel?.(relative)) continue
      const absolute = path.join(dir, name)
      const stat = await fsp.stat(absolute).catch(() => undefined)
      if (!stat) continue
      if (stat.isDirectory()) {
        stack.push({ dir: absolute, rel: relative })
        continue
      }
      if (!stat.isFile()) continue
      if (entries.length >= limit) {
        truncated = true
        skipped.push({ relative, reason: `超过上限 ${limit} 个文件` })
        continue
      }
      if (stat.size > MAX_EXPORT_ENTRY_BYTES) {
        skipped.push({ relative, reason: `单个文件 ${stat.size} 字节 > ${MAX_EXPORT_ENTRY_BYTES}` })
        continue
      }
      entries.push({ relative, absolute, size: stat.size })
    }
  }
  return { entries, skipped, truncated }
}

async function toBufferMap(entries: CollectedEntry[], prefix = ''): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {}
  for (const entry of entries) {
    const name = prefix.length > 0 ? `${prefix}/${entry.relative}` : entry.relative
    out[name] = new Uint8Array(await fsp.readFile(entry.absolute))
  }
  return out
}

/** `https://cdn.modrinth.com/data/{project}/versions/{version}/{file}` — the shape used by real mrpacks. */
export function modrinthCdnUrl(projectId: string, versionId: string, fileName: string): string {
  return `https://cdn.modrinth.com/data/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/${encodeURIComponent(fileName)}`
}

const MRPACK_DEP_KEY: Partial<Record<LoaderId, string>> = {
  fabric: 'fabric-loader',
  'legacy-fabric': 'legacy-fabric',
  quilt: 'quilt_loader',
  forge: 'forge',
  neoforge: 'neoforge',
  optifine: 'optifine',
  liteloader: 'liteloader',
  cleanroom: 'cleanroom'
}

export interface MrpackBuild {
  /** The mrpack index document; absent for the raw `zip` export. */
  index?: Record<string, unknown>
  members: Record<string, Uint8Array | string>
  fileCount: number
  skipped: { relative: string; reason: string }[]
  /** mods exported without a resolvable download URL. */
  unresolved: string[]
}

/** Lists `mods/` (skipping `*.disabled`) with streaming sha1 + provenance URLs. */
async function modEntries(
  deps: ModpackServiceDeps,
  gameDir: string,
  instanceId: string
): Promise<{ files: Record<string, unknown>[]; unresolved: string[]; skipped: { relative: string; reason: string }[]; count: number }> {
  const modsDir = path.join(gameDir, 'mods')
  const names = (await readdirSafe(modsDir)).filter((n) => MOD_SUFFIXES.test(n) && !DISABLED_SUFFIX.test(n))
  let known: Map<string, { provider?: string; projectId?: string; versionId?: string }> = new Map()
  try {
    const installed = await deps.mods.installed(instanceId)
    known = new Map(installed.map((m) => [m.fileName, { provider: m.provider, projectId: m.projectId, versionId: m.versionId }]))
  } catch (error) {
    deps.log.warn(`读取模组列表失败，导出的 files[] 将没有下载地址: ${String(error)}`)
  }

  const files: Record<string, unknown>[] = []
  const unresolved: string[] = []
  const skipped: { relative: string; reason: string }[] = []
  for (const name of names) {
    const absolute = path.join(modsDir, name)
    const size = await sizeOf(absolute)
    if (size > MAX_EXPORT_ENTRY_BYTES) {
      skipped.push({ relative: `mods/${name}`, reason: `单个文件 ${size} 字节 > ${MAX_EXPORT_ENTRY_BYTES}` })
      continue
    }
    const sha1 = await streamSha1(absolute).catch(() => undefined)
    const provenance = known.get(name)
    const downloads: string[] = []
    if (provenance?.provider === 'modrinth' && provenance.projectId && provenance.versionId) {
      downloads.push(modrinthCdnUrl(provenance.projectId, provenance.versionId, name))
    } else {
      unresolved.push(name)
    }
    const entry: Record<string, unknown> = {
      path: `mods/${name}`,
      hashes: sha1 ? { sha1 } : {},
      env: { client: 'required', server: 'optional' },
      downloads,
      fileSize: size
    }
    files.push(entry)
  }
  return { files, unresolved, skipped, count: files.length }
}

export async function buildMrpack(
  deps: ModpackServiceDeps,
  instanceId: string
): Promise<MrpackBuild> {
  const instance = deps.instances.require(instanceId)
  const gameDir = deps.instances.gameDir(instance)
  const mods = await modEntries(deps, gameDir, instanceId)

  const overrides = await collectTree(gameDir, {
    excludeTop: [...SHARED_DIRS, 'mods', ...MRPACK_EXTRA_EXCLUSIONS],
    excludeRel: (relative) => relative === '.mouc-instance.json' || relative.startsWith('.')
  })
  const members = await toBufferMap(overrides.entries, 'overrides')
  const index: Record<string, unknown> = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1',
    name: instance.name,
    author: 'MoucX',
    dependencies: {
      minecraft: instance.gameVersion,
      ...(MRPACK_DEP_KEY[instance.loader] && instance.loaderVersion
        ? { [MRPACK_DEP_KEY[instance.loader] as string]: instance.loaderVersion }
        : {})
    },
    files: mods.files
  }
  return {
    index,
    members: {
      'modrinth.index.json': JSON.stringify(index, null, 2),
      'overrides/': new Uint8Array(0),
      ...members
    },
    fileCount: mods.count + overrides.entries.length,
    skipped: [...mods.skipped, ...overrides.skipped],
    unresolved: mods.unresolved
  }
}

export async function buildPortableZip(deps: ModpackServiceDeps, instanceId: string): Promise<MrpackBuild> {
  const instance = deps.instances.require(instanceId)
  const gameDir = deps.instances.gameDir(instance)
  const collected = await collectTree(gameDir, {
    excludeTop: SHARED_DIRS,
    excludeRel: (relative) => relative === '.mouc-instance.json'
  })
  const members = await toBufferMap(collected.entries)
  return {
    members,
    fileCount: collected.entries.length,
    skipped: collected.skipped,
    unresolved: []
  }
}

/** Writes the archive and returns a job describing what happened. */
async function writeArchive(
  deps: ModpackServiceDeps,
  target: string,
  members: Record<string, Uint8Array | string>,
  title: string,
  skipped: { relative: string; reason: string }[],
  unresolved: string[]
): Promise<DownloadJob> {
  const log = deps.log.child('modpack.export')
  const job = localJob(title, 'modpack', Object.keys(members).length)
  job.skipped = skipped.length + unresolved.length
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const data = zipAll(members, 6)
    const writer = deps.fs?.writeFile ?? fsp.writeFile
    await writer(target, data)
  } catch (error) {
    const wrapped = AppError.from(error, 'disk')
    job.status = 'error'
    job.failed = 1
    job.error = wrapped.toPayload()
    job.finishedAt = Date.now()
    log.error(`导出失败 ${target}: ${wrapped.message}`)
    return job
  }
  for (const entry of skipped) log.warn(`未打包 ${entry.relative}: ${entry.reason}`)
  if (unresolved.length > 0) {
    log.warn(`${unresolved.length} 个条目没有下载地址或过大，已记录：${unresolved.slice(0, 8).join(', ')}`)
  }
  job.bytesDone = await sizeOf(target)
  log.info(`导出完成 ${target}：${job.total} 项，跳过 ${job.skipped} 项`)
  return job
}

export async function exportModpack(
  deps: ModpackServiceDeps,
  instanceId: string,
  target: string,
  format: 'mrpack' | 'zip'
): Promise<DownloadJob> {
  if (format === 'mrpack') {
    const built = await buildMrpack(deps, instanceId)
    return writeArchive(deps, target, built.members, `导出 mrpack ${path.basename(target)}`, built.skipped, built.unresolved)
  }
  const built = await buildPortableZip(deps, instanceId)
  return writeArchive(deps, target, built.members, `导出压缩包 ${path.basename(target)}`, built.skipped, [])
}

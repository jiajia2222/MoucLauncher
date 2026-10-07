/**
 * Shared plumbing for the modpack importers/exporters.
 *
 * Everything that touches an archive goes through `core/zip` (central-directory
 * sniffing + per-member reads, never a whole-file inflate), and everything that
 * writes into an instance directory is guarded with `isPathInside` so a crafted
 * `overrides/../../windows/x.txt` member is dropped instead of followed.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  DownloadItem,
  DownloadJob,
  DownloadKind,
  DownloadPlan,
  Instance,
  LoaderId,
  ModpackManifest
} from '@shared/types'
import { AppError } from '@shared/errors'
import { sanitizeName, uid } from '@shared/utils'
import type { Downloader } from '../core/contracts'
import type { ZipReader } from '../core/zip'
import { instanceGameDir, isPathInside } from '../core/paths'
import type { ModpackServiceDeps } from './types'

/** Canonical Modrinth index name; `mrmodpack.json` is the early/legacy name. */
export const MRPACK_INDEX_NAMES = ['modrinth.index.json', 'mrmodpack.json'] as const
export const OVERRIDES_PREFIX = 'overrides'
export const CURSE_MANIFEST_NAME = 'manifest.json'
export const MULTIMC_INSTANCE_NAME = 'instance.cfg'
export const MULTIMC_PACK_NAME = 'mmc-pack.json'

/** A pack with more entries than this is not exported whole; see exporter.ts. */
export const MAX_EXPORT_FILES = 3000
/** Entries bigger than this are skipped (zipAll holds every byte in memory). */
export const MAX_EXPORT_ENTRY_BYTES = 200 * 1024 * 1024

/** `mods/foo.jar` -> `mod`, `resourcepacks/` -> `resource-pack`, ... */
export function fileKindFor(relativePath: string): DownloadKind {
  const first = normalizeMember(relativePath).split('/')[0]?.toLowerCase() ?? ''
  if (first === 'resourcepacks' || first === 'resourcepack') return 'resource-pack'
  if (first === 'shaders' || first === 'shaderpacks') return 'shader'
  if (first === 'saves' || first === 'worlds') return 'world'
  if (first === 'projections' || first === 'settings') return 'misc'
  return 'mod'
}

/** Archive member names use `/`; Windows authors occasionally emit `\`. */
export function normalizeMember(name: string): string {
  return name.replace(/\\/g, '/')
}

export function memberBaseName(name: string): string {
  const normalized = normalizeMember(name)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * Copies every member under `<prefix>/` into `dir`, dropping the prefix.
 * An empty prefix copies the whole archive. Returns what landed and what was refused
 * (traversal / absolute / drive paths).
 */
export async function extractTree(
  zip: ZipReader,
  dir: string,
  prefix: string,
  exclude?: (relative: string) => boolean
): Promise<{ written: string[]; refused: string[] }> {
  const root = path.resolve(dir)
  const head = prefix.length === 0 ? '' : `${normalizeMember(prefix).replace(/\/$/, '')}/`
  const written: string[] = []
  const refused: string[] = []
  for (const name of zip.names()) {
    const normalized = normalizeMember(name)
    if (head.length > 0 && !normalized.startsWith(head)) continue
    if (normalized.endsWith('/')) continue
    const relative = head.length > 0 ? normalized.slice(head.length) : normalized
    if (relative.length === 0) continue
    if (exclude?.(relative)) continue
    const target = path.resolve(root, relative)
    if (!isPathInside(root, target)) {
      refused.push(normalized)
      continue
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, await zip.read(name))
    written.push(target)
  }
  return { written, refused }
}

/** `extractTree` for the `overrides/` subtree of a pack. */
export async function extractOverrides(
  zip: ZipReader,
  dir: string,
  prefix: string,
  exclude?: (relative: string) => boolean
): Promise<{ written: string[]; refused: string[] }> {
  return extractTree(zip, dir, prefix, exclude)
}

/** mrpack `dependencies` key -> our `LoaderId`. */
const LOADER_BY_DEP_KEY: Readonly<Record<string, LoaderId>> = {
  'fabric-loader': 'fabric',
  fabric: 'fabric',
  'legacy-fabric': 'legacy-fabric',
  'legacy-fabric-loader': 'legacy-fabric',
  quilt_loader: 'quilt',
  'quilt-loader': 'quilt',
  quilt: 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
  'neo-forge': 'neoforge',
  optifine: 'optifine',
  liteloader: 'liteloader',
  cleanroom: 'cleanroom'
}

export function loaderIdFromKey(key: string): LoaderId | undefined {
  return LOADER_BY_DEP_KEY[key.toLowerCase().replace(/[\s_]+/g, '-').replace(/^fork-/, '')]
    ?? LOADER_BY_DEP_KEY[key.toLowerCase()]
}

export function describeLoader(loader: LoaderId | string, version?: string): string {
  const text = version && version.length > 0 ? `${loader} ${version}` : String(loader)
  return String(loader) === 'vanilla' ? '原版' : text
}

/** Modrinth-style loader version keys are `fabric-loader`; MultiMC uses `net.minecraftforge`. */
export function loaderIdFromMmcUid(uidName: string): LoaderId | undefined {
  const key = uidName.toLowerCase()
  if (key.includes('neoforge')) return 'neoforge'
  if (key.includes('legacy-fabric') || key.includes('legacyfabric')) return 'legacy-fabric'
  if (key.includes('fabric')) return 'fabric'
  if (key.includes('quilt')) return 'quilt'
  if (key.includes('optifine')) return 'optifine'
  if (key.includes('liteloader')) return 'liteloader'
  if (key.includes('forge')) return 'forge'
  if (key.includes('cleanroom')) return 'cleanroom'
  return undefined
}

/** A job we own end-to-end (nothing to download, or everything already local). */
export function localJob(title: string, kind: DownloadPlan['kind'], total: number, status: DownloadJob['status'] = 'done'): DownloadJob {
  const now = Date.now()
  return {
    id: uid('job'),
    title,
    kind,
    status,
    total,
    done: status === 'done' ? total : 0,
    failed: 0,
    skipped: 0,
    bytesTotal: 0,
    bytesDone: 0,
    startedAt: now,
    finishedAt: status === 'done' || status === 'error' ? now : undefined
  }
}

/**
 * Attaches "these N files could not be resolved" to a job. The `DownloadJob` shape has
 * no list field, so the detail string carries the first offenders and `failed` the count.
 */
export function reportUnresolved(
  job: DownloadJob,
  error: AppError,
  unresolved: string[],
  deps: ModpackServiceDeps
): DownloadJob {
  job.status = 'error'
  job.failed += unresolved.length
  job.finishedAt = Date.now()
  job.error = error.toPayload()
  if (job.error && unresolved.length > 0) {
    const shown = unresolved.slice(0, 12).join(', ')
    job.error = { ...job.error, detail: `${job.error.detail ?? ''}${job.error.detail ? ' | ' : ''}未解析 ${unresolved.length} 项：${shown}` }
  }
  deps.log.warn(`${job.title}: ${error.message}${unresolved.length > 0 ? `（${unresolved.length} 项未解析）` : ''}`)
  return job
}

export function manifestOf(
  name: string,
  author: string,
  version: string,
  gameVersion: string,
  loader: { id: LoaderId; version: string },
  files: number
): ModpackManifest {
  return { name, author, version, gameVersion, loader, files }
}

/** Isolated instance for an imported pack. `sanitizeName` keeps the folder inside `instances/`. */
export function createPackInstance(
  deps: ModpackServiceDeps,
  input: { name: string; versionId: string; gameVersion: string; loader: LoaderId; loaderVersion?: string; description: string }
): Instance {
  const name = sanitizeName(input.name, '整合包实例')
  return deps.instances.create({
    name,
    versionId: input.versionId,
    gameVersion: input.gameVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion,
    isolated: true,
    description: input.description
  })
}

/** The version id we point an instance at: loader-patched ids come back from `install`. */
export function instanceVersionId(installed: string | undefined, fallback: string): string {
  return installed && installed.length > 0 ? installed : fallback
}

export function instanceGameDirOf(deps: ModpackServiceDeps, instance: Instance): string {
  return instanceGameDir(instance, deps.paths())
}

/** Absolute target for a pack file entry, or undefined when it tries to escape. */
export function targetFor(gameDir: string, relative: string): string | undefined {
  const clean = normalizeMember(relative).replace(/^\.\/+/, '')
  if (clean.length === 0 || clean.startsWith('/')) return undefined
  const target = path.resolve(gameDir, clean)
  return isPathInside(gameDir, target) ? target : undefined
}

export function downloadItemsFor(
  gameDir: string,
  entries: { relative: string; url?: string; urls?: string[]; sha1?: string; size?: number; optional?: boolean }[]
): { items: DownloadItem[]; skipped: string[] } {
  const items: DownloadItem[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    const target = targetFor(gameDir, entry.relative)
    const url = entry.url ?? entry.urls?.[0]
    if (!target || !url) {
      skipped.push(entry.relative)
      continue
    }
    const item: DownloadItem = {
      id: target,
      url,
      target,
      kind: fileKindFor(entry.relative),
      label: memberBaseName(entry.relative)
    }
    if (entry.sha1) item.sha1 = entry.sha1
    if (entry.size !== undefined) item.size = entry.size
    if (entry.optional === true) item.optional = true
    const fallbacks = (entry.urls ?? []).filter((u) => u !== url)
    if (fallbacks.length > 0) item.fallbackUrls = fallbacks
    items.push(item)
  }
  return { items, skipped }
}

export async function writeFileEnsured(file: string, data: Uint8Array | string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  if (typeof data === 'string') await fsp.writeFile(file, data, 'utf8')
  else await fsp.writeFile(file, data)
}

/** `deps.downloader.enqueue` wrapper that never loses the plan title. */
export async function queuePlan(
  downloader: Downloader,
  title: string,
  items: DownloadItem[],
  kind: DownloadPlan['kind'] = 'modpack'
): Promise<DownloadJob> {
  return downloader.enqueue({ title, kind, items, after: 'none' })
}

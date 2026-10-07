/**
 * Modrinth `.mrpack` import.
 *
 * Schema verified on 2026-10-07 by downloading a real pack and reading its index
 * member (not from a blog post):
 *   https://cdn.modrinth.com/data/1KVo5zza/versions/YGtw3YsK/Fabulously.Optimized-v8.1.0.mrpack
 *   82015 bytes, sha1 37ba494b5c2fb9f1783ec4fc2eed270ac6582c2e, 47 file entries
 *   -> members: `modrinth.index.json` + `overrides/**`
 *   -> index:   { formatVersion: 1, game: "minecraft", versionId: "8.1.0",
 *                name: "Fabulously Optimized",
 *                dependencies: { "fabric-loader": "0.16.14", minecraft: "1.21.4" },
 *                files: [{ path: "mods/…jar", hashes: { sha1, sha512 },
 *                          env: { client: "required", server: "required" },
 *                          downloads: ["https://cdn.modrinth.com/…"], fileSize: 155059 }] }
 *
 * So the real field names are `versionId` / `dependencies.minecraft` /
 * `dependencies.<loader>` — *not* `version` / `game.minecraft.version` /
 * `loader.{id,version}`, and the member is `modrinth.index.json`, not
 * `mrmodpack.json`. `parseMrpackIndex` accepts the legacy draft names as well, and
 * `env` may be the `"required" | "optional" | "unsupported"` enum or the early boolean
 * shape. A trimmed copy of that real index lives in
 * `tests/fixtures/modpack/modrinth.index.json` (4 entries verbatim + 2 synthesized to
 * cover `env.client = "unsupported"`, which the sampled pack happens not to contain).
 */
import type { Instance, LoaderId, ModpackImportRequest } from '@shared/types'
import { AppError, invalidInput } from '@shared/errors'
import { openZip, type ZipReader } from '../core/zip'
import type { VersionInstallOutcome } from '../core/contracts'
import {
  MRPACK_INDEX_NAMES,
  OVERRIDES_PREFIX,
  createPackInstance,
  describeLoader,
  downloadItemsFor,
  extractOverrides,
  instanceVersionId,
  localJob,
  manifestOf,
  loaderIdFromKey,
  queuePlan
} from './common'
import { findMember, readTextMember } from './detect'
import type { ImportOutcome, ModpackServiceDeps } from './types'

export interface MrpackFileEntry {
  path: string
  hashes?: { sha1?: string; sha512?: string }
  env?: { client?: string | boolean; server?: string | boolean }
  downloads?: string[]
  fileSize?: number
  type?: string
  optional?: boolean
}

/** Union of the shipped (`modrinth.index.json`) and the legacy draft shape. */
export interface MrpackRaw {
  formatVersion?: number
  game?: string | { minecraft?: { version?: string } ; [key: string]: unknown }
  versionId?: string
  version?: string
  name?: string
  author?: string
  organization?: string
  overrides?: string
  dependencies?: Record<string, string>
  loader?: { id?: string; version?: string }
  files?: unknown
}

export interface MrpackIndex {
  /** Member the index was read from (`modrinth.index.json` normally). */
  member: string
  name: string
  author: string
  version: string
  gameVersion: string
  loader: { id: LoaderId; version: string }
  files: MrpackFileEntry[]
  overrides: string
  /** Anything odd about the pack, e.g. an unusable `formatVersion`. */
  warnings: string[]
}

/** `"unsupported"` / `false` means "not needed on the client". */
export function clientVisible(entry: MrpackFileEntry): boolean {
  const client = entry.env?.client
  if (typeof client === 'boolean') return client
  if (typeof client === 'string') return client.toLowerCase() !== 'unsupported'
  return true
}

/** `env.server` mirror of the above; used to label client-only files. */
export function serverVisible(entry: MrpackFileEntry): boolean {
  const server = entry.env?.server
  if (typeof server === 'boolean') return server
  if (typeof server === 'string') return server.toLowerCase() !== 'unsupported'
  return true
}

function entriesOf(raw: MrpackRaw): MrpackFileEntry[] {
  if (!Array.isArray(raw.files)) return []
  const out: MrpackFileEntry[] = []
  for (const item of raw.files) {
    const entry = item as MrpackFileEntry
    if (typeof entry?.path !== 'string' || entry.path.length === 0) continue
    out.push({
      path: entry.path,
      ...(entry.hashes ? { hashes: entry.hashes } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.downloads ? { downloads: entry.downloads } : {}),
      ...(typeof entry.fileSize === 'number' ? { fileSize: entry.fileSize } : {}),
      ...(entry.type ? { type: entry.type } : {}),
      ...(typeof entry.optional === 'boolean' ? { optional: entry.optional } : {})
    })
  }
  return out
}

function gameVersionOf(raw: MrpackRaw): string {
  const fromDeps = raw.dependencies?.minecraft ?? raw.dependencies?.['game']
  if (typeof fromDeps === 'string' && fromDeps.length > 0) return fromDeps
  const game = raw.game
  if (game && typeof game === 'object') {
    const nested = (game as { minecraft?: { version?: string } }).minecraft?.version
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return ''
}

function loaderOf(raw: MrpackRaw): { id: LoaderId; version: string } {
  for (const [key, value] of Object.entries(raw.dependencies ?? {})) {
    if (key.toLowerCase() === 'minecraft' || key.toLowerCase() === 'game') continue
    const id = loaderIdFromKey(key)
    if (id) return { id, version: String(value ?? '') }
  }
  // Legacy draft shape: `loader: { id, version }`.
  const legacyId = raw.loader?.id ? loaderIdFromKey(raw.loader.id) : undefined
  if (legacyId) return { id: legacyId, version: raw.loader?.version ?? '' }
  return { id: 'vanilla', version: raw.loader?.version ?? '' }
}

export function parseMrpackIndex(text: string, member: string): MrpackIndex {
  let raw: MrpackRaw
  try {
    raw = JSON.parse(text) as MrpackRaw
  } catch (error) {
    throw invalidInput('整合包清单不是有效的 JSON', `${member}: ${String(error)}`)
  }
  const warnings: string[] = []
  if (raw.formatVersion !== undefined && raw.formatVersion !== 1) {
    warnings.push(`formatVersion=${String(raw.formatVersion)}（本启动器只按 v1 解析）`)
  }
  const gameVersion = gameVersionOf(raw)
  if (gameVersion.length === 0) throw invalidInput('整合包清单缺少 Minecraft 版本', `${member}.dependencies.minecraft`)
  const files = entriesOf(raw)
  const loader = loaderOf(raw)
  if (loader.id !== 'vanilla' && loader.version.length === 0) {
    warnings.push(`清单声明了 ${loader.id} 但没有版本号，将按原版版本安装`)
  }
  const overrides = typeof raw.overrides === 'string' && raw.overrides.length > 0 ? raw.overrides : OVERRIDES_PREFIX
  return {
    member,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : '导入的整合包',
    author: raw.author ?? raw.organization ?? (typeof raw.game === 'string' ? 'Modrinth' : ''),
    version: raw.versionId ?? raw.version ?? '',
    gameVersion,
    loader,
    files,
    overrides: overrides.replace(/\/+$/, ''),
    warnings
  }
}

/** Opens the pack and returns its normalized index plus the still-open reader. */
export async function readMrpack(file: string): Promise<{ index: MrpackIndex; zip: ZipReader }> {
  const zip = await openZip(file)
  const member = findMember(zip.names(), MRPACK_INDEX_NAMES[0]) ?? findMember(zip.names(), MRPACK_INDEX_NAMES[1])
  if (!member) {
    await zip.close().catch(() => undefined)
    throw new AppError('not-found', '整合包缺少 modrinth.index.json', file)
  }
  try {
    const text = await readTextMember(zip, member)
    return { index: parseMrpackIndex(text, member), zip }
  } catch (error) {
    await zip.close().catch(() => undefined)
    throw error
  }
}

/**
 * Imports an mrpack into a brand-new isolated instance.
 *
 * Order: instance -> overrides -> version + loader -> queued file downloads, so the
 * user always ends up with a visible instance even when the network part fails.
 */
export async function importMrpack(deps: ModpackServiceDeps, req: ModpackImportRequest): Promise<ImportOutcome> {
  const log = deps.log.child('modpack.mrpack')
  const { index, zip } = await readMrpack(req.file)
  let instance: Instance
  try {
    instance = createPackInstance(deps, {
      name: req.name.length > 0 ? req.name : index.name,
      versionId: index.gameVersion,
      gameVersion: index.gameVersion,
      loader: index.loader.id,
      loaderVersion: index.loader.version.length > 0 ? index.loader.version : undefined,
      description: `导入自 ${index.name}${index.version ? ` ${index.version}` : ''}（${describeLoader(index.loader.id, index.loader.version)}）`
    })
    const gameDir = deps.instances.gameDir(instance)

    // 1. overrides, traversal-guarded, prefix stripped.
    const overrides = await extractOverrides(zip, gameDir, index.overrides)
    if (overrides.refused.length > 0) {
      log.warn(`忽略了 ${overrides.refused.length} 个越界的 overrides 成员：${overrides.refused.slice(0, 5).join(', ')}`)
    }

    // 2. version + loader. `install` returns the id it actually wrote (loader-patched).
    const installRequest: Parameters<typeof deps.versions.install>[0] = {
      id: index.gameVersion,
      createInstance: false
    }
    if (index.loader.id !== 'vanilla' && index.loader.version.length > 0) {
      installRequest.loader = { id: index.loader.id, version: index.loader.version }
    }
    let versionOutcome: VersionInstallOutcome
    try {
      versionOutcome = await deps.versions.install(installRequest)
    } catch (error) {
      const wrapped = AppError.from(error, 'network')
      log.error(`版本安装失败，实例 ${instance.id} 已建立但内容为空: ${wrapped.message}`)
      await closeQuietly(zip)
      const job = localJob(`${index.name}：版本安装失败`, 'modpack', index.files.length, 'error')
      job.failed = index.files.length
      job.error = wrapped.toPayload()
      return {
        job,
        manifest: manifestOf(index.name, index.author, index.version, index.gameVersion, index.loader, index.files.length),
        instance
      }
    }
    const versionId = instanceVersionId(versionOutcome.versionId, index.gameVersion)
    if (versionId !== instance.versionId) {
      instance = deps.instances.update(instance.id, {
        versionId,
        loader: index.loader.id,
        loaderVersion: index.loader.version.length > 0 ? index.loader.version : undefined
      })
    }

    // 3. client-visible files -> the instance's own dirs.
    const wanted = index.files.filter(clientVisible)
    const skippedServerOnly = index.files.length - wanted.length
    const entries = wanted.map((entry) => ({
      relative: entry.path,
      urls: entry.downloads ?? [],
      sha1: entry.hashes?.sha1,
      size: entry.fileSize
    }))
    const { items, skipped } = downloadItemsFor(gameDir, entries)
    for (const bad of skipped) log.warn(`清单条目没有可下载地址：${bad}`)

    const title = `导入整合包 ${index.name}${index.version ? ` ${index.version}` : ''}`
    const job = await queuePlan(deps.downloader, title, items, 'modpack')
    if (skippedServerOnly > 0) log.info(`跳过 ${skippedServerOnly} 个仅服务端文件（env.client=unsupported）`)
    if (index.warnings.length > 0) log.warn(index.warnings.join('；'))

    await closeQuietly(zip)
    return {
      job,
      manifest: manifestOf(index.name, index.author, index.version, index.gameVersion, index.loader, index.files.length),
      instance
    }
  } catch (error) {
    await closeQuietly(zip)
    throw error
  }
}

async function closeQuietly(zip: { close: () => Promise<void> }): Promise<void> {
  await zip.close().catch(() => undefined)
}

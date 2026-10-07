/**
 * Version manifest access with an on-disk cache under `<configDir>/cache`.
 * The primary endpoint is probed first; the legacy host is the automatic fallback.
 */
import path from 'node:path'
import { ENDPOINTS, MANIFEST_CACHE_MS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { PathInfo, VersionManifest, VersionRef, VersionType } from '@shared/types'
import { compareVersionIds } from '@shared/utils'
import { readJsonSafe, writeJsonAtomic } from '../core/fsx'
import type { HttpClient } from '../core/contracts'
import type { Logger } from '../core/log'

/** Types hidden unless the caller asks for them explicitly. */
const DEFAULT_HIDDEN: VersionType[] = ['old_beta', 'old_alpha']

export interface ManifestCacheFile {
  fetchedAt: number
  manifest: VersionManifest
}

export interface ManifestDeps {
  http: HttpClient
  paths: () => PathInfo
  log: Logger
}

export interface ManifestService {
  /** Cached document; refetches when older than MANIFEST_CACHE_MS or `force`. */
  load(force?: boolean): Promise<VersionManifest>
  /** Fetches (respecting the cache unless `force`) and returns every ref. */
  refresh(force?: boolean): Promise<VersionRef[]>
  /** Visible list: sorted by compareVersionIds desc, old_beta/old_alpha filtered unless requested. */
  list(types?: VersionType[]): Promise<VersionRef[]>
  refFor(id: string): Promise<VersionRef>
}

export function manifestCacheFile(paths: PathInfo): string {
  return path.join(paths.configDir, 'cache', 'version_manifest.json')
}

function isManifest(value: unknown): value is VersionManifest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.versions) && v.latest != null && typeof v.latest === 'object'
}

export function createManifest(deps: ManifestDeps): ManifestService {
  let memory: ManifestCacheFile | undefined

  async function readCache(): Promise<ManifestCacheFile | undefined> {
    if (memory) return memory
    const raw = await readJsonSafe<ManifestCacheFile | null>(manifestCacheFile(deps.paths()), null)
    if (raw && isManifest(raw.manifest) && typeof raw.fetchedAt === 'number') {
      memory = raw
      return raw
    }
    return undefined
  }

  async function fetchRemote(): Promise<VersionManifest> {
    try {
      return await deps.http.json<VersionManifest>(ENDPOINTS.versionManifest)
    } catch (error) {
      deps.log.warn(`version_manifest_v2.json 主地址失败，回退旧地址: ${String(error)}`)
      // Throws if the legacy host fails too; AppError.from keeps network semantics.
      return await deps.http.json<VersionManifest>(ENDPOINTS.versionManifestLegacy)
    }
  }

  async function load(force = false): Promise<VersionManifest> {
    const cached = await readCache()
    if (!force && cached && Date.now() - cached.fetchedAt < MANIFEST_CACHE_MS) return cached.manifest
    try {
      const manifest = await fetchRemote()
      if (!isManifest(manifest)) throw new AppError('internal', '版本清单格式不正确')
      const next: ManifestCacheFile = { fetchedAt: Date.now(), manifest }
      memory = next
      await writeJsonAtomic(manifestCacheFile(deps.paths()), next).catch((e: unknown) => {
        deps.log.warn(`写入版本清单缓存失败: ${String(e)}`)
      })
      return manifest
    } catch (error) {
      // Offline / both hosts down: the stale cache is still better than nothing.
      if (cached) {
        deps.log.warn(`版本清单刷新失败，使用过期缓存: ${String(error)}`)
        return cached.manifest
      }
      throw AppError.from(error, 'network')
    }
  }

  function sortRefs(refs: VersionRef[]): VersionRef[] {
    return [...refs].sort((a, b) => compareVersionIds(b.id, a.id))
  }

  function filterTypes(refs: VersionRef[], types?: VersionType[]): VersionRef[] {
    if (types && types.length > 0) return refs.filter((r) => types.includes(r.type))
    return refs.filter((r) => !DEFAULT_HIDDEN.includes(r.type))
  }

  return {
    load,
    async refresh(force = false) {
      const manifest = await load(force)
      return sortRefs(manifest.versions)
    },
    async list(types?: VersionType[]) {
      const manifest = await load()
      return sortRefs(filterTypes(manifest.versions, types))
    },
    async refFor(id: string) {
      const manifest = await load()
      const ref = manifest.versions.find((r) => r.id === id)
      if (!ref) throw new AppError('not-found', `版本 ${id} 不存在`, ENDPOINTS.versionManifest)
      return ref
    }
  }
}

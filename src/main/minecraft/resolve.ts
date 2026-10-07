/**
 * Reads a version json (local `<versions>/<id>/<id>.json` first, network otherwise),
 * follows `inheritsFrom` and merges the parent into a ResolvedVersion.
 * The merged document is cached under `<configDir>/cache/resolved/<id>.json`;
 * Mojang's own json in the version dir is never overwritten here.
 */
import path from 'node:path'
import fs from 'node:fs'
import { MANIFEST_CACHE_MS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type {
  ArgList,
  Library,
  PathInfo,
  RawVersionJson,
  ResolvedVersion
} from '@shared/types'
import { isSafeName } from '@shared/utils'
import { readJsonSafe, writeJsonAtomic } from '../core/fsx'
import { versionJsonPath, versionJarPath } from '../core/paths'
import type { HttpClient } from '../core/contracts'
import type { Logger } from '../core/log'
import type { ManifestService } from './manifest'

export interface ResolvedCacheFile {
  fetchedAt: number
  resolved: ResolvedVersion
}

export interface ResolverDeps {
  http: HttpClient
  paths: () => PathInfo
  manifest: ManifestService
  log: Logger
}

export interface VersionResolver {
  resolve(id: string): Promise<ResolvedVersion>
  /** Raw (pre-merge) json of `id`, local file preferred over the network. */
  loadRaw(id: string): Promise<RawVersionJson>
  resolvedCacheFile(id: string): string
  invalidate(id: string): void
}

/** Dedupe key: the maven coordinate without the `@ext` suffix. */
function mavenKey(name: string): string {
  return name.split('@')[0] ?? name
}

function mergeLibraries(child: Library[], parent: Library[]): Library[] {
  const out: Library[] = []
  const seen = new Set<string>()
  // Child first: a child entry wins even when its rules deny it on this OS.
  for (const lib of [...child, ...parent]) {
    const key = mavenKey(lib.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(lib)
  }
  return out
}

/** `libraries = child.concat(parent)` deduped, `game` args appended, everything else child ?? parent. */
export function mergeVersionJson(child: RawVersionJson, parent: RawVersionJson): RawVersionJson {
  const merged: RawVersionJson = {
    ...parent,
    ...child,
    id: child.id,
    mainClass: child.mainClass ?? parent.mainClass,
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    libraries: mergeLibraries(child.libraries ?? [], parent.libraries ?? []),
    downloads: child.downloads ?? parent.downloads,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    logging: child.logging ?? parent.logging,
    type: child.type ?? parent.type,
    time: child.time ?? parent.time,
    releaseTime: child.releaseTime ?? parent.releaseTime,
    minimumLauncherVersion: child.minimumLauncherVersion ?? parent.minimumLauncherVersion,
    complianceLevel: child.complianceLevel ?? parent.complianceLevel
  }

  const childGame = child.arguments?.game
  const parentGame = parent.arguments?.game
  const args: { game?: ArgList; jvm?: ArgList } = {}
  if (childGame || parentGame) args.game = [...(parentGame ?? []), ...(childGame ?? [])]
  const jvm = child.arguments?.jvm ?? parent.arguments?.jvm
  if (jvm) args.jvm = jvm
  if (child.arguments || parent.arguments) merged.arguments = args

  return merged
}

export function toResolvedVersion(merged: RawVersionJson, paths: PathInfo): ResolvedVersion {
  if (!merged.id || !isSafeName(merged.id)) throw new AppError('invalid-input', '非法的版本号', merged.id)
  const mainClass = merged.mainClass
  if (!mainClass) throw new AppError('invalid-input', `版本 ${merged.id} 缺少 mainClass`)

  const gameArgs: ArgList = merged.arguments?.game
    ?? (merged.minecraftArguments ? merged.minecraftArguments.split(' ') : [])
  const jvmArgs: ArgList = merged.arguments?.jvm ?? []

  // The `jar` field points at the version whose vanilla jar must be reused.
  const usesVanillaJarOf = merged.jar ? (merged.inheritsFrom ?? merged.jar) : undefined
  const jarSource = usesVanillaJarOf ?? merged.id

  return {
    id: merged.id,
    type: merged.type ?? 'release',
    mainClass,
    gameArgs,
    jvmArgs,
    libraries: merged.libraries ?? [],
    client: merged.downloads?.client,
    assetIndex: merged.assetIndex,
    assetsVersion: merged.assets ?? '1.0',
    javaVersion: merged.javaVersion ?? { majorVersion: 8 },
    logging: merged.logging,
    jsonPath: versionJsonPath(paths, merged.id),
    clientJarPath: versionJarPath(paths, jarSource),
    ...(usesVanillaJarOf ? { usesVanillaJarOf } : {}),
    raw: merged
  }
}

export function createResolver(deps: ResolverDeps): VersionResolver {
  const cacheDir = (): string => path.join(deps.paths().configDir, 'cache', 'resolved')

  function resolvedCacheFile(id: string): string {
    return path.join(cacheDir(), `${id}.json`)
  }

  async function fetchRaw(id: string): Promise<RawVersionJson> {
    const ref = await deps.manifest.refFor(id)
    return await deps.http.json<RawVersionJson>(ref.url)
  }

  async function loadRaw(id: string): Promise<RawVersionJson> {
    const local = await readJsonSafe<RawVersionJson | null>(versionJsonPath(deps.paths(), id), null)
    if (local && local.id === id) return local
    return await fetchRaw(id)
  }

  async function resolve(id: string): Promise<ResolvedVersion> {
    if (!isSafeName(id)) throw new AppError('invalid-input', '非法的版本号', id)
    const paths = deps.paths()

    // Trust the merged cache when the source json is on disk (immutable after install)
    // or while it is still fresh (network-resolved copy).
    const cached = await readJsonSafe<ResolvedCacheFile | null>(resolvedCacheFile(id), null)
    const localJsonPresent = await fs.promises
      .stat(versionJsonPath(paths, id))
      .then((s) => s.isFile())
      .catch(() => false)
    if (cached && cached.resolved?.id === id && (localJsonPresent || Date.now() - cached.fetchedAt < MANIFEST_CACHE_MS)) {
      return cached.resolved
    }

    let merged: RawVersionJson
    try {
      const raw = await loadRaw(id)
      if (raw.inheritsFrom) {
        const parent = await loadRaw(raw.inheritsFrom)
        merged = mergeVersionJson(raw, parent)
      } else {
        merged = raw
      }
    } catch (error) {
      if (cached?.resolved?.id === id) {
        deps.log.warn(`版本 ${id} 解析失败，回退到缓存: ${String(error)}`)
        return cached.resolved
      }
      throw AppError.from(error, 'network')
    }

    const resolved = toResolvedVersion(merged, paths)
    await writeJsonAtomic(resolvedCacheFile(id), { fetchedAt: Date.now(), resolved } satisfies ResolvedCacheFile).catch(
      (e: unknown) => deps.log.warn(`写入 resolved 缓存失败: ${String(e)}`)
    )
    return resolved
  }

  function invalidate(id: string): void {
    try {
      fs.rmSync(resolvedCacheFile(id), { force: true })
    } catch {
      /* cache is disposable */
    }
  }

  return { resolve, loadRaw, resolvedCacheFile, invalidate }
}

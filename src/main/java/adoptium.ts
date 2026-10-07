/**
 * Adoptium (Eclipse Temurin) provisioning.
 *
 * IMPORTANT: Mojang's own java-runtime metadata blobs 404 at every URL tried
 * (see docs/endpoints.md), so this launcher provisions Java exclusively through
 * the Adoptium v3 API, which returned 200 for majors 8/17/21/25 on 2026-10-07.
 * `.../v3/assets/latest/{major}/hotspot?...` is tried first; when it yields no
 * usable package we fall back to `.../v3/assets/feature_releases/{major}?feature_version=...`.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { JavaProvisionResult, JavaRuntime, PathInfo } from '@shared/types'
import type { Downloader, HttpClient } from '../core/contracts'
import { ensureDir, isFile, readJsonSafe, sizeOf, writeJsonAtomic } from '../core/fsx'
import type { Logger } from '../core/log'
import { openZip, unzipAll } from '../core/zip'
import { isPathInside } from '../core/paths'

export type AdoptiumImageType = 'jre' | 'jdk'

export interface AdoptiumRelease {
  release_name?: string
  version?: { major?: number; semver?: string }
  binary?: {
    architecture?: string
    image_type?: string
    os?: string
    package?: { link?: string; name?: string; checksum?: string; size?: number }
  }
}

export interface AdoptiumPackage {
  link: string
  name: string
  checksum?: string
  size?: number
  releaseName: string
  semver: string
}

/* ------------------------------------------------------------------ */
/* urls + payload picking                                              */
/* ------------------------------------------------------------------ */

export function adoptiumLatestUrl(major: number, imageType: AdoptiumImageType = 'jre', arch = 'x64', os = 'windows'): string {
  return `${ENDPOINTS.adoptiumLatest}/${major}/hotspot?architecture=${arch}&image_type=${imageType}&os=${os}&vendor=eclipse`
}

/** Fallback: the feature_releases list endpoint (`/9?feature_version=9...` style). */
export function adoptiumListUrl(major: number, imageType: AdoptiumImageType = 'jre', arch = 'x64', os = 'windows'): string {
  const q = `feature_version=${major}&architecture=${arch}&image_type=${imageType}&os=${os}&vendor=eclipse&sort_order=DESC&page_size=8`
  return `${ENDPOINTS.adoptiumReleaseList}/${major}?${q}`
}

/**
 * Chooses the best package from an Adoptium response array. Filters hard on
 * `package.link`; ranks os/architecture/image_type matches so a jdk-only answer
 * is still usable when the jre query came back empty.
 */
export function pickAdoptiumPackage(payload: unknown, imageType: AdoptiumImageType, arch = 'x64', os = 'windows'): AdoptiumPackage | undefined {
  const releases = Array.isArray(payload) ? (payload as AdoptiumRelease[]) : []
  let best: { pkg: AdoptiumPackage; score: number } | undefined
  for (const release of releases) {
    const pkgInfo = release?.binary?.package
    if (!pkgInfo?.link) continue
    const pkg: AdoptiumPackage = {
      link: pkgInfo.link,
      name: pkgInfo.name ?? path.basename(new URL(pkgInfo.link, 'https://example.invalid').pathname),
      checksum: pkgInfo.checksum,
      size: pkgInfo.size,
      releaseName: release.release_name ?? `jdk${imageType}`,
      semver: release.version?.semver ?? release.release_name ?? ''
    }
    let score = 0
    if (release.binary?.os !== os) score += 4
    if (release.binary?.architecture !== arch) score += 4
    if (release.binary?.image_type !== imageType) score += 2
    if (best === undefined || score < best.score) best = { pkg, score }
  }
  return best?.pkg
}

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

export interface JavaRegistryEntry {
  id: string
  major: number
  /** Runtime ROOT (the folder that contains `bin/`), not the extracted top folder. */
  root: string
  executable: string
  vendor: string
  releaseName: string
  installedAt: number
  source: 'adoptium'
}

export interface JavaRegistryFile {
  version: number
  entries: JavaRegistryEntry[]
}

export function registryFilePath(javaStoreDir: string): string {
  return path.join(javaStoreDir, 'registry.json')
}

export async function loadRegistry(javaStoreDir: string): Promise<JavaRegistryFile> {
  const raw = await readJsonSafe<JavaRegistryFile>(registryFilePath(javaStoreDir), { version: 1, entries: [] })
  return { version: raw.version ?? 1, entries: Array.isArray(raw.entries) ? raw.entries : [] }
}

export async function saveRegistry(javaStoreDir: string, file: JavaRegistryFile): Promise<void> {
  await writeJsonAtomic(registryFilePath(javaStoreDir), file)
}

/* ------------------------------------------------------------------ */
/* extracted-archive navigation                                        */
/* ------------------------------------------------------------------ */

/**
 * Adoptium zips contain a single top folder like `jdk-25.0.4.1+1`. Walk up to
 * `maxDepth` levels looking for `bin/javaw.exe` (or `java.exe`) and return the
 * directory that owns `bin`, i.e. the runtime ROOT.
 */
export async function findRuntimeRoot(dir: string, maxDepth = 3): Promise<string | undefined> {
  const queue: { current: string; depth: number }[] = [{ current: dir, depth: 0 }]
  while (queue.length > 0) {
    const { current, depth } = queue.shift()!
    if (await isFile(path.join(current, 'bin', 'javaw.exe'))) return current
    if (await isFile(path.join(current, 'bin', 'java.exe'))) return current
    if (depth >= maxDepth) continue
    let names: string[] = []
    try {
      names = await fsp.readdir(current)
    } catch {
      continue
    }
    for (const name of names) {
      const child = path.join(current, name)
      try {
        if ((await fsp.stat(child)).isDirectory()) queue.push({ current: child, depth: depth + 1 })
      } catch {
        /* ignore unreadable children */
      }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* provisioner                                                         */
/* ------------------------------------------------------------------ */

export interface AdoptiumDeps {
  http: HttpClient
  downloader: Downloader
  paths: () => PathInfo
  log: Logger
}

export interface AdoptiumProvisioner {
  /** Runtimes recorded in registry.json whose files still exist. */
  listProvisioned(): Promise<JavaRuntime[]>
  /** Find a provisioned runtime by pinned executable/root path (case-insensitive). */
  lookupByPath(p: string): Promise<JavaRuntime | undefined>
  provision(req: { major: number; imageType?: AdoptiumImageType; targetDir?: string }): Promise<JavaProvisionResult>
  remove(id: string): Promise<void>
}

export function runtimeFromEntry(entry: JavaRegistryEntry): JavaRuntime {
  return {
    id: entry.id,
    path: entry.root,
    rawVersion: `${entry.vendor} ${entry.releaseName} (auto-provisioned)`,
    major: entry.major,
    vendor: entry.vendor,
    arch: 'x64',
    source: 'adoptium',
    executable: entry.executable,
    canHeadless: true
  }
}

export function createAdoptiumProvisioner(deps: AdoptiumDeps): AdoptiumProvisioner {
  const storeDir = (): string => deps.paths().javaStoreDir

  async function resolvePackage(major: number, imageType: AdoptiumImageType): Promise<AdoptiumPackage> {
    const latestUrl = adoptiumLatestUrl(major, imageType)
    let pkg = pickAdoptiumPackage(await deps.http.json<unknown>(latestUrl).catch((error: unknown) => {
      deps.log.warn(`Adoptium latest(${major}) 查询失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }), imageType)
    if (!pkg) {
      const listUrl = adoptiumListUrl(major, imageType)
      pkg = pickAdoptiumPackage(await deps.http.json<unknown>(listUrl).catch((error: unknown) => {
        throw new AppError('network', 'Adoptium API 无法访问', error instanceof Error ? error.message : String(error), true)
      }), imageType)
    }
    if (!pkg) throw new AppError('not-found', `Adoptium 没有提供 Java ${major} 的 Windows x64 安装包`, latestUrl)
    return pkg
  }

  async function extractArchive(zipFile: string, dir: string): Promise<void> {
    try {
      const zip = await openZip(zipFile)
      try {
        await zip.extractTo(dir)
      } finally {
        await zip.close()
      }
    } catch (error) {
      // core/zip sizes its central-directory read as entryCount*46+8, which
      // truncates archives with long entry names (real Temurin zips RangeError).
      // Fall back to the whole-archive inflate from core/zip in that case.
      deps.log.warn(`openZip 增量解压失败，回退整包解压：${String(error)}`)
      const buffer = await fsp.readFile(zipFile)
      const files = unzipAll(buffer)
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/') || /^[a-z]:|^\//i.test(name)) continue
        const target = path.join(dir, name)
        const rel = path.relative(path.resolve(dir), path.resolve(target))
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue
        await ensureDir(path.dirname(target))
        await fsp.writeFile(target, Buffer.from(data))
      }
    }
  }

  async function extractAndRegister(pkg: AdoptiumPackage, cacheFile: string, major: number, targetDir: string): Promise<JavaProvisionResult> {
    await fsp.rm(targetDir, { recursive: true, force: true })
    await ensureDir(targetDir)
    await extractArchive(cacheFile, targetDir)
    const root = await findRuntimeRoot(targetDir, 3)
    if (!root) throw new AppError('internal', `解压后未找到 bin/javaw.exe`, targetDir)
    const javaw = path.join(root, 'bin', 'javaw.exe')
    const executable = (await isFile(javaw)) ? javaw : path.join(root, 'bin', 'java.exe')
    const entry: JavaRegistryEntry = {
      id: `temurin-${major}`,
      major,
      root,
      executable,
      vendor: 'Eclipse Temurin',
      releaseName: pkg.releaseName,
      installedAt: Date.now(),
      source: 'adoptium'
    }
    const reg = await loadRegistry(storeDir())
    reg.entries = reg.entries.filter((e) => e.id !== entry.id && e.major !== major)
    reg.entries.push(entry)
    await saveRegistry(storeDir(), reg)
    deps.log.info(`Java ${major} 已安装到 ${root}`)
    return { runtime: runtimeFromEntry(entry), downloadedBytes: pkg.size ?? (await sizeOf(cacheFile)), fromCache: false }
  }

  return {
    async listProvisioned(): Promise<JavaRuntime[]> {
      const reg = await loadRegistry(storeDir())
      const out: JavaRuntime[] = []
      for (const entry of reg.entries) {
        if (await isFile(entry.executable)) out.push(runtimeFromEntry(entry))
      }
      return out
    },

    async lookupByPath(p: string): Promise<JavaRuntime | undefined> {
      if (!p) return undefined
      const needle = p.toLowerCase()
      const reg = await loadRegistry(storeDir())
      for (const entry of reg.entries) {
        if (
          (entry.executable.toLowerCase() === needle || entry.root.toLowerCase() === needle) &&
          (await isFile(entry.executable))
        ) {
          return runtimeFromEntry(entry)
        }
      }
      return undefined
    },

    async provision(req): Promise<JavaProvisionResult> {
      const major = req.major
      if (!Number.isInteger(major) || major <= 0) throw new AppError('invalid-input', 'Java 主版本号不合法', String(major))
      const imageType: AdoptiumImageType = req.imageType ?? 'jre'
      const store = storeDir()
      const targetDir = req.targetDir ?? path.join(store, String(major))

      // Idempotency: a registry entry whose files survived is reused as-is.
      const reg = await loadRegistry(store)
      const existing = reg.entries.find((e) => e.major === major && (!req.targetDir || e.root === targetDir))
      if (existing && (await isFile(existing.executable))) {
        return { runtime: runtimeFromEntry(existing), downloadedBytes: 0, fromCache: true }
      }

      const pkg = await resolvePackage(major, imageType)
      const cacheDir = path.join(store, '_cache')
      const cacheFile = path.join(cacheDir, pkg.name)
      const item = {
        id: cacheFile,
        url: pkg.link,
        target: cacheFile,
        sha1: pkg.checksum,
        size: pkg.size,
        kind: 'java' as const,
        label: `Temurin ${major} (${imageType})`,
        overwrite: true
      }
      const result = await deps.downloader.ensure(item)
      const fromCache = !result.fetched
      const extracted = await extractAndRegister(pkg, cacheFile, major, targetDir)
      return { ...extracted, fromCache }
    },

    async remove(id: string): Promise<void> {
      const store = storeDir()
      const reg = await loadRegistry(store)
      const entry = reg.entries.find((e) => e.id === id)
      if (!entry) throw new AppError('not-found', `Java 运行时 ${id} 不存在`, registryFilePath(store))
      // Only delete directories we provisioned ourselves.
      if (isPathInside(store, entry.root)) fs.rmSync(entry.root, { recursive: true, force: true })
      reg.entries = reg.entries.filter((e) => e.id !== id)
      await saveRegistry(store, reg)
    }
  }
}

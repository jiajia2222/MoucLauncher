/**
 * ModService: search/version discovery across providers, install into an instance with
 * required-dependency resolution, enumerate/toggle/remove installed jars, and update
 * detection.
 *
 * Routing by kind -> `<gameDir>/mods|resourcepacks|shaderpacks|saves`. `modpack` is NOT
 * handled as a mod: the `.mrpack` is fetched into a temp dir and a job returned — the
 * actual import belongs to ModpackService (not this module).
 */
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type {
  DownloadItem,
  DownloadJob,
  DownloadPlan,
  InstalledMod,
  LoaderId,
  ModFile,
  ModProject,
  PathInfo,
  ProjectKind,
  ProjectProvider,
  ProjectVersion,
  SearchPage,
  SearchQuery
} from '@shared/types'
import type { Downloader, HttpClient, ModService, SettingsLike } from '../core/contracts'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'
import { readJsonSafe, writeJsonAtomic, readdirSafe, sizeOf, isFile } from '../core/fsx'
import { createModrinthProvider, type ModrinthProvider } from './providers/modrinth'
import { createCurseForgeProvider, type CurseForgeProvider } from './providers/curseforge'
import { readModMetadata } from './metadata'

export interface ModServiceDeps {
  http: HttpClient
  downloader: Downloader
  instances: InstanceStore
  settings: SettingsLike
  paths: PathInfo
  log: Logger
}

/** Provenance map keyed by jar file name; used to drive update checks. */
interface ProvenanceEntry {
  provider: ProjectProvider
  projectId: string
  versionId?: string
  kind: ProjectKind
}
type ProvenanceFile = Record<string, ProvenanceEntry>

const KIND_DIR: Record<Exclude<ProjectKind, 'modpack'>, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  world: 'saves'
}

const DISABLED_SUFFIX = '.disabled'
const MAX_DEP_DEPTH = 6

/** Strips the `.disabled` suffix so provenance is always keyed by the enabled name. */
function baseName(fileName: string): string {
  return fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName
}

export function createModService(deps: ModServiceDeps): ModService {
  const { http, downloader, instances, settings, log } = deps
  const modrinth: ModrinthProvider = createModrinthProvider(http, ENDPOINTS.modrinthSearch)

  // CurseForge reads the API key lazily so a key added in Settings takes effect without
  // re-creating the service.
  function curseforge(): CurseForgeProvider {
    return createCurseForgeProvider(http, settings.get().curseForgeApiKey, ENDPOINTS.curseForgeMods)
  }

  /* ------------------------------ routing ------------------------------ */

  type OnlineProvider = Pick<ModrinthProvider, 'search' | 'versions'>
  function providerFor(provider: ProjectProvider): OnlineProvider {
    if (provider === 'modrinth') return modrinth
    if (provider === 'curseforge') return curseforge()
    throw new AppError('unsupported', '本地来源没有在线仓库')
  }

  /* ------------------------------ routing ------------------------------ */

  function kindDir(kind: ProjectKind, gameDir: string): string {
    if (kind === 'modpack') {
      const dir = path.join(os.tmpdir(), 'mouc-modpacks', String(Date.now()))
      return dir
    }
    return path.join(gameDir, KIND_DIR[kind])
  }

  function provenanceFile(gameDir: string): string {
    return path.join(gameDir, '.mouc', 'mod-provenance.json')
  }

  async function readProvenance(gameDir: string): Promise<ProvenanceFile> {
    return readJsonSafe<ProvenanceFile>(provenanceFile(gameDir), {})
  }

  async function writeProvenance(gameDir: string, data: ProvenanceFile): Promise<void> {
    await writeJsonAtomic(provenanceFile(gameDir), data)
  }

  /* ------------------------------ search / versions ------------------------------ */

  async function search(query: SearchQuery): Promise<SearchPage<ModProject>> {
    return providerFor(query.provider).search(query)
  }

  async function versions(
    provider: ProjectProvider,
    projectId: string,
    gameVersion?: string,
    loader?: string
  ): Promise<ProjectVersion[]> {
    return providerFor(provider).versions(projectId, gameVersion, loader)
  }

  /* ------------------------------ install ------------------------------ */

  function fileToItem(file: ModFile, target: string): DownloadItem {
    const item: DownloadItem = {
      id: target,
      url: file.url,
      target,
      kind: 'mod',
      label: file.fileName,
      overwrite: true
    }
    if (file.hashes.sha1) item.sha1 = file.hashes.sha1
    if (file.size) item.size = file.size
    return item
  }

  /** Recursively gathers required dependencies that are not already installed. */
  async function collectDependencies(
    file: ModFile,
    provider: ProjectProvider,
    gameDir: string,
    installedProjectIds: Set<string>,
    visited: Set<string>,
    depth: number
  ): Promise<Array<{ file: ModFile; item: DownloadItem }>> {
    if (depth >= MAX_DEP_DEPTH) {
      log.warn(`依赖解析超过最大深度 ${MAX_DEP_DEPTH}，停止于 ${file.fileName}`)
      return []
    }
    const out: Array<{ file: ModFile; item: DownloadItem }> = []
    const required = file.dependencies.filter((d) => d.kind === 'required' && d.projectId)
    for (const dep of required) {
      const depProvider = dep.projectProvider ?? provider
      const key = `${depProvider}:${dep.projectId}`
      if (visited.has(key) || installedProjectIds.has(dep.projectId)) continue
      visited.add(key)
      try {
        const versions = await providerFor(depProvider).versions(dep.projectId)
        const primaryVersion = versions.find((v) => v.files.some((f) => f.primary)) ?? versions[0]
        const depFile = primaryVersion?.files.find((f) => f.primary) ?? primaryVersion?.files[0]
        if (!depFile) continue
        const target = path.join(kindDir('mod', gameDir), depFile.fileName)
        out.push({ file: depFile, item: fileToItem(depFile, target) })
        const nested = await collectDependencies(depFile, depProvider, gameDir, installedProjectIds, visited, depth + 1)
        out.push(...nested)
      } catch (error) {
        log.warn(`依赖 ${dep.projectId} 解析失败: ${String(error)}`)
      }
    }
    return out
  }

  async function install(instanceId: string, kind: ProjectKind, file: ModFile, withDependencies = false): Promise<DownloadJob> {
    const instance = instances.require(instanceId)
    const gameDir = instances.gameDir(instance)
    const dir = kindDir(kind, gameDir)
    const target = path.join(dir, file.fileName)
    const items: DownloadItem[] = [fileToItem(file, target)]
    const provenance: Record<string, ProvenanceEntry> = {
      [file.fileName]: { provider: file.provider, projectId: file.projectId, versionId: file.versionId, kind }
    }

    if (withDependencies && file.provider !== 'local') {
      const installedProjectIds = await installedProjectIdSet(gameDir)
      const deps = await collectDependencies(file, file.provider, gameDir, installedProjectIds, new Set([`${file.provider}:${file.projectId}`]), 0)
      for (const dep of deps) {
        items.push(dep.item)
        provenance[dep.file.fileName] = { provider: dep.file.provider, projectId: dep.file.projectId, versionId: dep.file.versionId, kind: 'mod' }
      }
    }

    const plan: DownloadPlan = { title: `安装 ${file.fileName}`, kind: kind === 'modpack' ? 'modpack' : 'mod', items, after: 'none' }
    const job = await downloader.run(plan)
    const existing = await readProvenance(gameDir)
    await writeProvenance(gameDir, { ...existing, ...provenance })
    return job
  }

  /* ------------------------------ installed / toggle / remove ------------------------------ */

  async function installedProjectIdSet(gameDir: string): Promise<Set<string>> {
    const prov = await readProvenance(gameDir)
    return new Set(Object.values(prov).map((p) => p.projectId))
  }

  async function listDir(dir: string): Promise<string[]> {
    return readdirSafe(dir)
  }

  function isDisabled(fileName: string): boolean {
    return fileName.endsWith(`.jar${DISABLED_SUFFIX}`) || fileName.endsWith(`.zip${DISABLED_SUFFIX}`)
  }

  async function toInstalledMod(file: string, fileName: string, disabled: boolean, prov?: ProvenanceEntry): Promise<InstalledMod> {
    const mod: InstalledMod = {
      fileName,
      size: await sizeOf(file),
      disabled,
      updatedAt: (await fsp.stat(file).then((s) => s.mtimeMs).catch(() => 0))
    }
    // Metadata only for jar-family artifacts (resourcepacks/shaders are zips without a mod descriptor).
    if (fileName.endsWith('.jar') || fileName.endsWith('.jar.disabled')) {
      const parsed = await readModMetadata(file)
      Object.assign(mod, parsed)
    }
    if (prov) {
      mod.projectId = prov.projectId
      mod.provider = prov.provider
      mod.versionId = prov.versionId
    }
    return mod
  }

  async function installed(instanceId: string): Promise<InstalledMod[]> {
    const instance = instances.require(instanceId)
    const gameDir = instances.gameDir(instance)
    const dir = path.join(gameDir, 'mods')
    const names = await listDir(dir)
    const provenance = await readProvenance(gameDir)
    const out: InstalledMod[] = []
    for (const name of names) {
      if (!(await isFile(path.join(dir, name)))) continue
      const disabled = isDisabled(name)
      // Provenance is keyed by the enabled file name.
      out.push(await toInstalledMod(path.join(dir, name), name, disabled, provenance[baseName(name)]))
    }
    return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
  }

  async function toggle(instanceId: string, fileName: string, disabled: boolean): Promise<InstalledMod> {
    const instance = instances.require(instanceId)
    const gameDir = instances.gameDir(instance)
    const dir = path.join(gameDir, 'mods')
    const source = path.join(dir, fileName)
    if (!(await isFile(source))) throw new AppError('not-found', `mod 文件不存在`, fileName)
    // Disabled state is expressed purely by the `.disabled` suffix.
    const baseEnabled = fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName
    const target = disabled ? `${baseEnabled}${DISABLED_SUFFIX}` : baseEnabled
    const targetPath = path.join(dir, target)
    if (source !== targetPath) await fsp.rename(source, targetPath)
    const provenance = await readProvenance(gameDir)
    // Provenance stays keyed by the enabled name regardless of the disabled suffix.
    const entry = provenance[baseEnabled]
    return toInstalledMod(targetPath, target, disabled, entry)
  }

  async function remove(instanceId: string, fileName: string): Promise<void> {
    const instance = instances.require(instanceId)
    const gameDir = instances.gameDir(instance)
    const file = path.join(gameDir, 'mods', fileName)
    await fsp.rm(file, { force: true })
    const provenance = await readProvenance(gameDir)
    const base = fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName
    if (provenance[base] || provenance[fileName]) {
      delete provenance[base]
      delete provenance[fileName]
      await writeProvenance(gameDir, provenance)
    }
  }

  /* ------------------------------ updates ------------------------------ */

  async function checkUpdates(instanceId: string): Promise<InstalledMod[]> {
    const instance = instances.require(instanceId)
    const gameDir = instances.gameDir(instance)
    const provenance = await readProvenance(gameDir)
    const loader = instance.loader as LoaderId
    const list = await installed(instanceId)
    const out: InstalledMod[] = []
    for (const mod of list) {
      const entry = provenance[baseName(mod.fileName)]
      if (!entry || entry.provider === 'local' || !mod.projectId) {
        out.push(mod)
        continue
      }
      try {
        const versions = await providerFor(entry.provider).versions(entry.projectId, instance.gameVersion, loader)
        const newest = versions[0]
        if (newest && entry.versionId && newest.id !== entry.versionId) mod.updateAvailable = newest
        else if (newest && !entry.versionId) mod.updateAvailable = newest
      } catch (error) {
        log.warn(`检查更新失败 ${mod.fileName}: ${String(error)}`)
      }
      out.push(mod)
    }
    return out
  }

  /* ------------------------------ local install ------------------------------ */

  async function installLocal(instanceId: string, kind: ProjectKind, source: string): Promise<InstalledMod> {
    const instance = instances.require(instanceId)
    const gameDir = instances.gameDir(instance)
    const fileName = path.basename(source)
    const target = path.join(kindDir(kind, gameDir), fileName)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(source, target)
    const parsed = await readModMetadata(target)
    return { fileName, size: await sizeOf(target), disabled: false, updatedAt: Date.now(), ...parsed }
  }

  return { search, versions, install, installed, toggle, remove, checkUpdates, installLocal }
}

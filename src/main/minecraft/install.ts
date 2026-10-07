/**
 * Turns a ResolvedVersion into a concrete DownloadPlan (version json, client jar,
 * libraries, natives, asset index + every asset object, log4j xml), runs it through
 * the shared Downloader and performs the post-download steps (native extraction,
 * virtual asset copies, instance creation).
 */
import fs from 'node:fs'
import path from 'node:path'
import { AppError, cancelled } from '@shared/errors'
import type { VersionInstallRequest } from '@shared/ipc'
import type {
  DownloadItem,
  DownloadJob,
  DownloadPlan,
  Instance,
  PathInfo,
  ResolvedVersion
} from '@shared/types'
import { isSafeName, sleep } from '@shared/utils'
import { isPathInside } from '../core/paths'
import { isFile, readJsonSafe } from '../core/fsx'
import {
  assetIndexPath,
  libraryPath,
  versionJsonPath,
  versionDir
} from '../core/paths'
import type { Downloader, HttpClient, VersionInstallOutcome } from '../core/contracts'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'
import {
  assetIndexItem,
  assetObjectItems,
  assetObjects,
  mapsToResources,
  writeVirtualCopies,
  type AssetIndexDoc
} from './assets'
import { loggingClientPath, nativeJarFiles, osRuleContext, plannedLibraryFiles } from './arguments'
import type { ManifestService } from './manifest'
import { ensureNatives } from './natives'
import type { VersionResolver } from './resolve'
import { checkPlan, type PlanCheck } from './verify'

export interface InstallerDeps {
  http: HttpClient
  downloader: Downloader
  instances: InstanceStore
  paths: () => PathInfo
  manifest: ManifestService
  resolver: VersionResolver
  log: Logger
}

export interface VersionInstaller {
  installPlan(req: VersionInstallRequest): Promise<DownloadPlan>
  install(req: VersionInstallRequest): Promise<VersionInstallOutcome>
  repair(id: string): Promise<DownloadJob>
  checkInstalled(id: string): Promise<PlanCheck>
  uninstall(id: string): Promise<void>
  postInstall(id: string): Promise<void>
}

/** Polls the job registry until the downloader settles it. */
export async function waitForJob(downloader: Downloader, jobId: string): Promise<DownloadJob> {
  const deadline = Date.now() + 30 * 60 * 1000
  for (;;) {
    const job = downloader.job(jobId)
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
      if (job.status === 'error') {
        throw new AppError(job.error?.code ?? 'internal', job.error?.message ?? '下载失败', job.error?.detail)
      }
      if (job.status === 'cancelled') throw cancelled()
      return job
    }
    if (Date.now() > deadline) throw new AppError('internal', `下载任务 ${jobId} 超时`)
    await sleep(50)
  }
}

async function loadIndexDoc(paths: PathInfo, index: ResolvedVersion['assetIndex'], deps: InstallerDeps): Promise<AssetIndexDoc | undefined> {
  if (!index) return undefined
  const local = await readJsonSafe<AssetIndexDoc | null>(assetIndexPath(paths, index.id), null)
  if (local) return local
  try {
    return await deps.http.json<AssetIndexDoc>(index.url)
  } catch {
    return undefined
  }
}

export function createInstaller(deps: InstallerDeps): VersionInstaller {
  async function versionJsonItem(id: string, paths: PathInfo, items: DownloadItem[]): Promise<void> {
    if (await isFile(versionJsonPath(paths, id))) return
    // Only ids present in the manifest (vanilla / parent of a loader json) can be downloaded.
    const ref = await deps.manifest.refFor(id).catch(() => undefined)
    if (!ref) return
    const target = versionJsonPath(paths, id)
    items.push({ id: target, url: ref.url, target, kind: 'version-json', label: `${id}.json` })
  }

  async function build(req: VersionInstallRequest): Promise<{ plan: DownloadPlan; resolved: ResolvedVersion }> {
    const paths = deps.paths()
    const resolved = await deps.resolver.resolve(req.id)
    const ctx = osRuleContext({})

    const items: DownloadItem[] = []
    const push = (item: DownloadItem): void => {
      if (!items.some((existing) => existing.id === item.id)) items.push(item)
    }

    // 1. Version jsons: the requested id and, for loader profiles, the vanilla parent.
    await versionJsonItem(resolved.id, paths, items)
    if (resolved.raw.inheritsFrom) await versionJsonItem(resolved.raw.inheritsFrom, paths, items)

    // 2. The client jar (sha1 + size verified by the downloader).
    if (resolved.client) {
      push({
        id: resolved.clientJarPath,
        url: resolved.client.url,
        target: resolved.clientJarPath,
        sha1: resolved.client.sha1,
        size: resolved.client.size,
        kind: 'client-jar',
        label: path.basename(resolved.clientJarPath)
      })
    }

    // 3. Libraries + native jars for this OS.
    for (const lib of resolved.libraries) {
      for (const file of plannedLibraryFiles(lib, ctx, paths.librariesDir)) {
        const target = libraryPath(paths, file.relativePath)
        const item: DownloadItem = {
          id: target,
          url: file.url,
          target,
          kind: file.isNative ? 'natives' : 'library',
          label: path.basename(file.relativePath)
        }
        if (file.sha1) item.sha1 = file.sha1
        if (file.size !== undefined) item.size = file.size
        push(item)
      }
    }

    // 4. Asset index json + every object it references.
    if (resolved.assetIndex) {
      push(assetIndexItem(resolved.assetIndex, paths))
      const indexDoc = await loadIndexDoc(paths, resolved.assetIndex, deps)
      if (indexDoc) {
        for (const item of assetObjectItems(assetObjects(indexDoc), paths)) push(item)
      }
    }

    // 5. The log4j client configuration xml.
    const logFile = resolved.logging?.client?.file
    if (logFile) {
      const target = loggingClientPath(paths, logFile.id ?? 'client')
      push({
        id: target,
        url: logFile.url,
        target,
        sha1: logFile.sha1,
        size: logFile.size,
        kind: 'misc',
        label: path.basename(target)
      })
    }

    const plan: DownloadPlan = {
      title: `安装 ${req.id}`,
      kind: 'misc',
      items,
      after: 'extract-natives',
      afterPayload: { versionId: req.id }
    }
    return { plan, resolved }
  }

  async function postInstall(id: string): Promise<void> {
    const paths = deps.paths()
    const resolved = await deps.resolver.resolve(id)
    const ctx = osRuleContext({})
    await ensureNatives(paths, id, nativeJarFiles(resolved, paths, ctx)).catch((e: unknown) =>
      deps.log.warn(`解压本地化库失败: ${String(e)}`)
    )
    if (resolved.assetIndex) {
      const indexDoc = await loadIndexDoc(paths, resolved.assetIndex, deps)
      if (indexDoc && mapsToResources(indexDoc)) {
        const copies = await writeVirtualCopies(paths, resolved.assetIndex.id, assetObjects(indexDoc))
        if (copies > 0) deps.log.info(`写入 ${copies} 个 virtual 资源副本`)
      }
    }
  }

  return {
    async installPlan(req) {
      const { plan } = await build(req)
      return plan
    },

    async install(req): Promise<VersionInstallOutcome> {
      const { plan, resolved } = await build(req)
      const job = await deps.downloader.enqueue(plan)
      const settled = await waitForJob(deps.downloader, job.id)
      await postInstall(req.id)

      let instance: Instance | undefined
      if (req.createInstance) {
        const gameVersion = resolved.raw.inheritsFrom ?? req.id
        instance = deps.instances.create({
          name: req.instanceName ?? req.id,
          versionId: req.id,
          gameVersion,
          loader: 'vanilla'
        })
      }
      return { job: settled, versionId: req.id, ...(instance ? { instance } : {}) }
    },

    async repair(id) {
      const { plan } = await build({ id })
      const check = await checkPlan(plan)
      if (check.missing.length === 0) {
        // Nothing to fetch: still return a settled job so callers can show progress consistently.
        const job = await deps.downloader.enqueue({ ...plan, title: `修复 ${id}`, items: [] })
        return waitForJob(deps.downloader, job.id).catch(() => job)
      }
      const repairPlan: DownloadPlan = {
        title: `修复 ${id}`,
        kind: 'misc',
        items: check.missing,
        after: 'extract-natives',
        afterPayload: { versionId: id }
      }
      const job = await deps.downloader.enqueue(repairPlan)
      const settled = await waitForJob(deps.downloader, job.id)
      await postInstall(id)
      return settled
    },

    async checkInstalled(id) {
      const { plan } = await build({ id })
      return checkPlan(plan)
    },

    async uninstall(id) {
      if (!isSafeName(id)) throw new AppError('invalid-input', '非法的版本号', id)
      const paths = deps.paths()
      const dir = versionDir(paths, id)
      if (!isPathInside(paths.versionsDir, dir)) throw new AppError('invalid-input', '拒绝删除版本目录之外的路径', dir)
      await fs.promises.rm(dir, { recursive: true, force: true })
      deps.resolver.invalidate(id)
    },

    postInstall
  }
}

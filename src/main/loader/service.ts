/**
 * LoaderService: discovers loader builds for a game version and installs them into an
 * instance by writing a version json + fetching its libraries, then repointing
 * `instance.versionId/loader/loaderVersion`.
 *
 * All endpoints come from `ENDPOINTS` (verified 2026-10-07). Every provider transform is
 * built against a committed fixture under `tests/fixtures/loader/`, not invented fields.
 */
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { LoaderOption } from '@shared/ipc'
import type {
  DownloadJob,
  DownloadKind,
  DownloadPlan,
  Instance,
  LoaderId,
  PathInfo,
  RawVersionJson,
  Settings
} from '@shared/types'
import type { Downloader, HttpClient, LoaderService, VersionService } from '../core/contracts'
import { writeJsonAtomic } from '../core/fsx'
import { openInstallerZip } from './installerZip'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'
import { sortVersionIds } from '@shared/utils'
import { loaderOptionVersions, profileToPlan } from './fabric'
import { buildProcessorCommands, isProcessable, planFromProfile } from './forge'
import { parseMavenVersions } from './xml'
import type { FabricLoaderEntry, ForgeInstallProfile, LoaderProfileJson } from './types'

/** Minimal read surface the loader needs from the settings store. */
export interface SettingsReader {
  get(): Settings
}

export interface LoaderServiceDeps {
  http: HttpClient
  downloader: Downloader
  versions: VersionService
  instances: InstanceStore
  settings: SettingsReader
  paths: PathInfo
  log: Logger
}

interface Promotions {
  promos: Record<string, string>
}

/** Which meta host serves the loader list + profile for each loader family. */
const FABRIC_LIKE: Partial<Record<LoaderId, { list: string; maven: string; label: string }>> = {
  fabric: { list: ENDPOINTS.fabricLoaderList, maven: ENDPOINTS.fabricMaven, label: 'Fabric' },
  quilt: { list: ENDPOINTS.quiltLoaderList, maven: ENDPOINTS.quiltMaven, label: 'Quilt' }
}

export function createLoaderService(deps: LoaderServiceDeps): LoaderService {
  const { http, downloader, instances, settings, paths, log } = deps

  async function fetchJson<T>(url: string): Promise<T> {
    return http.json<T>(url, { headers: { 'user-agent': 'MoucLauncher' } })
  }

  /* ------------------------------ options ------------------------------ */

  async function fabricLikeOption(
    id: LoaderId,
    cfg: { list: string; label: string },
    game: string
  ): Promise<LoaderOption | undefined> {
    try {
      const entries = await fetchJson<FabricLoaderEntry[]>(`${cfg.list}/${game}`)
      return { id, label: cfg.label, versions: loaderOptionVersions(entries ?? []) }
    } catch (error) {
      // legacy-fabric / quilt may be unreachable for a version: drop it from the list.
      log.warn(`${id} 列表获取失败 (${game}): ${String(error)}`)
      return undefined
    }
  }

  async function forgeOption(
    id: Extract<LoaderId, 'forge' | 'neoforge'>,
    game: string
  ): Promise<LoaderOption | undefined> {
    const metadataUrl = id === 'forge' ? ENDPOINTS.forgeMavenMetadata : ENDPOINTS.neoforgeMavenMetadata
    const label = id === 'forge' ? 'Forge' : 'NeoForge'
    try {
      const xml = await http.text(metadataUrl, { headers: { 'user-agent': 'MoucLauncher' } })
      const all = parseMavenVersions(xml).filter((v) => v.startsWith(`${game}-`))
      const versions = sortVersionIds(all).map((version) => ({ version, stable: false, recommended: false }))
      // Forge publishes the "recommended/latest" pointers per game line in promotions_slim.json.
      if (id === 'forge') {
        try {
          const promo = await fetchJson<Promotions>(ENDPOINTS.forgePromotions)
          const rec = promo.promos?.[`${game}-recommended`]
          const latest = promo.promos?.[`${game}-latest`]
          for (const v of versions) {
            const build = v.version.slice(game.length + 1)
            if (rec && build === rec) {
              v.recommended = true
              v.stable = true
            } else if (latest && build === latest) v.stable = true
          }
        } catch (error) {
          log.warn(`Forge promotions 获取失败: ${String(error)}`)
        }
      } else {
        // NeoForge (net.neoforged:forge) marks the highest build as stable.
        if (versions[0]) versions[0].stable = true
      }
      return { id, label, versions }
    } catch (error) {
      log.warn(`${label} 版本列表获取失败: ${String(error)}`)
      return undefined
    }
  }

  async function options(gameVersion: string): Promise<LoaderOption[]> {
    const game = gameVersion
    const jobs: Array<Promise<LoaderOption | undefined>> = [
      fabricLikeOption('fabric', FABRIC_LIKE.fabric!, game),
      fabricLikeOption('quilt', FABRIC_LIKE.quilt!, game),
      fabricLikeOption('legacy-fabric', { list: ENDPOINTS.legacyFabricMeta, label: 'Legacy Fabric' }, game),
      forgeOption('forge', game),
      forgeOption('neoforge', game)
    ]
    const settled = await Promise.all(jobs)
    const out = settled.filter((o): o is LoaderOption => Boolean(o))
    // OptiFine has no machine-readable metadata endpoint (optifine.net/mirrors is 404 and
    // /downloads is HTML), so it is offered only as a manual/local install.
    out.push({ id: 'optifine', label: 'OptiFine（手动）', versions: [] })
    return out
  }

  /* ------------------------------ helpers ------------------------------ */

  function repoint(instance: Instance, versionId: string, loader: LoaderId, loaderVersion: string): Instance {
    return instances.update(instance.id, {
      versionId,
      loader,
      loaderVersion,
      gameVersion: instance.gameVersion
    })
  }

  function vanillaJarPath(game: string): string {
    return path.join(paths.versionsDir, game, `${game}.jar`)
  }

  function downloadItem(url: string, target: string, kind: DownloadKind, label?: string) {
    return { id: target, url, target, kind, label: label ?? path.basename(target) }
  }

  /* ------------------------------ fabric / quilt / legacy ------------------------------ */

  async function installFabricLike(instance: Instance, loader: LoaderId, version: string): Promise<DownloadJob> {
    const cfg =
      loader === 'legacy-fabric'
        ? { list: ENDPOINTS.legacyFabricMeta, label: 'Legacy Fabric', kind: 'fabric' as DownloadKind }
        : FABRIC_LIKE[loader]!
    const game = instance.gameVersion
    const profileUrl = `${cfg.list}/${game}/${version}/profile/json`
    const profile = await fetchJson<LoaderProfileJson>(profileUrl)
    if (!profile?.id) throw new AppError('not-found', `${loader} profile 无效`, profileUrl)

    const plan = profileToPlan(profile, paths, loader)
    await writeJsonAtomic(path.join(paths.versionsDir, plan.versionId, `${plan.versionId}.json`), plan.versionJson)

    const downloadPlan: DownloadPlan = {
      title: `${cfg.label} ${version} 库文件`,
      kind: loader === 'quilt' ? 'quilt' : 'fabric',
      items: plan.items,
      after: 'none'
    }
    const job = await downloader.run(downloadPlan)
    repoint(instance, plan.versionId, loader, version)
    log.info(`已安装 ${loader} ${version} -> ${plan.versionId}`)
    return job
  }

  /* ------------------------------ forge / neoforge ------------------------------ */

  function forgeInstallerUrl(loader: LoaderId, version: string): string {
    const repo = loader === 'neoforge' ? ENDPOINTS.neoforgeMaven : ENDPOINTS.forgeMaven
    const group = loader === 'neoforge' ? 'net/neoforged/forge' : 'net/minecraftforge/forge'
    return `${repo}/${group}/${version}/forge-${version}-installer.jar`
  }

  async function installForgeLike(instance: Instance, loader: Extract<LoaderId, 'forge' | 'neoforge'>, version: string): Promise<DownloadJob> {
    const game = instance.gameVersion
    const installerUrl = forgeInstallerUrl(loader, version)
    const installerTarget = loader === 'neoforge'
      ? path.join(paths.librariesDir, 'net', 'neoforged', 'forge', version, `forge-${version}-installer.jar`)
      : path.join(paths.librariesDir, 'net', 'minecraftforge', 'forge', version, `forge-${version}-installer.jar`)

    // Fetch the installer archive (10-30MB); the download executor resolves sha lazily.
    await downloader.ensure(downloadItem(installerUrl, installerTarget, loader === 'neoforge' ? 'neoforge' : 'forge'))

    const zip = await openInstallerZip(installerTarget)
    let profile: ForgeInstallProfile
    let versionJson: RawVersionJson
    try {
      profile = JSON.parse((await zip.read('install_profile.json')).toString('utf8')) as ForgeInstallProfile
      if (profile.versionInfo) {
        versionJson = profile.versionInfo
      } else if (profile.json) {
        const member = profile.json.replace(/^\//, '')
        versionJson = JSON.parse((await zip.read(member)).toString('utf8')) as RawVersionJson
      } else {
        throw new AppError('unsupported', '请使用 Fabric/Quilt 或手动安装', 'install_profile.json 无 versionInfo/json')
      }
    } finally {
      await zip.close()
    }

    if (!isProcessable(profile)) {
      // Legacy Forge (<=1.12) has no `processors`: it can only be installed by running the
      // installer's own java bootstrap, which we do not do automatically.
      throw new AppError('unsupported', '请使用 Fabric/Quilt 或手动安装')
    }

    const plan = planFromProfile(profile, versionJson, { libraryDir: paths.librariesDir })
    await writeJsonAtomic(path.join(paths.versionsDir, plan.versionId, `${plan.versionId}.json`), plan.versionJson)

    // Pre-compute the processor argv for the launch-time executor (`after: run-installer`).
    const commands = buildProcessorCommands(profile, versionJson, {
      libraryDir: paths.librariesDir,
      root: instances.gameDir(instance),
      minecraftJar: vanillaJarPath(game),
      installer: installerTarget,
      java: settings.get().customJavaPath || 'java',
      minecraftVersion: game,
      side: 'client'
    })

    const installerItem = downloadItem(installerUrl, installerTarget, loader === 'neoforge' ? 'neoforge' : 'forge')
    const downloadPlan: DownloadPlan = {
      title: `${loader === 'neoforge' ? 'NeoForge' : 'Forge'} ${version} 库文件`,
      kind: loader === 'neoforge' ? 'neoforge' : 'forge',
      items: [installerItem, ...plan.items],
      after: 'run-installer',
      afterPayload: { versionId: plan.versionId, commands }
    }
    const job = await downloader.run(downloadPlan)
    repoint(instance, plan.versionId, loader, version)
    log.info(`已安装 ${loader} ${version} -> ${plan.versionId}（处理器待执行 ${commands.length} 个）`)
    return job
  }

  /* ------------------------------ install / remove ------------------------------ */

  async function install(instanceId: string, loader: Instance['loader'], version: string): Promise<DownloadJob> {
    const instance = instances.require(instanceId)
    if (!version) throw new AppError('invalid-input', '缺少加载器版本')
    switch (loader) {
      case 'fabric':
      case 'quilt':
      case 'legacy-fabric':
        return installFabricLike(instance, loader, version)
      case 'forge':
      case 'neoforge':
        return installForgeLike(instance, loader, version)
      case 'optifine':
        // No verified machine-readable metadata endpoint -> manual/local install only.
        throw new AppError('unsupported', 'OptiFine 请手动放入 mods 目录或使用本地安装')
      default:
        throw new AppError('unsupported', '请使用 Fabric/Quilt 或手动安装')
    }
  }

  async function remove(instanceId: string): Promise<Instance> {
    const instance = instances.require(instanceId)
    return instances.update(instance.id, {
      loader: 'vanilla',
      versionId: instance.gameVersion,
      loaderVersion: undefined
    })
  }

  async function installedLoader(instance: Instance): Promise<{ ok: boolean; detail?: string }> {
    if (instance.loader === 'vanilla') return { ok: true, detail: '原版' }
    const file = path.join(paths.versionsDir, instance.versionId, `${instance.versionId}.json`)
    try {
      const json = JSON.parse(await readFile(file, 'utf8')) as RawVersionJson
      const marker = `${instance.loader}-${instance.loaderVersion ?? ''}`.toLowerCase()
      const ok = json.id.toLowerCase().includes(instance.loader.toLowerCase())
      return { ok, detail: ok ? `${marker} -> ${json.id}` : `版本 json 与 ${instance.loader} 不匹配: ${json.id}` }
    } catch {
      return { ok: false, detail: `缺少版本 json: ${file}` }
    }
  }

  return { options, install, remove, installedLoader }
}

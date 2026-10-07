/**
 * VersionService composition: manifest + resolver + installer + verify behind the
 * frozen `VersionService` contract.
 */
import path from 'node:path'
import type { VersionInstallRequest } from '@shared/ipc'
import type { PathInfo, VersionType } from '@shared/types'
import { isSafeName, sortVersionIds } from '@shared/utils'
import { readdirSafe, isFile } from '../core/fsx'
import type {
  AccountService,
  Downloader,
  HttpClient,
  JavaService,
  VersionInstallOutcome,
  VersionService
} from '../core/contracts'
import type { SettingsStore } from '../core/config'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'
import { createManifest } from './manifest'
import { createInstaller } from './install'
import { createResolver } from './resolve'

export interface MinecraftServiceDeps {
  http: HttpClient
  downloader: Downloader
  settings: SettingsStore
  instances: InstanceStore
  paths: () => PathInfo
  java: JavaService
  accounts: AccountService
  log: Logger
}

export function createVersionService(deps: MinecraftServiceDeps): VersionService {
  const manifest = createManifest(deps)
  const resolver = createResolver({ http: deps.http, paths: deps.paths, manifest, log: deps.log })
  const installer = createInstaller({
    http: deps.http,
    downloader: deps.downloader,
    instances: deps.instances,
    paths: deps.paths,
    manifest,
    resolver,
    log: deps.log
  })

  return {
    refresh: (force?: boolean) => manifest.refresh(force),
    list: (types?: VersionType[]) => manifest.list(types),

    async installed(): Promise<string[]> {
      const paths = deps.paths()
      const entries = await readdirSafe(paths.versionsDir)
      const found: string[] = []
      for (const entry of entries) {
        if (!isSafeName(entry)) continue
        if (await isFile(path.join(paths.versionsDir, entry, `${entry}.json`))) found.push(entry)
      }
      return sortVersionIds(found)
    },

    resolve: (id: string) => resolver.resolve(id),
    installPlan: (req: VersionInstallRequest) => installer.installPlan(req),
    install: (req: VersionInstallRequest): Promise<VersionInstallOutcome> => installer.install(req),
    uninstall: (id: string) => installer.uninstall(id),
    repair: (id: string) => installer.repair(id),
    checkInstalled: (id: string) => installer.checkInstalled(id)
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { ENDPOINTS } from '@shared/constants'
import { compareVersionIds } from '@shared/utils'
import type { GameDirStats, LauncherStatus, PathInfo, UpdateInfo } from '@shared/types'
import { createHttpClient, createDownloader } from './download'
import { createVersionService, createGameService } from './minecraft'
import { createJavaService } from './java/service'
import { createAccountService } from './account/service'
import { createLoaderService } from './loader/service'
import { createModService } from './mods/service'
import { createOnlineServices } from './online/service'
import { createCrashService } from './crash'
import { createModpackService } from './modpack'
import { SettingsStore } from './core/config'
import { InstanceStore } from './core/instanceStore'
import { Logger } from './core/log'
import { buildPaths, defaultGameRoot, instanceGameDir } from './core/paths'
import { dirSize, readdirSafe } from './core/fsx'
import { emitLog, emitMicrosoft, emitProgress, emitRelay } from './core/bus'
import type { Container } from './core/contracts'

const WINDOW_STATE_FILE = 'window.json'

/**
 * Builds the service graph. Every service gets plain dependency objects of
 * interfaces, never the container itself, so wiring stays readable and cycles would
 * show up here as a compile error rather than at runtime.
 */
export function createContainer(): Container {
  const appData = app.getPath('userData')
  const documents = safeDocumentsPath()
  const log = new Logger('app', path.join(appData, 'logs'))
  const settings = new SettingsStore(appData, documents)
  const paths = (): PathInfo => buildPaths(appData, settings.get().gameRoot || defaultGameRoot(appData, documents))
  const instances = new InstanceStore(paths)
  /** mods/ and loader code keep a PathInfo value; this view keeps it current. */
  const livePaths = pathView(paths)

  const http = createHttpClient({ settings: () => settings.get(), log, version: app.getVersion() })
  const downloader = createDownloader({
    http,
    settings: () => settings.get(),
    paths,
    log,
    onProgress: (progress) => emitProgress(progress)
  })

  const java = createJavaService({ http, downloader, settings, paths, log })
  const accounts = createAccountService({
    http,
    downloader,
    settings,
    paths,
    log,
    cipher: electronCipher(log),
    onMicrosoft: (progress) => emitMicrosoft(progress)
  })
  const versions = createVersionService({ http, downloader, settings, instances, paths, java, accounts, log })
  const game = createGameService({
    http,
    downloader,
    settings,
    instances,
    paths,
    java,
    accounts,
    log,
    launcherVersion: app.getVersion(),
    onLog: (line) => emitLog(line)
  })
  const mods = createModService({ http, downloader, instances, settings, paths: livePaths, log })
  const loaders = createLoaderService({
    http,
    downloader,
    versions,
    instances,
    settings,
    paths: livePaths,
    log
  })
  const online = createOnlineServices({
    log,
    settings,
    gameDirOf: (instanceId) => instanceGameDir(instances.require(instanceId), paths()),
    onRelayStatus: (status) => emitRelay(status)
  })
  const servers = online.servers
  const relay = online.relay
  const crash = createCrashService({ instances, paths, mods, log })
  const modpack = createModpackService({
    downloader,
    versions,
    instances,
    mods,
    paths,
    log,
    settings: () => settings.get()
  })

  let lastOnlineCheck: { at: number; value: boolean } | undefined

  const container: Container = {
    appData,
    appInfo: {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node ?? '',
      platform: process.platform,
      arch: process.arch
    },
    log,
    settings,
    paths,
    instances,
    http,
    downloader,
    versions,
    java,
    accounts,
    game,
    loaders,
    mods,
    servers,
    relay,
    crash,
    modpack,
    status,
    networkOnline,
    stats,
    checkUpdate,
    windowStatePath: () => path.join(appData, 'config', WINDOW_STATE_FILE),
    dispose: async () => {
      for (const job of downloader.jobs()) {
        if (job.status === 'running' || job.status === 'queued') await downloader.cancel(job.id)
      }
      await online.dispose()
      await settings.flush()
      await instances.flush()
      log.close()
    }
  }

  /** Cached reachability probe; the status bar asks often, the network must not. */
  async function networkOnline(): Promise<boolean> {
    if (lastOnlineCheck && Date.now() - lastOnlineCheck.at < 30_000) return lastOnlineCheck.value
    let value = false
    try {
      const response = await http.head(ENDPOINTS.versionManifest, { timeoutMs: 4000 })
      value = response.status < 500
    } catch (error) {
      log.debug(`在线检查失败: ${String(error)}`)
      value = false
    }
    lastOnlineCheck = { at: Date.now(), value }
    return value
  }

  async function status(): Promise<LauncherStatus> {
    const running = game.running()
    const active = downloader.jobs().find((job) => job.status === 'running' || job.status === 'queued')
    const javaList = await java.list().catch(() => [])
    const accountList = await accounts.list().catch(() => [])
    return {
      version: container.appInfo.version,
      electron: container.appInfo.electron,
      node: container.appInfo.node,
      platform: container.appInfo.platform,
      arch: container.appInfo.arch,
      gameRoot: paths().gameRoot,
      online: await networkOnline(),
      java: javaList.length,
      instances: instances.list().length,
      accounts: accountList.length,
      ...(active ? { activeJob: active } : {}),
      ...(running[0] ? { runningGame: running[0] } : {})
    }
  }

  async function stats(): Promise<GameDirStats> {
    const root = paths()
    const exists = fs.existsSync(root.gameRoot)
    const { bytes, files } = exists ? await dirSize(root.gameRoot) : { bytes: 0, files: 0 }
    let mods = 0
    for (const instance of instances.list()) {
      mods += countJars(path.join(instanceGameDir(instance, root), 'mods'))
    }
    return {
      exists,
      sizeBytes: bytes,
      fileCount: files,
      versions: exists ? (await readdirSafe(root.versionsDir)).length : 0,
      instances: instances.list().length,
      mods,
      screenshots: countFiles(path.join(root.gameRoot, 'screenshots'))
    }
  }

  /** Latest GitHub release; every failure degrades to "no update" rather than an error toast. */
  async function checkUpdate(): Promise<UpdateInfo> {
    const current = app.getVersion()
    const base: UpdateInfo = { available: false, current, latest: current, assets: [] }
    try {
      const json = await http.json<{
        tag_name: string
        body?: string
        html_url?: string
        assets?: { name: string }[]
      }>(`${ENDPOINTS.githubApi}/repos/${ENDPOINTS.updateRepo}/releases/latest`, { timeoutMs: 8000 })
      const latest = json.tag_name.replace(/^v/, '')
      return {
        available: compareVersionIds(latest, current) > 0,
        current,
        latest,
        url: json.html_url,
        notes: json.body?.slice(0, 2000),
        assets: (json.assets ?? []).map((asset) => asset.name)
      }
    } catch (error) {
      log.warn(`检查更新失败: ${String(error)}`)
      return base
    }
  }

  return container
}

/* ------------------------------- helpers ------------------------------- */

function safeDocumentsPath(): string | undefined {
  try {
    return app.getPath('documents')
  } catch {
    return undefined
  }
}

/** A PathInfo whose fields are read on access, so a Settings gameRoot change applies at once. */
function pathView(paths: () => PathInfo): PathInfo {
  return new Proxy({} as PathInfo, {
    get: (_target, property) => (paths() as unknown as Record<string | symbol, unknown>)[property],
    has: (_target, property) => property in paths(),
    ownKeys: () => Reflect.ownKeys(paths()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(paths(), property)
  })
}

function countFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).length
  } catch {
    return 0
  }
}

function countJars(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.jar')).length
  } catch {
    return 0
  }
}

export interface SecretCipher {
  available: boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

/** Tokens go through the OS credential store (DPAPI via Chromium); never plaintext on disk. */
function electronCipher(log: Logger): SecretCipher {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch (error) {
    log.warn(`安全存储不可用: ${String(error)}`)
  }
  if (!available) log.warn('系统安全存储不可用，账户令牌将以明文保存')
  return {
    available,
    encrypt: (value: string) => (available ? safeStorage.encryptString(value).toString('base64') : value),
    decrypt: (value: string) => (available ? safeStorage.decryptString(Buffer.from(value, 'base64')) : value)
  }
}

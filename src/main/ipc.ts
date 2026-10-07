import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { EVENTS, IPC, type InstanceCreateRequest, type ModInstallRequest, type RelayHostRequest, type VersionInstallRequest, type WindowState } from '@shared/ipc'
import { AppError, intoResult } from '@shared/errors'
import type {
  Instance,
  InstanceLaunchTarget,
  InstanceSummary,
  LaunchRequest,
  LoaderId,
  ModpackImportRequest,
  ProjectKind,
  ProjectProvider,
  SearchQuery,
  ServerEntry,
  Settings,
  VersionType
} from '@shared/types'
import { parseServerAddress } from '@shared/utils'
import { isPathInside } from './core/paths'
import { dirSize, isFile } from './core/fsx'
import { instanceGameDir, versionJsonPath } from './core/paths'
import { emit, emitExit } from './core/bus'
import type { Container } from './core/contracts'

/** `https:`/`http:` only — the renderer must never hand us `file:` or a custom scheme. */
function assertHttpUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AppError('invalid-input', '地址不合法', String(url))
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError('invalid-input', '只允许打开 http/https 链接', parsed.protocol)
  }
  return parsed
}

/** Opening a path reaches the shell, so clamp it to directories we own. */
function assertOwnedPath(container: Container, target: string): string {
  const paths = container.paths()
  const allowed = [paths.gameRoot, paths.appData]
  if (!isPathInside(allowed[0], target) && !isPathInside(allowed[1], target)) {
    throw new AppError('invalid-input', '只能访问启动器目录内的文件', target)
  }
  return target
}

function ownerWindow(getWindow: () => BrowserWindow | null): BrowserWindow | undefined {
  const win = getWindow()
  return win && !win.isDestroyed() ? win : undefined
}

function windowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), alwaysOnTop: win.isAlwaysOnTop() }
}

/** Fields the renderer must not write (version stamps are ours). */
function sanitizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const next: Partial<Settings> = { ...patch }
  delete next.settingsVersion
  delete next.lastSeenVersion
  if (typeof next.gameRoot !== 'string' || next.gameRoot.trim().length === 0) delete next.gameRoot
  if (next.maxConcurrentDownloads !== undefined) {
    next.maxConcurrentDownloads = Math.min(32, Math.max(1, Math.round(next.maxConcurrentDownloads)))
  }
  if (next.defaultMemoryMb !== undefined) {
    next.defaultMemoryMb = Math.min(262_144, Math.max(512, Math.round(next.defaultMemoryMb)))
  }
  return next
}

export function registerIpc(container: Container, getWindow: () => BrowserWindow | null): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, (_event, ...args: unknown[]) =>
      intoResult(() => fn(...(args as never[])))
    )
  }

  /* ------------------------------- app ------------------------------- */
  handle(IPC.app.status, () => container.status())
  handle(IPC.app.paths, () => container.paths())
  handle(IPC.app.version, () => container.appInfo.version)
  handle(IPC.app.stats, () => container.stats())
  handle(IPC.app.openExternal, (url: string) => {
    assertHttpUrl(url)
    return shell.openExternal(url).then(() => true)
  })
  handle(IPC.app.openPath, (target: string) => {
    assertOwnedPath(container, target)
    return shell.openPath(target).then((result) => {
      if (result.length > 0) throw new AppError('disk', '无法打开该位置', result)
      return true
    })
  })
  handle(IPC.app.pickFolder, async (title?: string, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择文件夹',
      ...(defaultPath && isPathInside(container.paths().gameRoot, defaultPath) ? { defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  handle(IPC.app.pickFile, async (title?: string, filters?: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择文件',
      properties: ['openFile'],
      filters: filters && filters.length > 0 ? filters : [{ name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  handle(IPC.app.checkUpdate, () => container.checkUpdate())
  handle(IPC.app.relaunch, () => {
    void container.dispose().finally(() => {
      app.relaunch()
      app.exit(0)
    })
    return true
  })
  handle(IPC.app.quit, () => {
    void container.dispose().finally(() => app.quit())
    return true
  })

  /* ----------------------------- settings ---------------------------- */
  handle(IPC.settings.get, () => container.settings.get())
  handle(IPC.settings.set, (patch: Partial<Settings>) => {
    const next = container.settings.set(sanitizeSettingsPatch(patch))
    emit(EVENTS.settings, next)
    return next
  })
  handle(IPC.settings.reset, () => {
    const next = container.settings.reset()
    emit(EVENTS.settings, next)
    return next
  })

  /* ------------------------------ version ---------------------------- */
  handle(IPC.version.refresh, (force?: boolean) => container.versions.refresh(Boolean(force)))
  handle(IPC.version.list, (types: VersionType[] | undefined) => container.versions.list(types))
  handle(IPC.version.installed, () => container.versions.installed())
  handle(IPC.version.install, async (req: VersionInstallRequest) => (await container.versions.install(req)).job)
  handle(IPC.version.uninstall, (id: string) => container.versions.uninstall(id))
  handle(IPC.version.repair, (id: string) => container.versions.repair(id))
  handle(IPC.version.resolved, (id: string) => container.versions.resolve(id))

  /* ----------------------------- instance ---------------------------- */
  handle(IPC.instance.list, async () => {
    const out: InstanceSummary[] = []
    for (const instance of container.instances.list()) out.push(await summarize(container, instance))
    return out
  })
  handle(IPC.instance.create, (req: InstanceCreateRequest) => container.instances.create({
    name: req.name,
    versionId: req.versionId,
    gameVersion: req.versionId,
    isolated: req.isolated ?? true,
    description: req.description,
    memoryMb: req.memoryMb,
    loader: req.loader?.id,
    loaderVersion: req.loader?.version,
    ...(req.accountId ? { accountId: req.accountId } : {})
  }))
  handle(IPC.instance.update, (patch: Partial<Instance> & { id: string }) =>
    container.instances.update(patch.id, patch)
  )
  handle(IPC.instance.remove, (id: string, deleteFiles?: boolean) => {
    container.instances.remove(id, Boolean(deleteFiles))
    return true
  })
  handle(IPC.instance.duplicate, (id: string, name: string) => container.instances.duplicate(id, name))
  handle(IPC.instance.state, (id: string) => summarize(container, container.instances.require(id)))
  handle(IPC.instance.importModpack, (req: ModpackImportRequest) => container.modpack.import(req))
  handle(IPC.instance.exportModpack, (id: string, target: string, format: 'mrpack' | 'zip') => {
    assertOwnedPath(container, path.dirname(target))
    return container.modpack.export(id, target, format)
  })
  handle(IPC.instance.openDir, (id: string) => {
    const dir = instanceGameDir(container.instances.require(id), container.paths())
    return shell.openPath(dir).then((result) => {
      if (result.length > 0) throw new AppError('disk', '无法打开实例目录', result)
      return true
    })
  })

  /* ------------------------------- java ------------------------------ */
  handle(IPC.java.scan, () => container.java.scan())
  handle(IPC.java.list, () => container.java.list())
  handle(IPC.java.provision, (req) => container.java.provision(req))
  handle(IPC.java.remove, (id: string) => {
    container.java.remove(id)
    return true
  })
  handle(IPC.java.resolve, async (instanceId: string) => {
    const instance = container.instances.require(instanceId)
    const resolved = await container.versions.resolve(instance.versionId)
    return container.java.peek(instance, resolved)
  })

  /* ----------------------------- account ----------------------------- */
  handle(IPC.account.list, () => container.accounts.list())
  handle(IPC.account.addOffline, (req) => container.accounts.addOffline(req))
  handle(IPC.account.remove, (id: string) => {
    container.accounts.remove(id)
    return true
  })
  handle(IPC.account.select, (id: string) => container.accounts.select(id))
  handle(IPC.account.refresh, (id: string) => container.accounts.refresh(id))
  handle(IPC.account.microsoftStart, () => container.accounts.microsoftStart())
  handle(IPC.account.microsoftPoll, (sessionKey: string) => container.accounts.microsoftPoll(sessionKey))
  handle(IPC.account.microsoftCancel, (sessionKey: string) => {
    container.accounts.microsoftCancel(sessionKey)
    return true
  })
  handle(IPC.account.skin, (accountId: string) => container.accounts.skin(accountId))
  handle(IPC.account.servers, (baseUrl: string) => {
    assertHttpUrl(baseUrl)
    return container.accounts.servers(baseUrl)
  })

  /* ----------------------------- download ---------------------------- */
  handle(IPC.download.jobs, () => container.downloader.jobs())
  handle(IPC.download.cancel, (jobId: string) => container.downloader.cancel(jobId))
  handle(IPC.download.retry, (jobId: string) => container.downloader.retry(jobId))
  handle(IPC.download.clear, () => container.downloader.clear())

  /* ------------------------------- game ------------------------------ */
  handle(IPC.game.preview, (instanceId: string) => container.game.preview(instanceId))
  handle(IPC.game.launch, (req: LaunchRequest) => launchAndWatch(container, req))
  handle(IPC.game.kill, (instanceId: string) => container.game.kill(instanceId))
  handle(IPC.game.running, () => container.game.running())
  handle(IPC.game.logs, (instanceId: string, lines?: number) => container.game.logs(instanceId, lines))
  handle(IPC.game.analyze, (text: string) => container.crash.analyze(text))
  handle(IPC.game.scanCrashReports, (instanceId: string) => container.crash.reports(instanceId))

  /* -------------------------------- mod ------------------------------ */
  handle(IPC.mod.search, (query: SearchQuery) => container.mods.search(query))
  handle(IPC.mod.versions, (provider: ProjectProvider, projectId: string, gameVersion?: string, loader?: string) =>
    container.mods.versions(provider, projectId, gameVersion, loader)
  )
  handle(IPC.mod.install, (req: ModInstallRequest) =>
    container.mods.install(req.instanceId, req.kind, req.file, req.withDependencies)
  )
  handle(IPC.mod.installed, (instanceId: string) => container.mods.installed(instanceId))
  handle(IPC.mod.toggle, (instanceId: string, fileName: string, disabled: boolean) =>
    container.mods.toggle(instanceId, fileName, disabled)
  )
  handle(IPC.mod.remove, (instanceId: string, fileName: string) => {
    container.mods.remove(instanceId, fileName)
    return true
  })
  handle(IPC.mod.checkUpdates, (instanceId: string) => container.mods.checkUpdates(instanceId))
  handle(IPC.mod.localFile, (instanceId: string, kind: ProjectKind, source: string) =>
    container.mods.installLocal(instanceId, kind, source)
  )

  /* ------------------------------ server ----------------------------- */
  handle(IPC.server.list, (instanceId: string) => container.servers.list(instanceId))
  handle(IPC.server.save, (instanceId: string, entry: ServerEntry) => container.servers.save(instanceId, entry))
  handle(IPC.server.remove, (instanceId: string, id: string) => {
    container.servers.remove(instanceId, id)
    return true
  })
  handle(IPC.server.ping, (address: string, port?: number) => container.servers.ping(address, port))
  handle(IPC.server.lanScan, async () => {
    await container.servers.startLanScan((game) => emit(EVENTS.lan, game))
    return true
  })
  handle(IPC.server.lanStop, () => container.servers.stopLanScan())
  handle(IPC.server.join, (instanceId: string, entry: ServerEntry) => {
    const parsed = parseServerAddress(entry.address)
    const target: InstanceLaunchTarget = { address: parsed?.host ?? entry.address, port: entry.port ?? parsed?.port ?? 25565 }
    return launchAndWatch(container, { instanceId, server: target })
  })
  handle(IPC.server.relayStatus, () => container.relay.status())
  handle(IPC.server.relayHost, (req: RelayHostRequest) => container.relay.host(req.targetPort, req.room, req.password))
  handle(IPC.server.relayJoin, (room: string, password?: string) => container.relay.join(room, password))
  handle(IPC.server.relayStop, () => container.relay.stop())

  /* ------------------------------ loader ----------------------------- */
  handle(IPC.loader.options, (gameVersion: string) => container.loaders.options(gameVersion))
  handle(IPC.loader.install, (instanceId: string, loader: LoaderId, version: string) =>
    container.loaders.install(instanceId, loader, version)
  )
  handle(IPC.loader.remove, (instanceId: string) => container.loaders.remove(instanceId))

  /* ----------------------------- window ------------------------------ */
  ipcMain.on(IPC.win.minimize, () => ownerWindow(getWindow)?.minimize())
  ipcMain.on(IPC.win.close, () => ownerWindow(getWindow)?.close())
  handle(IPC.win.toggleMaximize, () => {
    const win = ownerWindow(getWindow)
    if (!win) throw new AppError('busy', '窗口不可用')
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return windowState(win)
  })
  handle(IPC.win.state, () => {
    const win = ownerWindow(getWindow)
    return win
      ? windowState(win)
      : { maximized: false, fullscreen: false, alwaysOnTop: false }
  })
  handle(IPC.win.setAlwaysOnTop, (value: boolean) => {
    const win = ownerWindow(getWindow)
    if (!win) throw new AppError('busy', '窗口不可用')
    win.setAlwaysOnTop(Boolean(value))
    return windowState(win)
  })
}

/**
 * Launches the game and pushes exit info, adding a crash analysis from the log
 * tail when the process ended badly (the game writes its own report too).
 */
async function launchAndWatch(container: Container, req: LaunchRequest) {
  const info = await container.game.launch(req)
  void container.game
    .exited(req.instanceId)
    .then(async (exit) => {
      let analysis = exit.analysis
      if (exit.code !== 0 && !analysis) {
        const lines = await container.game.logs(req.instanceId, 400)
        if (lines.length > 0) analysis = container.crash.analyze(lines.map((line) => line.text).join('\n'))
      }
      emitExit({ ...exit, ...(analysis ? { analysis } : {}) })
    })
    .catch((error: unknown) => container.log.error('游戏退出处理失败', error))
  return info
}

/** Installed-state badge for the list; cheap checks only (no hash sweep). */
async function summarize(container: Container, instance: Instance): Promise<InstanceSummary> {
  const paths = container.paths()
  const gameDir = instanceGameDir(instance, paths)
  let modCount = 0
  let modsOk = false
  try {
    modCount = (await container.mods.installed(instance.id)).length
    modsOk = true
  } catch (error) {
    container.log.warn(`读取 ${instance.id} 模组列表失败: ${String(error)}`)
  }
  const checked = await container.versions.checkInstalled(instance.versionId).catch((error: unknown) => {
    container.log.error(`检查 ${instance.versionId} 失败`, error)
    return { ok: false, missing: [], sizeBytes: 0 }
  })
  const dir = await dirSize(gameDir)
  return {
    instance,
    state: {
      installed: checked.ok,
      versionResolved: await isFile(versionJsonPath(paths, instance.versionId)),
      clientJarOk: checked.ok,
      assetsOk: checked.ok,
      librariesOk: checked.ok,
      loaderOk: instance.loader === 'vanilla' || checked.ok,
      missingCount: checked.missing.length,
      sizeBytes: dir.bytes,
      lastCheckedAt: Date.now()
    },
    modCount: modsOk ? modCount : 0
  }
}

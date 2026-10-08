/**
 * The complete main-process surface exposed to the renderer.
 * `src/preload/index.ts` implements this object; `src/renderer/src/mock/api.ts`
 * implements the same interface for browser preview. Keep them in sync — the
 * UI only ever touches `window.mouc`.
 */
import type {
  Account,
  CrashAnalysis,
  DownloadJob,
  GameDirStats,
  GameLogLine,
  GameProcessInfo,
  InstalledMod,
  Instance,
  InstanceSummary,
  JavaProvisionRequest,
  JavaProvisionResult,
  JavaRuntime,
  LauncherStatus,
  LaunchPlan,
  LaunchRequest,
  LoaderId,
  MicrosoftLoginProgress,
  MicrosoftStartResult,
  ModFile,
  ModProject,
  ModpackImportRequest,
  ModpackManifest,
  OfflineLoginRequest,
  PathInfo,
  ProjectKind,
  ProjectProvider,
  ProjectVersion,
  RelayStatus,
  ResolvedVersion,
  Result,
  SearchPage,
  SearchQuery,
  ServerEntry,
  ServerPingResult,
  Settings,
  SkinInfo,
  UpdateInfo,
  VersionRef,
  VersionType
} from './types'

export const IPC = {
  app: {
    status: 'app:status',
    paths: 'app:paths',
    version: 'app:version',
    stats: 'app:stats',
    openExternal: 'app:open-external',
    openPath: 'app:open-path',
    pickFolder: 'app:pick-folder',
    pickFile: 'app:pick-file',
    checkUpdate: 'app:check-update',
    relaunch: 'app:relaunch',
    quit: 'app:quit'
  },
  settings: { get: 'settings:get', set: 'settings:set', reset: 'settings:reset' },
  version: {
    refresh: 'version:refresh',
    list: 'version:list',
    installed: 'version:installed',
    install: 'version:install',
    uninstall: 'version:uninstall',
    repair: 'version:repair',
    resolved: 'version:resolved'
  },
  instance: {
    list: 'instance:list',
    create: 'instance:create',
    update: 'instance:update',
    remove: 'instance:remove',
    duplicate: 'instance:duplicate',
    state: 'instance:state',
    importModpack: 'instance:import-modpack',
    exportModpack: 'instance:export-modpack',
    openDir: 'instance:open-dir'
  },
  java: {
    scan: 'java:scan',
    list: 'java:list',
    provision: 'java:provision',
    remove: 'java:remove',
    resolve: 'java:resolve'
  },
  account: {
    list: 'account:list',
    addOffline: 'account:add-offline',
    remove: 'account:remove',
    select: 'account:select',
    refresh: 'account:refresh',
    microsoftStart: 'account:microsoft-start',
    microsoftPoll: 'account:microsoft-poll',
    microsoftCancel: 'account:microsoft-cancel',
    skin: 'account:skin',
    servers: 'account:yggdrasil-servers'
  },
  download: {
    jobs: 'download:jobs',
    cancel: 'download:cancel',
    retry: 'download:retry',
    clear: 'download:clear'
  },
  game: {
    preview: 'game:preview',
    launch: 'game:launch',
    kill: 'game:kill',
    running: 'game:running',
    logs: 'game:logs',
    analyze: 'game:analyze',
    scanCrashReports: 'game:scan-crash-reports'
  },
  mod: {
    search: 'mod:search',
    versions: 'mod:versions',
    install: 'mod:install',
    installed: 'mod:installed',
    toggle: 'mod:toggle',
    remove: 'mod:remove',
    checkUpdates: 'mod:check-updates',
    localFile: 'mod:local-file'
  },
  server: {
    list: 'server:list',
    save: 'server:save',
    remove: 'server:remove',
    ping: 'server:ping',
    lanScan: 'server:lan-scan',
    lanStop: 'server:lan-stop',
    join: 'server:join',
    relayStatus: 'server:relay-status',
    relayHost: 'server:relay-host',
    relayJoin: 'server:relay-join',
    relayStop: 'server:relay-stop'
  },
  loader: {
    options: 'loader:options',
    install: 'loader:install',
    remove: 'loader:remove'
  },
  win: {
    minimize: 'win:minimize',
    toggleMaximize: 'win:toggle-maximize',
    close: 'win:close',
    state: 'win:state',
    setAlwaysOnTop: 'win:set-always-on-top'
  }
} as const

export const EVENTS = {
  progress: 'mouc:progress',
  jobFinished: 'mouc:job-finished',
  log: 'mouc:log',
  gameExit: 'mouc:game-exit',
  microsoft: 'mouc:microsoft-login',
  lan: 'mouc:lan-game',
  relay: 'mouc:relay',
  settings: 'mouc:settings-changed',
  windowState: 'mouc:window-state'
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

export interface VersionInstallRequest {
  id: string
  /** Create an instance for it as well. */
  createInstance?: boolean
  instanceName?: string
  /** Loader to install on top, applied after the vanilla files land. */
  loader?: { id: LoaderId; version: string }
  types?: VersionType[]
}

export interface LoaderOption {
  id: string
  label: string
  /** Loader builds available for a game version. */
  versions: { version: string; stable: boolean; recommended?: boolean; javaFix?: string }[]
}

export interface InstanceCreateRequest {
  name: string
  versionId: string
  isolated?: boolean
  loader?: { id: LoaderId; version: string }
  description?: string
  accountId?: string
  memoryMb?: number
}

export interface ModInstallRequest {
  instanceId: string
  kind: ProjectKind
  file: ModFile
  /** Pull required dependencies automatically. */
  withDependencies?: boolean
}

export interface RelayHostRequest {
  targetPort: number
  room?: string
  password?: string
}

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  alwaysOnTop: boolean
}

/** The object exposed as `window.mouc`. */
export interface MoucApi {
  app: {
    status(): Promise<Result<LauncherStatus>>
    paths(): Promise<Result<PathInfo>>
    version(): Promise<Result<string>>
    stats(): Promise<Result<GameDirStats>>
    openExternal(url: string): Promise<Result<boolean>>
    openPath(target: string): Promise<Result<boolean>>
    pickFolder(title?: string, defaultPath?: string): Promise<Result<string | undefined>>
    pickFile(title?: string, filters?: { name: string; extensions: string[] }[]): Promise<Result<string | undefined>>
    checkUpdate(): Promise<Result<UpdateInfo>>
    relaunch(): Promise<Result<boolean>>
    quit(): Promise<Result<boolean>>
  }
  settings: {
    get(): Promise<Result<Settings>>
    /** Partial update; returns the whole record after the write. */
    set(patch: Partial<Settings>): Promise<Result<Settings>>
    reset(): Promise<Result<Settings>>
  }
  version: {
    refresh(): Promise<Result<VersionRef[]>>
    list(): Promise<Result<VersionRef[]>>
    installed(): Promise<Result<string[]>>
    install(req: VersionInstallRequest): Promise<Result<DownloadJob>>
    uninstall(id: string): Promise<Result<boolean>>
    repair(id: string): Promise<Result<DownloadJob>>
    resolved(id: string): Promise<Result<ResolvedVersion>>
  }
  instance: {
    list(): Promise<Result<InstanceSummary[]>>
    create(req: InstanceCreateRequest): Promise<Result<Instance>>
    update(patch: Partial<Instance> & { id: string }): Promise<Result<Instance>>
    remove(id: string, deleteFiles?: boolean): Promise<Result<boolean>>
    duplicate(id: string, name: string): Promise<Result<Instance>>
    state(id: string): Promise<Result<InstanceSummary>>
    importModpack(req: ModpackImportRequest): Promise<Result<{ job: DownloadJob; manifest: ModpackManifest }>>
    exportModpack(id: string, target: string, format: 'mrpack' | 'zip'): Promise<Result<DownloadJob>>
    openDir(id: string): Promise<Result<boolean>>
  }
  java: {
    scan(): Promise<Result<JavaRuntime[]>>
    list(): Promise<Result<JavaRuntime[]>>
    provision(req: JavaProvisionRequest): Promise<Result<JavaProvisionResult>>
    remove(id: string): Promise<Result<boolean>>
    /** Which runtime will be used for an instance, null = needs download. */
    resolve(instanceId: string): Promise<Result<{ runtime: JavaRuntime | null; major: number }>>
  }
  account: {
    list(): Promise<Result<Account[]>>
    addOffline(req: OfflineLoginRequest): Promise<Result<Account>>
    remove(id: string): Promise<Result<boolean>>
    select(id: string): Promise<Result<Account>>
    refresh(id: string): Promise<Result<Account>>
    microsoftStart(): Promise<Result<MicrosoftStartResult>>
    microsoftPoll(sessionKey: string): Promise<Result<MicrosoftLoginProgress>>
    microsoftCancel(sessionKey: string): Promise<Result<boolean>>
    skin(accountId: string): Promise<Result<SkinInfo>>
    /** Yggdrasil/authlib-injector server list for a host. */
    servers(baseUrl: string): Promise<Result<{ serverName: string; serverUrl: string }[]>>
  }
  download: {
    jobs(): Promise<Result<DownloadJob[]>>
    cancel(jobId: string): Promise<Result<boolean>>
    retry(jobId: string): Promise<Result<DownloadJob>>
    clear(): Promise<Result<boolean>>
  }
  game: {
    preview(instanceId: string): Promise<Result<LaunchPlan>>
    launch(req: LaunchRequest): Promise<Result<GameProcessInfo>>
    kill(instanceId: string): Promise<Result<boolean>>
    running(): Promise<Result<GameProcessInfo[]>>
    /** Tail of the persisted log file for an instance. */
    logs(instanceId: string, lines?: number): Promise<Result<GameLogLine[]>>
    analyze(text: string): Promise<Result<CrashAnalysis>>
    scanCrashReports(instanceId: string): Promise<Result<CrashAnalysis[]>>
  }
  mod: {
    search(query: SearchQuery): Promise<Result<SearchPage<ModProject>>>
    versions(provider: ProjectProvider, projectId: string, gameVersion?: string, loader?: string): Promise<Result<ProjectVersion[]>>
    install(req: ModInstallRequest): Promise<Result<DownloadJob>>
    installed(instanceId: string): Promise<Result<InstalledMod[]>>
    toggle(instanceId: string, fileName: string, disabled: boolean): Promise<Result<InstalledMod>>
    remove(instanceId: string, fileName: string): Promise<Result<boolean>>
    checkUpdates(instanceId: string): Promise<Result<InstalledMod[]>>
    /** Install a .jar / .zip the user picked from disk. */
    localFile(instanceId: string, kind: ProjectKind, source: string): Promise<Result<InstalledMod>>
  }
  server: {
    list(instanceId: string): Promise<Result<ServerEntry[]>>
    save(instanceId: string, entry: ServerEntry): Promise<Result<ServerEntry>>
    remove(instanceId: string, id: string): Promise<Result<boolean>>
    ping(address: string, port?: number): Promise<Result<ServerPingResult>>
    lanScan(instanceId?: string): Promise<Result<boolean>>
    lanStop(): Promise<Result<boolean>>
    /** Launch straight into a server. */
    join(instanceId: string, entry: ServerEntry): Promise<Result<GameProcessInfo>>
    relayStatus(): Promise<Result<RelayStatus>>
    relayHost(req: RelayHostRequest): Promise<Result<RelayStatus>>
    relayJoin(room: string, password?: string): Promise<Result<RelayStatus>>
    relayStop(): Promise<Result<RelayStatus>>
  }
  loader: {
    /** Loader versions available for a game version. */
    options(gameVersion: string): Promise<Result<LoaderOption[]>>
    install(instanceId: string, loader: LoaderId, version: string): Promise<Result<DownloadJob>>
    remove(instanceId: string): Promise<Result<Instance>>
  }
  win: {
    minimize(): void
    toggleMaximize(): Promise<Result<WindowState>>
    close(): void
    state(): Promise<Result<WindowState>>
    setAlwaysOnTop(value: boolean): Promise<Result<WindowState>>
  }
  /** Subscribe to a main-process push event; returns the unsubscribe function. */
  on(event: EventName, handler: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    mouc: MoucApi
    /** True only in the browser preview (`npm run dev:web`). */
    __MOUCX_WEB__?: boolean
  }
}

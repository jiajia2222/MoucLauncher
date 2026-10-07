/**
 * Service contracts. Implementations live in the feature folders; the IPC layer and
 * the container talk to these interfaces only, so a module never imports another
 * module's concrete class.
 */
import type { LoaderOption, VersionInstallRequest } from '@shared/ipc'
import type {
  Account,
  CrashAnalysis,
  DownloadItem,
  DownloadJob,
  DownloadPlan,
  DownloadProgress,
  GameDirStats,
  GameExitInfo,
  GameLogLine,
  GameProcessInfo,
  Instance,
  JavaProvisionRequest,
  JavaProvisionResult,
  JavaRuntime,
  LanGame,
  LauncherStatus,
  LaunchPlan,
  LaunchRequest,
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
  SearchPage,
  SearchQuery,
  ServerEntry,
  ServerPingResult,
  Settings,
  SkinInfo,
  InstalledMod,
  UpdateInfo,
  VersionRef,
  VersionType
} from '@shared/types'
import type { InstanceStore } from './instanceStore'
import type { SettingsStore } from './config'
import type { Logger } from './log'

export interface HttpInit {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD'
  body?: string | Buffer
  /** Follow redirects (default true). */
  redirect?: boolean
}

export interface HeadInfo {
  status: number
  size?: number
  etag?: string
  acceptsRanges: boolean
}

export interface HttpClient {
  json<T>(url: string, init?: HttpInit): Promise<T>
  text(url: string, init?: HttpInit): Promise<string>
  buffer(url: string, init?: HttpInit): Promise<Buffer>
  head(url: string, init?: HttpInit): Promise<HeadInfo>
  /** Raw fetch with the configured proxy + user agent applied. */
  fetch(url: string, init?: HttpInit): Promise<Response>
}

export interface DownloadResult {
  item: DownloadItem
  /** False when the file already matched its sha1 and was not re-fetched. */
  fetched: boolean
}

export interface Downloader {
  /** Queues the plan and returns immediately; progress arrives through `subscribe`. */
  enqueue(plan: DownloadPlan): Promise<DownloadJob>
  /** Queues and waits for completion. Throws on a hard failure. */
  run(plan: DownloadPlan): Promise<DownloadJob>
  /** Single file, de-duplicated across concurrent callers. */
  ensure(item: DownloadItem): Promise<DownloadResult>
  ensureMany(items: DownloadItem[], title: string, kind: DownloadPlan['kind']): Promise<DownloadJob>
  cancel(jobId: string): Promise<boolean>
  retry(jobId: string): Promise<DownloadJob>
  /** Drop finished/failed/cancelled jobs from the registry (UI "清空列表"). */
  clear(): void
  jobs(): DownloadJob[]
  job(id: string): DownloadJob | undefined
  failures(id: string): DownloadItem[]
  subscribe(handler: (progress: DownloadProgress) => void): () => void
  /** Total bytes already cached under the game root. */
  cachedBytes(dir: string): Promise<number>
}

export interface VersionInstallOutcome {
  job: DownloadJob
  versionId: string
  instance?: Instance
}

export interface VersionService {
  refresh(force?: boolean): Promise<VersionRef[]>
  list(types?: VersionType[]): Promise<VersionRef[]>
  installed(): Promise<string[]>
  /** Merge `inheritsFrom`, flatten libraries/arguments. Cached on disk. */
  resolve(id: string): Promise<ResolvedVersion>
  installPlan(req: VersionInstallRequest): Promise<DownloadPlan>
  install(req: VersionInstallRequest): Promise<VersionInstallOutcome>
  uninstall(id: string): Promise<void>
  repair(id: string): Promise<DownloadJob>
  /** Verifies what is on disk; drives the "已安装/需要修复" badge. */
  checkInstalled(id: string): Promise<{ ok: boolean; missing: DownloadItem[]; sizeBytes: number }>
}

export interface JavaService {
  scan(): Promise<JavaRuntime[]>
  list(): Promise<JavaRuntime[]>
  provision(req: JavaProvisionRequest): Promise<JavaProvisionResult>
  remove(id: string): Promise<void>
  /** Runtime for an instance, downloading one when the settings allow it. */
  forInstance(instance: Instance, resolved: ResolvedVersion): Promise<JavaRuntime>
  peek(instance: Instance, resolved: ResolvedVersion): Promise<{ runtime: JavaRuntime | null; major: number }>
}

export interface AccountService {
  list(): Promise<Account[]>
  current(): Promise<Account | undefined>
  addOffline(req: OfflineLoginRequest): Promise<Account>
  remove(id: string): Promise<void>
  select(id: string): Promise<Account>
  refresh(id: string): Promise<Account>
  microsoftStart(): Promise<MicrosoftStartResult>
  microsoftPoll(sessionKey: string): Promise<MicrosoftLoginProgress>
  microsoftCancel(sessionKey: string): Promise<void>
  skin(accountId: string): Promise<SkinInfo>
  servers(baseUrl: string): Promise<{ serverName: string; serverUrl: string }[]>
  /** UUID / token pair fed to the launch arguments. */
  credentials(account: Account): Promise<{ uuid: string; token: string; type: string }>
}

export interface GameService {
  buildPlan(request: LaunchRequest): Promise<LaunchPlan>
  preview(instanceId: string): Promise<LaunchPlan>
  launch(request: LaunchRequest): Promise<GameProcessInfo>
  kill(instanceId: string): Promise<void>
  running(): GameProcessInfo[]
  logs(instanceId: string, lines?: number): GameLogLine[]
  /** Waits for exit, used by the "启动后监控" flow. */
  exited(instanceId: string): Promise<GameExitInfo>
}

export interface LoaderService {
  options(gameVersion: string): Promise<LoaderOption[]>
  /** Rewrites the version json + returns the extra downloads the loader needs. */
  install(instanceId: string, loader: Instance['loader'], version: string): Promise<DownloadJob>
  remove(instanceId: string): Promise<Instance>
  installedLoader(instance: Instance): Promise<{ ok: boolean; detail?: string }>
}

export interface ModService {
  search(query: SearchQuery): Promise<SearchPage<ModProject>>
  versions(
    provider: ProjectProvider,
    projectId: string,
    gameVersion?: string,
    loader?: string
  ): Promise<ProjectVersion[]>
  install(instanceId: string, kind: ProjectKind, file: ModFile, withDependencies?: boolean): Promise<DownloadJob>
  installed(instanceId: string): Promise<InstalledMod[]>
  toggle(instanceId: string, fileName: string, disabled: boolean): Promise<InstalledMod>
  remove(instanceId: string, fileName: string): Promise<void>
  checkUpdates(instanceId: string): Promise<InstalledMod[]>
  installLocal(instanceId: string, kind: ProjectKind, source: string): Promise<InstalledMod>
}

export interface ServerService {
  list(instanceId: string): Promise<ServerEntry[]>
  save(instanceId: string, entry: ServerEntry): Promise<ServerEntry>
  remove(instanceId: string, id: string): Promise<void>
  ping(address: string, port?: number): Promise<ServerPingResult>
  startLanScan(handler: (game: LanGame) => void): Promise<void>
  stopLanScan(): Promise<void>
}

export interface RelayService {
  status(): RelayStatus
  host(targetPort: number, room?: string, password?: string): Promise<RelayStatus>
  join(room: string, password?: string): Promise<RelayStatus>
  stop(): Promise<RelayStatus>
  subscribe(handler: (status: RelayStatus) => void): () => void
}

export interface CrashService {
  analyze(text: string, reportPath?: string): CrashAnalysis
  reports(instanceId: string): Promise<CrashAnalysis[]>
}

export interface ModpackService {
  detect(file: string): ModpackImportRequest['format'] | undefined
  import(req: ModpackImportRequest): Promise<{ job: DownloadJob; manifest: ModpackManifest; instance: Instance }>
  export(instanceId: string, target: string, format: 'mrpack' | 'zip'): Promise<DownloadJob>
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: NodeJS.Platform
  arch: string
}

export interface Container {
  appData: string
  appInfo: AppInfo
  log: Logger
  settings: SettingsStore
  paths(): PathInfo
  instances: InstanceStore
  http: HttpClient
  downloader: Downloader
  versions: VersionService
  java: JavaService
  accounts: AccountService
  game: GameService
  loaders: LoaderService
  mods: ModService
  servers: ServerService
  relay: RelayService
  crash: CrashService
  modpack: ModpackService
  stats(): Promise<GameDirStats>
  /** Aggregated state for the status bar / first paint. */
  status(): Promise<LauncherStatus>
  /** Cached reachability probe (never per-frame). */
  networkOnline(): Promise<boolean>
  checkUpdate(): Promise<UpdateInfo>
  /** Where the window size/position is persisted. */
  windowStatePath(): string
  /** Called on `before-quit`; every service cleans up here. */
  dispose(): Promise<void>
}

export type ServiceKey = keyof Container

/** Settings that services read through the container rather than caching. */
export type SettingsReader = () => Settings

/** The object shape of `SettingsStore` that services actually depend on; tests pass a stub. */
export interface SettingsLike {
  get(): Settings
}

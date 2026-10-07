/**
 * MoucLauncher domain types.
 * This file is the contract between the main-process services, the preload bridge
 * and the renderer. Nothing here may import from `electron` or from `src/main`.
 */

export type ErrorCode =
  | 'network'
  | 'http-status'
  | 'checksum-mismatch'
  | 'not-found'
  | 'already-exists'
  | 'invalid-input'
  | 'unsupported'
  | 'java-missing'
  | 'game-crash'
  | 'auth'
  | 'cancelled'
  | 'busy'
  | 'disk'
  | 'config'
  | 'internal'

export interface AppErrorPayload {
  code: ErrorCode
  message: string
  /** Human-readable extra context (url, path, upstream body excerpt...). */
  detail?: string
  retryable?: boolean
  /** Upstream HTTP status when the failure came from a response. */
  status?: number
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload }

/**
 * `process.platform` / child-process signal names, spelled out because this file is
 * compiled into the renderer too, where the `node` types are not available.
 */
export type NodePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'
  | 'haiku'

export type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK' | 'SIGKILL' | (string & {})

/* ------------------------------------------------------------------ */
/* Files / paths                                                       */
/* ------------------------------------------------------------------ */

export interface PathInfo {
  /** Electron userData: launcher config, account store, java store. */
  appData: string
  /** Root that holds `versions`, `libraries`, `assets`, `instances`. */
  gameRoot: string
  versionsDir: string
  librariesDir: string
  assetsDir: string
  instancesDir: string
  logsDir: string
  javaStoreDir: string
  configDir: string
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type Language = 'zh-CN' | 'en-US'
export type ThemeMode = 'dark' | 'light'
export type CloseAction = 'minimize' | 'exit' | 'ask'

/** A named download endpoint group. `hosts` rewrites official hosts to a mirror. */
export interface MirrorRule {
  id: string
  label: string
  enabled: boolean
  /** official host -> mirror host, e.g. "piston-data.mojang.com": "mirror.example.com" */
  hosts: Record<string, string>
  priority: number
}

export interface Settings {
  settingsVersion: number
  language: Language
  theme: ThemeMode
  /** Where the Minecraft game root lives. */
  gameRoot: string
  /** Max parallel file downloads. */
  maxConcurrentDownloads: number
  /** Reuse a partially downloaded file by sending Range when the server allows it. */
  resumeDownloads: boolean
  /** Fail the whole job when one file cannot be fetched, or skip and continue. */
  strictDownload: boolean
  mirrors: MirrorRule[]
  /** Java strategy. */
  javaMode: 'auto' | 'mojang-component' | 'adoptium' | 'custom'
  customJavaPath: string
  javaScanDirs: string[]
  /** Memory for new instances. */
  defaultMemoryMb: number
  defaultResolution: { width: number; height: number; fullscreen: boolean }
  extraJvmArgs: string
  closeAction: CloseAction
  showGameConsole: boolean
  /** Keep the launcher window hidden while playing. */
  hideOnLaunch: boolean
  /** Optional key for api.curseforge.com (403 without it). */
  curseForgeApiKey: string
  /** User agent sent to mod repositories. */
  modrinthBaseUrl: string
  /** Relay server used for the cross-network multiplayer room. */
  relayServerUrl: string
  /** HTTP(S) proxy for all main-process requests. '' = system. */
  proxyUrl: string
  /** Microsoft OAuth app (client id) used by the正版 login flow. */
  microsoftClientId: string
  autoCheckUpdate: boolean
  lastSeenVersion: string
}

export const SETTINGS_VERSION = 1

/* ------------------------------------------------------------------ */
/* Versions (Mojang metadata)                                          */
/* ------------------------------------------------------------------ */

export type VersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

export interface VersionRef {
  id: string
  type: VersionType
  url: string
  time: string
  releaseTime: string
  /** Present on the v2 manifest for some entries. */
  complianceLevel?: number
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionRef[]
}

export interface Artifact {
  url: string
  sha1: string
  size: number
  /** Maven-style relative path, used for the libraries target path. */
  path?: string
  /** Asset-index style relative path (e.g. "minecraft/assets/..."). */
  id?: string
}

export interface Rule {
  action: 'allow' | 'deny'
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}

export interface Library {
  name: string
  /** e.g. "com.mojang:legacy-launch:1.0" */
  downloads?: {
    artifact?: Artifact
    classifiers?: Record<string, Artifact>
    doc?: { url: string }
    source?: { url: string }
  }
  natives?: Partial<Record<'linux' | 'macos' | 'windows' | 'x86' | 'invalid', string>>
  extract?: { exclude?: string[] }
  rules?: Rule[]
  /** Legacy field, ignored by us but kept for round-tripping. */
  serverData?: unknown
  version?: string
}

export interface ArgEntry {
  rules?: Rule[]
  value: string | string[]
}

export type ArgList = (string | ArgEntry)[]

export interface JavaVersionInfo {
  component?: string
  majorVersion: number
}

export interface AssetIndexRef {
  id: string
  sha1: string
  size: number
  totalSize?: number
  url: string
  minecraft_references?: string[]
}

export interface LoggingConfig {
  client?: { argument: string; file: Artifact; type: string }
}

/** A Mojang version JSON, possibly incomplete until inheritance is resolved. */
export interface RawVersionJson {
  id: string
  inheritsFrom?: string
  mainClass?: string
  minecraftArguments?: string
  arguments?: { game?: ArgList; jvm?: ArgList }
  libraries?: Library[]
  downloads?: {
    client?: Artifact
    client_mappings?: Artifact
    server?: Artifact
    server_mappings?: Artifact
  }
  assetIndex?: AssetIndexRef
  assets?: string
  javaVersion?: JavaVersionInfo
  type?: VersionType
  time?: string
  releaseTime?: string
  minimumLauncherVersion?: number
  complianceLevel?: number
  logging?: LoggingConfig
  /** Loader-produced fields. */
  jar?: string
  problemFlags?: string[]
}

/** Fully resolved (inheritance merged) description used to install + launch. */
export interface ResolvedVersion {
  id: string
  type: VersionType
  mainClass: string
  /** Game arguments after resolution; feature rules are evaluated at launch. */
  gameArgs: ArgList
  jvmArgs: ArgList
  libraries: Library[]
  client?: Artifact
  assetIndex?: AssetIndexRef
  assetsVersion: string
  javaVersion: JavaVersionInfo
  logging?: LoggingConfig
  /** Path of the merged json we wrote into the version dir. */
  jsonPath: string
  clientJarPath: string
  /** Version whose vanilla jar is used (`jar` field), defaults to id. */
  usesVanillaJarOf?: string
  raw: RawVersionJson
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

export type LoaderId =
  | 'vanilla'
  | 'fabric'
  | 'legacy-fabric'
  | 'quilt'
  | 'forge'
  | 'neoforge'
  | 'optifine'
  | 'liteloader'
  | 'cleanroom'

export type InstanceJavaMode = 'auto' | 'pinned' | 'custom'

export interface InstanceJavaConfig {
  mode: InstanceJavaMode
  /** Absolute javaw.exe path when mode = custom/pinned. */
  path?: string
  /** Required major, e.g. 8 / 17 / 21 / 25. `auto` resolves it from the version json. */
  major?: number
}

export interface InstanceLaunchTarget {
  address: string
  port: number
}

export interface Instance {
  id: string
  name: string
  /** Descriptive text, shown in the tooltip. */
  description: string
  icon: string
  /** Mojang version id (possibly a loader-patched id). */
  versionId: string
  loader: LoaderId
  loaderVersion?: string
  gameVersion: string
  /** Isolated: `instances/<id>/`. Shared: the game root itself. */
  isolated: boolean
  java: InstanceJavaConfig
  memoryMb: number
  jvmArgs: string
  gameArgs: string
  resolution: { width: number; height: number; fullscreen: boolean }
  accountId?: string
  server?: InstanceLaunchTarget
  serverId?: string
  createdAt: number
  updatedAt: number
  lastPlayedAt?: number
  /** Played more than once -> used for the "最近游玩" sort. */
  playCount: number
  quickAccess?: boolean
  version: number
}

export interface InstanceState {
  installed: boolean
  versionResolved: boolean
  clientJarOk: boolean
  assetsOk: boolean
  librariesOk: boolean
  loaderOk: boolean
  missingCount: number
  /** Bytes on disk for the instance dir + its version assets (approximate). */
  sizeBytes: number
  lastCheckedAt: number
}

export interface InstanceSummary {
  instance: Instance
  state: InstanceState
  modCount: number
}

/* ------------------------------------------------------------------ */
/* Java                                                                */
/* ------------------------------------------------------------------ */

export type JavaSource = 'system-path' | 'scan' | 'adoptium' | 'zulu' | 'mojang' | 'manual'

export interface JavaRuntime {
  id: string
  path: string
  /** `java -version` first line, e.g. "openjdk version \"25\" ...". */
  rawVersion: string
  major: number
  vendor: string
  arch: 'x64' | 'x86' | 'arm64' | 'unknown'
  source: JavaSource
  /** Absolute javaw.exe path used for launching (no console window). */
  executable: string
  canHeadless: boolean
  broken?: string
}

export interface JavaProvisionRequest {
  major: number
  /** Prefer JRE (smaller) over JDK. */
  imageType?: 'jre' | 'jdk'
  /** Where to unpack. Defaults to `<appData>/java/<major>`. */
  targetDir?: string
}

export interface JavaProvisionResult {
  runtime: JavaRuntime
  downloadedBytes: number
  fromCache: boolean
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export type AccountType = 'microsoft' | 'offline' | 'yggdrasil' | 'authlib-injector'
export type TokenState = 'none' | 'valid' | 'needs-refresh' | 'invalid'

export interface Account {
  id: string
  type: AccountType
  /** In-game player name. */
  name: string
  uuid: string
  selected: boolean
  addedAt: number
  lastUsedAt: number
  tokenState: TokenState
  /** Microsoft accounts store refresh-token expiry here. */
  expiresAt?: number
  skinUrl?: string
  capeUrl?: string
  /** authlib-injector / Yggdrasil server base. */
  server?: string
  /** Masked, for display only. Never a secret. */
  label: string
}

export interface OfflineLoginRequest {
  name: string
  uuid?: string
}

export interface MicrosoftStartResult {
  /** OAuth device code the user must type at `verificationUri`. */
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
  /** Token used by the main process to poll; never shown. */
  sessionKey: string
  message: string
}

export type LoginStage =
  | 'waiting-user'
  | 'microsoft-ok'
  | 'xbox-ok'
  | 'live-ok'
  | 'minecraft-ok'
  | 'profile-ok'
  | 'done'
  | 'failed'

export interface MicrosoftLoginProgress {
  sessionKey: string
  stage: LoginStage
  message: string
  account?: Account
}

export interface SkinInfo {
  accountId: string
  name: string
  /** PNG bytes rendered to a temp path, shown via file:// or read as data url. */
  previewPng: string
  model: 'classic' | 'slim'
  source: 'microsoft' | 'offline-store' | 'none'
 capeUrl?: string
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

export type DownloadKind =
  | 'version-json'
  | 'client-jar'
  | 'asset-index'
  | 'asset'
  | 'library'
  | 'natives'
  | 'java'
  | 'forge'
  | 'neoforge'
  | 'fabric'
  | 'quilt'
  | 'optifine'
  | 'mod'
  | 'resource-pack'
  | 'shader'
  | 'world'
  | 'modpack'
  | 'misc'

export interface DownloadItem {
  /** Stable identity: the absolute target path. */
  id: string
  url: string
  /** Tried in order when `url` fails (mirror fallbacks). */
  fallbackUrls?: string[]
  /** Absolute destination file. Parents are created automatically. */
  target: string
  sha1?: string
  size?: number
  kind: DownloadKind
  /** Shown in the progress list; usually the file name. */
  label?: string
  /** Do not delete/re-download when it already exists and matches sha1. */
  overwrite?: boolean
  /** If false, a 404 on this item is a hard error. */
  optional?: boolean
}

export interface DownloadPlan {
  /** Human-readable title shown in the download panel. */
  title: string
  kind: DownloadKind
  items: DownloadItem[]
  /** Optional follow-up performed after every file landed. */
  after?: 'extract-natives' | 'run-installer' | 'none'
  afterPayload?: unknown
}

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'

export interface DownloadJob {
  id: string
  title: string
  kind: DownloadKind
  status: JobStatus
  total: number
  done: number
  failed: number
  skipped: number
  bytesTotal: number
  bytesDone: number
  startedAt: number
  finishedAt?: number
  error?: AppErrorPayload
}

export interface DownloadProgress {
  jobId: string
  status: JobStatus
  total: number
  done: number
  failed: number
  bytesTotal: number
  bytesDone: number
  speedBps: number
  etaSeconds: number
  currentLabel: string
  currentUrl?: string
  percent: number
}

export interface DownloadFailure {
  item: DownloadItem
  error: AppErrorPayload
}

/* ------------------------------------------------------------------ */
/* Launching                                                           */
/* ------------------------------------------------------------------ */

export interface LaunchRequest {
  instanceId: string
  accountId?: string
  /** Overrides the instance server target (used by "加入服务器"). */
  server?: InstanceLaunchTarget
  /** Do not download anything, fail instead. */
  offline?: boolean
  /** Extra args appended after everything else. */
  gameArgs?: string[]
}

export interface LaunchPlan {
  javaExecutable: string
  jvmArgs: string[]
  gameArgs: string[]
  /** The full argv, for display in the console. */
  commandLine: string
  classpath: string[]
  /** Native directory (`-Djava.library.path`). */
  nativesDir: string
  gameDir: string
  versionName: string
  javaMajor: number
  /** What the pre-launch check had to fix. */
  notes: string[]
}

export interface GameProcessInfo {
  pid: number
  instanceId: string
  startedAt: number
  commandLine: string
  javaExecutable: string
  gameDir: string
}

export interface GameExitInfo {
  instanceId: string
  pid: number
  code: number | null
  signal: ProcessSignal | null
  durationMs: number
  /** Stderr tail used by the crash analyser. */
  analysis?: CrashAnalysis
}

export type LogLevel = 'info' | 'warn' | 'error' | 'system'

export interface GameLogLine {
  instanceId: string
  ts: number
  level: LogLevel
  text: string
}

/* ------------------------------------------------------------------ */
/* Crash analysis                                                      */
/* ------------------------------------------------------------------ */

export interface CrashAnalysis {
  title: string
  cause: string
  suggestion: string
  severity: 'info' | 'warning' | 'critical'
  evidence: string[]
  tags: string[]
  /** File that produced this analysis, if any. */
  reportPath?: string
}

/* ------------------------------------------------------------------ */
/* Mod repositories                                                    */
/* ------------------------------------------------------------------ */

export type ProjectKind = 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'world'
export type ProjectProvider = 'modrinth' | 'curseforge' | 'local'

export interface ModProject {
  provider: ProjectProvider
  id: string
  slug: string
  kind: ProjectKind
  title: string
  description: string
  authors: string[]
  iconUrl?: string
  downloads: number
  categories: string[]
  loaders: LoaderId[]
  gameVersions: string[]
  dateModified: string
  license?: string
  body?: string
  sourceUrl?: string
}

export interface ModFileHashes {
  sha1?: string
  sha512?: string
}

export interface ModFile {
  versionId: string
  projectId: string
  provider: ProjectProvider
  name: string
  fileName: string
  url: string
  size: number
  hashes: ModFileHashes
  loaders: LoaderId[]
  gameVersions: string[]
  dependencies: ModDependency[]
  primary: boolean
}

export interface ModDependency {
  projectId: string
  kind: 'required' | 'optional' | 'incompatible'
  projectProvider?: ProjectProvider
}

export interface ProjectVersion {
  id: string
  projectId: string
  provider: ProjectProvider
  name: string
  versionNumber: string
  changelog?: string
  datePublished: string
  files: ModFile[]
  loaders: LoaderId[]
  gameVersions: string[]
  dependencies: ModDependency[]
}

export interface SearchQuery {
  provider: ProjectProvider
  kind: ProjectKind
  keyword: string
  loader?: LoaderId
  gameVersion?: string
  category?: string
  sort?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  offset: number
  limit: number
}

export interface SearchPage<T> {
  items: T[]
  total: number
  offset: number
}

export interface InstalledMod {
  fileName: string
  /** Mod id read from fabric.mod.json / mcmod.info, when parseable. */
  modId?: string
  name?: string
  version?: string
  description?: string
  loader?: LoaderId
  gameVersions?: string[]
  size: number
  disabled: boolean
  updatedAt: number
  /** Provider provenance, used for "检查更新". */
  projectId?: string
  provider?: ProjectProvider
  versionId?: string
  updateAvailable?: ProjectVersion
}

/* ------------------------------------------------------------------ */
/* Modpacks                                                            */
/* ------------------------------------------------------------------ */

export type ModpackFormat = 'mrpack' | 'zip-multimc' | 'curse-zip'

export interface ModpackImportRequest {
  file: string
  /** Optional hint; the importer sniffs the archive and only falls back to this. */
  format?: ModpackFormat
  name: string
}

export interface ModpackManifest {
  name: string
  author: string
  version: string
  gameVersion: string
  loader: { id: LoaderId; version: string }
  /** Files the pack declares; server-only entries are skipped during import. */
  files: number
}

/* ------------------------------------------------------------------ */
/* Multiplayer                                                         */
/* ------------------------------------------------------------------ */

export interface ServerEntry {
  id: string
  name: string
  address: string
  port?: number
  /** Hidden LAN-discovered servers are not persisted. */
  acceptTextures?: 0 | 1
  iconPngBase64?: string
  hidden?: boolean
  lastPingAt?: number
}

export interface ServerPingResult {
  address: string
  port: number
  online: boolean
  latencyMs: number
  motdPlain: string
  motdJson?: string
  versionName?: string
  protocol?: number
  maxPlayers?: number
  onlinePlayers?: number
  samplePlayers?: string[]
  iconPngBase64?: string
  error?: AppErrorPayload
}

export interface LanGame {
  /** MOTD line, may contain section codes. */
  motd: string
  address: string
  port: number
  versionName: string
  protocol: number
  gameMode?: string
  serverProperties?: Record<string, string>
  /** UDP source; used as the join address. */
  from: string
  seenAt: number
}

export type RelayState = 'idle' | 'hosting' | 'joining' | 'connected' | 'error'

export interface RelayStatus {
  state: RelayState
  /** Room code others join with. */
  room?: string
  /** Relays port the local MC client should connect to. */
  localPort?: number
  endpoint?: string
  peers: RelayPeer[]
  message: string
  error?: AppErrorPayload
}

export interface RelayPeer {
  id: string
  name: string
  latencyMs?: number
  bytesForwarded: number
  connectedAt: number
}

export interface RelayHostRequest {
  /** Local Minecraft's LAN/serve port. */
  targetPort: number
  room?: string
  relayUrl: string
  password?: string
}

/* ------------------------------------------------------------------ */
/* Misc shared shapes                                                  */
/* ------------------------------------------------------------------ */

export interface GameDirStats {
  exists: boolean
  sizeBytes: number
  fileCount: number
  versions: number
  instances: number
  mods: number
  screenshots: number
}

export interface UpdateInfo {
  available: boolean
  current: string
  latest: string
  url?: string
  notes?: string
  /** Asset names attached to the release. */
  assets: string[]
}

export interface LauncherStatus {
  version: string
  electron: string
  node: string
  platform: NodePlatform
  arch: string
  gameRoot: string
  online: boolean
  java: number
  instances: number
  accounts: number
  activeJob?: DownloadJob
  runningGame?: GameProcessInfo
}

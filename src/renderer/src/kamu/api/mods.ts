/**
 * Mod browsing / management data layer for the ported KAMUCL views.
 *
 * Upstream (`src/renderer/src/api.ts` in KAMUCL) exposes flat functions that return plain
 * values and reject on failure. MoucLauncher's backend is `window.mouc`, whose every method
 * resolves to `Result<T>`, so each call here goes through `call()` / `maybe()` from
 * `./core`, and everything leaving the renderer is sanitised with `plain()` (Electron cannot
 * structured-clone Vue reactive proxies).
 *
 * Ported pieces: community search (`mouc.mod.search`), version list (`mouc.mod.versions`),
 * install (`mouc.mod.install` + download-job pushes) and the per-instance installed list
 * (`mouc.mod.installed` / `toggle` / `remove` / `checkUpdates` / `localFile`).
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT for its own
 * contributions — see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import { EVENTS, type ModInstallRequest } from '@shared/ipc'
import type {
  AppErrorPayload,
  DownloadJob,
  DownloadProgress,
  InstalledMod,
  InstanceSummary,
  LoaderId,
  ModFile,
  ModProject,
  ProjectKind,
  ProjectProvider,
  ProjectVersion,
  SearchPage,
  SearchQuery,
  Settings
} from '@shared/types'
import { ApiError, api, call, maybe, plain } from './core'

/* ------------------------------------------------------------- filter tables */

/** Upstream `kindTabs`; our `ProjectKind` has no 数据包 but does have 世界存档. */
export const KIND_TABS: Array<{ value: ProjectKind; label: string }> = [
  { value: 'mod', label: 'Mod' },
  { value: 'modpack', label: '整合包' },
  { value: 'resourcepack', label: '资源包' },
  { value: 'shader', label: '光影包' },
  { value: 'world', label: '世界存档' }
]

export const KIND_LABELS: Record<ProjectKind, string> = {
  mod: 'Mod',
  modpack: '整合包',
  resourcepack: '资源包',
  shader: '光影包',
  world: '世界存档'
}

/** `SearchQuery.provider` is single-valued, so there is no 「全部来源」 like upstream had. */
export const PROVIDER_TABS: Array<{ value: ProjectProvider; label: string }> = [
  { value: 'modrinth', label: 'Modrinth' },
  { value: 'curseforge', label: 'CurseForge' }
]

/** Loader filters (upstream `loaderOptions`); '' = 全部加载器, never sent to the backend. */
export const LOADER_TABS: Array<{ value: '' | LoaderId; label: string }> = [
  { value: '', label: '全部加载器' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' }
]

export const SORT_TABS: Array<{ value: NonNullable<SearchQuery['sort']>; label: string }> = [
  { value: 'relevance', label: '相关度' },
  { value: 'downloads', label: '最多下载' },
  { value: 'follows', label: '最多关注' },
  { value: 'newest', label: '最新发布' },
  { value: 'updated', label: '最近更新' }
]

/**
 * Upstream `usesCommunityLoader()`: only MOD-shaped kinds carry a loader filter; resource
 * packs / shaders / worlds are filtered by game version alone.
 */
export function usesLoader(kind: ProjectKind): boolean {
  return kind === 'mod' || kind === 'modpack'
}

/** CurseForge always answers 403 / `unsupported` without a key, so the view asks first. */
export function curseForgeReady(settings: Settings | null): boolean {
  return (settings?.curseForgeApiKey ?? '').trim().length > 0
}

/* --------------------------------------------------------------- source links */

/** Upstream `CF_KIND_SEGMENT`: CurseForge URL segment per kind. */
const CF_KIND_SEGMENT: Record<ProjectKind, string> = {
  mod: 'mc-mods',
  modpack: 'modpacks',
  resourcepack: 'texture-packs',
  shader: 'shaders',
  world: 'worlds'
}

/** Source-site page of a project (Modrinth / CurseForge), ported from upstream. */
export function projectSourceUrl(project: Pick<ModProject, 'provider' | 'id' | 'slug'>, kind: ProjectKind): string {
  const path = project.slug || project.id
  if (project.provider === 'modrinth') return `https://modrinth.com/project/${path}`
  if (project.provider === 'curseforge') {
    return `https://www.curseforge.com/minecraft/${CF_KIND_SEGMENT[kind] ?? 'mc-mods'}/${path}`
  }
  return ''
}

/* ------------------------------------------------------------------ formatting */

/** Upstream `fmtDownloads`: 亿 / 万 for large counters, plain digits otherwise. */
export function formatDownloads(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count >= 1e8) return `${(count / 1e8).toFixed(1)} 亿`
  if (count >= 1e4) return `${(count / 1e4).toFixed(1)} 万`
  return String(count)
}

export function formatDate(value: string | number): string {
  if (value === '' || value === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('zh-CN')
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Upstream `formatSpeed`, kept for the install progress line. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

/* --------------------------------------------------------------- files & match */

/** Every downloadable file of a version list, primary file first (upstream file rows). */
export function filesOfVersion(versions: ProjectVersion[]): ModFile[] {
  const files: ModFile[] = []
  for (const version of versions) {
    for (const file of version.files) files.push(file)
  }
  return files.sort((a, b) => Number(b.primary) - Number(a.primary))
}

/** Required dependencies a file still needs (drives the 「同时下载必要前置」 row). */
export function requiredDependencies(file: ModFile | null): string[] {
  if (!file) return []
  return file.dependencies.filter((entry) => entry.kind === 'required').map((entry) => entry.projectId)
}

export function versionOf(file: ModFile | null, versions: ProjectVersion[]): ProjectVersion | null {
  if (!file) return null
  return versions.find((version) => version.id === file.versionId) ?? null
}

/**
 * Port of upstream `communityFileMatchesInstance`: a MOD file only offers itself to an
 * instance whose game version and loader it declares.
 */
export function fileMatchesInstance(file: ModFile, instance: InstanceSummary): boolean {
  if (instance.instance.loader === 'vanilla') return false
  const versionOk = !instance.instance.gameVersion || file.gameVersions.includes(instance.instance.gameVersion)
  const loaderOk = !file.loaders.length || file.loaders.includes(instance.instance.loader)
  return versionOk && loaderOk
}

/** Stable card key (upstream `itemKey`). */
export function projectKey(project: Pick<ModProject, 'provider' | 'id'>): string {
  return `${project.provider}:${project.id}`
}

/* ------------------------------------------------------------------ IPC calls */

export function searchProjects(query: SearchQuery): Promise<SearchPage<ModProject>> {
  return call(api().mod.search(plain(query)))
}

export function projectVersions(
  provider: ProjectProvider,
  projectId: string,
  gameVersion?: string,
  loader?: string
): Promise<ProjectVersion[]> {
  return call(api().mod.versions(provider, projectId, gameVersion || undefined, loader || undefined))
}

export function installProject(request: ModInstallRequest): Promise<DownloadJob> {
  return call(api().mod.install(plain(request)))
}

export function installedMods(instanceId: string): Promise<InstalledMod[]> {
  return call(api().mod.installed(instanceId))
}

export function setModDisabled(instanceId: string, fileName: string, disabled: boolean): Promise<InstalledMod> {
  return call(api().mod.toggle(instanceId, fileName, disabled))
}

export function removeInstalledMod(instanceId: string, fileName: string): Promise<boolean> {
  return call(api().mod.remove(instanceId, fileName))
}

export function checkInstalledUpdates(instanceId: string): Promise<InstalledMod[]> {
  return call(api().mod.checkUpdates(instanceId))
}

export function installFromDisk(instanceId: string, kind: ProjectKind, source: string): Promise<InstalledMod> {
  return call(api().mod.localFile(instanceId, kind, source))
}

/* ---------------------------------------------------- pickers shared with shell */

export function listInstances(): Promise<InstanceSummary[]> {
  return call(api().instance.list())
}

export function installedVersionIds(): Promise<string[]> {
  return call(api().version.installed())
}

export function readModSettings(): Promise<Settings> {
  return call(api().settings.get())
}

export function openInstanceDir(instanceId: string): Promise<boolean> {
  return maybe(api().instance.openDir(instanceId), false)
}

export function openExternal(url: string): Promise<boolean> {
  if (!url) return Promise.resolve(false)
  return maybe(api().app.openExternal(url), false)
}

/** `.jar` / `.zip` chooser used by 从磁盘安装; undefined when the dialog is dismissed. */
export function pickProjectFile(kind: ProjectKind): Promise<string | undefined> {
  const isPack = kind === 'modpack'
  return maybe(
    api().app.pickFile(isPack ? '选择整合包文件' : '选择模组文件', [
      {
        name: isPack ? '整合包' : 'Minecraft 模组',
        extensions: isPack ? ['mrpack', 'zip'] : ['jar', 'zip', 'litemod']
      }
    ]),
    undefined
  )
}

/* ------------------------------------------------------------------ job pushes */

export function cancelJob(jobId: string): Promise<boolean> {
  return maybe(api().download.cancel(jobId), false)
}

/** Live progress for the running job (`mouc:progress`). */
export function onJobProgress(handler: (progress: DownloadProgress) => void): () => void {
  const bridge = window.mouc
  if (!bridge || typeof bridge.on !== 'function') return () => undefined
  try {
    return bridge.on(EVENTS.progress, (payload) => handler(payload as DownloadProgress))
  } catch {
    return () => undefined
  }
}

/** Terminal job state (`mouc:job-finished`). */
export function onJobFinished(handler: (job: DownloadJob) => void): () => void {
  const bridge = window.mouc
  if (!bridge || typeof bridge.on !== 'function') return () => undefined
  try {
    return bridge.on(EVENTS.jobFinished, (payload) => handler(payload as DownloadJob))
  } catch {
    return () => undefined
  }
}

export function jobPercent(job: DownloadJob, progress?: DownloadProgress | null): number {
  if (progress && progress.jobId === job.id) return Math.round(progress.percent)
  if (job.bytesTotal > 0) return Math.round((job.bytesDone / job.bytesTotal) * 100)
  if (job.total > 0) return Math.round((job.done / job.total) * 100)
  return 0
}

/* --------------------------------------------------------------------- errors */

/** Ported from upstream `errText()`: anything thrown becomes one readable line. */
export function errText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'error' in error) {
    const payload = (error as { error?: AppErrorPayload }).error
    if (payload && typeof payload.message === 'string') {
      return payload.detail ? `${payload.message} — ${payload.detail}` : payload.message
    }
  }
  return String(error)
}

/** `unsupported` = the backend has no capability for this request (e.g. missing key). */
export function isUnsupported(error: unknown): boolean {
  return error instanceof ApiError && error.payload.code === 'unsupported'
}

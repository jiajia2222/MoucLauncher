/**
 * Instance management data layer — the flat, promise-rejecting API surface the ported
 * KAMUCL views expect (upstream `src/renderer/src/api.ts`), re-implemented on top of
 * `window.mouc`.
 *
 * Every call goes through `core.ts`, so a `Result` envelope becomes a rejection and every
 * payload leaving the renderer is `plain()`-sanitised (Electron refuses to structured-clone
 * Vue reactive proxies).
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import type { InstanceCreateRequest, LoaderOption } from '@shared/ipc'
import type {
  DownloadJob,
  Instance,
  InstanceJavaConfig,
  InstanceState,
  InstanceSummary,
  JavaProvisionResult,
  JavaRuntime,
  LoaderId,
  ModpackFormat,
  ModpackImportRequest,
  ModpackManifest
} from '@shared/types'
import { api, call, plain } from './core'

/* --------------------------------------------------------------- CRUD */

export async function listInstances(): Promise<InstanceSummary[]> {
  return call(api().instance.list())
}

export async function createInstance(req: InstanceCreateRequest): Promise<Instance> {
  return call(api().instance.create(plain(req)))
}

export async function updateInstance(patch: Partial<Instance> & { id: string }): Promise<Instance> {
  return call(api().instance.update(plain(patch)))
}

export async function deleteInstance(id: string, deleteFiles: boolean): Promise<boolean> {
  return call(api().instance.remove(id, deleteFiles))
}

export async function duplicateInstance(id: string, name: string): Promise<Instance> {
  return call(api().instance.duplicate(id, name.trim()))
}

/** Re-run the integrity check for one instance; returns the refreshed summary. */
export async function refreshInstanceState(id: string): Promise<InstanceSummary> {
  return call(api().instance.state(id))
}

export async function openInstanceFolder(id: string): Promise<boolean> {
  return call(api().instance.openDir(id))
}

/* ------------------------------------------------------- modpack transfer */

export const MODPACK_EXPORT_FORMATS = ['mrpack', 'zip'] as const
export type ModpackExportFormat = (typeof MODPACK_EXPORT_FORMATS)[number]

export async function exportInstanceModpack(
  id: string,
  target: string,
  format: ModpackExportFormat
): Promise<DownloadJob> {
  return call(api().instance.exportModpack(id, target, format))
}

/** Import formats the main process can read; `zip` export maps back to `zip-multimc`. */
export const MODPACK_IMPORT_FORMATS: Array<{ value: ModpackFormat; label: string }> = [
  { value: 'mrpack', label: 'Modrinth (.mrpack)' },
  { value: 'zip-multimc', label: 'MultiMC / Prism (.zip)' },
  { value: 'curse-zip', label: 'CurseForge (.zip)' }
]

export async function importModpack(
  req: ModpackImportRequest
): Promise<{ job: DownloadJob; manifest: ModpackManifest }> {
  return call(api().instance.importModpack(plain(req)))
}

/** Native folder picker used by the export flow. `undefined` = user cancelled. */
export async function pickExportFolder(defaultPath?: string): Promise<string | undefined> {
  return call(api().app.pickFolder('选择导出位置', defaultPath))
}

export async function pickModpackFile(): Promise<string | undefined> {
  return call(
    api().app.pickFile('选择整合包文件', [
      { name: '整合包', extensions: ['mrpack', 'zip'] }
    ])
  )
}

/* ------------------------------------------------------------------ java */

export async function javaRuntimes(): Promise<JavaRuntime[]> {
  return call(api().java.list())
}

export async function resolveInstanceJava(
  id: string
): Promise<{ runtime: JavaRuntime | null; major: number }> {
  return call(api().java.resolve(id))
}

export async function provisionJava(major: number): Promise<JavaProvisionResult> {
  return call(api().java.provision(plain({ major })))
}

/* ------------------------------------------------------- derived display */

export const LOADER_LABELS: Record<LoaderId, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  'legacy-fabric': 'Legacy Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  optifine: 'OptiFine',
  liteloader: 'LiteLoader',
  cleanroom: 'Cleanroom'
}

export function loaderLabel(loader: LoaderId, version?: string): string {
  const base = LOADER_LABELS[loader] ?? loader
  return version ? `${base} ${version}` : base
}

/** Loader ids the create dialog accepts; `LoaderOption.id` from the bridge is a loose string. */
const KNOWN_LOADERS = Object.keys(LOADER_LABELS) as LoaderId[]

export function asLoaderId(value: string): LoaderId | null {
  return (KNOWN_LOADERS as string[]).includes(value) ? (value as LoaderId) : null
}

export function loaderOptionFor(id: string, options: LoaderOption[]): LoaderOption | undefined {
  return options.find((option) => option.id === id)
}

export type InstanceHealth = 'complete' | 'repair' | 'missing' | 'uninstalled'

export interface InstanceHealthInfo {
  health: InstanceHealth
  /** 完整 / 需修复 / 缺 N 个文件 / 未安装 */
  label: string
  /** `.tag-*` modifier from the vendored kamu.css. */
  tone: 'tag-success' | 'tag-danger' | 'tag-gold' | ''
  /** Which integrity flags still have to be satisfied. */
  problems: string[]
}

/** Turn the raw `InstanceState` into the single badge the instance rows show. */
export function instanceHealth(state: InstanceState): InstanceHealthInfo {
  const problems: string[] = []
  if (!state.versionResolved) problems.push('版本 json 无法解析')
  if (!state.clientJarOk) problems.push('client jar 缺失或校验失败')
  if (!state.loaderOk) problems.push('模组加载器未安装')
  if (!state.assetsOk) problems.push('资源文件不完整')
  if (!state.librariesOk) problems.push('依赖库不完整')

  if (!state.installed) {
    return { health: 'uninstalled', label: '未安装', tone: '', problems: problems.length ? problems : ['尚未下载运行文件'] }
  }
  if (problems.length) {
    return { health: 'repair', label: '需修复', tone: 'tag-danger', problems }
  }
  if (state.missingCount > 0) {
    return {
      health: 'missing',
      label: `缺 ${state.missingCount} 个文件`,
      tone: 'tag-gold',
      problems: [`仍有 ${state.missingCount} 个文件待校验`]
    }
  }
  return { health: 'complete', label: '完整', tone: 'tag-success', problems: [] }
}

/** Game version of a summary: the instance stores the loader-patched id, we show the base. */
export function gameVersionOf(summary: InstanceSummary): string {
  const { instance } = summary
  if (instance.gameVersion) return instance.gameVersion
  return instance.versionId.split(/[+]/)[0] ?? instance.versionId
}

export function instanceDirLabel(summary: InstanceSummary): string {
  return summary.instance.isolated ? '独立游戏目录' : '共享游戏目录'
}

const NAME_MAX = 64
/** Mirrors the main-process validation: no path separators or Windows-reserved characters. */
const NAME_PATTERN = /^[^<>:"/\\|?*]{1,64}$/

/** Returns an error message, or `''` when the name is usable. */
export function validateInstanceName(name: string, existing: Instance[], selfId?: string): string {
  const value = name.trim()
  if (!value) return '请填写实例名称'
  if (value.length > NAME_MAX) return `名称不能超过 ${NAME_MAX} 个字符`
  if (!NAME_PATTERN.test(value)) return '名称不能包含 < > : " / \\ | ? * 等字符'
  if (existing.some((instanceItem) => instanceItem.id !== selfId && instanceItem.name === value)) {
    return '已经有一个同名实例了'
  }
  return ''
}

/** Default instance name for a freshly installed version, upstream style. */
export function suggestedInstanceName(versionId: string, loader?: string | null): string {
  const base = versionId.split('+')[0] ?? versionId
  return loader && loader !== 'vanilla' ? `${loader} ${base}` : base
}

export function javaConfigOf(runtime: JavaRuntime | null, major: number): InstanceJavaConfig {
  return runtime ? { mode: 'pinned', path: runtime.executable, major } : { mode: 'auto', major }
}

/** `memoryMb` -> the "GB" text the cards show. */
export function formatMemory(memoryMb: number): string {
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) return '默认'
  return memoryMb >= 1024 ? `${(memoryMb / 1024).toFixed(memoryMb % 1024 === 0 ? 0 : 1)} GB` : `${memoryMb} MB`
}

/* ------------------------------------------------------- home presentation */
/* Ported from upstream `store.ts` (`displayVersionName` / `displayVersionSub` /
 * `sortWithFavorite` / `fmtLastPlayed`): the home hero and its recent-game rows show the
 * instance's real content instead of a generated id, and never infer a version from a name. */

/** The base game version of an instance, without the loader suffix. */
function baseVersion(instance: Instance): string {
  return instance.gameVersion || (instance.versionId.split('+')[0] ?? instance.versionId)
}

/** Auto-named instances carry the version text we generated for them. */
function isAutoInstanceName(instance: Instance): boolean {
  const name = instance.name.trim()
  if (!name) return true
  const base = baseVersion(instance)
  return (
    name === instance.versionId ||
    name === base ||
    name.startsWith(`${base}+`) ||
    name.startsWith(`${base} `) ||
    name === suggestedInstanceName(instance.versionId, instance.loader)
  )
}

/** `1.21.1 · Fabric 0.16.14` — the technical content of an instance. */
export function instanceContent(instance: Instance): string {
  const base = baseVersion(instance)
  if (instance.loader === 'vanilla') return base
  return `${base} · ${loaderLabel(instance.loader, instance.loaderVersion ?? undefined)}`
}

export function instanceTitle(summary: InstanceSummary): string {
  const name = summary.instance.name.trim()
  return !name || isAutoInstanceName(summary.instance) ? instanceContent(summary.instance) : name
}

export function instanceSub(summary: InstanceSummary): string {
  return isAutoInstanceName(summary.instance) ? summary.instance.versionId : instanceContent(summary.instance)
}

/** The hero badge: upstream shows 「正式版」 for a vanilla instance. */
export function loaderBadge(instance: Instance): string {
  return instance.loader === 'vanilla' ? '正式版' : loaderLabel(instance.loader, instance.loaderVersion ?? undefined)
}

/** Only a real icon URL can be rendered; anything else falls back to the default block. */
export function instanceIconUrl(instance: Instance): string {
  const icon = instance.icon
  if (!icon) return ''
  return /^(https?:|data:|file:)/i.test(icon) ? icon : ''
}

/** Upstream `sortWithFavorite()`: pinned first, then most recently played. */
export function sortInstances(list: InstanceSummary[]): InstanceSummary[] {
  return [...list].sort((a, b) => {
    const pin = (b.instance.quickAccess ? 1 : 0) - (a.instance.quickAccess ? 1 : 0)
    if (pin !== 0) return pin
    return (b.instance.lastPlayedAt ?? 0) - (a.instance.lastPlayedAt ?? 0)
  })
}

/** Upstream `toggleFavorite()`, on the instance's own `quickAccess` flag. */
export function togglePinned(instance: Instance): Promise<Instance> {
  return updateInstance({ id: instance.id, quickAccess: !instance.quickAccess })
}

/** Upstream `fmtLastPlayed()` — 今天 / 昨天 / x天前. */
export function lastPlayedText(ts?: number): string {
  if (!ts) return '—'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '—'
  const startOf = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  return date.toLocaleDateString('zh-CN')
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${SIZE_UNITS[unit]}`
}

/** Anything but a complete integrity check needs the user's attention on the home card. */
export function needsAttention(summary: InstanceSummary): boolean {
  return instanceHealth(summary.state).health !== 'complete'
}


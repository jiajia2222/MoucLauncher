/**
 * CurseForge zip import (`manifest.json` + `overrides/`).
 *
 * The archive only carries `projectID` / `fileID` pairs, so every file has to be
 * resolved against api.curseforge.com (403 without a key). Two rules this importer
 * follows on purpose:
 *
 * - The instance is always created and `overrides/` always lands, even when nothing
 *   can be resolved — an empty but visible instance beats a failed dialog.
 * - Unresolved files are never dropped quietly: they are counted in `job.failed` and
 *   listed in `job.error.detail`, and `job.status` becomes `error` carrying an
 *   `AppError('unsupported')` payload.
 *
 * Endpoints reached through `ModService` (see `ENDPOINTS` in `@shared/constants`):
 * `GET https://api.curseforge.com/v1/mods/{projectID}/files?gameVersion=…`.
 * Contract gap worth noting: `ModService` has no "file id -> download url" call, so an
 * exact `fileID` can only be found by listing the project's versions and matching
 * `ModFile.versionId`; a pack pinning a file the API no longer lists stays unresolved.
 */
import type { Instance, LoaderId, ModpackImportRequest } from '@shared/types'
import { AppError, invalidInput } from '@shared/errors'
import { openZip, type ZipReader } from '../core/zip'
import type { VersionInstallOutcome } from '../core/contracts'
import {
  CURSE_MANIFEST_NAME,
  OVERRIDES_PREFIX,
  createPackInstance,
  describeLoader,
  downloadItemsFor,
  extractOverrides,
  instanceVersionId,
  localJob,
  manifestOf,
  queuePlan,
  reportUnresolved
} from './common'
import { curseFileEntries, findMember, readTextMember } from './detect'
import type { ImportOutcome, ModpackServiceDeps } from './types'

export interface CurseFileEntry {
  projectID: number
  fileID: number
  required?: boolean
}

export interface CurseIndex {
  member: string
  gameVersion: string
  loader: { id: LoaderId; version: string }
  files: CurseFileEntry[]
  overrides: string
  name: string
  warnings: string[]
}

const CURSE_LOADER_KEYS: { token: string; id: LoaderId }[] = [
  { token: 'neoforge', id: 'neoforge' },
  { token: 'legacy-fabric', id: 'legacy-fabric' },
  { token: 'legacyfabric', id: 'legacy-fabric' },
  { token: 'fabric', id: 'fabric' },
  { token: 'quilt', id: 'quilt' },
  { token: 'optifine', id: 'optifine' },
  { token: 'liteloader', id: 'liteloader' },
  { token: 'cleanroom', id: 'cleanroom' },
  { token: 'forge', id: 'forge' }
]

/** `forge-47.2.0` / `1.20.1-47.2.0` / `neoforge-20.4.70-beta` -> id + version. */
export function loaderFromCurseStrings(values: (string | undefined)[]): { id: LoaderId; version: string } {
  for (const value of values) {
    if (!value) continue
    const text = value.toLowerCase()
    const hit = CURSE_LOADER_KEYS.find((k) => text.includes(k.token))
    if (!hit) continue
    const tail = text.slice(text.indexOf(hit.token) + hit.token.length).replace(/^[^0-9a-zA-Z]*/, '')
    const version = tail.split(/[^0-9a-zA-Z.+-]/)[0] ?? ''
    return { id: hit.id, version }
  }
  return { id: 'vanilla', version: '' }
}

export function parseCurseIndex(text: string, member: string): CurseIndex {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw invalidInput('整合包 manifest.json 不是有效 JSON', `${member}: ${String(error)}`)
  }
  const warnings: string[] = []
  const gameVersion = typeof raw.minecraftVersion === 'string' ? raw.minecraftVersion : ''
  if (gameVersion.length === 0) throw invalidInput('整合包 manifest.json 缺少 minecraftVersion', member)

  const loaderNames: string[] = []
  if (Array.isArray(raw.modLoaders)) {
    for (const item of raw.modLoaders) {
      if (typeof item === 'string') loaderNames.push(item)
      else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        loaderNames.push((item as { id: string }).id)
      }
    }
  }
  if (typeof raw.forgeVersion === 'string') loaderNames.push(raw.forgeVersion)
  const loader = loaderFromCurseStrings(loaderNames)
  if (loader.id === 'vanilla' && loaderNames.length > 0) {
    warnings.push(`无法识别加载器声明「${loaderNames.join(', ')}」，按原版安装`)
  }
  const files = curseFileEntries(text)
  if (files.length === 0) warnings.push('manifest.json 里没有带 projectID/fileID 的条目')

  return {
    member,
    gameVersion,
    loader,
    files,
    overrides: typeof raw.overrides === 'string' && raw.overrides.length > 0 ? raw.overrides.replace(/\/+$/, '') : OVERRIDES_PREFIX,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'CurseForge 整合包',
    warnings
  }
}

/** Opens the pack; the caller closes the reader. */
export async function readCurse(file: string): Promise<{ index: CurseIndex; zip: ZipReader }> {
  const zip = await openZip(file)
  const member = findMember(zip.names(), CURSE_MANIFEST_NAME)
  if (!member) {
    await zip.close().catch(() => undefined)
    throw new AppError('not-found', '整合包缺少 manifest.json', file)
  }
  try {
    return { index: parseCurseIndex(await readTextMember(zip, member), member), zip }
  } catch (error) {
    await zip.close().catch(() => undefined)
    throw error
  }
}

function labelOf(entry: CurseFileEntry): string {
  return `project ${entry.projectID}/file ${entry.fileID}`
}

/**
 * `projectID/fileID` -> a concrete download URL through `ModService`, or undefined.
 * Never throws: the caller keeps a complete "what could not be resolved" list.
 */
async function resolveFile(
  deps: ModpackServiceDeps,
  entry: CurseFileEntry,
  gameVersion: string
): Promise<{ url: string; fileName?: string; sha1?: string; size?: number } | undefined> {
  try {
    const versions = await deps.mods.versions('curseforge', String(entry.projectID), gameVersion)
    for (const version of versions) {
      const file = version.files.find((f) => f.versionId === String(entry.fileID) && f.url.length > 0)
      if (file) {
        return { url: file.url, fileName: file.fileName, sha1: file.hashes.sha1, size: file.size }
      }
    }
    return undefined
  } catch (error) {
    deps.log.warn(`解析 ${labelOf(entry)} 失败: ${String(error)}`)
    return undefined
  }
}

export async function importCurse(deps: ModpackServiceDeps, req: ModpackImportRequest): Promise<ImportOutcome> {
  const log = deps.log.child('modpack.curse')
  const { index, zip } = await readCurse(req.file)
  const key = (deps.settings?.()?.curseForgeApiKey ?? '').trim()
  const manifest = manifestOf(index.name, 'CurseForge', '', index.gameVersion, index.loader, index.files.length)
  const title = `导入整合包 ${index.name}`
  let instance: Instance
  try {
    instance = createPackInstance(deps, {
      name: req.name.length > 0 ? req.name : index.name,
      versionId: index.gameVersion,
      gameVersion: index.gameVersion,
      loader: index.loader.id,
      loaderVersion: index.loader.version.length > 0 ? index.loader.version : undefined,
      description: `导入自 CurseForge 整合包（${describeLoader(index.loader.id, index.loader.version)}）`
    })
    const gameDir = deps.instances.gameDir(instance)
    const overrides = await extractOverrides(zip, gameDir, index.overrides)
    if (overrides.refused.length > 0) log.warn(`忽略了 ${overrides.refused.length} 个越界的 overrides 成员`)

    let versionOutcome: VersionInstallOutcome | undefined
    let versionError: AppError | undefined
    const installRequest: Parameters<typeof deps.versions.install>[0] = { id: index.gameVersion, createInstance: false }
    if (index.loader.id !== 'vanilla' && index.loader.version.length > 0) {
      installRequest.loader = { id: index.loader.id, version: index.loader.version }
    }
    try {
      versionOutcome = await deps.versions.install(installRequest)
    } catch (error) {
      versionError = AppError.from(error, 'network')
      log.error(`版本安装失败，实例 ${instance.id} 已建立: ${versionError.message}`)
    }
    if (versionOutcome) {
      const versionId = instanceVersionId(versionOutcome.versionId, index.gameVersion)
      if (versionId !== instance.versionId) {
        instance = deps.instances.update(instance.id, {
          versionId,
          loader: index.loader.id,
          loaderVersion: index.loader.version.length > 0 ? index.loader.version : undefined
        })
      }
    }

    // No key: nothing is resolvable, so list every entry instead of skipping quietly.
    if (key.length === 0) {
      await zip.close().catch(() => undefined)
      const detail = '在 设置 → 模组源 填写 CurseForge API Key 后重新导入；实例与 overrides 已就绪。'
      const error = versionError
        ? new AppError('unsupported', `未配置 CurseForge API Key，且版本安装失败：${versionError.message}`, detail)
        : new AppError('unsupported', '未配置 CurseForge API Key，无法解析模组文件', detail)
      const job = localJob(title, 'modpack', index.files.length)
      return { job: reportUnresolved(job, error, index.files.map(labelOf), deps), manifest, instance }
    }

    const resolved: { relative: string; url: string; sha1?: string; size?: number; optional?: boolean }[] = []
    const unresolved: string[] = []
    for (const entry of index.files) {
      const found = await resolveFile(deps, entry, index.gameVersion)
      if (!found) {
        unresolved.push(labelOf(entry))
        continue
      }
      resolved.push({
        relative: `mods/${found.fileName ?? `project${entry.projectID}-file${entry.fileID}.jar`}`,
        url: found.url,
        ...(found.sha1 ? { sha1: found.sha1 } : {}),
        ...(typeof found.size === 'number' ? { size: found.size } : {}),
        optional: entry.required === false
      })
    }

    const { items, skipped } = downloadItemsFor(deps.instances.gameDir(instance), resolved)
    for (const bad of skipped) log.warn(`无法落地的路径被跳过：${bad}`)
    const job = items.length > 0 ? await queuePlan(deps.downloader, title, items) : localJob(title, 'modpack', resolved.length)

    await zip.close().catch(() => undefined)
    const problems = [...unresolved]
    if (index.warnings.length > 0) log.warn(index.warnings.join('；'))
    if (problems.length > 0 || versionError) {
      const error = versionError ?? new AppError('unsupported', `有 ${problems.length} 个文件无法从 CurseForge 解析`)
      return { job: reportUnresolved(job, error, problems.length > 0 ? problems : [error.message], deps), manifest, instance }
    }
    return { job, manifest, instance }
  } catch (error) {
    await zip.close().catch(() => undefined)
    throw error
  }
}

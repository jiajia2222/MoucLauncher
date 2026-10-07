/**
 * MultiMC / Prism Launcher instance import (`instance.cfg` + `mmc-pack.json`).
 *
 * What we do: read `IntendedVersion` / `InstanceType` out of `instance.cfg`, copy the
 * whole archive tree (minus launcher scratch dirs) into a new isolated instance dir,
 * make sure the *vanilla* version exists, and register the instance pointing at that
 * version.
 *
 * Limits, stated because they are real:
 * - MultiMC builds its version json itself from `mmc-pack.json` components (Forge /
 *   LiteLoader / OptiFine / custom patches). We do not replay that assembly: if the
 *   pack declares a loader we record it on the instance and log a warning, but the
 *   version json has to be produced by our own LoaderService ("安装加载器") before it
 *   launches.
 * - `InstanceType=SubInstance` / `global` / managed-Java paths point at the source
 *   machine; those keys are read and reported, never applied.
 * - Anything outside the instance dir (a shared/mods folder of the source profile) is
 *   not present in the zip, so it cannot be restored.
 * - ZIP64 archives are rejected by `core/zip`, hence unsupported here too.
 */
import type { Instance, LoaderId, ModpackImportRequest } from '@shared/types'
import { AppError, invalidInput } from '@shared/errors'
import { openZip, type ZipReader } from '../core/zip'
import {
  MULTIMC_INSTANCE_NAME,
  MULTIMC_PACK_NAME,
  createPackInstance,
  describeLoader,
  extractTree,
  loaderIdFromMmcUid,
  localJob,
  manifestOf,
  normalizeMember,
  reportUnresolved
} from './common'
import { findMember, readTextMember } from './detect'
import type { ImportOutcome, ModpackServiceDeps } from './types'

/** Directories that belong to the source launcher, not to the instance. */
const SKIP_TOP_DIRS = ['logs', 'natives', 'versions', 'libraries', 'assets', '.bin', 'MMCTransfer', 'mmc']

export interface MmcComponent {
  uid: string
  version: string
}

export interface MultiMcIndex {
  name: string
  gameVersion: string
  loader: { id: LoaderId; version: string }
  instanceType: string
  memoryMb?: number
  jvmArgs?: string
  javaPath?: string
  components: MmcComponent[]
  /** Prefix inside the archive: MultiMC zips the folder, Prism writes at the root. */
  root: string
  warnings: string[]
}

/** Tiny INI reader: `key=value`, `#`/`;` comments, optional quotes. */
export function parseInstanceCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && /^".*"$/.test(value)) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

export function parseMmcPack(text: string): MmcComponent[] {
  let parsed: { components?: unknown }
  try {
    parsed = JSON.parse(text) as { components?: unknown }
  } catch {
    return []
  }
  const list = Array.isArray(parsed.components) ? parsed.components : []
  const out: MmcComponent[] = []
  for (const item of list) {
    const entry = item as { uid?: unknown; version?: unknown; disabled?: unknown }
    if (typeof entry?.uid !== 'string' || entry.disabled === true) continue
    out.push({ uid: entry.uid, version: typeof entry.version === 'string' ? entry.version : '' })
  }
  return out
}

/** The single top-level folder MultiMC's export produces, `''` when the pack is flat. */
export function archiveRootOf(names: readonly string[], anchor: string): string {
  const direct = names.find((n) => normalizeMember(n) === anchor)
  if (direct !== undefined) return ''
  const depthOne = names.filter((n) => {
    const parts = normalizeMember(n).split('/')
    return parts.length === 2 && parts[1] === anchor
  })
  if (depthOne.length !== 1) return ''
  return normalizeMember(depthOne[0] ?? '').split('/')[0] ?? ''
}

export function buildMultiMcIndex(
  cfg: Record<string, string>,
  components: MmcComponent[],
  root: string
): MultiMcIndex {
  const warnings: string[] = []
  const minecraft = components.find((c) => c.uid.toLowerCase() === 'net.minecraft')
  const gameVersion = cfg.IntendedVersion ?? minecraft?.version ?? ''
  const loaderComponent = components.find((c) => loaderIdFromMmcUid(c.uid) !== undefined && c.uid.toLowerCase() !== 'net.minecraft')
  const loaderId = loaderComponent ? loaderIdFromMmcUid(loaderComponent.uid) ?? 'vanilla' : 'vanilla'
  const instanceType = cfg.InstanceType ?? ''
  if (instanceType.length > 0 && !['oneinstance', 'portable', 'instancelocation'].includes(instanceType.toLowerCase())) {
    warnings.push(`InstanceType=${instanceType}：源机的父子/全局关系无法还原，按独立实例导入`)
  }
  if (gameVersion.length === 0) {
    warnings.push('instance.cfg 与 mmc-pack.json 都没有版本号')
  }
  if (loaderId !== 'vanilla') {
    warnings.push(`源启动器的 ${describeLoader(loaderId, loaderComponent?.version)} 组件不会被重放，请用「安装加载器」补一次`)
  }
  const memory = Number.parseInt(cfg.MaxMemAlloc ?? '', 10)
  return {
    name: cfg.name ?? 'MultiMC 实例',
    gameVersion,
    loader: { id: loaderId, version: loaderComponent?.version ?? '' },
    instanceType,
    components,
    root,
    warnings,
    ...(Number.isFinite(memory) && memory > 0 ? { memoryMb: memory } : {}),
    ...(cfg.JVMArgs ? { jvmArgs: cfg.JVMArgs } : {}),
    ...(cfg.JavaPath ? { javaPath: cfg.JavaPath } : {})
  }
}

export async function readMultiMc(file: string): Promise<{ index: MultiMcIndex; zip: ZipReader }> {
  const zip = await openZip(file)
  const names = zip.names()
  const anchorName = findMember(names, MULTIMC_INSTANCE_NAME) ?? findMember(names, MULTIMC_PACK_NAME)
  if (!anchorName) {
    await zip.close().catch(() => undefined)
    throw new AppError('not-found', '整合包里没有 instance.cfg / mmc-pack.json', file)
  }
  try {
    const cfgText = findMember(names, MULTIMC_INSTANCE_NAME) ? await readTextMember(zip, MULTIMC_INSTANCE_NAME) : ''
    const packText = findMember(names, MULTIMC_PACK_NAME) ? await readTextMember(zip, MULTIMC_PACK_NAME) : ''
    const cfg = parseInstanceCfg(cfgText)
    const components = parseMmcPack(packText)
    const root = archiveRootOf(names, normalizeMember(anchorName))
    const index = buildMultiMcIndex(cfg, components, root)
    if (index.gameVersion.length === 0) throw invalidInput('无法确定 MultiMC 实例的 Minecraft 版本', anchorName)
    return { index, zip }
  } catch (error) {
    await zip.close().catch(() => undefined)
    throw error
  }
}

/** Members of the pack tree that should not be copied into an instance dir. */
function shouldSkip(relative: string): boolean {
  const first = relative.split('/')[0]?.toLowerCase() ?? ''
  return SKIP_TOP_DIRS.includes(first)
}

export async function importMultiMc(deps: ModpackServiceDeps, req: ModpackImportRequest): Promise<ImportOutcome> {
  const log = deps.log.child('modpack.multimc')
  const { index, zip } = await readMultiMc(req.file)
  let instance: Instance
  try {
    instance = createPackInstance(deps, {
      name: req.name.length > 0 ? req.name : index.name,
      versionId: index.gameVersion,
      gameVersion: index.gameVersion,
      loader: index.loader.id,
      loaderVersion: index.loader.version.length > 0 ? index.loader.version : undefined,
      description: `导入自 MultiMC/Prism 实例（${describeLoader(index.loader.id, index.loader.version)}）`
    })
    const gameDir = deps.instances.gameDir(instance)

    // The whole tree, prefix stripped: `mods/`, `config/`, `saves/`, `instance.cfg`…
    // `instance.cfg` stays as plain data; our own marker is `.mouc-instance.json`.
    const copied = await extractTree(zip, gameDir, index.root, shouldSkip)
    if (copied.refused.length > 0) {
      log.warn(`忽略了 ${copied.refused.length} 个越界成员：${copied.refused.slice(0, 5).join(', ')}`)
    }

    const installed = await deps.versions.installed().catch(() => [] as string[])
    let jobError: AppError | undefined
    if (!installed.includes(index.gameVersion)) {
      try {
        await deps.versions.install({ id: index.gameVersion, createInstance: false })
      } catch (error) {
        jobError = AppError.from(error, 'network')
        log.error(`原版版本 ${index.gameVersion} 安装失败: ${jobError.message}`)
      }
    }

    await zip.close().catch(() => undefined)
    for (const warning of index.warnings) log.warn(warning)
    const title = `导入整合包 ${index.name}（MultiMC）`
    const job = localJob(title, 'modpack', copied.written.length)
    const problems = [...index.warnings]
    if (jobError) problems.unshift(`版本安装：${jobError.message}`)
    if (problems.length > 0) {
      return {
        job: reportUnresolved(job, jobError ?? new AppError('unsupported', 'MultiMC 组件未完全还原', problems.join('；')), problems, deps),
        manifest: manifestOf(index.name, 'MultiMC', '', index.gameVersion, index.loader, copied.written.length),
        instance
      }
    }
    return {
      job,
      manifest: manifestOf(index.name, 'MultiMC', '', index.gameVersion, index.loader, copied.written.length),
      instance
    }
  } catch (error) {
    await zip.close().catch(() => undefined)
    throw error
  }
}

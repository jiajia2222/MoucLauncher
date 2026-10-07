/**
 * Turns a ResolvedVersion + launch context into the final argv.
 * Rule filtering uses `utils.activeArgs`; the classpath is built from the resolved
 * libraries with the vanilla jar pinned last; every documented `${placeholder}` is
 * substituted through one table.
 */
import path from 'node:path'
import { SUPPORTED_FEATURES } from '@shared/constants'
import type { Library, PathInfo, ResolvedVersion } from '@shared/types'
import {
  activeArgs,
  libraryFiles,
  mavenPath,
  parseMaven,
  rulesMatch,
  type LibraryFile,
  type RuleContext
} from '@shared/utils'
import { libraryPath, nativesDir as defaultNativesDir } from '../core/paths'
import { virtualAssetsDir } from './assets'

export const LAUNCHER_NAME = 'MoucLauncher'

/** `-Dlog4j.configurationFile` target for `logging.client.file`. */
export function loggingClientPath(paths: PathInfo, id = 'client'): string {
  return path.join(paths.librariesDir, 'mouc', 'logging', `${id}.xml`)
}

function mapArch(arch: string): 'x64' | 'x86' | 'arm64' | 'unknown' {
  switch (arch) {
    case 'x64':
      return 'x64'
    case 'ia32':
      return 'x86'
    case 'arm64':
      return 'arm64'
    default:
      return 'unknown'
  }
}

/** This launcher only ever runs on Windows (project scope), but rules still filter. */
export function osRuleContext(features: Record<string, boolean>, arch: string = process.arch): RuleContext {
  return { osName: 'windows', osArch: mapArch(arch), features }
}

/**
 * `utils.libraryFiles` plus a fallback for pre-1.6 libraries that carry only a maven
 * `name` (no `downloads` block): the jar is derived from the coordinate + libraries base.
 */
export function plannedLibraryFiles(lib: Library, ctx: RuleContext, librariesDir: string): LibraryFile[] {
  const planned = libraryFiles(lib, ctx, librariesDir).map((file) => {
    // `utils.libraryFiles` drops the main artifact once a natives classifier exists;
    // the artifact jar still carries the classes, so it must stay on the classpath.
    if (!file.isNative && !file.onClasspath) return { ...file, onClasspath: true }
    return file
  })
  if (planned.length > 0 || lib.downloads) return planned
  if (!rulesMatch(lib.rules, ctx)) return []
  const coord = parseMaven(lib.name)
  if (!coord) return []
  const nativeKey = lib.natives?.windows
  const nativeName = nativeKey ? nativeKey.replace('${arch}', ctx.osArch === 'x86' ? '32' : '64') : undefined
  const rel = mavenPath(nativeName ? `${coord.group}:${coord.artifact}:${coord.version}:${nativeName}` : lib.name)
  if (!rel) return []
  const file: LibraryFile = {
    relativePath: rel,
    url: `${librariesDir.replace(/\/$/, '')}/${rel}`,
    onClasspath: !nativeName,
    isNative: Boolean(nativeName),
    exclude: lib.extract?.exclude
  }
  return [file]
}

export interface Resolution {
  width: number
  height: number
  fullscreen: boolean
}

/**
 * `SUPPORTED_FEATURES` plus `hasCustomResolution`, which is only true when the user
 * actually changed the width/height away from the settings default.
 */
export function launcherFeatures(resolution: Resolution, defaultResolution: Resolution): Record<string, boolean> {
  const changed =
    resolution.width !== defaultResolution.width || resolution.height !== defaultResolution.height
  return { ...SUPPORTED_FEATURES, hasCustomResolution: changed }
}

/** Classpath entries (libraries only, this OS, no natives) in json order, deduped by resolved path. */
export function libraryClasspath(resolved: ResolvedVersion, paths: PathInfo, ctx: RuleContext): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (file: string): void => {
    const key = path.resolve(file)
    if (seen.has(key)) return
    seen.add(key)
    out.push(file)
  }
  for (const lib of resolved.libraries) {
    for (const file of plannedLibraryFiles(lib, ctx, paths.librariesDir)) {
      if (!file.onClasspath) continue
      add(libraryPath(paths, file.relativePath))
    }
  }
  return out
}

/**
 * Absolute paths of the native classifier jars (the files that get unpacked into
 * the natives dir). Used by install/launch to call `ensureNatives`.
 */
export function nativeJarFiles(
  resolved: ResolvedVersion,
  paths: PathInfo,
  ctx: RuleContext
): { file: string; exclude?: string[] }[] {
  const out: { file: string; exclude?: string[] }[] = []
  const seen = new Set<string>()
  for (const lib of resolved.libraries) {
    for (const file of plannedLibraryFiles(lib, ctx, paths.librariesDir)) {
      if (!file.isNative) continue
      const abs = libraryPath(paths, file.relativePath)
      const key = path.resolve(abs)
      if (seen.has(key)) continue
      seen.add(key)
      const entry: { file: string; exclude?: string[] } = { file: abs }
      if (lib.extract?.exclude) entry.exclude = lib.extract.exclude
      out.push(entry)
    }
  }
  return out
}

export interface AccountPlaceholders {
  name: string
  /** With or without dashes; the table always strips them. */
  uuid: string
  token: string
  /** 'Mojang' for microsoft, 'legacy' for offline. */
  userType: string
  xuid?: string
  clientId?: string
}

export interface PlaceholderContext {
  resolved: ResolvedVersion
  paths: PathInfo
  account: AccountPlaceholders
  gameDir: string
  versionName: string
  resolution: Resolution
  /** Library classpath entries; `buildArguments` appends the vanilla jar as the last one. */
  classpath: string[]
  /** True when the asset index maps to resources (old `map_to_resources` indexes). */
  virtualAssets: boolean
  nativesDirectory: string
  launcherVersion?: string
}

/** The full placeholder table; keys are the `${...}` names used by Mojang argument lists. */
export function placeholderTable(ctx: PlaceholderContext): Record<string, string> {
  const { resolved } = ctx
  const indexId = resolved.assetIndex?.id ?? resolved.assetsVersion
  const joinedClasspath = `"${ctx.classpath.join(';')}"`
  const table: Record<string, string> = {
    auth_player_name: ctx.account.name,
    version_name: ctx.versionName,
    game_directory: ctx.gameDir,
    assets_root: ctx.paths.assetsDir,
    // Virtual (named) asset tree for `map_to_resources` indexes, hashed objects otherwise.
    game_assets: ctx.virtualAssets
      ? virtualAssetsDir(ctx.paths, indexId)
      : path.join(ctx.paths.assetsDir, 'objects'),
    assets_index_name: indexId,
    auth_uuid: ctx.account.uuid.replace(/-/g, ''),
    auth_access_token: ctx.account.token,
    // 1.5-era jsons reference ${auth_session}; it is the same token for our accounts.
    auth_session: ctx.account.token,
    clientid: ctx.account.clientId ?? '',
    auth_xuid: ctx.account.xuid ?? '',
    user_type: ctx.account.userType,
    user_properties: '{}',
    version_type: resolved.type,
    resolution_width: String(ctx.resolution.width),
    resolution_height: String(ctx.resolution.height),
    natives_directory: ctx.nativesDirectory,
    classpath: joinedClasspath,
    launcher_name: LAUNCHER_NAME,
    launcher_version: ctx.launcherVersion ?? '1.0.0',
    // `-Dlog4j.configurationFile=${path}` from logging.client.argument.
    path: resolved.logging?.client?.file
      ? loggingClientPath(ctx.paths, resolved.logging.client.file.id ?? 'client')
      : ''
  }
  return table
}

export function substitute(token: string, table: Record<string, string>): string {
  return token.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key: string) => table[key] ?? match)
}

/** Quoting used for the displayed command line and the `@argfile` lines. */
export function quoteArg(arg: string): string {
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length > 1) return arg
  return `"${arg}"`
}

/** Default natives directory for a version. */
export function nativesFor(resolved: ResolvedVersion, paths: PathInfo): string {
  return defaultNativesDir(paths, resolved.id)
}

export interface ArgumentBuildContext extends PlaceholderContext {
  /** Computed with `launcherFeatures(resolution, defaultResolution)`; required so the
   *  caller cannot accidentally evaluate rules with the wrong feature flags. */
  features: Record<string, boolean>
  /** Free-form tokens appended after the json JVM args (memory, user extras). */
  extraJvmArgs?: string[]
  /** Free-form tokens appended after the json game args (user extras, quickPlay). */
  extraGameArgs?: string[]
  /** Rule context override; defaults to windows + given features. */
  ruleArch?: string
}

export interface BuiltArguments {
  /** Everything before the main class. */
  jvmArgs: string[]
  /** Everything after the main class. */
  gameArgs: string[]
  mainClass: string
  /** Full classpath including the vanilla jar as the last entry. */
  classpath: string[]
}

/** Classic JVM argument set for pre-`arguments` jsons (1.5 and older). */
export const CLASSIC_JVM_ARGS = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}']

/** Dedupe by resolved path, then pin `vanillaJar` as the last classpath entry. */
export function finalizeClasspath(libraryEntries: string[], vanillaJar: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of [...libraryEntries, vanillaJar]) {
    const key = path.resolve(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  const jarKey = path.resolve(vanillaJar)
  const idx = out.findIndex((entry) => path.resolve(entry) === jarKey)
  if (idx >= 0 && idx !== out.length - 1) {
    const [jar] = out.splice(idx, 1)
    if (jar) out.push(jar)
  }
  return out
}

export function buildArguments(ctx: ArgumentBuildContext): BuiltArguments {
  const { resolved } = ctx
  const ruleCtx = osRuleContext(ctx.features, ctx.ruleArch)

  // `ctx.classpath` carries the library entries; the vanilla jar is always last.
  const classpath = finalizeClasspath(ctx.classpath, resolved.clientJarPath)
  const table = placeholderTable({ ...ctx, classpath })
  const subst = (token: string): string => substitute(token, table)

  // Legacy jsons (1.5-) have no `arguments.jvm`: use the classic library-path/cp set.
  let jvmArgs =
    resolved.jvmArgs.length > 0
      ? activeArgs(resolved.jvmArgs, ruleCtx).map(subst)
      : CLASSIC_JVM_ARGS.map(subst)

  const logArgument = resolved.logging?.client?.argument
  if (logArgument && !jvmArgs.some((a) => a.includes('-Dlog4j.configurationFile'))) {
    jvmArgs = [...jvmArgs, subst(logArgument)]
  }
  if (ctx.extraJvmArgs && ctx.extraJvmArgs.length > 0) jvmArgs = [...jvmArgs, ...ctx.extraJvmArgs]

  const gameArgs = [...activeArgs(resolved.gameArgs, ruleCtx).map(subst), ...(ctx.extraGameArgs ?? [])]

  return { jvmArgs, gameArgs, mainClass: resolved.mainClass, classpath }
}

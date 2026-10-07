/**
 * Forge / NeoForge installer handling.
 *
 * Real installers (verified by downloading 1.21.1-52.1.0 and 1.20.1-47.1.106 archives)
 * use `spec: 1` bootstrap format:
 *   install_profile.json -> { spec, version, path, minecraft, data, processors,
 *                             libraries, json: "/version.json" }
 * The version json is a *member* of the installer zip (referenced by `json`), NOT
 * inlined. 1.13-1.16 installers inline it as `versionInfo`; both are supported.
 *
 * `libraries[].downloads.artifact` already carries an absolute url in every sample, but
 * a coordinate-only entry resolves through the provider repos below.
 */
import path from 'node:path'
import { ENDPOINTS, OFFICIAL_HOSTS } from '@shared/constants'
import type { DownloadItem, Library, RawVersionJson } from '@shared/types'
import { mavenPath, parseMaven } from '@shared/utils'
import type {
  ExecRunner,
  ForgeInstallProfile,
  ForgeProfileLibrary,
  ForgeProcessor,
  LoaderPlan,
  ProcessorCommand,
  ProcessorContext
} from './types'

/** groupId prefix -> Maven repo base, used only when a library has no `downloads`. */
export function repoForCoord(name: string): string {
  if (name.startsWith('net.neoforged')) return ENDPOINTS.neoforgeMaven
  if (name.startsWith('com.mojang') || name.startsWith('net.minecraft')) {
    return `https://${OFFICIAL_HOSTS.libraries}`
  }
  return ENDPOINTS.forgeMaven
}

interface ResolvedArtifact {
  rel: string
  url: string
  sha1?: string
  size?: number
}

/** Resolves one forge/neoforge library entry (either download shape) to a fetchable file. */
export function resolveLibraryArtifact(lib: ForgeProfileLibrary | Library): ResolvedArtifact | undefined {
  const artifact = lib.downloads?.artifact
  if (artifact?.path) {
    const resolved: ResolvedArtifact = { rel: artifact.path, url: artifact.url }
    if (artifact.sha1) resolved.sha1 = artifact.sha1
    if (typeof artifact.size === 'number') resolved.size = artifact.size
    return resolved
  }
  const rel = mavenPath(lib.name)
  const coord = parseMaven(lib.name)
  if (!rel || !coord) return undefined
  const base = (lib as ForgeProfileLibrary).url ? (lib as ForgeProfileLibrary).url!.replace(/\/$/, '') : repoForCoord(lib.name)
  return { rel, url: `${base}/${rel}` }
}

function libraryItem(lib: ForgeProfileLibrary | Library, libraryDir: string): DownloadItem | undefined {
  const resolved = resolveLibraryArtifact(lib)
  if (!resolved) return undefined
  const target = path.join(libraryDir, resolved.rel)
  const item: DownloadItem = {
    id: target,
    url: resolved.url,
    target,
    kind: 'library',
    label: path.basename(resolved.rel)
  }
  if (resolved.sha1) item.sha1 = resolved.sha1
  if (resolved.size !== undefined) item.size = resolved.size
  return item
}

function dedupeByTarget(items: DownloadItem[]): DownloadItem[] {
  const map = new Map<string, DownloadItem>()
  for (const item of items) if (!map.has(item.target)) map.set(item.target, item)
  return [...map.values()]
}

/**
 * Turns (install_profile.json + embedded version.json) into a loader plan: the version
 * json to write plus every library download the loader and the version json reference.
 * The installer archive itself is downloaded separately by the service.
 */
export function planFromProfile(
  profile: ForgeInstallProfile,
  versionJson: RawVersionJson,
  ctx: Pick<ProcessorContext, 'libraryDir'>
): LoaderPlan {
  const items: DownloadItem[] = []
  for (const lib of versionJson.libraries ?? []) {
    const item = libraryItem(lib as ForgeProfileLibrary, ctx.libraryDir)
    if (item) items.push(item)
  }
  for (const lib of profile.libraries ?? []) {
    const item = libraryItem(lib, ctx.libraryDir)
    if (item) items.push(item)
  }
  return { versionId: versionJson.id, versionJson, items: dedupeByTarget(items) }
}

/** Picks the `{client,server}` value for a side and normalises brackets/quotes. */
function sidedValue(value: unknown, side: 'client' | 'server'): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const map = value as Record<string, string>
    return map[side] ?? map.client
  }
  return undefined
}

/** Resolves a raw data value to the filesystem path a processor expects. */
export function resolveDataToken(raw: string | undefined, ctx: ProcessorContext): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  // `[net.foo:bar:1.0:classifier]` -> library path.
  const coord = trimmed.match(/^\[(.+)\]$/)
  if (coord?.[1]) {
    const rel = mavenPath(coord[1])
    return rel ? path.join(ctx.libraryDir, rel) : undefined
  }
  // `/data/client.lzma` -> a member inside the installer archive.
  if (trimmed.startsWith('/')) return `${ctx.installer}!${trimmed}`
  // `'sha1'` -> the quoted scalar as-is (used for `outputs` verification).
  return trimmed
}

/**
 * Builds the token map every `{PLACEHOLDER}` in a processor's args resolves against.
 * Provider data keys take priority so `{MOJMAPS}` etc. resolve; then the fixed set
 * the brief calls out: {ROOT}, {MINECRAFT_JAR}, {INSTALLER}, {SIDE}, {MINECRAFT_JAVA},
 * {MINECRAFT_VERSION}, {LIBRARY_DIR}, {MCP_VERSION}.
 */
export function buildTokenMap(profile: ForgeInstallProfile, ctx: ProcessorContext): Record<string, string> {
  const side = ctx.side ?? 'client'
  const map: Record<string, string> = {
    ROOT: ctx.root,
    INSTALLER: ctx.installer,
    MINECRAFT_JAR: ctx.minecraftJar,
    MINECRAFT_JAVA: ctx.java,
    JAVA: ctx.java,
    SIDE: side,
    MINECRAFT_VERSION: ctx.minecraftVersion,
    LIBRARY_DIR: ctx.libraryDir,
    MAVEN_REPO: repoForCoord(profile.path ?? '')
  }
  for (const [key, value] of Object.entries(profile.data ?? {})) {
    const scalar = sidedValue(value, side)
    if (scalar === undefined) continue
    // SHA/ver scalars keep their quotes for output verification; coord/path values map to files.
    const bare = scalar.replace(/^'(.*)'$/, '$1')
    if (/^[a-f0-9]{40}$/i.test(bare)) map[key] = bare
    else {
      const resolved = resolveDataToken(scalar, ctx)
      if (resolved) map[key] = resolved
    }
  }
  if (ctx.mcpVersion && map.MCP_VERSION === undefined) map.MCP_VERSION = ctx.mcpVersion
  return map
}

/** Substitutes `{TOKEN}` occurrences; unknown tokens are left intact so tools can expand them. */
export function substituteTokens(input: string, tokens: Record<string, string>): string {
  return input.replace(/\{([A-Z0-9_]+)\}/g, (whole, name: string) => tokens[name] ?? whole)
}

function processorJar(p: ForgeProcessor): string {
  return p.jar ?? p.maven ?? ''
}

/** Joins the processor's jar + classpath coordinates into absolute library paths. */
export function processorClasspath(p: ForgeProcessor, tokens: Record<string, string>, ctx: ProcessorContext): string[] {
  const coords = [processorJar(p), ...(p.classpath ?? [])].filter(Boolean)
  const out: string[] = []
  for (const coord of coords) {
    const rel = mavenPath(coord)
    if (rel) out.push(path.join(ctx.libraryDir, rel))
  }
  void tokens
  return out
}

/**
 * Constructs the fully-resolved processor commands for one side (we always run client).
 * Pure: performs no process spawn. `runProcessors` feeds these to the injected runner.
 */
export function buildProcessorCommands(
  profile: ForgeInstallProfile,
  versionJson: RawVersionJson,
  ctx: ProcessorContext
): ProcessorCommand[] {
  const side = ctx.side ?? 'client'
  const tokens = buildTokenMap(profile, ctx)
  const stdinPayload = buildStdinPayload(profile, versionJson, ctx, tokens)
  const commands: ProcessorCommand[] = []
  for (const p of profile.processors ?? []) {
    if (p.sides && !p.sides.includes(side)) continue
    const args = (p.args ?? []).map((a) => substituteTokens(a, tokens))
    const classpath = processorClasspath(p, tokens, ctx).join(path.delimiter)
    const jar = processorJar(p)
    const main = p.main ?? `${jar}#Main-Class`
    commands.push({
      jar,
      java: ctx.java,
      classpath,
      main: substituteTokens(main, tokens),
      args,
      stdin: stdinPayload
    })
  }
  return commands
}

/** The JSON object legacy processors read from stdin (`data/root/side/minecraft_jar/...`). */
export function buildStdinPayload(
  profile: ForgeInstallProfile,
  versionJson: RawVersionJson,
  ctx: ProcessorContext,
  tokens: Record<string, string>
): string {
  const side = ctx.side ?? 'client'
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(profile.data ?? {})) {
    if (tokens[key] !== undefined) data[key] = tokens[key]!
    else {
      const scalar = sidedValue(value, side)
      if (scalar !== undefined) data[key] = scalar
    }
  }
  return JSON.stringify(
    {
      data,
      root: ctx.root,
      side,
      name: profile.profile,
      maven: profile.path,
      version: profile.version,
      minecraft: ctx.minecraftVersion,
      java: ctx.java,
      minecraft_jar: ctx.minecraftJar,
      libraries: ctx.libraryDir,
      mainJar: versionJson.id
    },
    null,
    2
  )
}

/**
 * Runs every client-side processor through the injected exec runner. Never spawns java
 * itself; tests pass a recording stub. Returns the version json processors may have
 * rewritten (identity here — rewriting is the tool's job via the files it emits).
 */
export async function runProcessors(
  profile: ForgeInstallProfile,
  versionJson: RawVersionJson,
  ctx: ProcessorContext,
  exec: ExecRunner
): Promise<RawVersionJson> {
  const commands = buildProcessorCommands(profile, versionJson, ctx)
  for (const command of commands) await exec(command)
  return versionJson
}

/** True when this installer can be handled without running legacy `<install>` scripts. */
export function isProcessable(profile: ForgeInstallProfile): boolean {
  return Array.isArray(profile.processors) && profile.processors.length > 0 &&
    (Boolean(profile.json) || Boolean(profile.versionInfo))
}

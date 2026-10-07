/**
 * Wire shapes for the loader providers. Every field name here was read from a live
 * response captured in `tests/fixtures/loader/` on 2026-10-07; nothing is guessed.
 */
import type { DownloadItem, RawVersionJson } from '@shared/types'

/* ---------------------------------------------------------------- */
/* Fabric / Quilt / Legacy-Fabric meta (v2/v3 share this shape)      */
/* ---------------------------------------------------------------- */

export interface FabricLikeLibrary {
  /** Maven coordinate `group:artifact:version`. */
  name: string
  /** Base URL of the Maven repo this artifact lives in. */
  url?: string
  md5?: string
  sha1?: string
  sha256?: string
  sha512?: string
  size?: number
}

/** One loader build for a game version, as returned by the `.../loader/{game}` list. */
export interface FabricLoaderEntry {
  loader: { version: string; maven: string; build?: number; stable?: boolean; separator?: string }
  intermediary: { version: string; maven: string; stable?: boolean }
  launcherMeta?: unknown
}

/** The full version JSON served by `.../loader/{game}/{loader}/profile/json`. */
export interface LoaderProfileJson extends RawVersionJson {
  libraries?: FabricLikeLibrary[]
}

/* ---------------------------------------------------------------- */
/* Forge / NeoForge installer `install_profile.json` (spec 1)        */
/* ---------------------------------------------------------------- */

/**
 * `install_profile.json` as it really is on 1.17+ installers. Note the task brief
 * mentioned a `versionInfo` field: the modern bootstrap format does NOT inline the
 * version json, it points at a zip member through `json` (`"/version.json"`).
 * Older installers (1.13-1.16) DO inline `versionInfo`; both are handled.
 */
export interface ForgeProfileLibrary {
  name: string
  downloads?: {
    artifact?: { path: string; url: string; sha1?: string; size?: number }
    classifiers?: Record<string, { path: string; url: string; sha1?: string; size?: number }>
  }
  url?: string
}

/** A `{client,server}` value: a maven coord in `[]`, an archive path, or a quoted hash. */
export type SidedData = Record<'client' | 'server', string>

export interface ForgeProcessor {
  /** Restrict to one side; absent means both. */
  sides?: Array<'client' | 'server'>
  /** Maven coordinate of the executable jar (its MANIFEST Main-Class is the entry). */
  jar: string
  /** Additional maven coordinates placed on the classpath ahead of `jar`. */
  classpath?: string[]
  /** CLI arguments; may contain `{TOKEN}` placeholders. */
  args?: string[]
  /** Output token -> expected sha1 token (the tool writes the file at the token path). */
  outputs?: Record<string, string>
  /** Legacy (pre-1.17) processors used `main`/`maven` instead of `jar`. */
  main?: string
  maven?: string
}

export interface ForgeInstallProfile {
  spec?: number
  profile?: string
  /** Full forge version id, e.g. `1.21.1-forge-52.1.0`. */
  version: string
  /** Maven coordinate of the loader artifact (`net.minecraftforge:forge:1.21.1-52.1.0:shim`). */
  path?: string
  /** Minecraft version this installer targets. */
  minecraft: string
  serverJarPath?: string
  data?: Record<string, SidedData | string>
  processors?: ForgeProcessor[]
  libraries?: ForgeProfileLibrary[]
  /** Path of the version json inside the installer archive (`"/version.json"`). */
  json?: string
  /** Older installers inline the version json instead of pointing at a member. */
  versionInfo?: RawVersionJson
  icon?: string
  logo?: string
  mirrorList?: string
  welcome?: string
}

/* ---------------------------------------------------------------- */
/* Plan results                                                      */
/* ---------------------------------------------------------------- */

export interface LoaderPlan {
  /** The version id we write under `<versionsDir>/<id>/<id>.json`. */
  versionId: string
  /** JSON content of the version file. */
  versionJson: RawVersionJson
  /** Files to fetch before the loader is usable. */
  items: DownloadItem[]
}

export interface ProcessorContext {
  /** Where libraries live (absolute). */
  libraryDir: string
  /** The instance game dir (`{ROOT}`). */
  root: string
  /** Absolute path of the vanilla client jar (`{MINECRAFT_JAR}`). */
  minecraftJar: string
  /** Absolute path of the downloaded installer archive (`{INSTALLER}`). */
  installer: string
  /** Java executable used to run the processors (`{MINECRAFT_JAVA}`). */
  java: string
  /** Minecraft version (`{MINECRAFT_VERSION}`). */
  minecraftVersion: string
  /** Only processors matching this side run; we always launch the client. */
  side?: 'client' | 'server'
  /** Maven coordinate of the loader (`{MINECRAFT_NVERSION}` / `{MCP_VERSION}` helpers). */
  mcpVersion?: string
}

/** One fully-substituted processor invocation. */
export interface ProcessorCommand {
  /** The processor jar coordinate, for logging. */
  jar: string
  java: string
  /** Absolute, `path`-separator-joined classpath (already-downloaded library files). */
  classpath: string
  /** Entry class; read from the jar MANIFEST when available, otherwise a placeholder. */
  main: string
  /** Tokens substituted for absolute paths / scalars. */
  args: string[]
  /** The JSON payload the legacy processor protocol feeds on stdin. */
  stdin: string
}

/** Injectable exec runner — never touches `java` in tests. */
export type ExecRunner = (command: ProcessorCommand) => Promise<void>

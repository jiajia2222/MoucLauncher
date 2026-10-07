/**
 * Reads provenance out of an installed mod jar, in loader order:
 *   fabric.mod.json -> quilt.mod.json -> META-INF/mods.toml -> mcmod.info
 * Uses `core/zip.openZip` so we only inflate the single small descriptor member from a
 * possibly-hundreds-of-MB jar. Anything that does not parse still yields an empty result;
 * the caller keeps the file listed by `fileName`.
 */
import type { LoaderId } from '@shared/types'
import { openInstallerZip } from '../loader/installerZip'

export interface ParsedModMetadata {
  modId?: string
  name?: string
  version?: string
  description?: string
  loader?: LoaderId
  gameVersions?: string[]
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseFabricModJson(text: string): ParsedModMetadata | undefined {
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const out: ParsedModMetadata = { loader: 'fabric' }
    const id = asString(json.id)
    if (id) out.modId = id
    const version = asString(json.version)
    if (version) out.version = version
    const name = asString(json.name)
    if (name) out.name = name
    const description = asString(json.description)
    if (description) out.description = description
    return out
  } catch {
    return undefined
  }
}

function parseQuiltModJson(text: string): ParsedModMetadata | undefined {
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    // Quilt nests the descriptor under `quilt_mod`; some jars keep it top-level.
    const nested = (json.quilt_mod ?? json) as Record<string, unknown>
    const metadata = (nested.metadata ?? {}) as Record<string, unknown>
    const out: ParsedModMetadata = { loader: 'quilt' }
    const id = asString(nested.id)
    if (id) out.modId = id
    const version = asString(nested.version)
    if (version) out.version = version
    const name = asString(metadata.name)
    if (name) out.name = name
    const description = asString(metadata.description)
    if (description) out.description = description
    return out
  } catch {
    return undefined
  }
}

/** `mods.toml` is Java-side TOML; we regex out the three scalar keys we care about. */
function parseModsToml(text: string): ParsedModMetadata | undefined {
  // A jar can list several `[[mods]]` / `[[dependencies.*]]` blocks, each with its own
  // modId; anchor on the first `[[mods]]` block so we don't pick up a dependency id.
  const block = text.match(/\[\[mods\]\]([\s\S]*?)(?=\[\[|$)/)
  const scope = block ? block[1] ?? '' : text
  const modId = scope.match(/^\s*modId\s*=\s*"([^"]+)"/m)?.[1]
  const version = scope.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
  const displayName = scope.match(/^\s*displayName\s*=\s*"([^"]+)"/m)?.[1]
  const description = scope.match(/^\s*description\s*=\s*"([^"]+)"/m)?.[1]
  if (!modId && !displayName) return undefined
  const loader: LoaderId = /neoforge/i.test(text) ? 'neoforge' : 'forge'
  const out: ParsedModMetadata = { loader }
  if (modId) out.modId = modId
  if (version) out.version = version
  if (displayName) out.name = displayName
  if (description) out.description = description
  return out
}

function parseMcmodInfo(text: string): ParsedModMetadata | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (!first || typeof first !== 'object') return undefined
    const json = first as Record<string, unknown>
    const out: ParsedModMetadata = { loader: 'forge' }
    const modId = asString(json.modid)
    if (modId) out.modId = modId
    const version = asString(json.version)
    if (version) out.version = version
    const name = asString(json.name)
    if (name) out.name = name
    const description = asString(json.description)
    if (description) out.description = description
    const mcversion = asString(json.mcversion)
    if (mcversion) out.gameVersions = [mcversion]
    return out
  } catch {
    return undefined
  }
}

/** Opens the jar and tries each descriptor in turn. Never throws on unreadable entries. */
export async function readModMetadata(file: string): Promise<ParsedModMetadata> {
  let zip: Awaited<ReturnType<typeof openInstallerZip>>
  try {
    zip = await openInstallerZip(file)
  } catch {
    return {}
  }
  try {
    const tries: Array<[string, (text: string) => ParsedModMetadata | undefined]> = [
      ['fabric.mod.json', parseFabricModJson],
      ['quilt.mod.json', parseQuiltModJson],
      ['META-INF/mods.toml', parseModsToml],
      ['mcmod.info', parseMcmodInfo]
    ]
    for (const [member, parser] of tries) {
      if (!zip.has(member)) continue
      const text = (await zip.read(member)).toString('utf8')
      const parsed = parser(text)
      if (parsed) return parsed
    }
    return {}
  } finally {
    await zip.close().catch(() => undefined)
  }
}

/** Exported so the TOML/Fabric parsers can be unit-tested without a real jar. */
export const __parsers = { parseFabricModJson, parseQuiltModJson, parseModsToml, parseMcmodInfo }

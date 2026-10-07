/**
 * Native jar extraction. Signatures and the multi-release block must never land in
 * the natives dir (Java SecurityException from signed jars on the library path),
 * so `META-INF/*.SF|*.DSA|*.RSA` and `META-INF/versions/` are skipped, together
 * with each library's own `extract.exclude` globs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'
import type { PathInfo } from '@shared/types'
import { ensureDir } from '../core/fsx'
import { nativesDir } from '../core/paths'
import { openZip, unzipAll } from '../core/zip'

export const NATIVES_MARKER = '.mouc.marker'

const SIGNED_ENTRY = /META-INF\/.*\.(SF|DSA|RSA)$/i
const VERSIONS_BLOCK = /META-INF\/versions\//i

/** Converts a Mojang extract-exclude glob ("META-INF/*") into a matcher. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export function shouldSkipNativeEntry(name: string, exclude: string[] = []): boolean {
  if (SIGNED_ENTRY.test(name)) return true
  if (VERSIONS_BLOCK.test(name)) return true
  const posix = name.replace(/\\/g, '/')
  for (const pattern of exclude) {
    if (/[*?]/.test(pattern)) {
      if (globToRegExp(pattern).test(posix)) return true
      continue
    }
    // Mojang uses plain names ("META-INF") to mean "this whole directory".
    const base = pattern.replace(/\/+$/, '')
    if (posix === base || posix.startsWith(`${base}/`)) return true
  }
  return false
}

function markerFile(dir: string): string {
  return path.join(dir, NATIVES_MARKER)
}

/** Re-extract when the jar changed after our marker was written. */
export function needsReextract(jarFile: string, dir: string): boolean {
  try {
    const marker = fs.statSync(markerFile(dir))
    const jar = fs.statSync(jarFile)
    // utimes is not millisecond-accurate on every filesystem; treat "within 1s" as fresh.
    return jar.mtimeMs - marker.mtimeMs > 1_000
  } catch {
    return true
  }
}

function touchMarker(dir: string, when: number): void {
  const marker = markerFile(dir)
  fs.writeFileSync(marker, `mouc-natives ${new Date(when).toISOString()}\n`, 'utf8')
  // Pin the marker to the jar's mtime so "newer than marker" stays truthful.
  try {
    fs.utimesSync(marker, new Date(when), new Date(when))
  } catch {
    /* best effort; a fresh marker is still newer than any old jar */
  }
}

/** Extracts one native jar into `dir` honouring the library excludes. Returns written paths. */
export async function extractNativeJar(
  jarFile: string,
  dir: string,
  exclude: string[] = []
): Promise<string[]> {
  if (!fs.existsSync(jarFile)) throw new AppError('not-found', '本地化 jar 不存在', jarFile)
  if (!needsReextract(jarFile, dir)) return []
  await ensureDir(dir)

  const shouldSkip = (name: string): boolean => shouldSkipNativeEntry(name, exclude)
  const writeEntry = async (name: string, data: Uint8Array): Promise<string | undefined> => {
    if (name.endsWith('/') || /^[a-z]:|^\//.test(name)) return undefined
    if (shouldSkip(name)) return undefined
    const target = path.join(dir, name)
    // Directory traversal guard: a crafted jar must not write outside `dir`.
    const rel = path.relative(path.resolve(dir), path.resolve(target))
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    return target
  }

  const written: string[] = []
  try {
    const zip = await openZip(jarFile)
    try {
      for (const file of await zip.extractTo(dir, shouldSkip)) written.push(file)
    } finally {
      await zip.close().catch(() => undefined)
    }
  } catch (error) {
    // Fallback for archives the streaming reader cannot parse (e.g. central
    // directories it under-allocates): inflate everything in memory instead.
    if (written.length > 0) throw error
    const entries = unzipAll(fs.readFileSync(jarFile))
    for (const [name, data] of Object.entries(entries)) {
      const file = await writeEntry(name, data)
      if (file) written.push(file)
    }
  }
  touchMarker(dir, fs.statSync(jarFile).mtimeMs)
  return written
}

/**
 * Extracts every native jar belonging to a version into `<versions>/<id>/natives-windows`
 * (shared across jars, matching what `-Djava.library.path` points at).
 */
export async function ensureNatives(
  paths: PathInfo,
  id: string,
  nativeJars: { file: string; exclude?: string[] }[]
): Promise<string[]> {
  const dir = nativesDir(paths, id)
  let lastWritten: string[] = []
  for (const native of nativeJars) {
    if (!fs.existsSync(native.file)) continue
    const written = await extractNativeJar(native.file, dir, native.exclude ?? [])
    if (written.length > 0) lastWritten = written
  }
  return lastWritten
}

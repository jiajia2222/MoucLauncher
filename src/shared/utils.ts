import type { ArgEntry, ArgList, Library, Rule } from './types'

/* ------------------------------ ids ------------------------------ */

let counter = 0

/** Short unique id, stable within a process; used for jobs and instances. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 0xffff
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/* ---------------------------- formatting ---------------------------- */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(digits)} ${UNITS[unit]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond, 1)}/s`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--'
  return formatDuration(seconds * 1000)
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`
}

/* ----------------------------- paths ----------------------------- */

const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\x00-\x1f]/
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'lpt1', 'lpt2'])

/**
 * Instance names / file names become real directories, so they must not escape
 * the game root. Rejects traversal, absolute paths, control chars and reserved names.
 */
export function isSafeName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false
  if (WINDOWS_FORBIDDEN.test(name)) return false
  if (name.startsWith('.') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false
  if (RESERVED.has(name.toLowerCase())) return false
  return true
}

export function sanitizeName(name: string, fallback = 'unnamed'): string {
  const cleaned = name
    .replace(WINDOWS_FORBIDDEN, '')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 64)
  return cleaned.length > 0 && !RESERVED.has(cleaned.toLowerCase()) ? cleaned : fallback
}

/** True when `child` is `base` or lives under it, compared on normalized absolute paths.
 *  Lives in `src/main/core/paths.ts` — it needs `node:path`, and this file must stay
 *  importable by the renderer. */

/* ---------------------------- versions ---------------------------- */

/**
 * Splits a version id into comparable tokens: "1.20.4" -> [1,20,4],
 * "26.4-snapshot-3" -> [26,4,'snapshot',3]. Numeric tokens sort numerically,
 * so year-style ids (26.x) correctly rank above classic ids (1.x).
 */
export function tokenizeVersion(id: string): (number | string)[] {
  return id
    .toLowerCase()
    .split(/[.\-_+]/)
    .filter((t) => t.length > 0)
    .map((t) => (/^\d+$/.test(t) ? Number(t) : t))
}

export function compareVersionIds(a: string, b: string): number {
  const ta = tokenizeVersion(a)
  const tb = tokenizeVersion(b)
  const len = Math.max(ta.length, tb.length)
  for (let i = 0; i < len; i += 1) {
    const x = ta[i]
    const y = tb[i]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
    } else if (typeof x === 'number') {
      return 1
    } else if (typeof y === 'number') {
      return -1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function sortVersionIds(ids: string[], descending = true): string[] {
  return [...ids].sort((a, b) => (descending ? compareVersionIds(b, a) : compareVersionIds(a, b)))
}

/** "1.20.4" / "26.3" -> 1.20 / 26 ; used for "which series does this belong to". */
export function versionSeries(id: string): string {
  const parts = id.split('-')[0]!.split('.')
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]!
}

export function isSnapshot(id: string): boolean {
  return /-snapshot|snapshot|\balpha\b|\bbeta\b/i.test(id)
}

/* ----------------------------- maven ----------------------------- */

export interface MavenCoord {
  group: string
  artifact: string
  version: string
  classifier?: string
  ext: string
}

/** `g:a:v[:classifier][@ext]` */
export function parseMaven(name: string): MavenCoord | undefined {
  const [coord, ext] = name.split('@')
  const parts = coord?.split(':')
  if (!parts || parts.length < 3) return undefined
  const [group, artifact, version, classifier] = parts
  if (!group || !artifact || !version) return undefined
  const out: MavenCoord = { group, artifact, version, ext: ext ?? 'jar' }
  if (classifier) out.classifier = classifier
  return out
}

export function mavenPath(name: string): string | undefined {
  const c = parseMaven(name)
  if (!c) return undefined
  const suffix = c.classifier ? `-${c.classifier}` : ''
  return `${c.group.replace(/\./g, '/')}/${c.artifact}/${c.version}/${c.artifact}-${c.version}${suffix}.${c.ext}`
}

export function mavenUrl(repoBase: string, name: string): string | undefined {
  const p = mavenPath(name)
  if (!p) return undefined
  return `${repoBase.replace(/\/$/, '')}/${p}`
}

/* ------------------------------ rules ------------------------------ */

export interface RuleContext {
  osName: 'windows' | 'osx' | 'linux' | 'unknown'
  osArch: 'x64' | 'x86' | 'arm64' | 'unknown'
  osVersion?: string
  features: Record<string, boolean>
}

function osMatches(rule: Rule['os'], ctx: RuleContext): boolean {
  if (!rule) return true
  if (rule.name && rule.name !== ctx.osName) return false
  if (rule.arch && rule.arch !== ctx.osArch && !(rule.arch === 'x86' && ctx.osArch === 'x64')) return false
  if (rule.version && ctx.osVersion) {
    // Mojang uses a Java regex on the Windows build number (">=10.0.0" style or regex).
    const re = new RegExp(rule.version)
    if (!re.test(ctx.osVersion)) return false
  }
  return true
}

/** Evaluates Mojang `rules`. No rules means "always allowed". */
export function rulesMatch(rules: Rule[] | undefined, ctx: RuleContext): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    const osOk = osMatches(rule.os, ctx)
    const featuresOk = !rule.features
      || Object.entries(rule.features).every(([k, want]) => Boolean(ctx.features[k]) === want)
    if (!osOk || !featuresOk) continue
    if (rule.action === 'allow') allowed = true
    else if (rule.action === 'deny') return false
  }
  return allowed
}

/** Flattens `["a", {rules:[…], value:["b"]}]` into the active argument list. */
export function activeArgs(list: ArgList | undefined, ctx: RuleContext): string[] {
  const out: string[] = []
  for (const entry of list ?? []) {
    if (typeof entry === 'string') {
      out.push(entry)
      continue
    }
    const item = entry as ArgEntry
    if (!rulesMatch(item.rules, ctx)) continue
    const values = Array.isArray(item.value) ? item.value : [item.value]
    for (const v of values) {
      if (typeof v === 'string') out.push(v)
      else out.push(...activeArgs([v], ctx))
    }
  }
  return out
}

export interface LibraryFile {
  /** Absolute-ish relative path inside `libraries`. */
  relativePath: string
  url: string
  sha1?: string
  size?: number
  /** True for the jar that must be added to the classpath. */
  onClasspath: boolean
  /** True when it must be unpacked into the natives dir. */
  isNative: boolean
  exclude?: string[]
}

/**
 * Turns a library entry into concrete downloads for this machine.
 * Handles `natives` classifier substitution and extract exclusions (META-INF/*.SF).
 */
export function libraryFiles(lib: Library, ctx: RuleContext, librariesBase: string): LibraryFile[] {
  const out: LibraryFile[] = []
  if (!rulesMatch(lib.rules, ctx)) return out
  const dl = lib.downloads
  if (!dl) return out

  const nativeSlot = ctx.osName === 'osx' ? 'macos' : ctx.osName === 'unknown' ? 'windows' : ctx.osName
  const nativeKey = lib.natives?.[nativeSlot]
  const nativeName = nativeKey ? nativeKey.replace('${arch}', ctx.osArch === 'x86' ? '32' : '64') : undefined

  if (dl.artifact) {
    const rel = dl.artifact.path ?? mavenPath(lib.name)
    if (rel) {
      out.push({
        relativePath: rel,
        url: dl.artifact.url,
        sha1: dl.artifact.sha1,
        size: dl.artifact.size,
        onClasspath: !nativeName,
        isNative: false,
        exclude: lib.extract?.exclude
      })
    }
  }

  if (nativeName) {
    const classifier = dl.classifiers?.[nativeName]
    const coord = parseMaven(lib.name)
    if (classifier?.path && coord) {
      out.push({
        relativePath: classifier.path,
        url: classifier.url,
        sha1: classifier.sha1,
        size: classifier.size,
        onClasspath: false,
        isNative: true,
        exclude: lib.extract?.exclude
      })
    } else if (coord) {
      // Legacy shape: native jar only exists as a maven coordinate.
      const rel = mavenPath(`${coord.group}:${coord.artifact}:${coord.version}:${nativeName}`)
      if (rel) {
        out.push({
          relativePath: rel,
          url: `${librariesBase.replace(/\/$/, '')}/${rel}`,
          onClasspath: false,
          isNative: true,
          exclude: lib.extract?.exclude
        })
      }
    }
  }

  return out
}

/* ------------------------------ misc ------------------------------ */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/** Strips Minecraft section codes (§a) and chat-component JSON into plain text. */
export function plainMotd(raw: string): string {
  let text = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string') text = parsed
    else if (parsed && typeof parsed === 'object') text = flattenComponent(parsed as Record<string, unknown>)
  } catch {
    text = raw
  }
  return text.replace(/§./g, '').trim()
}

function flattenComponent(node: Record<string, unknown> | string): string {
  if (typeof node === 'string') return node
  let out = typeof node.text === 'string' ? node.text : ''
  const extra = node.extra
  if (Array.isArray(extra)) {
    for (const child of extra) out += flattenComponent(child as Record<string, unknown> | string)
  }
  return out
}

/** Accepts `host`, `host:port` or `scheme://host:port`; returns host + port. */
export function parseServerAddress(input: string, defaultPort = 25565): { host: string; port: number } | undefined {
  const value = input.trim().replace(/^(minecraft:|tcp:|https?:\/\/)/i, '')
  if (value.length === 0) return undefined

  const bracketed = value.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/)
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : defaultPort
    if (port < 1 || port > 65535) return undefined
    return { host: bracketed[1]!, port }
  }

  // Bare IPv6 (no brackets) contains several colons: only a trailing :port is separable.
  const parts = value.split(':')
  if (parts.length > 2 && !value.match(/^[^:]+:\d+$/)) {
    return { host: value, port: defaultPort }
  }
  if (parts.length === 2 && /^\d{1,5}$/.test(parts[1]!)) {
    const port = Number(parts[1])
    const host = parts[0]!
    if (host.length === 0 || port < 1 || port > 65535) return undefined
    return { host, port }
  }
  return { host: value, port: defaultPort }
}

export function isIPv4Like(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return clamp(Math.round((done / total) * 1000) / 10, 0, 100)
}

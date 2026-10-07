/**
 * Java runtime scanner. Finds candidate JRE/JDK installs on this machine, probes
 * each one with `<exe> -version` through an INJECTABLE runner (tests never need
 * a real Java), and caches results per exe path + mtime + size.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { JavaRuntime, JavaSource, Settings } from '@shared/types'
import { md5Of } from '../core/fsx'
import { defaultJavaScanDirs } from '../core/config'

export interface JavaExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable so unit tests never shell out. Resolves (never rejects) is fine. */
export type JavaExecRunner = (exe: string, args: string[], timeoutMs: number) => Promise<JavaExecResult>

export interface SettingsLike {
  get(): Settings
}

export interface ScanJavaDeps {
  settings: SettingsLike
  execRunner: JavaExecRunner
}

/** `java -version` prints to stderr and takes <1s cold; 5s bounds a hung jre. */
export const VERSION_PROBE_TIMEOUT_MS = 5_000

const EXE_NAMES = ['javaw.exe', 'java.exe'] as const

const scanCache = new Map<string, JavaRuntime>()

export function clearJavaScanCache(): void {
  scanCache.clear()
}

export function defaultExecRunner(): JavaExecRunner {
  return (exe, args, timeoutMs) =>
    new Promise<JavaExecResult>((resolve) => {
      execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
        void error
        resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
}

/* ------------------------------------------------------------------ */
/* version parsing                                                     */
/* ------------------------------------------------------------------ */

export interface ParsedJavaVersion {
  /** Null when the `-version` output could not be understood. */
  major: number | null
  /** First line that contains `version "..."` (or the first non-empty line). */
  raw: string
  vendor: string
  arch: JavaRuntime['arch']
}

/** Mojang/PCL style: `version "1.8.0_362"` -> 8, `version "17.0.9"` -> 17, `"26"` -> 26. */
const VERSION_RE = /version "(\d+)(?:\.(\d+))?/

export function parseJavaVersionOutput(text: string, pathHint = ''): ParsedJavaVersion {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const raw = lines.find((l) => l.includes('version "')) ?? lines[0] ?? ''
  const m = VERSION_RE.exec(text)
  let major: number | null = null
  if (m) {
    const first = Number(m[1])
    const second = m[2] === undefined ? undefined : Number(m[2])
    // Java 8 wrote `1.8.0_362`; Java 9+ writes the major directly.
    major = first === 1 && second !== undefined ? second : first
    if (!Number.isFinite(major) || major <= 0) major = null
  }
  const vendor = vendorFromText(text)
  const pathVendor = vendorFromPath(pathHint)
  // "OpenJDK" is what every downstream prints; a more specific vendor from the
  // installation path (Temurin/Microsoft/Zulu buckets) wins over that generic label.
  const vendorOut = vendor !== '' && vendor !== 'OpenJDK' ? vendor : pathVendor !== '' ? pathVendor : vendor
  return { major, raw, vendor: vendorOut === '' ? 'Unknown' : vendorOut, arch: detectArch(text, pathHint) }
}

const VENDOR_TOKENS: [RegExp, string][] = [
  [/temurin|adoptium|adoptopenjdk/i, 'Eclipse Temurin'],
  [/corretto|amazon/i, 'Amazon Corretto'],
  [/zulu|azul/i, 'Azul Zulu'],
  [/liberica|bellsoft/i, 'BellSoft Liberica'],
  [/graalvm/i, 'GraalVM'],
  [/semeru|ibm/i, 'IBM Semeru'],
  [/\bmicrosoft\b|ms[-_]openjdk|jdk-\d+-msft/i, 'Microsoft'],
  [/java\(tm\)|java se\b/i, 'Oracle'],
  [/openjdk/i, 'OpenJDK']
]

function vendorFromText(text: string): string {
  for (const [re, name] of VENDOR_TOKENS) if (re.test(text)) return name
  return ''
}

function vendorFromPath(p: string): string {
  return vendorFromText(p)
}

function detectArch(text: string, pathHint: string): JavaRuntime['arch'] {
  const hay = `${text}\n${pathHint}`
  if (/aarch64|arm64/i.test(hay)) return 'arm64'
  if (/32[-_]bit|\bx86(32)?\b|\(x86\)/i.test(hay)) return 'x86'
  if (/64[-_]bit|x64|x86_64/i.test(hay)) return 'x64'
  return 'unknown'
}

/* ------------------------------------------------------------------ */
/* candidate discovery                                                 */
/* ------------------------------------------------------------------ */

/** Trims a trailing `*` / `\*` glob and trailing separators from a scan dir. */
export function cleanScanDir(dir: string): string {
  return dir.trim().replace(/[\\/]\*+$/, '').replace(/^\*+$/g, '').replace(/[\\/]+$/g, '')
}

interface CandidateExe {
  root: string
  exe: string
  source: JavaSource
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

/** `<dir>/bin/javaw.exe`, falling back to `java.exe`. Returns the runtime root too. */
export async function findExecutableInDir(dir: string): Promise<{ root: string; exe: string } | undefined> {
  for (const name of EXE_NAMES) {
    const exe = path.join(dir, 'bin', name)
    if (await isFile(exe)) return { root: dir, exe }
  }
  return undefined
}

/**
 * Accepts a root dir, a bin dir or an explicit javaw/java.exe path (what users
 * naturally paste into `customJavaPath`). Prefers javaw.exe over java.exe.
 */
export async function locateExecutable(p: string): Promise<{ root: string; exe: string } | undefined> {
  if (!p || p.trim().length === 0) return undefined
  const cleaned = cleanScanDir(p)
  try {
    const st = await fsp.stat(cleaned)
    if (st.isFile()) {
      const base = path.basename(cleaned).toLowerCase()
      if (base !== 'javaw.exe' && base !== 'java.exe' && base !== 'javaw' && base !== 'java') return undefined
      const dir = path.dirname(cleaned)
      let exe = cleaned
      if (base === 'java.exe' || base === 'java') {
        const sibling = path.join(dir, 'javaw.exe')
        if (await isFile(sibling)) exe = sibling
      }
      const exeDir = path.dirname(exe)
      const root = path.basename(exeDir).toLowerCase() === 'bin' ? path.dirname(exeDir) : exeDir
      return { root, exe }
    }
    if (st.isDirectory()) {
      // The dir may be a root (`<dir>/bin/...`) or a vendor bucket (`<dir>/<vendor-x>/bin/...`).
      const direct = await findExecutableInDir(cleaned)
      if (direct) return direct
      let children: fs.Dirent[]
      try {
        children = await fsp.readdir(cleaned, { withFileTypes: true })
      } catch {
        return undefined
      }
      for (const child of children) {
        if (!child.isDirectory()) continue
        const found = await findExecutableInDir(path.join(cleaned, child.name))
        if (found) return found
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function rootDirs(settings: Settings): { dir: string; source: JavaSource }[] {
  const out: { dir: string; source: JavaSource }[] = []
  const push = (dir: string, source: JavaSource): void => {
    const cleaned = cleanScanDir(dir)
    if (cleaned.length === 0) return
    out.push({ dir: cleaned, source })
  }
  for (const dir of settings.javaScanDirs ?? []) push(dir, 'scan')
  push(process.env.JAVA_HOME ?? '', 'scan')
  for (const dir of defaultJavaScanDirs()) push(dir, 'scan')
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  for (const entry of pathVar.split(path.delimiter)) push(entry, 'system-path')
  return out
}

/** One level of entries, so `<dir>/<vendor-xxx>/bin/javaw.exe` is also a candidate. */
async function expand(rootDir: string): Promise<string[]> {
  const out = [rootDir]
  try {
    const entries = await fsp.readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) out.push(path.join(rootDir, entry.name))
    }
  } catch {
    /* unreadable dir contributes nothing */
  }
  return out
}

/* ------------------------------------------------------------------ */
/* probing                                                             */
/* ------------------------------------------------------------------ */

export async function probeRuntime(exe: string, root: string, source: JavaSource, runner: JavaExecRunner): Promise<JavaRuntime> {
  let mtimeMs = 0
  let size = 0
  try {
    const st = await fsp.stat(exe)
    mtimeMs = Math.round(st.mtimeMs)
    size = st.size
  } catch {
    /* stat failure still yields a broken record, uncached */
  }
  const cacheKey = `${exe.toLowerCase()}|${mtimeMs}|${size}`
  const cached = scanCache.get(cacheKey)
  if (cached) return cached

  const id = `scan-${md5Of(Buffer.from(exe.toLowerCase(), 'utf8')).slice(0, 12)}`
  let text = ''
  let broken: string | undefined
  try {
    const res = await runner(exe, ['-version'], VERSION_PROBE_TIMEOUT_MS)
    // `-version` historically goes to stderr; accept both streams.
    text = [res.stderr, res.stdout].map((v) => v.trim()).filter((v) => v.length > 0).join('\n')
    if (res.code !== 0 && !VERSION_RE.test(text)) broken = `执行 ${path.basename(exe)} -version 失败 (exit ${res.code})`
  } catch (error) {
    broken = `无法执行 ${path.basename(exe)} -version：${error instanceof Error ? error.message : String(error)}`
  }

  const parsed = parseJavaVersionOutput(text, root)
  if (!broken && parsed.major === null) broken = '无法从 java -version 输出解析版本号'

  const runtime: JavaRuntime = {
    id,
    path: root,
    rawVersion: parsed.raw,
    major: parsed.major ?? 0,
    vendor: parsed.vendor,
    arch: detectArch(text, root),
    source,
    executable: exe,
    canHeadless: !broken,
    ...(broken ? { broken } : {})
  }
  if (mtimeMs > 0 || size > 0) scanCache.set(cacheKey, runtime)
  return runtime
}

/** Scans every configured location; broken candidates come back with `broken` set. */
export async function scanJava(deps: ScanJavaDeps): Promise<JavaRuntime[]> {
  const settings = deps.settings.get()
  const seen = new Map<string, CandidateExe>()

  // `customJavaPath` is a first-class candidate and is labelled 'manual'.
  if (settings.customJavaPath && settings.customJavaPath.trim().length > 0) {
    const manual = await locateExecutable(settings.customJavaPath)
    if (manual) seen.set(manual.exe.toLowerCase(), { ...manual, source: 'manual' })
  }

  for (const root of rootDirs(settings)) {
    if (!(await isDirectory(root.dir))) continue
    for (const dir of await expand(root.dir)) {
      const found = await findExecutableInDir(dir)
      if (!found) continue
      const key = found.exe.toLowerCase()
      if (!seen.has(key)) seen.set(key, { ...found, source: root.source })
    }
  }

  const out: JavaRuntime[] = []
  for (const candidate of seen.values()) {
    out.push(await probeRuntime(candidate.exe, candidate.root, candidate.source, deps.execRunner))
  }
  return out
}

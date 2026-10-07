import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS_CONST } from '@shared/constants'
import { SETTINGS_VERSION, type MirrorRule, type PathInfo, type Settings } from '@shared/types'
import { buildPaths, defaultGameRoot } from './paths'

type Listener = (next: Settings, previous: Settings) => void

/** Settings persisted as pretty JSON under `<configDir>/settings.json`. */
export class SettingsStore {
  private readonly file: string
  private cached: Settings | undefined
  private listeners = new Set<Listener>()
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly appData: string,
    private readonly documents?: string
  ) {
    this.file = path.join(appData, 'config', 'settings.json')
  }

  defaults(): Settings {
    const gameRoot = defaultGameRoot(this.appData, this.documents)
    return {
      settingsVersion: SETTINGS_VERSION,
      language: 'zh-CN',
      theme: 'dark',
      gameRoot,
      maxConcurrentDownloads: DEFAULT_SETTINGS_CONST.maxConcurrentDownloads,
      resumeDownloads: true,
      strictDownload: false,
      mirrors: [],
      javaMode: 'adoptium',
      customJavaPath: '',
      javaScanDirs: defaultJavaScanDirs(),
      defaultMemoryMb: DEFAULT_SETTINGS_CONST.memoryMb,
      defaultResolution: {
        width: DEFAULT_SETTINGS_CONST.width,
        height: DEFAULT_SETTINGS_CONST.height,
        fullscreen: false
      },
      extraJvmArgs: '',
      closeAction: 'ask',
      showGameConsole: true,
      hideOnLaunch: false,
      curseForgeApiKey: '',
      modrinthBaseUrl: 'https://api.modrinth.com/v2',
      relayServerUrl: '',
      proxyUrl: '',
      microsoftClientId: '',
      autoCheckUpdate: true,
      lastSeenVersion: ''
    }
  }

  get(): Settings {
    if (this.cached) return this.cached
    this.cached = this.read()
    return this.cached
  }

  paths(): PathInfo {
    return buildPaths(this.appData, this.get().gameRoot)
  }

  private read(): Settings {
    const base = this.defaults()
    if (!fs.existsSync(this.file)) return base
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>
      const merged: Settings = { ...base, ...(raw as Partial<Settings>) }
      merged.defaultResolution = { ...base.defaultResolution, ...(raw.defaultResolution as object | undefined) }
      merged.mirrors = Array.isArray(raw.mirrors) ? (raw.mirrors as MirrorRule[]) : base.mirrors
      merged.javaScanDirs = Array.isArray(raw.javaScanDirs) ? (raw.javaScanDirs as string[]) : base.javaScanDirs
      if (typeof merged.gameRoot !== 'string' || merged.gameRoot.length === 0) merged.gameRoot = base.gameRoot
      merged.maxConcurrentDownloads = clampNum(merged.maxConcurrentDownloads, 1, 32, base.maxConcurrentDownloads)
      merged.defaultMemoryMb = clampNum(merged.defaultMemoryMb, 512, 262_144, base.defaultMemoryMb)
      merged.language = merged.language === 'en-US' ? 'en-US' : 'zh-CN'
      merged.theme = merged.theme === 'light' ? 'light' : 'dark'
      return merged
    } catch {
      // A corrupt config must not brick the launcher: keep the old file for inspection.
      try {
        fs.copyFileSync(this.file, `${this.file}.bad-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return base
    }
  }

  set(patch: Partial<Settings>): Settings {
    const previous = this.get()
    const next: Settings = {
      ...previous,
      ...patch,
      defaultResolution: { ...previous.defaultResolution, ...(patch.defaultResolution ?? {}) },
      mirrors: patch.mirrors ?? previous.mirrors,
      javaScanDirs: patch.javaScanDirs ?? previous.javaScanDirs
    }
    next.settingsVersion = SETTINGS_VERSION
    this.cached = next
    this.enqueueWrite(next)
    for (const listener of this.listeners) {
      try {
        listener(next, previous)
      } catch {
        /* listener errors are logged by the caller */
      }
    }
    return next
  }

  reset(): Settings {
    return this.set(this.defaults())
  }

  private enqueueWrite(next: Settings): void {
    this.writing = this.writing.then(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
        fs.renameSync(tmp, this.file)
      } catch {
        /* surfaced to the user through the settings handler result */
      }
    })
  }

  flush(): Promise<void> {
    return this.writing
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Where we look for an existing Java installation before offering a download. */
export function defaultJavaScanDirs(): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA ?? ''
  const javaHome = process.env.JAVA_HOME
  const out = [
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Microsoft'),
    path.join(programFiles, 'Zulu'),
    path.join(programFiles, 'BellSoft'),
    path.join(programFilesX86, 'Java'),
    path.join(programFilesX86, 'Zulu')
  ]
  if (local) {
    out.push(path.join(local, 'Programs', 'Java'))
    out.push(path.join(local, 'Packages', 'Java'))
  }
  if (javaHome) out.push(javaHome)
  // Common toolchains that ship a bundled JRE.
  out.push(path.join(programFiles, 'Minecraft Launcher', 'runtime'))
  out.push(path.join(local, 'Packages', 'MinecraftLauncher_*'))
  return out.filter((p) => p.length > 0)
}

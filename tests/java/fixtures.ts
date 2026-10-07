import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Instance, JavaVersionInfo, ResolvedVersion, Settings } from '@shared/types'
import { SETTINGS_VERSION } from '@shared/types'
import { adoptiumListUrl, adoptiumLatestUrl } from '../../src/main/java/adoptium'
import type { JavaExecResult, JavaExecRunner } from '../../src/main/java/scanner'
import { sha1Of } from '../../src/main/core/fsx'
import { zipAll } from '../../src/main/core/zip'

/* --------------------------- temp dirs --------------------------- */

export function touch(file: string, content = 'fake-bytes'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Env sandbox so defaultJavaScanDirs()/JAVA_HOME/PATH only point at temp dirs. */
const ENV_KEYS = ['JAVA_HOME', 'PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'] as const

export function sandboxJavaEnv(tmp: string): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.ProgramFiles = path.join(tmp, 'PF')
  process.env['ProgramFiles(x86)'] = path.join(tmp, 'PF86')
  process.env.LOCALAPPDATA = path.join(tmp, 'LA')
  process.env.JAVA_HOME = path.join(tmp, 'no-java-home')
  process.env.PATH = path.join(tmp, 'empty-path')
  fs.mkdirSync(path.join(tmp, 'PF'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'PF86'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'LA'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'empty-path'), { recursive: true })
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/* --------------------------- settings --------------------------- */

export function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    settingsVersion: SETTINGS_VERSION,
    language: 'zh-CN',
    theme: 'dark',
    gameRoot: 'C:/fake/game',
    maxConcurrentDownloads: 4,
    resumeDownloads: true,
    strictDownload: false,
    mirrors: [],
    javaMode: 'adoptium',
    customJavaPath: '',
    javaScanDirs: [],
    defaultMemoryMb: 4096,
    defaultResolution: { width: 854, height: 480, fullscreen: false },
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
    lastSeenVersion: '',
    ...overrides
  }
}

/* --------------------------- fake exec runner --------------------------- */

/** Maps (lowercased) exe path -> `java -version` text served on stderr. */
export function scriptedRunner(table: Record<string, string>, opts: { defaultText?: string; defaultCode?: number } = {}): {
  runner: JavaExecRunner
  calls: string[]
} {
  const calls: string[] = []
  const runner: JavaExecRunner = async (exe, args) => {
    calls.push(exe)
    void args
    const text = table[exe.toLowerCase()]
    if (text === undefined) {
      const result: JavaExecResult = { code: opts.defaultCode ?? 1, stdout: '', stderr: opts.defaultText ?? 'unreachable in tests' }
      return result
    }
    return { code: 0, stdout: '', stderr: text }
  }
  return { runner, calls }
}

/* --------------------------- instance / resolved fixtures --------------------------- */

export function makeInstance(java: Instance['java'] = { mode: 'auto' }): Instance {
  const t = Date.now()
  return {
    id: 'test-instance',
    name: 'Test',
    description: '',
    icon: 'cube',
    versionId: '1.20.4',
    loader: 'vanilla',
    gameVersion: '1.20.4',
    isolated: true,
    java,
    memoryMb: 4096,
    jvmArgs: '',
    gameArgs: '',
    resolution: { width: 854, height: 480, fullscreen: false },
    createdAt: t,
    updatedAt: t,
    playCount: 0,
    version: 1
  }
}

export function makeResolved(majorVersion: number): ResolvedVersion {
  const javaVersion: JavaVersionInfo = { component: 'java-runtime-gamma', majorVersion }
  return {
    id: '1.20.4',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    gameArgs: [],
    jvmArgs: [],
    libraries: [],
    assetsVersion: '12',
    javaVersion,
    jsonPath: 'C:/fake/versions/1.20.4/1.20.4.json',
    clientJarPath: 'C:/fake/versions/1.20.4/1.20.4.jar',
    raw: { id: '1.20.4' }
  }
}

/* --------------------------- adoptium fixtures --------------------------- */

export const FIXTURE_TOP_FOLDER = 'OpenJDK21U-jre_x64_windows_hotspot_21.0.4_7'

/** A zip with the single top folder Adoptium really ships (`jdk-x.y.z+n/`). */
export function makeAdoptiumZip(major = 21, topFolder = FIXTURE_TOP_FOLDER): Buffer {
  const files: Record<string, string> = {}
  files[`${topFolder}/bin/javaw.exe`] = 'fake-javaw'
  files[`${topFolder}/bin/java.exe`] = 'fake-java'
  files[`${topFolder}/release`] = `JAVA_VERSION="${major}"`
  return Buffer.from(zipAll(files))
}

export function adoptiumReleaseFixture(major = 21, imageType: 'jre' | 'jdk' = 'jre', zip?: Buffer) {
  const bytes = zip ?? makeAdoptiumZip(major)
  return {
    release: {
      release_name: `jdk${major}u-${imageType}-${major === 21 ? '21.0.4+7' : `${major}.0.1+1`}`,
      version: { major, semver: major === 21 ? '21.0.4+7' : `${major}.0.1+1` },
      binary: {
        architecture: 'x64',
        image_type: imageType,
        os: 'windows',
        package: {
          link: `https://github.com/adoptium/temurin${major}-binaries/releases/download/x/OpenJDK${major}U-${imageType}_x64_windows_hotspot_${major}_1.zip`,
          name: `OpenJDK${major}U-${imageType}_x64_windows_hotspot_${major}_1.zip`,
          checksum: sha1Of(bytes),
          size: bytes.length
        }
      }
    },
    bytes
  }
}

export function adoptiumUrls(major: number): { latest: string; list: string } {
  return { latest: adoptiumLatestUrl(major, 'jre'), list: adoptiumListUrl(major, 'jre') }
}

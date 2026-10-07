import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearJavaScanCache,
  cleanScanDir,
  parseJavaVersionOutput,
  scanJava,
  VERSION_PROBE_TIMEOUT_MS
} from '../../src/main/java/scanner'
import type { Settings } from '@shared/types'
import { baseSettings, makeTempDir, sandboxJavaEnv, scriptedRunner, touch } from './fixtures'

const V1_8 = 'openjdk version "1.8.0_362"\nOpenJDK Runtime Environment (Zulu 8.68.0.21-CA-win64) (build 1.8.0_362-b05)\nOpenJDK 64-Bit Server VM (Zulu 8.68.0.21-CA-win64) (build 25.362-b05, mixed mode)'
const V17 = 'openjdk version "17.0.9" 2023-10-17 LTS\nOpenJDK Runtime Environment (build 17.0.9+11-LTS)\nOpenJDK 64-Bit Server VM (build 17.0.9+11-LTS, mixed mode, sharing)'
const V21_TEMURIN = 'openjdk version "21.0.4" 2024-07-16 LTS\nOpenJDK Runtime Environment Temurin-21.0.4+7 (build 21.0.4+7-LTS)\nOpenJDK 64-Bit Server VM Temurin-21.0.4+7 (build 21.0.4+7-LTS, mixed mode)'
const V25 = 'openjdk version "25" 2025-09-16\nOpenJDK Runtime Environment Temurin-25+36 (build 25+36)\nOpenJDK 64-Bit Server VM Temurin-25+36 (build 25+36, mixed mode)'

describe('parseJavaVersionOutput', () => {
  it('maps 1.x to the second number', () => {
    expect(parseJavaVersionOutput(V1_8).major).toBe(8)
    expect(parseJavaVersionOutput('java version "1.8" 01').major).toBe(8)
  })

  it('parses modern majors incl 26 (year-style)', () => {
    expect(parseJavaVersionOutput(V17).major).toBe(17)
    expect(parseJavaVersionOutput(V21_TEMURIN).major).toBe(21)
    expect(parseJavaVersionOutput(V25).major).toBe(25)
    expect(parseJavaVersionOutput('openjdk version "26" 2026-03-17').major).toBe(26)
    expect(parseJavaVersionOutput('java version "11.0.2"').major).toBe(11)
  })

  it('returns null major for garbage', () => {
    const parsed = parseJavaVersionOutput('boom not a version line')
    expect(parsed.major).toBeNull()
    const empty = parseJavaVersionOutput('')
    expect(empty.major).toBeNull()
  })

  it('extracts vendor from text and arch from 64-Bit markers', () => {
    const temurin = parseJavaVersionOutput(V21_TEMURIN)
    expect(temurin.vendor).toBe('Eclipse Temurin')
    expect(temurin.arch).toBe('x64')
    expect(parseJavaVersionOutput(V1_8).vendor).toBe('Azul Zulu')
    expect(parseJavaVersionOutput(V17).vendor).toBe('OpenJDK')
    expect(parseJavaVersionOutput('openjdk version "21" \nOpenJDK 64-Bit Server VM (aarch64)').arch).toBe('arm64')
  })

  it('falls back to path heuristics for vendor/arch', () => {
    const parsed = parseJavaVersionOutput('openjdk version "17.0.2" (build)', 'C:\\Program Files (x86)\\Java\\jdk-17.0.2')
    expect(parsed.arch).toBe('x86')
    const ms = parseJavaVersionOutput('openjdk version "17.0.2"', 'C:\\Program Files\\Microsoft\\jdk-17.0.2.8-hotspot')
    expect(ms.vendor).toBe('Microsoft')
  })
})

describe('cleanScanDir', () => {
  it('tolerates trailing globs and separators', () => {
    expect(cleanScanDir('C:\\Program Files\\Java\\*')).toBe('C:\\Program Files\\Java')
    expect(cleanScanDir('C:/Program Files/Java/*')).toBe('C:/Program Files/Java')
    expect(cleanScanDir('C:\\Program Files\\Java\\')).toBe('C:\\Program Files\\Java')
  })
})

describe('scanJava candidate discovery', () => {
  let tmp = ''
  let restoreEnv: () => void = () => undefined

  beforeEach(() => {
    clearJavaScanCache()
    tmp = makeTempDir('mouc-scan-')
    restoreEnv = sandboxJavaEnv(tmp)

    // <scanRoot>/bin/javaw.exe (direct runtime root)
    touch(path.join(tmp, 'scan1', 'bin', 'javaw.exe'), 'w')
    touch(path.join(tmp, 'scan1', 'bin', 'java.exe'), 'j')
    // <scanRoot>/<vendor-xxx>/bin/javaw.exe (one level deeper)
    touch(path.join(tmp, 'scan2', 'vendor-temurin-21', 'bin', 'javaw.exe'), 'w')
    // JAVA_HOME with only java.exe
    touch(path.join(tmp, 'jhome', 'bin', 'java.exe'), 'j')
    // PATH entry
    touch(path.join(tmp, 'pathdir', 'bin', 'javaw.exe'), 'w')
    // defaultJavaScanDirs hit: ProgramFiles\Java\<jdk>\bin\javaw.exe, unparseable output
    touch(path.join(tmp, 'PF', 'Java', 'broken-jdk', 'bin', 'javaw.exe'), 'w')
    // JAVA_HOME is also listed in javaScanDirs -> must be de-duplicated
  })

  afterEach(() => {
    restoreEnv()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function settings(overrides: Partial<Settings>): Settings {
    return baseSettings({
      javaScanDirs: [`${path.join(tmp, 'scan1')}${path.sep}*`, path.join(tmp, 'scan2'), path.join(tmp, 'jhome')],
      ...overrides
    })
  }

  it('finds javaw.exe roots, nested vendor dirs, JAVA_HOME and PATH entries', async () => {
    process.env.JAVA_HOME = path.join(tmp, 'jhome')
    process.env.PATH = [path.join(tmp, 'pathdir'), process.env.PATH].join(path.delimiter)
    const { runner, calls } = scriptedRunner({
      [path.join(tmp, 'scan1', 'bin', 'javaw.exe').toLowerCase()]: V1_8,
      [path.join(tmp, 'scan2', 'vendor-temurin-21', 'bin', 'javaw.exe').toLowerCase()]: V21_TEMURIN,
      [path.join(tmp, 'jhome', 'bin', 'java.exe').toLowerCase()]: V17,
      [path.join(tmp, 'pathdir', 'bin', 'javaw.exe').toLowerCase()]: V25
    })
    const list = await scanJava({ settings: { get: () => settings({}) }, execRunner: runner })

    const scan1 = list.find((r) => r.path === path.join(tmp, 'scan1'))
    expect(scan1, 'scan1 root found').toBeDefined()
    expect(scan1!.major).toBe(8)
    expect(scan1!.executable.toLowerCase()).toBe(path.join(tmp, 'scan1', 'bin', 'javaw.exe').toLowerCase())
    expect(scan1!.source).toBe('scan')

    const nested = list.find((r) => r.path === path.join(tmp, 'scan2', 'vendor-temurin-21'))
    expect(nested, 'vendor-xxx one level deeper found').toBeDefined()
    expect(nested!.major).toBe(21)
    expect(nested!.vendor).toBe('Eclipse Temurin')

    const home = list.find((r) => r.path === path.join(tmp, 'jhome'))
    expect(home, 'JAVA_HOME found').toBeDefined()
    expect(home!.major).toBe(17)
    expect(home!.executable).toBe(path.join(tmp, 'jhome', 'bin', 'java.exe'))

    const fromPath = list.find((r) => r.path === path.join(tmp, 'pathdir'))
    expect(fromPath, 'PATH dir found').toBeDefined()
    expect(fromPath!.source).toBe('system-path')
    expect(fromPath!.major).toBe(25)

    // scan1 also holds java.exe but javaw.exe wins and is probed once.
    expect(calls.filter((c) => c.toLowerCase().includes('scan1'))).toEqual([path.join(tmp, 'scan1', 'bin', 'javaw.exe')])
    // JAVA_HOME was both in javaScanDirs and env -> exactly one entry.
    expect(list.filter((r) => r.path === path.join(tmp, 'jhome'))).toHaveLength(1)
  })

  it('marks runtimes whose probe fails or prints garbage as broken', async () => {
    const { runner } = scriptedRunner({})
    const list = await scanJava({ settings: { get: () => settings({}) }, execRunner: runner })
    const broken = list.find((r) => r.path === path.join(tmp, 'PF', 'Java', 'broken-jdk'))
    expect(broken, 'broken entry surfaced from defaultJavaScanDirs').toBeDefined()
    expect(broken!.broken).toMatch(/失败|无法解析/)
    expect(broken!.canHeadless).toBe(false)
  })

  it('includes settings.customJavaPath as a manual source', async () => {
    const { runner } = scriptedRunner({
      [path.join(tmp, 'scan1', 'bin', 'javaw.exe').toLowerCase()]: V1_8
    })
    const list = await scanJava({
      settings: { get: () => settings({ customJavaPath: path.join(tmp, 'scan1') }) },
      execRunner: runner
    })
    const manual = list.find((r) => r.source === 'manual')
    expect(manual).toBeDefined()
    expect(manual!.major).toBe(8)
  })

  it('caches probe results by path+mtime+size (second scan runs nothing)', async () => {
    const first = scriptedRunner({
      [path.join(tmp, 'scan1', 'bin', 'javaw.exe').toLowerCase()]: V1_8
    })
    await scanJava({ settings: { get: () => settings({ javaScanDirs: [path.join(tmp, 'scan1')] }) }, execRunner: first.runner })
    expect(first.calls.length).toBeGreaterThan(0)
    const second = scriptedRunner({})
    const list = await scanJava({ settings: { get: () => settings({ javaScanDirs: [path.join(tmp, 'scan1')] }) }, execRunner: second.runner })
    expect(second.calls).toHaveLength(0)
    expect(list.find((r) => r.path === path.join(tmp, 'scan1'))?.major).toBe(8)

    // touching the exe changes mtime -> cache miss, probe runs again
    await new Promise((resolve) => setTimeout(resolve, 5))
    touch(path.join(tmp, 'scan1', 'bin', 'javaw.exe'), 'changed-size')
    const third = scriptedRunner({
      [path.join(tmp, 'scan1', 'bin', 'javaw.exe').toLowerCase()]: V25
    })
    const relisted = await scanJava({ settings: { get: () => settings({ javaScanDirs: [path.join(tmp, 'scan1')] }) }, execRunner: third.runner })
    expect(third.calls.length).toBeGreaterThan(0)
    expect(relisted.find((r) => r.path === path.join(tmp, 'scan1'))?.major).toBe(25)
  })

  it('probes with -version and a 5s timeout', async () => {
    const seen: { args: string[]; timeout: number }[] = []
    const list = await scanJava({
      settings: { get: () => settings({ javaScanDirs: [path.join(tmp, 'scan1')] }) },
      execRunner: async (_exe, args, timeoutMs) => {
        seen.push({ args, timeout: timeoutMs })
        return { code: 0, stdout: '', stderr: V17 }
      }
    })
    expect(list.length).toBeGreaterThan(0)
    expect(seen[0]!.args).toEqual(['-version'])
    expect(seen[0]!.timeout).toBe(VERSION_PROBE_TIMEOUT_MS)
  })
})

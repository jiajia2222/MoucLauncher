import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPaths } from '../../src/main/core/paths'
import { Logger } from '../../src/main/core/log'
import type { DownloadResult, Downloader, HttpClient } from '../../src/main/core/contracts'
import { createJavaService, selectRuntime } from '../../src/main/java/service'
import { clearJavaScanCache } from '../../src/main/java/scanner'
import type { DownloadItem, JavaRuntime, PathInfo } from '@shared/types'
import {
  adoptiumReleaseFixture,
  adoptiumUrls,
  baseSettings,
  makeAdoptiumZip,
  makeInstance,
  makeResolved,
  makeTempDir,
  sandboxJavaEnv,
  scriptedRunner,
  touch
} from './fixtures'

const V8 = 'openjdk version "1.8.0_362"\nOpenJDK 64-Bit Server VM (Zulu)'
const V17_OPENJDK = 'openjdk version "17.0.9" 2023-10-17\nOpenJDK 64-Bit Server VM'
const V17_TEMURIN = 'openjdk version "17.0.9"\nOpenJDK Runtime Environment Temurin-17.0.9+10\nOpenJDK 64-Bit Server VM Temurin-17.0.9+10'
const V21_ZULU = 'openjdk version "21.0.4" 2024-07-16\nOpenJDK Runtime Environment Zulu21\nOpenJDK 64-Bit Server VM Zulu21'
const V21_TEMURIN = 'openjdk version "21.0.4" 2024-07-16\nOpenJDK Runtime Environment Temurin-21.0.4+7\nOpenJDK 64-Bit Server VM Temurin-21.0.4+7'
const V25_MS = 'openjdk version "25" 2025-09-16\nMicrosoft OpenJDK 64-Bit Server VM'

function runtimeFixture(overrides: Partial<JavaRuntime> & Pick<JavaRuntime, 'executable'>): JavaRuntime {
  return {
    id: `scan-${overrides.executable}`,
    path: path.dirname(path.dirname(overrides.executable)),
    rawVersion: '',
    major: 17,
    vendor: 'OpenJDK',
    arch: 'x64',
    source: 'scan',
    canHeadless: true,
    ...overrides
  }
}

describe('selectRuntime ranking', () => {
  const pool = [
    runtimeFixture({ executable: 'C:/j/zulu21/bin/javaw.exe', major: 21, vendor: 'Azul Zulu' }),
    runtimeFixture({ executable: 'C:/j/ms25/bin/javaw.exe', major: 25, vendor: 'Microsoft' }),
    runtimeFixture({ executable: 'C:/j/tem17/bin/javaw.exe', major: 17, vendor: 'Eclipse Temurin' }),
    runtimeFixture({ executable: 'C:/j/plain17/bin/javaw.exe', major: 17, vendor: 'OpenJDK' }),
    runtimeFixture({ executable: 'C:/j/tem21/bin/javaw.exe', major: 21, vendor: 'Eclipse Temurin' }),
    runtimeFixture({ executable: 'C:/j/broken17/bin/javaw.exe', major: 17, broken: '挂了' })
  ]

  it('prefers exact major, then the smallest major >= required', () => {
    expect(selectRuntime(pool, 17)!.major).toBe(17)
    expect(selectRuntime(pool, 18)!.major).toBe(21)
    expect(selectRuntime(pool, 26)).toBeNull()
    expect(selectRuntime(pool, 18)!.executable).toContain('tem21')
  })

  it('breaks ties by Temurin/Microsoft vendor then x64, and skips broken entries', () => {
    const exact = selectRuntime(pool, 17)!
    expect(exact.vendor).toBe('Eclipse Temurin')
    expect(exact.executable).toContain('tem17')
    expect(exact.executable).not.toContain('broken')
    expect(selectRuntime([], 17)).toBeNull()
  })
})

describe('createJavaService.forInstance', () => {
  let tmp = ''
  let restoreEnv: () => void = () => undefined
  let log: Logger
  let paths: () => PathInfo = () => buildPaths('x', 'y')

  const RUNTIMES: Record<string, string> = {}

  function seedJava(name: string, versionText: string): string {
    const root = path.join(tmp, 'runtimes', name)
    touch(path.join(root, 'bin', 'javaw.exe'), 'w')
    RUNTIMES[path.join(root, 'bin', 'javaw.exe').toLowerCase()] = versionText
    return root
  }

  let ensured: DownloadItem[] = []

  beforeEach(() => {
    clearJavaScanCache()
    tmp = makeTempDir('mouc-jsvc-')
    restoreEnv = sandboxJavaEnv(tmp)
    log = new Logger('test-java-service', path.join(tmp, 'logs'))
    paths = () => buildPaths(tmp, path.join(tmp, 'game'))
    ensured = []
    for (const key of Object.keys(RUNTIMES)) delete RUNTIMES[key]
  })

  afterEach(() => {
    restoreEnv()
    log.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  interface Harness {
    ensured: () => DownloadItem[]
    service: ReturnType<typeof createJavaService>
    probeCalls: string[]
    httpUrls: string[]
  }

  function harness(opts: {
    settings?: Partial<Parameters<typeof baseSettings>[0]>
    javaTable?: Record<string, string>
  } = {}): Harness {
    const table = opts.javaTable ?? { ...RUNTIMES }
    const { runner, calls } = scriptedRunner(table)
    const zip = makeAdoptiumZip(17, 'jdk-17.0.9+8-jre')
    const release = adoptiumReleaseFixture(17, 'jre', zip)
    const httpUrls: string[] = []
    const http = {
      async json<T>(url: string): Promise<T> {
        httpUrls.push(url)
        if (url === adoptiumUrls(17).latest) return [release.release] as T
        throw new Error(`unexpected java url ${url}`)
      }
    } as unknown as HttpClient
    const downloader = {
      async ensure(item: DownloadItem): Promise<DownloadResult> {
        ensured.push(item)
        fs.mkdirSync(path.dirname(item.target), { recursive: true })
        fs.writeFileSync(item.target, zip)
        return { item, fetched: true }
      }
    } as unknown as Downloader
    const service = createJavaService({
      downloader,
      http,
      settings: { get: () => baseSettings({ javaScanDirs: [path.join(tmp, 'runtimes')], ...opts.settings }) },
      paths,
      log,
      execRunner: runner
    })
    return {
      ensured: () => ensured,
      service,
      probeCalls: calls,
      httpUrls
    }
  }

  it('uses instance.java.mode=custom path first, above everything else', async () => {
    const root8 = seedJava('zulu8', V8)
    seedJava('tem17', V17_TEMURIN)
    const h = harness()
    const instance = makeInstance({ mode: 'custom', path: path.join(root8, 'bin', 'javaw.exe') })
    const runtime = await h.service.forInstance(instance, makeResolved(17))
    expect(runtime.major).toBe(8)
    expect(runtime.source).toBe('manual')
  })

  it('falls back to settings.customJavaPath before scanning', async () => {
    seedJava('zulu8', V8)
    const root21 = seedJava('tem21', V21_TEMURIN)
    const h = harness({ settings: { customJavaPath: root21 } })
    const runtime = await h.service.forInstance(makeInstance(), makeResolved(17))
    expect(runtime.major).toBe(21)
    expect(runtime.source).toBe('manual')
  })

  it('picks the scanned runtime with the exact required major (Temurin preferred)', async () => {
    seedJava('plain17', V17_OPENJDK)
    seedJava('tem17', V17_TEMURIN)
    seedJava('zulu21', V21_ZULU)
    const h = harness()
    const runtime = await h.service.forInstance(makeInstance(), makeResolved(17))
    expect(runtime.major).toBe(17)
    expect(runtime.vendor).toBe('Eclipse Temurin')
    expect(runtime.executable.toLowerCase()).toContain('tem17')
  })

  it('uses the smallest major >= required when the exact one is missing', async () => {
    seedJava('zulu8', V8)
    seedJava('zulu21', V21_ZULU)
    seedJava('ms25', V25_MS)
    const h = harness()
    const runtime = await h.service.forInstance(makeInstance(), makeResolved(17))
    expect(runtime.major).toBe(21)
  })

  it('auto-provisions from Adoptium when nothing matches (javaw.exe executable)', async () => {
    seedJava('zulu8', V8)
    const h = harness()
    const runtime = await h.service.forInstance(makeInstance(), makeResolved(17))
    expect(runtime.source).toBe('adoptium')
    expect(runtime.major).toBe(17)
    expect(runtime.executable.endsWith('javaw.exe')).toBe(true)
    expect(h.ensured()).toHaveLength(1)
    // ensure() receives the package link served by the Adoptium fixture…
    expect(h.ensured()[0]!.url).toContain('adoptium/temurin17-binaries')
    // …which was discovered through the verified Adoptium latest endpoint.
    expect(h.httpUrls).toEqual([adoptiumUrls(17).latest])
    // second forInstance reuses the registry without a new download
    const again = await h.service.forInstance(makeInstance(), makeResolved(17))
    expect(again.id).toBe(runtime.id)
    expect(h.ensured()).toHaveLength(1)
  })

  it('pinned mode resolves against the registry', async () => {
    const h = harness()
    const provisioned = await h.service.provision({ major: 17 })
    const instance = makeInstance({ mode: 'pinned', path: provisioned.runtime.executable })
    const runtime = await h.service.forInstance(instance, makeResolved(21))
    expect(runtime.id).toBe('temurin-17')
    expect(runtime.major).toBe(17)
  })

  it('mojang-component mode throws unsupported (Mojang metadata is unreachable)', async () => {
    seedJava('zulu8', V8)
    const h = harness({ settings: { javaMode: 'mojang-component' } })
    await expect(h.service.forInstance(makeInstance(), makeResolved(17))).rejects.toMatchObject({
      code: 'unsupported'
    })
    expect(h.ensured()).toHaveLength(0)
  })

  it('custom mode refuses to download and throws java-missing', async () => {
    const h = harness({ settings: { javaMode: 'custom' } })
    await expect(h.service.forInstance(makeInstance(), makeResolved(17))).rejects.toMatchObject({
      code: 'java-missing'
    })
    expect(h.ensured()).toHaveLength(0)
  })

  it('peek performs the same search without downloading', async () => {
    seedJava('zulu8', V8)
    const h = harness()
    const result = await h.service.peek(makeInstance(), makeResolved(17))
    expect(result.runtime).toBeNull()
    expect(result.major).toBe(17)
    expect(h.ensured()).toHaveLength(0)
    expect(h.httpUrls).toHaveLength(0)

    const okPeek = await h.service.peek(makeInstance(), makeResolved(8))
    expect(okPeek.runtime?.major).toBe(8)
  })

  it('prefers javaw.exe over java.exe for launching', async () => {
    const root = path.join(tmp, 'runtimes', 'both17')
    touch(path.join(root, 'bin', 'java.exe'), 'j')
    touch(path.join(root, 'bin', 'javaw.exe'), 'w')
    RUNTIMES[path.join(root, 'bin', 'javaw.exe').toLowerCase()] = V17_TEMURIN
    const h = harness()
    const runtime = await h.service.forInstance(makeInstance(), makeResolved(17))
    expect(path.basename(runtime.executable)).toBe('javaw.exe')
  })

  it('scan()/list() include the provisioned runtime', async () => {
    seedJava('zulu8', V8)
    const h = harness()
    await h.service.provision({ major: 17 })
    const scanned = await h.service.scan()
    expect(scanned.some((r) => r.source === 'scan')).toBe(true)
    const list = await h.service.list()
    expect(list.some((r) => r.source === 'adoptium')).toBe(true)
    expect(list.some((r) => r.major === 8)).toBe(true)
  })
})

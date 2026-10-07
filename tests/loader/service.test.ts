import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { LoaderOption } from '@shared/ipc'
import { createLoaderService } from '../../src/main/loader/service'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { zipAll } from '../../src/main/core/zip'
import { readFixtureBuffer, readFixtureJson, makeStubHttp, makeRecordingDownloader, fakeLogger, fakeSettings, makeTempWorkspace, type TempWorkspace, type UrlResolver } from './helpers'
import type { LoaderProfileJson } from '../../src/main/loader/types'

let workspace: TempWorkspace
let cleanupPaths: string[] = []

beforeEach(() => {
  workspace = makeTempWorkspace('loader-svc')
  cleanupPaths.push(workspace.appData)
})
afterEach(() => {
  const base = path.dirname(workspace.appData)
  fs.rmSync(base, { recursive: true, force: true })
  void cleanupPaths
})

function makeService(resolver: UrlResolver) {
  const http = makeStubHttp(resolver)
  const downloader = makeRecordingDownloader()
  const instances = new InstanceStore(() => workspace.paths)
  const settings = fakeSettings()
  const service = createLoaderService({
    http,
    downloader,
    versions: {} as never,
    instances,
    settings,
    paths: workspace.paths,
    log: fakeLogger()
  })
  return { service, downloader, instances }
}

function fabricResolver(overrides: Partial<Record<string, unknown>> = {}): UrlResolver {
  return (url) => {
    if (url.startsWith(ENDPOINTS.fabricLoaderList)) return readFixtureJson('loader/fabric-loader-list-1.21.1.json')
    if (url.startsWith(ENDPOINTS.quiltLoaderList)) return readFixtureJson('loader/quilt-loader-list-1.21.1.json')
    if (url.startsWith(ENDPOINTS.legacyFabricMeta)) return readFixtureJson('loader/legacyfabric-loader-1.12.2.json')
    if (url.startsWith(ENDPOINTS.forgeMavenMetadata)) return readFixtureBuffer('loader/forge-maven-metadata.xml').toString('utf8')
    if (url.startsWith(ENDPOINTS.neoforgeMavenMetadata)) return readFixtureBuffer('loader/neoforge-maven-metadata.xml').toString('utf8')
    if (url.startsWith(ENDPOINTS.forgePromotions)) return readFixtureJson('loader/forge-promotions-slim.json')
    if (url.includes('/profile/json')) {
      if (url.startsWith(ENDPOINTS.fabricLoaderList)) return readFixtureJson('loader/fabric-profile-1.21.1.json')
      if (url.startsWith(ENDPOINTS.quiltLoaderList)) return readFixtureJson('loader/quilt-profile-1.21.1.json')
      if (url.startsWith(ENDPOINTS.legacyFabricMeta)) return readFixtureJson('loader/legacyfabric-profile-1.12.2.json')
    }
    for (const [key, value] of Object.entries(overrides)) if (url.includes(key)) return value
    throw new Error(`unmapped url: ${url}`)
  }
}

describe('options()', () => {
  it('lists all reachable providers and offers optifine as a manual entry', async () => {
    const { service } = makeService(fabricResolver())
    const options = await service.options('1.21.1')
    const ids = options.map((o) => o.id)
    expect(ids).toContain('fabric')
    expect(ids).toContain('quilt')
    expect(ids).toContain('legacy-fabric')
    expect(ids).toContain('forge')
    expect(ids).toContain('neoforge')
    const optifine = options.find((o) => o.id === 'optifine')!
    expect(optifine.versions).toEqual([])
  })

  it('marks the promotions recommended + latest forge builds', async () => {
    const { service } = makeService(fabricResolver())
    const options = await service.options('1.20.1')
    const forge = options.find((o) => o.id === 'forge')!
    // promotions_slim.json 1.20.1-recommended = 47.4.10, latest = 47.4.26
    const rec = forge.versions.find((v) => v.recommended)
    const latest = forge.versions.find((v) => v.stable && !v.recommended)
    expect(rec?.version).toBe('1.20.1-47.4.10')
    expect(latest?.version).toBe('1.20.1-47.4.26')
  })

  it('drops legacy-fabric from options when its meta host is unreachable', async () => {
    const resolver: UrlResolver = (url) => {
      if (url.startsWith(ENDPOINTS.legacyFabricMeta)) throw new AppError('network', 'legacy fabric unreachable')
      return fabricResolver()(url)
    }
    const { service } = makeService(resolver)
    const options = await service.options('1.12.2')
    expect(options.map((o: LoaderOption) => o.id)).not.toContain('legacy-fabric')
    expect(options.map((o: LoaderOption) => o.id)).toContain('fabric')
  })
})

describe('install() fabric', () => {
  it('writes the version json and repoints the instance', async () => {
    const profile = readFixtureJson<LoaderProfileJson>('loader/fabric-profile-1.21.1.json')
    const { service, downloader, instances } = makeService((url) => {
      if (url.includes('/profile/json')) return profile
      throw new Error('unmapped ' + url)
    })
    const instance = instances.create({ name: 'demo', versionId: '1.21.1', gameVersion: '1.21.1' })
    const job = await service.install(instance.id, 'fabric', '0.19.5')

    expect(job.status).toBe('done')
    const jsonFile = path.join(workspace.paths.versionsDir, 'fabric-loader-0.19.5-1.21.1', 'fabric-loader-0.19.5-1.21.1.json')
    expect(fs.existsSync(jsonFile)).toBe(true)
    const written = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as { id: string }
    expect(written.id).toBe('fabric-loader-0.19.5-1.21.1')

    const updated = instances.require(instance.id)
    expect(updated.versionId).toBe('fabric-loader-0.19.5-1.21.1')
    expect(updated.loader).toBe('fabric')
    expect(updated.loaderVersion).toBe('0.19.5')

    // The library plan targets the shared libraries dir via the fabric maven repo.
    const plan = downloader.plans[0]!
    expect(plan.kind).toBe('fabric')
    expect(plan.items.some((i) => i.url.startsWith(ENDPOINTS.fabricMaven))).toBe(true)
  })
})

describe('install() forge', () => {
  function placeInstaller(loader: 'forge' | 'neoforge', version: string, members: Record<string, unknown>): string {
    const dir =
      loader === 'forge'
        ? path.join(workspace.paths.librariesDir, 'net', 'minecraftforge', 'forge', version)
        : path.join(workspace.paths.librariesDir, 'net', 'neoforged', 'forge', version)
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `forge-${version}-installer.jar`)
    const zip: Record<string, Uint8Array> = {}
    for (const [name, value] of Object.entries(members)) zip[name] = Buffer.from(JSON.stringify(value), 'utf8')
    fs.writeFileSync(target, Buffer.from(zipAll(zip)))
    return target
  }

  it('reads install_profile.json + version.json from the real installer jar, writes the json, repoints', async () => {
    const installProfile = readFixtureJson('loader/forge-install_profile.json')
    const versionJson = readFixtureJson('loader/forge-version.json')
    placeInstaller('forge', '1.21.1-52.1.0', {
      'install_profile.json': installProfile,
      'version.json': versionJson
    })
    const { service, downloader, instances } = makeService(() => {
      throw new Error('forge install should not hit http.json')
    })
    const instance = instances.create({ name: 'forge', versionId: '1.21.1', gameVersion: '1.21.1' })
    const job = await service.install(instance.id, 'forge', '1.21.1-52.1.0')
    expect(job.status).toBe('done')

    const jsonFile = path.join(workspace.paths.versionsDir, '1.21.1-forge-52.1.0', '1.21.1-forge-52.1.0.json')
    expect(fs.existsSync(jsonFile)).toBe(true)
    const updated = instances.require(instance.id)
    expect(updated.versionId).toBe('1.21.1-forge-52.1.0')
    expect(updated.loader).toBe('forge')

    const plan = downloader.plans[0]!
    expect(plan.after).toBe('run-installer')
    expect((plan.afterPayload as { commands: unknown[] }).commands.length).toBeGreaterThan(0)
  })

  it('rejects a legacy installer with no processors', async () => {
    placeInstaller('forge', '1.8.9-11.15.1.2318-1.8.9', {
      'install_profile.json': {
        version: '1.8.9-11.15.1.2318-1.8.9',
        minecraft: '1.8.9',
        versionInfo: { id: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9' },
        libraries: []
      }
    })
    const { service, instances } = makeService(() => {
      throw new Error('no http')
    })
    const instance = instances.create({ name: 'legacy', versionId: '1.8.9', gameVersion: '1.8.9' })
    await expect(service.install(instance.id, 'forge', '1.8.9-11.15.1.2318-1.8.9')).rejects.toThrow(AppError)
  })

  it('optifine install is a documented manual path (unsupported)', async () => {
    const { service, instances } = makeService(fabricResolver())
    const instance = instances.create({ name: 'of', versionId: '1.20.1', gameVersion: '1.20.1' })
    await expect(service.install(instance.id, 'optifine', 'HD_U_I6')).rejects.toThrow(/OptiFine/)
  })
})

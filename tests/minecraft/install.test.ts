import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { DownloadItem } from '@shared/types'
import { assetIndexPath, assetObjectPath, libraryPath, nativesDir, versionJarPath } from '../../src/main/core/paths'
import { assetObjectUrl } from '../../src/main/minecraft/assets'
import { loggingClientPath } from '../../src/main/minecraft/arguments'
import {
  ANCIENT,
  ANCIENT_NATIVE_REL,
  ASSET_A_SHA,
  CLIENT_SHA,
  GSON_SHA,
  MODERN,
  NATIVES_ZIP,
  createTestEnv,
  type TestEnv
} from './fixtures'

let env: TestEnv | undefined
afterEach(() => {
  env?.cleanup()
  env = undefined
})

function itemsByKind(items: DownloadItem[], kind: DownloadItem['kind']): DownloadItem[] {
  return items.filter((i) => i.kind === kind)
}

describe('installPlan', () => {
  it('covers json, client jar (sha1+size), libraries, natives, asset index + objects, log xml', async () => {
    env = createTestEnv()
    env.writeVersionJson(MODERN)
    env.writeAssetIndex('36', JSON.stringify({ objects: { 'minecraft/sounds/a.ogg': { hash: ASSET_A_SHA, size: 11 } } }))

    const plan = await env.versions.installPlan({ id: '26.3' })
    expect(plan.items.length).toBeGreaterThan(0)

    // Local version json present -> no version-json download.
    expect(itemsByKind(plan.items, 'version-json')).toEqual([])

    const jar = plan.items.find((i) => i.kind === 'client-jar')
    expect(jar?.target).toBe(versionJarPath(env.paths, '26.3'))
    expect(jar?.sha1).toBe(CLIENT_SHA)
    expect(jar?.size).toBeGreaterThan(0)

    const libs = itemsByKind(plan.items, 'library').map((i) => i.id)
    expect(libs).toContain(libraryPath(env.paths, 'com/google/code/gson/gson/2.11.0/gson-2.11.0.jar'))
    expect(libs.some((l) => l.includes('deny-me'))).toBe(false)

    const natives = itemsByKind(plan.items, 'natives')
    expect(natives[0]?.target).toBe(
      libraryPath(env.paths, 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar')
    )

    const index = itemsByKind(plan.items, 'asset-index')
    expect(index[0]?.target).toBe(assetIndexPath(env.paths, '36'))
    expect(index[0]?.sha1).toBe(MODERN.assetIndex?.sha1)

    const assets = itemsByKind(plan.items, 'asset')
    expect(assets).toHaveLength(1)
    expect(assets[0]?.target).toBe(assetObjectPath(env.paths, ASSET_A_SHA))
    expect(assets[0]?.url).toBe(assetObjectUrl(ASSET_A_SHA))

    const xml = plan.items.find((i) => i.target === loggingClientPath(env!.paths, 'client'))
    expect(xml).toBeDefined()
    expect(plan.after).toBe('extract-natives')

    // Every target is unique.
    const ids = plan.items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('legacy plan: minecraftArguments json still yields jar/libs/natives/objects', async () => {
    env = createTestEnv()
    env.writeVersionJson(ANCIENT)
    env.writeAssetIndex('legacy', JSON.stringify({ map_to_resources: true, 'mob/step1.ogg': ASSET_A_SHA }))
    const plan = await env.versions.installPlan({ id: '1.5.2' })
    expect(itemsByKind(plan.items, 'client-jar')[0]?.sha1).toBe(ANCIENT.downloads?.client?.sha1)
    const natives = itemsByKind(plan.items, 'natives')
    expect(natives).toHaveLength(1)
    expect(natives[0]!.target.replace(/\\/g, '/')).toContain(ANCIENT_NATIVE_REL)
    const assets = itemsByKind(plan.items, 'asset')
    expect(assets[0]?.sha1).toBe(ASSET_A_SHA)
    expect(assets[0]?.size).toBeUndefined()
  })
})

describe('install + checkInstalled + repair', () => {
  it('install() lands every file, extracts natives, writes virtual copies, optionally creates the instance', async () => {
    env = createTestEnv()
    await env.installFiles('1.5.2')

    expect(fs.existsSync(versionJarPath(env.paths, '1.5.2'))).toBe(true)
    expect(fs.existsSync(assetObjectPath(env.paths, ASSET_A_SHA))).toBe(true)
    // map_to_resources -> virtual copies exist next to the objects.
    expect(
      fs.existsSync(path.join(env.paths.assetsDir, 'virtual', 'legacy', 'mob/step2.ogg'))
    ).toBe(true)
    // Legacy natives jar downloaded (url = libraries dir path) and extracted.
    const nativeJar = path.join(env.paths.librariesDir, ANCIENT_NATIVE_REL.split('/').join(path.sep))
    expect(fs.existsSync(nativeJar)).toBe(true)
    const check = await env.versions.checkInstalled('1.5.2')
    expect(check.ok).toBe(true)
    expect(check.sizeBytes).toBeGreaterThan(0)
  }, 30_000)

  it('creates the instance after files land when createInstance is set', async () => {
    env = createTestEnv()
    await env.installFiles('26.3')
    // installFiles() installs without an instance; use the service with createInstance.
    const outcome = await env.versions.install({ id: '26.3', createInstance: true, instanceName: 'My 26.3' })
    expect(outcome.job.status).toBe('done')
    expect(outcome.versionId).toBe('26.3')
    expect(outcome.instance?.versionId).toBe('26.3')
    expect(outcome.instance?.name).toBe('My 26.3')
    expect(outcome.instance?.gameVersion).toBe('26.3')
  }, 30_000)

  it('checkInstalled flags the broken library as missing; repair() re-fetches it', async () => {
    env = createTestEnv()
    await env.installFiles('26.3')
    const gsonJar = libraryPath(env.paths, 'com/google/code/gson/gson/2.11.0/gson-2.11.0.jar')
    expect(fs.existsSync(gsonJar)).toBe(true)
    fs.writeFileSync(gsonJar, 'CORRUPT')

    const check = await env.versions.checkInstalled('26.3')
    expect(check.ok).toBe(false)
    expect(check.missing).toHaveLength(1)
    expect(check.missing[0]!.target).toBe(gsonJar)
    expect(check.missing[0]!.sha1).toBe(GSON_SHA)

    const job = await env.versions.repair('26.3')
    expect(job.status).toBe('done')
    const lastPlan = env.downloader.plans.at(-1)!
    expect(lastPlan.title).toBe('修复 26.3')
    expect(lastPlan.items).toHaveLength(1)
    expect(await env.versions.checkInstalled('26.3')).toMatchObject({ ok: true })
  }, 30_000)

  it('modern install unpacks the natives jar into <versions>/<id>/natives-windows', async () => {
    env = createTestEnv()
    await env.installFiles('26.3')
    const ndir = nativesDir(env.paths, '26.3')
    expect(fs.existsSync(path.join(ndir, 'lwjgl.dll'))).toBe(true)
    expect(fs.existsSync(path.join(ndir, 'META-INF', 'OK.SF'))).toBe(false)
    expect(fs.existsSync(path.join(ndir, '.mouc.marker'))).toBe(true)
    // sanity: the zip used for extraction was the real fixture
    expect(fs.readFileSync(path.join(env.paths.librariesDir, 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'))).toEqual(NATIVES_ZIP)
  }, 30_000)

  it('uninstall removes the version directory', async () => {
    env = createTestEnv()
    await env.installFiles('26.3')
    await env.versions.uninstall('26.3')
    expect(fs.existsSync(versionJarPath(env.paths, '26.3'))).toBe(false)
    expect((await env.versions.installed()).includes('26.3')).toBe(false)
  }, 30_000)
})

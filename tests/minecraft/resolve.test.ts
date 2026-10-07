import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ENDPOINTS } from '@shared/constants'
import { versionJsonPath, versionJarPath } from '../../src/main/core/paths'
import { createTestEnv, readJsonFile, LOADER_FABRIC, MODERN, PARENT_1201, URLS, type TestEnv } from './fixtures'

let env: TestEnv | undefined
afterEach(() => {
  env?.cleanup()
  env = undefined
})

describe('resolve() without inheritance', () => {
  it('reads the local <versions>/<id>/<id>.json and maps the 26.3 schema', async () => {
    env = createTestEnv()
    env.writeVersionJson(MODERN)
    const resolved = await env.versions.resolve('26.3')

    expect(resolved.id).toBe('26.3')
    expect(resolved.type).toBe('release')
    expect(resolved.mainClass).toBe('net.minecraft.client.main.Main')
    expect(resolved.javaVersion).toEqual({ component: 'java-runtime-epsilon', majorVersion: 25 })
    expect(resolved.assetIndex?.id).toBe('36')
    expect(resolved.assetsVersion).toBe('36')
    expect(resolved.client?.url).toBe('https://piston-data.mojang.com/v1/objects/' +
      resolved.client?.sha1 + '/client.jar')
    expect(resolved.logging?.client?.argument).toBe('-Dlog4j.configurationFile=${path}')
    expect(resolved.jsonPath).toBe(versionJsonPath(env.paths, '26.3'))
    expect(resolved.clientJarPath).toBe(versionJarPath(env.paths, '26.3'))
    expect(resolved.usesVanillaJarOf).toBeUndefined()
    // No network use beyond the manifest (never needed: local json wins).
    expect(env.http.calls.filter((u) => u !== ENDPOINTS.versionManifest)).toEqual([])
  })

  it('downloads ref.url when the version json is missing and caches the merge', async () => {
    env = createTestEnv()
    const resolved = await env.versions.resolve('26.3')
    expect(env.http.calls).toContain(URLS.modernJson)
    expect(resolved.mainClass).toContain('Main')

    const cacheFile = path.join(env.paths.configDir, 'cache', 'resolved', '26.3.json')
    expect(fs.existsSync(cacheFile)).toBe(true)

    // Mojang's own json was NOT written by resolve; the merged doc lives in the cache only.
    expect(fs.existsSync(versionJsonPath(env.paths, '26.3'))).toBe(false)
  })
})

describe('inheritance merge', () => {
  async function prepareLoader(): Promise<TestEnv> {
    env = createTestEnv()
    env.writeVersionJson(PARENT_1201)
    env.writeVersionJson(LOADER_FABRIC)
    return env
  }

  it('dedupes libraries with the child entry winning, even when it denies', async () => {
    await prepareLoader()
    const resolved = await env!.versions.resolve('1.20.1-fabric')

    const names = resolved.libraries.map((l) => l.name)
    expect(names.filter((n) => n === 'com.google.code.gson:gson:2.10.0')).toHaveLength(1)
    const gson = resolved.libraries.find((l) => l.name === 'com.google.code.gson:gson:2.10.0')
    // The surviving entry is the child's deny-rule override, not the parent's artifact entry.
    expect(gson?.rules?.some((r) => r.action === 'deny')).toBe(true)
    expect(gson?.downloads).toBeUndefined()
    expect(names[0]).toBe('net.fabricmc:fabric-loader:0.15.0')
    expect(names).toContain('org.lwjgl:lwjgl:3.3.3')
  })

  it('appends child game args after the parent ones but takes jvm wholesale from the parent', async () => {
    await prepareLoader()
    const resolved = await env!.versions.resolve('1.20.1-fabric')

    const game = resolved.gameArgs.filter((a): a is string => typeof a === 'string')
    expect(game).toEqual(['--username', '${auth_player_name}', '--version', '${version_name}', '--fabricArg'])

    // The child has no arguments.jvm at all -> the parent's jvm list survives unchanged.
    expect(resolved.jvmArgs).toEqual(PARENT_1201.arguments?.jvm)
  })

  it('mainClass comes from the child, downloads/assets from the parent, jar reference pinned', async () => {
    await prepareLoader()
    const resolved = await env!.versions.resolve('1.20.1-fabric')

    expect(resolved.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(resolved.client?.sha1).toBe(PARENT_1201.downloads?.client?.sha1)
    expect(resolved.assetsVersion).toBe('36')
    expect(resolved.javaVersion.majorVersion).toBe(17)
    expect(resolved.usesVanillaJarOf).toBe('1.20.1')
    expect(resolved.clientJarPath).toBe(versionJarPath(env!.paths, '1.20.1'))

    // The loader's own json on disk must stay byte-identical (no merged overwrite).
    const onDisk = readJsonFile(versionJsonPath(env!.paths, '1.20.1-fabric')) as Record<string, unknown>
    expect(onDisk.inheritsFrom).toBe('1.20.1')
    expect((onDisk.libraries as unknown[]).length).toBe(2)
  })

  it('resolves a loader profile whose parent only exists on the network', async () => {
    env = createTestEnv()
    env.writeVersionJson(LOADER_FABRIC)
    const resolved = await env.versions.resolve('1.20.1-fabric')
    expect(resolved.javaVersion.majorVersion).toBe(17)
    expect(resolved.libraries.map((l) => l.name)).toContain('org.lwjgl:lwjgl:3.3.3')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ENDPOINTS, MANIFEST_CACHE_MS } from '@shared/constants'
import type { VersionType } from '@shared/types'
import { manifestCacheFile } from '../../src/main/minecraft/manifest'
import { createVersionService } from '../../src/main/minecraft/version'
import { createTestEnv, type TestEnv } from './fixtures'

let env: TestEnv | undefined
afterEach(() => {
  env?.cleanup()
  env = undefined
})

describe('version manifest', () => {
  it('serves the first list() from the network, later ones from cache', async () => {
    env = createTestEnv()
    const first = await env.versions.list()
    const primaryCalls = env.http.calls.filter((u) => u === ENDPOINTS.versionManifest).length
    expect(primaryCalls).toBe(1)
    expect(first[0]!.id).toBe('26.4-snapshot-3')

    const second = await env.versions.list()
    expect(env.http.calls.filter((u) => u === ENDPOINTS.versionManifest).length).toBe(1)
    expect(second.map((v) => v.id)).toEqual(first.map((v) => v.id))

    // The cache document lives under <configDir>/cache/version_manifest.json.
    const cacheFile = manifestCacheFile(env.paths)
    expect(fs.existsSync(cacheFile)).toBe(true)
  })

  it('refresh(true) bypasses the fresh cache', async () => {
    env = createTestEnv()
    await env.versions.list()
    await env.versions.refresh(true)
    expect(env.http.calls.filter((u) => u === ENDPOINTS.versionManifest).length).toBe(2)
  })

  it('refetches once the cache is older than MANIFEST_CACHE_MS', async () => {
    env = createTestEnv()
    await env.versions.list()
    const cacheFile = manifestCacheFile(env.paths)
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { fetchedAt: number }
    raw.fetchedAt = Date.now() - MANIFEST_CACHE_MS - 1_000
    fs.writeFileSync(cacheFile, JSON.stringify(raw), 'utf8')
    // A fresh service = a new launcher process reading the stale on-disk cache.
    const second = createVersionService(env.deps)
    await second.list()
    expect(env.http.calls.filter((u) => u === ENDPOINTS.versionManifest).length).toBe(2)
  })

  it('falls back to the legacy host when the primary endpoint fails', async () => {
    env = createTestEnv()
    env.http.failPrimaryManifest = true
    const refs = await env.versions.refresh(true)
    expect(env.http.calls).toContain(ENDPOINTS.versionManifest)
    expect(env.http.calls).toContain(ENDPOINTS.versionManifestLegacy)
    expect(refs.length).toBeGreaterThan(0)
  })

  it('hides old_beta/old_alpha unless requested and sorts descending', async () => {
    env = createTestEnv()
    const defaultList = await env.versions.list()
    expect(defaultList.map((v) => v.id)).toEqual(['26.4-snapshot-3', '26.3', '1.20.1', '1.5.2'])

    const withBeta: VersionType[] = ['old_beta']
    const betaList = await env.versions.list(withBeta)
    expect(betaList.map((v) => v.id)).toEqual(['b1.9'])

    const releases = await env.versions.list(['release'])
    expect(releases.map((v) => v.id)).toEqual(['26.3', '1.20.1', '1.5.2'])
  })

  it('installed() lists version dirs that own a <id>.json, sorted desc', async () => {
    env = createTestEnv()
    env.writeVersionJson({ id: '1.5.2', mainClass: 'x' })
    env.writeVersionJson({ id: '26.3', mainClass: 'x' })
    // A dir without its json must not count as installed.
    fs.mkdirSync(path.join(env.paths.versionsDir, 'broken'), { recursive: true })
    expect(await env.versions.installed()).toEqual(['26.3', '1.5.2'])
  })
})

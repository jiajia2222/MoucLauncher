import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OFFICIAL_HOSTS } from '@shared/constants'
import { assetObjectPath } from '../../src/main/core/paths'
import {
  assetIndexItem,
  assetObjectItems,
  assetObjectUrl,
  assetObjects,
  mapsToResources,
  virtualAssetsDir,
  writeVirtualCopies,
  type AssetIndexDoc
} from '../../src/main/minecraft/assets'
import { createTestEnv, INDEX_LEGACY_DOC, INDEX_MODERN_DOC, type TestEnv } from './fixtures'

let env: TestEnv | undefined
afterEach(() => {
  env?.cleanup()
  env = undefined
})

describe('asset index parsing', () => {
  it('parses the modern { objects: { name: {hash,size} } } shape', () => {
    const objects = assetObjects(INDEX_MODERN_DOC as unknown as AssetIndexDoc)
    expect(objects).toHaveLength(2)
    const a = objects.find((o) => o.name === 'minecraft/sounds/a.ogg')
    expect(a?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(a?.size).toBe(11)
  })

  it('parses pre-1.7.3 indexes whose values are bare hash strings', () => {
    const objects = assetObjects(INDEX_LEGACY_DOC as unknown as AssetIndexDoc)
    expect(objects).toHaveLength(2)
    expect(objects.every((o) => /^[0-9a-f]{40}$/.test(o.hash))).toBe(true)
    expect(objects.every((o) => o.size === undefined)).toBe(true)
  })

  it('detects map_to_resources indexes and builds virtual paths', () => {
    expect(mapsToResources(INDEX_LEGACY_DOC as unknown as AssetIndexDoc)).toBe(true)
    expect(mapsToResources(INDEX_MODERN_DOC as unknown as AssetIndexDoc)).toBe(false)
    env = createTestEnv()
    expect(virtualAssetsDir(env.paths, 'legacy')).toBe(path.join(env.paths.assetsDir, 'virtual', 'legacy'))
  })

  it('writes named copies for a map_to_resources index', async () => {
    env = createTestEnv()
    const objects = assetObjects(INDEX_LEGACY_DOC as unknown as AssetIndexDoc)
    for (const o of objects) {
      const target = assetObjectPath(env.paths, o.hash)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from(`content-of-${o.hash}`))
    }
    const written = await writeVirtualCopies(env.paths, 'legacy', objects)
    expect(written).toBe(2)
    expect(fs.existsSync(path.join(env.paths.assetsDir, 'virtual', 'legacy', 'mob/step1.ogg'))).toBe(true)
    // Idempotent: the second run copies nothing.
    expect(await writeVirtualCopies(env.paths, 'legacy', objects)).toBe(0)
  })
})

describe('asset download items', () => {
  it('index item targets assets/indexes/<id>.json with sha1+size', () => {
    env = createTestEnv()
    const item = assetIndexItem(
      { id: '36', sha1: 'abc', size: 123, url: 'https://meta.example/36.json' },
      env.paths
    )
    expect(item.target).toBe(path.join(env.paths.assetsDir, 'indexes', '36.json'))
    expect(item.kind).toBe('asset-index')
    expect(item.sha1).toBe('abc')
    expect(item.size).toBe(123)
  })

  it('object items use the resources host + hashed-objects layout', () => {
    env = createTestEnv()
    const objects = assetObjects(INDEX_MODERN_DOC as unknown as AssetIndexDoc)
    const items = assetObjectItems(objects, env.paths)
    expect(items).toHaveLength(2)
    for (const item of items) {
      const hash = item.sha1!
      expect(item.url).toBe(`https://${OFFICIAL_HOSTS.resources}/${hash.slice(0, 2)}/${hash}`)
      expect(item.target).toBe(assetObjectPath(env!.paths, hash))
      expect(item.kind).toBe('asset')
    }
    const probe = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    expect(assetObjectUrl(probe)).toBe(`https://${OFFICIAL_HOSTS.resources}/de/${probe}`)
  })
})

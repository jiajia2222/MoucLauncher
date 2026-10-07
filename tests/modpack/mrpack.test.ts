import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clientVisible, parseMrpackIndex, readMrpack } from '../../src/main/modpack/mrpack'
import { detect } from '../../src/main/modpack/detect'
import { cleanup, makeHarness, mrpackIndexText, writeZip, type Harness, type HarnessOptions } from './helpers'

let harness: Harness | undefined

async function newHarness(text: string, options: HarnessOptions = {}): Promise<Harness> {
  harness = makeHarness(options)
  await writeZip(path.join(harness.root, 'pack.mrpack'), {
    'modrinth.index.json': text,
    'overrides/': '',
    'overrides/options.txt': 'lang:zh_cn\n',
    'overrides/config/fabric/lobbies.yaml': 'a: 1\n',
    'overrides/resourcepacks/pack.zip': 'PK',
    'overrides/../escape.txt': 'nope',
    'overrides/C:/Windows/system.ini': 'nope'
  })
  return harness
}

afterEach(async () => {
  if (harness) await cleanup(harness)
  harness = undefined
})

describe('mrpack index parsing', () => {
  it('reads the real schema (versionId + dependencies map)', () => {
    const index = parseMrpackIndex(mrpackIndexText(), 'modrinth.index.json')
    expect(index.gameVersion).toBe('1.21.4')
    expect(index.loader).toEqual({ id: 'fabric', version: '0.16.14' })
    expect(index.version).toBe('8.1.0')
    // mrpack 1.0 has no author field; the parser falls back to the platform name.
    expect(index.author).toBe('Modrinth')
    expect(index.files).toHaveLength(6)
    expect(index.overrides).toBe('overrides')
  })

  it('still accepts the legacy draft shape', () => {
    const legacy = JSON.stringify({
      name: 'Old Pack',
      author: 'someone',
      version: '1.0',
      game: { minecraft: { version: '1.16.5' } },
      loader: { id: 'forge', version: '36.2.39' },
      overrides: 'overrides',
      files: [{ path: 'mods/a.jar', hashes: { sha1: 'aa' }, env: { client: true, server: false }, downloads: ['https://x/a.jar'] }]
    })
    const index = parseMrpackIndex(legacy, 'mrmodpack.json')
    expect(index.gameVersion).toBe('1.16.5')
    expect(index.loader).toEqual({ id: 'forge', version: '36.2.39' })
    expect(index.version).toBe('1.0')
    expect(index.author).toBe('someone')
    expect(clientVisible(index.files[0]!)).toBe(true)
  })

  it('treats env.client=unsupported / false as server-only', () => {
    expect(clientVisible({ path: 'mods/a.jar', env: { client: 'unsupported', server: 'required' } })).toBe(false)
    expect(clientVisible({ path: 'mods/a.jar', env: { client: false } })).toBe(false)
    expect(clientVisible({ path: 'mods/a.jar', env: { client: 'optional', server: 'unsupported' } })).toBe(true)
    expect(clientVisible({ path: 'mods/a.jar' })).toBe(true)
  })

  it('rejects an index without a minecraft version', () => {
    expect(() => parseMrpackIndex('{"files":[]}', 'modrinth.index.json')).toThrowError(/Minecraft 版本/)
    expect(() => parseMrpackIndex('{oops', 'modrinth.index.json')).toThrowError(/JSON/)
  })

  it('opens a real archive through core/zip', async () => {
    const h = await newHarness(mrpackIndexText())
    const { index, zip } = await readMrpack(path.join(h.root, 'pack.mrpack'))
    await zip.close()
    expect(index.member).toBe('modrinth.index.json')
    expect(detect(path.join(h.root, 'pack.mrpack'))).toBe('mrpack')
  })
})

describe('mrpack import', () => {
  it('creates the instance, lands overrides, installs the version and queues client files', async () => {
    const h = await newHarness(mrpackIndexText())
    const file = path.join(h.root, 'pack.mrpack')
    const result = await h.service.import({ file, format: 'mrpack', name: '幻想优化' })

    // instance
    expect(result.instance.name).toBe('幻想优化')
    expect(result.instance.isolated).toBe(true)
    expect(result.instance.gameVersion).toBe('1.21.4')
    expect(result.instance.loader).toBe('fabric')
    expect(result.instance.loaderVersion).toBe('0.16.14')
    const gameDir = path.join(h.gameRoot, 'instances', result.instance.id)
    expect(fs.existsSync(gameDir)).toBe(true)

    // version + loader request
    expect(h.installRequests).toHaveLength(1)
    expect(h.installRequests[0]).toMatchObject({ id: '1.21.4', loader: { id: 'fabric', version: '0.16.14' } })

    // overrides, prefix stripped
    expect(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8')).toContain('lang:zh_cn')
    expect(fs.readFileSync(path.join(gameDir, 'config', 'fabric', 'lobbies.yaml'), 'utf8')).toContain('a: 1')
    expect(fs.existsSync(path.join(gameDir, 'resourcepacks', 'pack.zip'))).toBe(true)
    // traversal-safe: nothing escaped the instance dir
    expect(fs.existsSync(path.join(h.root, 'escape.txt'))).toBe(false)
    expect(fs.existsSync(path.join(gameDir, 'C:'))).toBe(false)
    expect(fs.existsSync(path.join(h.gameRoot, 'escape.txt'))).toBe(false)

    // queued downloads
    expect(h.plans).toHaveLength(1)
    const plan = h.plans[0]!
    expect(plan.kind).toBe('modpack')
    const paths = plan.items.map((i) => i.target)
    expect(paths).toHaveLength(5)
    expect(paths.every((p) => p.startsWith(gameDir))).toBe(true)
    expect(paths.some((p) => p.endsWith(path.join('mods', 'server-only-example.jar')))).toBe(false)
    expect(plan.items.map((i) => path.basename(i.target))).toEqual([
      'BetterGrassify-1.7.0+fabric.1.21.4.jar',
      'Debugify-1.21.4+1.1.jar',
      'ForgeConfigAPIPort-v21.4.1-1.21.4-Fabric.jar',
      'ImmediatelyFast-Fabric-1.8.0+1.21.4.jar',
      'Mod Menu Helper.zip'
    ])
    const first = plan.items[0]!
    expect(first.sha1).toBe('8bada432a857ce7af3772f60a19901ca85f3dfb3')
    expect(first.size).toBe(155059)
    expect(first.kind).toBe('mod')
    const rp = plan.items[4]!
    expect(rp.kind).toBe('resource-pack')
    expect(rp.fallbackUrls).toEqual(['https://download.modrinth.cn/data/EXAMPLE/versions/EXAMPLE/Mod%20Menu%20Helper.zip'])
    // manifest.files is what the pack declares (6); the job only queues the 5 client ones.
    expect(result.manifest.files).toBe(6)
    expect(result.job.total).toBe(5)
  })

  it('points the instance at the loader-patched version id', async () => {
    const h = await newHarness(mrpackIndexText(), { installsAs: '1.21.4-fabric-0.16.14' })
    const result = await h.service.import({ file: path.join(h.root, 'pack.mrpack'), format: 'mrpack', name: 'P' })
    expect(result.instance.versionId).toBe('1.21.4-fabric-0.16.14')
    expect(result.instance.loader).toBe('fabric')
  })

  it('keeps the instance and surfaces an error job when the version install fails', async () => {
    const h = await newHarness(mrpackIndexText(), { installError: new Error('offline') })
    const result = await h.service.import({ file: path.join(h.root, 'pack.mrpack'), format: 'mrpack', name: 'P' })
    expect(result.job.status).toBe('error')
    expect(result.job.error?.message).toContain('offline')
    expect(result.instance.versionId).toBe('1.21.4')
    expect(fs.existsSync(path.join(h.gameRoot, 'instances', result.instance.id, 'options.txt'))).toBe(true)
    expect(h.plans).toHaveLength(0)
  })

  it('skips every server-only file and reports the manifest counts', async () => {
    const text = mrpackIndexText((json) => {
      json.files = [
        { path: 'mods/client.jar', hashes: { sha1: 'a'.repeat(40) }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://cdn/x/client.jar'], fileSize: 1 },
        { path: 'mods/server.jar', hashes: { sha1: 'b'.repeat(40) }, env: { client: 'unsupported', server: 'required' }, downloads: ['https://cdn/x/server.jar'], fileSize: 1 },
        { path: 'mods/both.jar', downloads: ['https://cdn/x/both.jar'] }
      ]
      return json
    })
    const h = await newHarness(text)
    const result = await h.service.import({ file: path.join(h.root, 'pack.mrpack'), format: 'mrpack', name: 'P' })
    const queued = h.plans[0]!.items.map((i) => path.basename(i.target))
    expect(queued).toEqual(['client.jar', 'both.jar'])
    expect(result.manifest.files).toBe(3)
  })

  it('refuses an archive without an index and falls back to the declared format', async () => {
    const h = makeHarness()
    const file = await writeZip(path.join(h.root, 'nope.zip'), { 'readme.txt': 'hi' })
    await expect(h.service.import({ file, format: 'mrpack', name: 'P' })).rejects.toThrow(/modrinth.index.json/)
    await cleanup(h)
  })
})

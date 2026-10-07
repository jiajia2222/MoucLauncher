import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { curseFileEntries, detect, detectWithZip, hasMember, listMembers } from '../../src/main/modpack/detect'
import { mrpackIndexText, CURSE_MANIFEST, MULTIMC_INSTANCE_CFG, writeZip } from './helpers'

let root = ''
const pack = (name: string, members: Record<string, string>): Promise<string> =>
  writeZip(path.join(root, name), members)

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-detect-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('modpack detection', () => {
  it('reads only the central directory, not the payload', async () => {
    const file = await pack('members.zip', {
      'modrinth.index.json': mrpackIndexText(),
      'overrides/config/a.toml': 'x = 1',
      'big/blob.bin': 'y'.repeat(50_000)
    })
    const members = listMembers(file)
    expect(members?.map((m) => m.name)).toEqual(
      expect.arrayContaining(['modrinth.index.json', 'overrides/config/a.toml', 'big/blob.bin'])
    )
    expect(members?.find((m) => m.name === 'modrinth.index.json')?.uncompressedSize).toBeGreaterThan(100)
  })

  it('detects mrpack by modrinth.index.json', async () => {
    const file = await pack('real.mrpack', { 'modrinth.index.json': mrpackIndexText(), 'overrides/options.txt': 'lang:zh_cn' })
    expect(detect(file)).toBe('mrpack')
    expect(await detectWithZip(file)).toBe('mrpack')
  })

  it('accepts the legacy mrmodpack.json name', async () => {
    const file = await pack('legacy.mrpack', { 'mrmodpack.json': JSON.stringify({ name: 'x', files: [] }) })
    expect(detect(file)).toBe('mrpack')
  })

  it('detects curse-zip only when manifest.json carries projectID/fileID', async () => {
    const curse = await pack('curse.zip', { 'manifest.json': CURSE_MANIFEST, 'overrides/config/b.txt': 'hi' })
    expect(detect(curse)).toBe('curse-zip')
    expect(await detectWithZip(curse)).toBe('curse-zip')

    const unrelated = await pack('random.zip', {
      'manifest.json': JSON.stringify({ name: 'resource pack', type: 'minecraft:resource_pack' }),
      'pack.mcmeta': '{}'
    })
    expect(detect(unrelated)).toBeUndefined()
    expect(curseFileEntries('{"files":[{"projectID":1,"fileID":2}]}')).toEqual([{ projectID: 1, fileID: 2, required: undefined }])
    expect(curseFileEntries('{"files":[{"projectID":1}]}')).toEqual([])
    expect(curseFileEntries('not json')).toEqual([])
  })

  it('detects zip-multimc from instance.cfg or mmc-pack.json, flat or nested', async () => {
    const flat = await pack('flat.zip', { 'instance.cfg': MULTIMC_INSTANCE_CFG, 'mods/a.jar': 'A' })
    expect(detect(flat)).toBe('zip-multimc')
    const nested = await pack('nested.zip', { '老伙伴/instance.cfg': MULTIMC_INSTANCE_CFG, '老伙伴/mods/a.jar': 'A' })
    expect(detect(nested)).toBe('zip-multimc')
    const packJsonOnly = await pack('packjson.zip', { 'mmc-pack.json': '{"components":[]}' })
    expect(detect(packJsonOnly)).toBe('zip-multimc')
    expect(hasMember(['x/instance.cfg'], 'instance.cfg')).toBe(true)
    expect(hasMember(['a/instance.cfg', 'b/instance.cfg'], 'instance.cfg')).toBe(false)
  })

  it('prefers mrpack over a coincidental manifest.json', async () => {
    const file = await pack('mixed.zip', { 'modrinth.index.json': mrpackIndexText(), 'manifest.json': CURSE_MANIFEST })
    expect(detect(file)).toBe('mrpack')
  })

  it('returns undefined for a non-archive and for an empty zip', async () => {
    const text = path.join(root, 'notes.txt')
    fs.writeFileSync(text, 'not a zip at all')
    expect(detect(text)).toBeUndefined()
    const empty = await pack('empty.zip', { 'readme/only.txt': 'hi' })
    expect(detect(empty)).toBeUndefined()
    expect(await detectWithZip(path.join(root, 'missing.zip'))).toBeUndefined()
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, PathInfo } from '@shared/types'
import { buildPaths } from '../../src/main/core/paths'
import { ENDPOINTS } from '@shared/constants'
import {
  offlineSkinFile,
  profileCapeUrl,
  profileSkinUrl,
  skinCacheFile,
  skinForMicrosoft,
  skinForOffline,
  textureUrlFromProfileUrl
} from '../../src/main/account/skin'
import { fakeDownloader, makeTempDir, MS_HASH_64 } from './fixtures'

const PNG = Buffer.from('89504e470d0a1a0a' + '00'.repeat(32), 'hex')

function account(overrides: Partial<Account>): Account {
  return {
    id: 'acc-1',
    type: 'microsoft',
    name: 'Tester',
    uuid: '5627dd98-e6be-3c21-b8a8-e92344183641',
    selected: true,
    addedAt: 0,
    lastUsedAt: 0,
    tokenState: 'valid',
    label: 'Tester',
    ...overrides
  }
}

describe('skin url helpers', () => {
  it('rewrites profile urls to the public blob server', () => {
    expect(textureUrlFromProfileUrl(`http://textures.minecraft.net/texture/${MS_HASH_64}`)).toBe(
      `${ENDPOINTS.skinBlobServer}/${MS_HASH_64}`
    )
    expect(textureUrlFromProfileUrl(`https://api.minecraftservices.com/minecraft/profile/skins/active/texture/${MS_HASH_64}`)).toBe(
      `${ENDPOINTS.skinBlobServer}/${MS_HASH_64}`
    )
    expect(textureUrlFromProfileUrl('https://example.com/plain.png')).toBe('https://example.com/plain.png')
  })

  it('prefers ACTIVE classic skins/capes', () => {
    const skins = [
      { state: 'INACTIVE', url: 'a' },
      { state: 'ACTIVE', url: `x/slim`, variant: 'SLIM' },
      { state: 'ACTIVE', url: `x/classic`, variant: 'CLASSIC' }
    ]
    expect(profileSkinUrl(skins)).toBe('x/classic')
    expect(profileCapeUrl([{ state: 'ACTIVE', url: 'cape-1' }])).toBe('cape-1')
    expect(profileSkinUrl(undefined)).toBeUndefined()
  })
})

describe('microsoft skin cache', () => {
  let tmp = ''
  let paths: () => PathInfo = () => buildPaths('x', 'y')

  beforeEach(() => {
    tmp = makeTempDir('mouc-skin-')
    paths = () => buildPaths(tmp, path.join(tmp, 'game'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('downloads into <configDir>/cache/skins/<uuid>.png and reuses the cache', async () => {
    const { downloader, ensured } = fakeDownloader(() => PNG)
    const acc = account({ skinUrl: `https://api.minecraftservices.com/minecraft/profile/skins/active/texture/${MS_HASH_64}` })

    const info = await skinForMicrosoft({ downloader, paths }, acc)
    const expected = skinCacheFile(paths(), acc.uuid)
    expect(expected).toBe(path.join(tmp, 'config', 'cache', 'skins', `${acc.uuid}.png`))
    expect(info.previewPng).toBe(expected)
    expect(info.source).toBe('microsoft')
    expect(info.model).toBe('classic')
    expect(info.accountId).toBe(acc.id)
    expect(fs.existsSync(expected)).toBe(true)
    expect(ensured).toHaveLength(1)
    expect(ensured[0]!.url).toBe(`${ENDPOINTS.skinBlobServer}/${MS_HASH_64}`)
    expect(ensured[0]!.kind).toBe('misc')
    expect(ensured[0]!.id).toBe(expected)

    // Second call: file already cached, no new download.
    const again = await skinForMicrosoft({ downloader, paths }, acc)
    expect(again.previewPng).toBe(expected)
    expect(ensured).toHaveLength(1)
  })

  it('reports source=none when the account has no skin url', async () => {
    const { downloader, ensured } = fakeDownloader(() => PNG)
    const info = await skinForMicrosoft({ downloader, paths }, account({}))
    expect(info.source).toBe('none')
    expect(ensured).toHaveLength(0)
  })
})

describe('offline skin store', () => {
  let tmp = ''
  let paths: () => PathInfo = () => buildPaths('x', 'y')

  beforeEach(() => {
    tmp = makeTempDir('mouc-oskin-')
    paths = () => buildPaths(tmp, path.join(tmp, 'game'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('surfaces <gameRoot>/skins/<name>.png as offline-store', async () => {
    const { downloader } = fakeDownloader(() => PNG)
    const acc = account({ type: 'offline', name: 'Steve', id: 'offline-steve' })
    const file = offlineSkinFile(paths().gameRoot, 'Steve')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, PNG)
    const info = await skinForOffline({ downloader, paths }, acc)
    expect(info.source).toBe('offline-store')
    expect(info.previewPng).toBe(file)
  })

  it('falls back to none when the user has not placed a png', async () => {
    const { downloader } = fakeDownloader(() => PNG)
    const info = await skinForOffline({ downloader, paths }, account({ type: 'offline', name: 'Steve' }))
    expect(info.source).toBe('none')
    expect(info.previewPng).toBe('')
  })
})

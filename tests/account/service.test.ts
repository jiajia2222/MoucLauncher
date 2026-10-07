import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadItem, MicrosoftLoginProgress, PathInfo, Settings } from '@shared/types'
import { buildPaths } from '../../src/main/core/paths'
import type { HttpClient } from '../../src/main/core/contracts'
import type { Logger } from '../../src/main/core/log'
import { accountsFileFor, createAccountStore } from '../../src/main/account/store'
import { createAccountService } from '../../src/main/account/service'
import { offlineUuid } from '../../src/main/account/offline'
import { fakeCipher, fakeDownloader, makeLogger, makeTempDir, microsoftStub, msSettings } from './fixtures'

const PNG = Buffer.from('89504e470d0a1a0a' + '00'.repeat(16), 'hex')

describe('createAccountService', () => {
  let tmp = ''
  let paths: () => PathInfo = () => buildPaths('x', 'y')
  let log: Logger = undefined as unknown as Logger
  let emitted: MicrosoftLoginProgress[] = []

  function build(opts: { settings?: Partial<Settings>; stub?: ReturnType<typeof microsoftStub> } = {}): {
    service: ReturnType<typeof createAccountService>
    ensured: DownloadItem[]
  } {
    const stub = opts.stub ?? microsoftStub()
    const { downloader, ensured } = fakeDownloader(() => PNG)
    const service = createAccountService({
      http: stub.http as unknown as HttpClient,
      settings: { get: () => msSettings(opts.settings ?? {}) },
      paths,
      log,
      downloader,
      cipher: fakeCipher,
      now: () => Date.now(),
      onMicrosoft: (p) => emitted.push(p)
    })
    return { service, ensured }
  }

  beforeEach(() => {
    tmp = makeTempDir('mouc-asvc-')
    paths = () => buildPaths(tmp, path.join(tmp, 'game'))
    log = makeLogger(tmp, 'account-service')
    emitted = []
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('addOffline uses the Java offline UUID and selects the first account', async () => {
    const { service } = build()
    const steve = await service.addOffline({ name: 'Steve' })
    expect(steve.uuid).toBe(offlineUuid('Steve'))
    expect(steve.uuid).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')
    expect(steve.selected).toBe(true)
    expect(steve.tokenState).toBe('valid')

    const notch = await service.addOffline({ name: 'Notch' })
    expect(notch.selected).toBe(false)
    const current = await service.current()
    expect(current?.id).toBe(steve.id)
  })

  it('rejects illegal offline names and honours a custom uuid', async () => {
    const { service } = build()
    await expect(service.addOffline({ name: 'bad name!' })).rejects.toMatchObject({ code: 'invalid-input' })
    const custom = await service.addOffline({ name: 'Steve', uuid: 'DEADBEEF-0000-0000-0000-000000000000' })
    expect(custom.uuid).toBe('deadbeef-0000-0000-0000-000000000000')
  })

  it('select keeps exactly one selected; remove falls back to a survivor', async () => {
    const { service } = build()
    const a = await service.addOffline({ name: 'Steve' })
    const b = await service.addOffline({ name: 'Notch' })
    await service.select(b.id)
    let list = await service.list()
    expect(list.filter((x) => x.selected).map((x) => x.id)).toEqual([b.id])
    await service.remove(b.id)
    list = await service.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.selected).toBe(true)
    expect(list[0]!.id).toBe(a.id)
    await expect(service.select('nope')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('credentials: offline token is the uuid (vanilla behaviour)', async () => {
    const { service } = build()
    const steve = await service.addOffline({ name: 'Steve' })
    const creds = await service.credentials(steve)
    expect(creds).toEqual({ uuid: steve.uuid, token: steve.uuid, type: 'offline' })
  })

  it('microsoft start/poll stores the account with encrypted tokens and returns them via credentials', async () => {
    const { service } = build()
    const start = await service.microsoftStart()
    expect(start.userCode).toBe('ABCD-EFGH')

    const done = await service.microsoftPoll(start.sessionKey)
    expect(done.stage).toBe('done')
    expect(done.account?.name).toBe('Tester')

    // EVENTS.microsoft mirror got every stage.
    expect(emitted.map((p) => p.stage)).toContain('microsoft-ok')
    expect(emitted.at(-1)!.stage).toBe('done')

    const accounts = await service.list()
    expect(accounts).toHaveLength(1)
    const acc = accounts[0]!
    expect(acc.type).toBe('microsoft')
    expect(acc.selected).toBe(true) // first account
    expect(acc.tokenState).toBe('valid')

    // Tokens never live in the JSON file in plaintext.
    const raw = fs.readFileSync(accountsFileFor(tmp), 'utf8')
    expect(raw).not.toContain('MC-AT-1')
    expect(raw).not.toContain('MS-RT-1')
    expect(raw).toContain('enc:')
    // but the (uuid-keyed) profile fields are visible
    expect(raw).toContain('Tester')

    const creds = await service.credentials(acc)
    expect(creds.type).toBe('microsoft')
    expect(creds.token).toBe('MC-AT-1')
    expect(creds.uuid).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')

    // skin url came from the profile response and downloads via the blob server
    const info = await service.skin(acc.id)
    expect(info.source).toBe('microsoft')
    expect(info.previewPng).toBe(path.join(tmp, 'config', 'cache', 'skins', `${acc.uuid}.png`))
  })

  it('credentials refreshes a needs-refresh microsoft account through the token chain', async () => {
    const { service } = build()
    const start = await service.microsoftStart()
    await service.microsoftPoll(start.sessionKey)
    const acc = (await service.list())[0]!

    // Force expiry through a second store instance against the same file.
    const s2 = createAccountStore({ appData: tmp, cipher: fakeCipher })
    await s2.upsert({ ...acc, tokenState: 'needs-refresh' })

    // A second service (same appData) wired to a refresh-capable stub.
    const refreshStub = microsoftStub({
      refreshScript: [{ access_token: 'MS-AT-2', refresh_token: 'MS-RT-2', expires_in: 3600 }],
      mcAuth: { access_token: 'MC-AT-2', username: 'Tester' }
    })
    const { service: service2 } = build({ stub: refreshStub })
    const creds = await service2.credentials({ ...acc, tokenState: 'needs-refresh' })
    expect(creds.token).toBe('MC-AT-2')
    expect(refreshStub.refreshBodies).toHaveLength(1)
    expect(refreshStub.refreshBodies[0]!.get('refresh_token')).toBe('MS-RT-1')

    const updated = await s2.get(acc.id)
    expect(updated?.tokenState).toBe('valid')
    const raw = fs.readFileSync(accountsFileFor(tmp), 'utf8')
    expect(raw).not.toContain('MC-AT-2')
    expect(raw).not.toContain('MS-RT-2')
  })

  it('a rejected refresh marks the account invalid and surfaces an auth error', async () => {
    const { service } = build()
    const start = await service.microsoftStart()
    await service.microsoftPoll(start.sessionKey)
    const acc = (await service.list())[0]!

    const failingStub = microsoftStub({ refreshScript: [{ error: 'invalid_grant' }] })
    const { service: service2 } = build({ stub: failingStub })
    await expect(service2.refresh(acc.id)).rejects.toMatchObject({ code: 'auth' })
    const s2 = createAccountStore({ appData: tmp, cipher: fakeCipher })
    const after = await s2.get(acc.id)
    expect(after?.tokenState).toBe('invalid')
  })

  it('servers() reads the authlib-injector yggdrasil document', async () => {
    const http = {
      async json<T>(url: string): Promise<T> {
        if (url === 'https://skin.example/api/yggdrasil') {
          return { serverName: '私服', links: { self: 'https://skin.example/auth' } } as T
        }
        throw new Error('unexpected ' + url)
      }
    } as unknown as HttpClient
    const { downloader } = fakeDownloader(() => PNG)
    const service = createAccountService({
      http,
      settings: { get: () => msSettings() },
      paths,
      log,
      downloader,
      cipher: fakeCipher,
      now: () => Date.now()
    })
    const servers = await service.servers('https://skin.example/')
    expect(servers).toEqual([{ serverName: '私服', serverUrl: 'https://skin.example/auth' }])
    await expect(service.servers('  ')).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('offline skin goes through the <gameRoot>/skins store (v1 limitation)', async () => {
    const { service } = build()
    const steve = await service.addOffline({ name: 'Steve' })
    const info = await service.skin(steve.id)
    expect(info.source).toBe('none')
    const file = path.join(paths().gameRoot, 'skins', 'Steve.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, PNG)
    const info2 = await service.skin(steve.id)
    expect(info2.source).toBe('offline-store')
    expect(info2.previewPng).toBe(file)
  })
})

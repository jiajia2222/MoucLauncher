import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HttpClient, Downloader, DownloadResult } from '../../src/main/core/contracts'
import type { DownloadItem, Settings } from '@shared/types'
import { Logger } from '../../src/main/core/log'
import { ENDPOINTS } from '@shared/constants'
import { baseSettings } from '../java/fixtures'

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function makeLogger(tmp: string, scope = 'test'): Logger {
  return new Logger(scope, path.join(tmp, 'logs'))
}

/** Trivial reversible cipher for tests; production uses Electron safeStorage. */
export const fakeCipher = {
  encrypt(plain: string): string {
    return 'enc:' + Buffer.from(plain, 'utf8').toString('base64')
  },
  decrypt(cipherText: string): string {
    if (!cipherText.startsWith('enc:')) throw new Error(`bad cipher: ${cipherText.slice(0, 8)}`)
    return Buffer.from(cipherText.slice('enc:'.length), 'base64').toString('utf8')
  }
}

/* ------------------------------- Microsoft fixtures ------------------------------- */

export const MS_HASH_64 = 'af18469cb2e1fa2adf40c75659a23cd63acc55277f4fb30f1b5dc92c3f0e4500'

export const msFixtures = {
  deviceCode: {
    device_code: 'DEV-CODE-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://www.microsoft.com/link',
    verification_uri_complete: 'https://www.microsoft.com/link?code=ABCD-EFGH',
    expires_in: 900,
    interval: 1
  },
  tokenOk: { access_token: 'MS-AT-1', refresh_token: 'MS-RT-1', expires_in: 3600, token_type: 'Bearer' },
  xbl: { Token: 'XBL-TOKEN', DisplayClaims: { Uhs: ['UHS-1'] } },
  xsts: { Token: 'XSTS-TOKEN', DisplayClaims: { Uhs: ['UHS-1'] } },
  mcAuth: { access_token: 'MC-AT-1', username: 'Tester', roles: ['category_minecraft'] },
  profile: {
    id: '5627dd98e6be3c21b8a8e92344183641',
    name: 'Tester',
    skins: [{ id: 'skin1', state: 'ACTIVE', url: `https://api.minecraftservices.com/minecraft/profile/skins/active/texture/${MS_HASH_64}`, variant: 'CLASSIC' }]
  },
  entitlementsOwned: { items: [{ skuName: 'Minecraft Java Edition', skuId: '87AB312371C1', signature: 'sig' }] },
  entitlementsMissing: { items: [{ skuName: 'Minecraft Dungeons', skuId: 'DUNGEONS', signature: 'sig' }] }
}

export interface MsStubOptions {
  /** Responses served (in order) for each msToken POST; the last one repeats. */
  tokenScript?: Record<string, unknown>[]
  /** Responses served (in order) for refresh-token POSTs. */
  refreshScript?: Record<string, unknown>[]
  profile?: unknown
  entitlements?: unknown
  xbl?: unknown
  xsts?: unknown
  mcAuth?: unknown
  /** URL substrings whose json() call should throw (simulating non-2xx). */
  failUrls?: string[]
}

export interface MsStub {
  http: HttpClient
  tokenBodies: URLSearchParams[]
  refreshBodies: URLSearchParams[]
  fetchUrls: string[]
  jsonUrls: string[]
  jsonBodies: Map<string, string>
  jsonHeaders: Map<string, Record<string, string>>
}

/** Offline stub of HttpClient implementing the whole Microsoft chain from fixtures. */
export function microsoftStub(options: MsStubOptions = {}): MsStub {
  const tokenScript = [...(options.tokenScript ?? [msFixtures.tokenOk])]
  const refreshScript = [...(options.refreshScript ?? [msFixtures.tokenOk])]
  const stub: MsStub = {
    http: undefined as unknown as HttpClient,
    tokenBodies: [],
    refreshBodies: [],
    fetchUrls: [],
    jsonUrls: [],
    jsonBodies: new Map(),
    jsonHeaders: new Map()
  }

  const response = (status: number, body: unknown) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      async text(): Promise<string> {
        return JSON.stringify(body)
      }
    }) as unknown as Response

  const http: HttpClient = {
    async fetch(url: string, init?: { body?: string | Buffer }): Promise<Response> {
      stub.fetchUrls.push(url)
      if (url === ENDPOINTS.msDeviceCode) {
        return response(200, msFixtures.deviceCode)
      }
      if (url === ENDPOINTS.msToken) {
        const params = new URLSearchParams(String(init?.body ?? ''))
        if (params.get('grant_type') === 'refresh_token') {
          stub.refreshBodies.push(params)
          const next = refreshScript.length > 1 ? refreshScript.shift() : refreshScript[0]
          return response(200, next ?? msFixtures.tokenOk)
        }
        stub.tokenBodies.push(params)
        const next = tokenScript.length > 1 ? tokenScript.shift() : tokenScript[0]
        // Device-flow errors arrive with 4xx status; the flow must still read the body.
        const err = (next as { error?: string } | undefined)?.error
        return response(err ? 400 : 200, next)
      }
      throw new Error(`unexpected fetch url ${url}`)
    },
    async json<T>(url: string, init?: { body?: string | Buffer; headers?: Record<string, string> }): Promise<T> {
      stub.jsonUrls.push(url)
      if (init?.body !== undefined) stub.jsonBodies.set(url, String(init.body))
      if (init?.headers) stub.jsonHeaders.set(url, init.headers)
      if (options.failUrls?.some((needle) => url.includes(needle))) {
        throw new Error(`stubbed failure for ${url}`)
      }
      switch (url) {
        case ENDPOINTS.xboxUserAuth:
          return (options.xbl ?? msFixtures.xbl) as T
        case ENDPOINTS.xboxXsts:
          return (options.xsts ?? msFixtures.xsts) as T
        case ENDPOINTS.minecraftLoginWithXbox:
          return (options.mcAuth ?? msFixtures.mcAuth) as T
        case ENDPOINTS.minecraftProfile:
          return (options.profile ?? msFixtures.profile) as T
        case ENDPOINTS.minecraftEntitlements:
          return (options.entitlements ?? msFixtures.entitlementsOwned) as T
        default:
          throw new Error(`unexpected json url ${url}`)
      }
    },
    async text(): Promise<string> {
      throw new Error('not used')
    },
    async buffer(): Promise<Buffer> {
      throw new Error('not used')
    },
    async head() {
      throw new Error('not used')
    }
  }
  stub.http = http
  return stub
}

/* ------------------------------- downloader stub ------------------------------- */

export function fakeDownloader(writePayload: () => Buffer): { downloader: Downloader; ensured: DownloadItem[] } {
  const ensured: DownloadItem[] = []
  const downloader = {
    async ensure(item: DownloadItem): Promise<DownloadResult> {
      ensured.push(item)
      fs.mkdirSync(path.dirname(item.target), { recursive: true })
      fs.writeFileSync(item.target, writePayload())
      return { item, fetched: true }
    }
  } as unknown as Downloader
  return { downloader, ensured }
}

export function msSettings(overrides: Partial<Settings> = {}): Settings {
  return baseSettings({ microsoftClientId: 'test-client-id', ...overrides })
}

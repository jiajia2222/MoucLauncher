/**
 * AccountService: wires store + offline + microsoft + skin into the frozen
 * `AccountService` contract. Exactly one account is `selected` at all times.
 * `credentials()` feeds the launch arguments: offline accounts use their UUID
 * as the token (vanilla behaviour), microsoft accounts use the MC access token
 * and are refreshed when `tokenState === 'needs-refresh'`.
 */
import type {
  Account,
  MicrosoftLoginProgress,
  MicrosoftStartResult,
  OfflineLoginRequest,
  PathInfo,
  Settings,
  SkinInfo
} from '@shared/types'
import { AppError } from '@shared/errors'
import type { AccountService, Downloader, HttpClient } from '../core/contracts'
import type { Logger } from '../core/log'
import { createAccountStore, type AccountStore, type SecretCipher, type SecretsBag } from './store'
import { OFFLINE_NAME_RE, offlineUuid } from './offline'
import { createMicrosoftFlow, type MicrosoftFlow, type MicrosoftSignIn } from './microsoft'
import { skinForMicrosoft, skinForOffline } from './skin'

export interface SettingsLike {
  get(): Settings
}

export interface AccountServiceDeps {
  http: HttpClient
  settings: SettingsLike
  paths: () => PathInfo
  log: Logger
  downloader: Downloader
  /** Injected for tests; production falls back to Electron safeStorage. */
  cipher?: SecretCipher
  now?: () => number
  /** Push sink for EVENTS.microsoft (the container wires it to core/bus). */
  onMicrosoft?: (progress: MicrosoftLoginProgress) => void
}

/** Yggdrasil server list entry (authlib-injector shape). */
interface AliServer {
  serverName?: string
  serverUrl?: string
  links?: { self?: string; authentication?: string }
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const now = deps.now ?? ((): number => Date.now())

  let storePromise: Promise<AccountStore> | undefined
  function store(): Promise<AccountStore> {
    if (!storePromise) {
      storePromise = (async () => {
        let cipher = deps.cipher
        if (!cipher) {
          // Dynamic import keeps Electron out of the test graph.
          cipher = (await import('./electronCipher')).createElectronCipher()
        }
        return createAccountStore({ appData: deps.paths().appData, cipher })
      })()
    }
    return storePromise
  }

  /** Fresh snapshot per start so a changed client id takes effect on the next login. */
  function buildFlow(): MicrosoftFlow {
    return createMicrosoftFlow({
      http: deps.http,
      settings: { ...deps.settings.get() },
      log: deps.log,
      now,
      onStage: (progress) => deps.onMicrosoft?.(progress)
    })
  }

  let activeFlow: MicrosoftFlow | undefined

  async function saveSignIn(signIn: MicrosoftSignIn): Promise<Account> {
    const s = await store()
    const existing = await s.get(signIn.account.id)
    const accounts = await s.list()
    const account: Account = {
      ...signIn.account,
      addedAt: existing?.addedAt ?? signIn.account.addedAt,
      lastUsedAt: now(),
      selected: existing ? existing.selected : accounts.length === 0,
      ...(existing?.skinUrl && !signIn.account.skinUrl ? { skinUrl: existing.skinUrl } : {}),
      ...(existing?.capeUrl && !signIn.account.capeUrl ? { capeUrl: existing.capeUrl } : {})
    }
    await s.upsert(account, signIn.secrets as unknown as SecretsBag)
    return account
  }

  const refreshImpl = async (id: string): Promise<Account> => {
    const s = await store()
    const account = await s.get(id)
    if (!account) throw new AppError('not-found', `账户 ${id} 不存在`)
    if (account.type !== 'microsoft') {
      await s.upsert({ ...account, lastUsedAt: now(), tokenState: 'valid' })
      return account
    }
    const secrets = await s.secrets(id)
    const refreshToken = typeof secrets.refreshToken === 'string' ? secrets.refreshToken : ''
    if (refreshToken.length === 0) {
      throw new AppError('auth', '该 Microsoft 账户缺少刷新令牌，请重新登录')
    }
    const flow = buildFlow()
    let signIn: MicrosoftSignIn
    try {
      signIn = await flow.refreshChain(refreshToken)
    } catch (error) {
      const e = AppError.from(error, 'auth')
      await s.upsert({ ...account, tokenState: 'invalid' })
      throw e
    }
    return saveSignIn({ ...signIn, account: { ...signIn.account, tokenState: 'valid' } })
  }

  return {
    async list(): Promise<Account[]> {
      return (await store()).list()
    },

    async current(): Promise<Account | undefined> {
      return (await (await store()).list()).find((a) => a.selected)
    },

    async addOffline(req: OfflineLoginRequest): Promise<Account> {
      const name = (req.name ?? '').trim()
      if (!OFFLINE_NAME_RE.test(name)) {
        throw new AppError('invalid-input', '离线用户名不合法', '只允许 A-Z a-z 0-9 下划线，最长 16 字符')
      }
      const uuid = (req.uuid ?? '').trim().length > 0 ? req.uuid!.trim().toLowerCase() : offlineUuid(name)
      const s = await store()
      const accounts = await s.list()
      const existing = accounts.find((a) => a.id === uuid)
      const account: Account = {
        id: uuid,
        type: 'offline',
        name,
        uuid,
        selected: existing ? existing.selected : accounts.length === 0,
        addedAt: existing?.addedAt ?? now(),
        lastUsedAt: now(),
        tokenState: 'valid',
        label: name
      }
      await s.upsert(account, {})
      return account
    },

    async remove(id: string): Promise<void> {
      const s = await store()
      const accounts = await s.list()
      const target = accounts.find((a) => a.id === id)
      if (!target) return
      await s.remove(id)
      if (target.selected) {
        const rest = await s.list()
        if (rest.length > 0 && !rest.some((a) => a.selected)) await s.select(rest[0]!.id)
      }
    },

    async select(id: string): Promise<Account> {
      const s = await store()
      const accounts = await s.list()
      if (!accounts.some((a) => a.id === id)) throw new AppError('not-found', `账户 ${id} 不存在`)
      return s.select(id)
    },

    async refresh(id: string): Promise<Account> {
      return refreshImpl(id)
    },

    async microsoftStart(): Promise<MicrosoftStartResult> {
      activeFlow = buildFlow()
      return activeFlow.start()
    },

    async microsoftPoll(sessionKey: string): Promise<MicrosoftLoginProgress> {
      const flow = activeFlow ?? buildFlow()
      const result = await flow.poll(sessionKey)
      if (result.signIn) {
        const account = await saveSignIn(result.signIn)
        activeFlow = undefined
        return { ...result, account }
      }
      return result
    },

    async microsoftCancel(sessionKey: string): Promise<void> {
      activeFlow?.cancel(sessionKey)
      activeFlow = undefined
    },

    async skin(accountId: string): Promise<SkinInfo> {
      const s = await store()
      const account = await s.get(accountId)
      if (!account) throw new AppError('not-found', `账户 ${accountId} 不存在`)
      const skinDeps = { downloader: deps.downloader, paths: deps.paths }
      if (account.type === 'microsoft') return skinForMicrosoft(skinDeps, account)
      return skinForOffline(skinDeps, account)
    },

    async servers(baseUrl: string): Promise<{ serverName: string; serverUrl: string }[]> {
      const base = baseUrl.trim().replace(/\/+$/, '')
      if (base.length === 0) throw new AppError('invalid-input', '服务器地址不能为空')
      const data = await deps.http.json<AliServer>(`${base}/api/yggdrasil`, {
        headers: { Accept: 'application/json' }
      })
      const name = data.serverName ?? base
      const url = data.links?.self ?? data.links?.authentication ?? base
      return [{ serverName: name, serverUrl: url }]
    },

    async credentials(account: Account): Promise<{ uuid: string; token: string; type: string }> {
      const s = await store()
      let target = account
      if (target.type === 'microsoft' && target.tokenState !== 'valid') {
        // needs-refresh / invalid: run the refresh token chain first.
        target = await refreshImpl(target.id)
      }
      if (target.type === 'offline') {
        // Vanilla behaviour: offline token == uuid.
        return { uuid: target.uuid, token: target.uuid, type: 'offline' }
      }
      const secrets = await s.secrets(target.id)
      const token = typeof secrets.accessToken === 'string' ? secrets.accessToken : ''
      const expiresAt = typeof secrets.expiresAt === 'number' ? secrets.expiresAt : 0
      if (target.type === 'microsoft') {
        if (token.length === 0) throw new AppError('auth', `账户 ${target.name} 缺少访问令牌，请重新登录`)
        if (expiresAt > 0 && expiresAt <= now()) {
          const refreshed = await refreshImpl(target.id)
          const fresh = await s.secrets(refreshed.id)
          return { uuid: refreshed.uuid, token: String(fresh.accessToken ?? ''), type: 'microsoft' }
        }
        return { uuid: target.uuid, token, type: 'microsoft' }
      }
      return { uuid: target.uuid, token: token.length > 0 ? token : target.uuid, type: target.type }
    }
  }
}

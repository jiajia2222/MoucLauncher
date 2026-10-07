/**
 * Account adapter: upstream's flat `api.ts` account calls re-expressed over
 * `window.mouc`, so the ported view keeps its upstream call shapes and its
 * `try / catch / toast` pattern (`call()` throws `ApiError` instead of
 * resolving `{ ok: false }`).
 *
 * Deliberately not ported: the third-party (Yggdrasil / authlib-injector)
 * provider CRUD, skins and modsync of upstream — this build exposes
 * `mouc.account.servers()` only.
 *
 * Upstream: KAMUCL src/renderer/src/api.ts (MIT, (c) 2026 kamubaba-i) —
 * see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import { EVENTS } from '@shared/ipc'
import type {
  Account,
  LoginStage,
  MicrosoftLoginProgress,
  MicrosoftStartResult,
  Settings,
  SkinInfo
} from '@shared/types'
import { api, call, plain } from './core'

export interface YggdrasilServerEntry {
  serverName: string
  serverUrl: string
}

/**
 * Device-code stages in display order. `failed` is a terminal state rather than a
 * step, so the stepper keeps it outside the list.
 */
export const MS_STAGES: LoginStage[] = [
  'waiting-user',
  'microsoft-ok',
  'xbox-ok',
  'live-ok',
  'minecraft-ok',
  'profile-ok',
  'done'
]

export const listAccounts = (): Promise<Account[]> => call(api().account.list())

export const addOfflineAccount = (name: string): Promise<Account> =>
  call(api().account.addOffline(plain({ name })))

export const removeAccount = (id: string): Promise<boolean> => call(api().account.remove(id))

export const selectAccount = (id: string): Promise<Account> => call(api().account.select(id))

export const refreshAccount = (id: string): Promise<Account> => call(api().account.refresh(id))

export const accountSkin = (accountId: string): Promise<SkinInfo> =>
  call(api().account.skin(accountId))

/**
 * Starts the device-code flow. Unlike upstream, the poll loop lives in the view:
 * this build hands back a `sessionKey` and expects repeated `microsoftPoll` calls.
 */
export const msBeginLogin = (): Promise<MicrosoftStartResult> =>
  call(api().account.microsoftStart())

export const msPollLogin = (sessionKey: string): Promise<MicrosoftLoginProgress> =>
  call(api().account.microsoftPoll(sessionKey))

export const msCancelLogin = (sessionKey: string): Promise<boolean> =>
  call(api().account.microsoftCancel(sessionKey))

/** Live stage pushes; returns the unsubscribe handle for `onUnmounted`. */
export function onMsLoginProgress(handler: (progress: MicrosoftLoginProgress) => void): () => void {
  return api().on(EVENTS.microsoft, (payload) => handler(payload as MicrosoftLoginProgress))
}

/** The only third-party capability this build exposes: a server list for an API Root. */
export const yggdrasilServers = (baseUrl: string): Promise<YggdrasilServerEntry[]> =>
  call(api().account.servers(baseUrl))

export const readSettings = (): Promise<Settings> => call(api().settings.get())

export const openExternal = (url: string): Promise<boolean> => call(api().app.openExternal(url))

/** Clipboard with upstream's `execCommand` fallback, which Electron needs for paste focus. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

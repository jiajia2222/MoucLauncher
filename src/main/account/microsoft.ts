/**
 * Microsoft OAuth device-code flow + Xbox/Minecraft token chain.
 * Every stage is pushed as a MicrosoftLoginProgress through the injected
 * `onStage` callback (the account service also forwards it as EVENTS.microsoft).
 *
 * Verified on 2026-10-07 from this machine: msDeviceCode/msToken answer (POST
 * probes hit the OAuth endpoints) and the XBL/XSTS/MC hosts resolve and return
 * JSON errors — proof the endpoints are live. The exact request bodies below
 * (MS_FLOW) could NOT be exercised end-to-end without a real Azure client id;
 * see docs/microsoft-auth.md for the per-hop status and app registration steps.
 */
import type { Account, MicrosoftLoginProgress, MicrosoftStartResult, Settings } from '@shared/types'
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import { uid, sleep } from '@shared/utils'
import type { HttpClient, HttpInit } from '../core/contracts'
import type { Logger } from '../core/log'

/** XBL/XSTS constants. Unverified without a real client id — see docs/microsoft-auth.md. */
export const MS_FLOW = {
  scope: 'XboxLive.signin offline_access',
  deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
  refreshGrantType: 'refresh_token',
  tokenType: 'JWT',
  authMethod: 'RPOP',
  sandbox: 'RETAIL',
  /** user.auth relying party. */
  xboxRelyingParty: 'http://auth.xboxlive.com',
  /** xsts/authorize relying party (same value reaches Minecraft's XBL3.0 flow). */
  xstsRelyingParty: 'http://auth.xboxlive.com',
  /** OAuth spec: `slow_down` means "add 5 seconds to the polling interval". */
  slowDownStepMs: 5_000,
  /** Minecraft access tokens live ~24h (observed); drives needs-refresh. */
  mcTokenLifetimeMs: 24 * 60 * 60 * 1000
} as const

export interface MicrosoftSecrets {
  /** Minecraft access token used for launching. */
  accessToken: string
  /** MS OAuth refresh token, stored encrypted; used by refresh(). */
  refreshToken: string
  /** MC token expiry (ms epoch) -> tokenState needs-refresh past this. */
  expiresAt: number
  userHash?: string
}

export interface MicrosoftSignIn {
  account: Account
  secrets: MicrosoftSecrets
  /** Set when the entitlements call shows the account may not own Java MC. */
  warning?: string
}

export interface MicrosoftFlowDeps {
  http: HttpClient
  settings: Settings
  log: Logger
  /** Injectable clock (ms epoch). */
  now?: () => number
  /** Optional stage sink; the service pushes these as EVENTS.microsoft. */
  onStage?: (progress: MicrosoftLoginProgress) => void
  /** Injectable delay so tests with fake timers control interval waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type MicrosoftPollResult = MicrosoftLoginProgress & { signIn?: MicrosoftSignIn }

export interface MicrosoftFlow {
  start(): Promise<MicrosoftStartResult>
  /** One throttled, cancellable token poll; completes the chain on success. */
  poll(sessionKey: string): Promise<MicrosoftPollResult>
  cancel(sessionKey: string): void
  /** Re-runs token + XBL + XSTS + MC login + profile from a stored refresh token. */
  refreshChain(refreshToken: string): Promise<MicrosoftSignIn>
  /** Session keys currently waiting on the user. */
  pending(): string[]
}

const MISSING_CLIENT_ID = '未配置 Microsoft OAuth 客户端 ID'
const MISSING_CLIENT_ID_DETAIL = '在 设置→账户 中填入你自己的 Azure 应用 ID，README 有创建步骤'

function clientIdOf(settings: Settings): string {
  const id = (settings.microsoftClientId ?? '').trim()
  if (id.length === 0) throw new AppError('auth', MISSING_CLIENT_ID, MISSING_CLIENT_ID_DETAIL)
  return id
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
const JSON_HDR = { 'Content-Type': 'application/json', Accept: 'application/json' }

/** Dashed-lowercase uuid; the MC profile returns it undashed. */
export function dashedUuid(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return id.toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ------------------------- upstream JSON shapes (minimal) ------------------------- */

interface DeviceCodeResponse {
  error?: string
  error_description?: string
  device_code?: string
  user_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface TokenResponse {
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

interface XblResponse {
  Token?: string
  DisplayClaims?: { Uhs?: string[] }
  XErr?: number
  Message?: string
}

interface McTokenResponse {
  access_token?: string
  username?: string
  roles?: string[]
  error?: string
  errorMessage?: string
}

interface McProfile {
  id?: string
  name?: string
  skins?: { id?: string; state?: string; url?: string; variant?: string }[]
  capes?: { id?: string; state?: string; url?: string }[]
  error?: string
  errorMessage?: string
}

interface Entitlements {
  items?: { skuName?: string; skuId?: string; signature?: string; isBaseGame?: boolean }[]
  error?: string
}

interface MicrosoftSession {
  deviceCode: string
  intervalMs: number
  /** ms epoch when the whole device-code flow expires. */
  expiresAt: number
  /** ms epoch until which the next token poll is throttled. */
  nextAllowedPollAt: number
  controller: AbortController
  finished: boolean
}

/* -------------------------------------- implementation -------------------------------------- */

export function createMicrosoftFlow(deps: MicrosoftFlowDeps): MicrosoftFlow {
  const { http, log } = deps
  const now = deps.now ?? ((): number => Date.now())
  const delay = deps.sleep ?? sleep
  const sessions = new Map<string, MicrosoftSession>()

  function stage(sessionKey: string, progress: Omit<MicrosoftLoginProgress, 'sessionKey'>): MicrosoftPollResult {
    const full: MicrosoftPollResult = { sessionKey, ...progress }
    try {
      deps.onStage?.(full)
    } catch (error) {
      log.warn(`microsoft onStage 失败：${String(error)}`)
    }
    return full
  }

  /**
   * POSTs and parses the JSON body even on non-2xx: the device-code flow reports
   * `authorization_pending` etc. inside HTTP 400/401 bodies, which a strict
   * `json()` helper would surface as a plain http-status error.
   */
  async function requestJson<T>(url: string, init: HttpInit): Promise<{ status: number; body: T }> {
    const res = await http.fetch(url, init)
    const text = await res.text()
    let body: unknown = {}
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new AppError('network', `Microsoft 返回了非 JSON 响应 (HTTP ${res.status})`, url)
      }
    }
    return { status: res.status, body: body as T }
  }

  async function requestToken(form: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: TokenResponse }> {
    const body = new URLSearchParams(form).toString()
    return requestJson<TokenResponse>(ENDPOINTS.msToken, { method: 'POST', headers: FORM, body, signal })
  }

  /**
   * XBL -> XSTS -> login_with_xbox -> profile -> entitlements. Emits one
   * MicrosoftLoginProgress per hop. Throws AppError('auth') on any hard failure.
   */
  async function completeWithProfile(sessionKey: string, msAccessToken: string, refreshToken: string): Promise<MicrosoftPollResult> {
    try {
      stage(sessionKey, { stage: 'microsoft-ok', message: 'Microsoft 令牌获取成功' })

      const xbl = await http.json<XblResponse>(ENDPOINTS.xboxUserAuth, {
        method: 'POST',
        headers: JSON_HDR,
        body: JSON.stringify({
          RelyingParty: MS_FLOW.xboxRelyingParty,
          TokenType: MS_FLOW.tokenType,
          Properties: { AuthMethod: MS_FLOW.authMethod, UserToken: msAccessToken, SandboxId: MS_FLOW.sandbox }
        })
      })
      if (!xbl.Token) {
        throw new AppError('auth', `Xbox Live 登录失败${xbl.XErr !== undefined ? ` (XErr ${xbl.XErr})` : ''}`, xbl.Message)
      }
      stage(sessionKey, { stage: 'xbox-ok', message: 'Xbox Live 令牌就绪' })

      const xsts = await http.json<XblResponse>(ENDPOINTS.xboxXsts, {
        method: 'POST',
        headers: JSON_HDR,
        body: JSON.stringify({
          RelyingParty: MS_FLOW.xstsRelyingParty,
          TokenType: MS_FLOW.tokenType,
          Properties: { AuthMethod: MS_FLOW.authMethod, UserToken: xbl.Token, SandboxId: MS_FLOW.sandbox }
        })
      })
      if (!xsts.Token) {
        // XErr 2148916233 = the account has no Xbox profile, 2148916238 = unsupported region.
        throw new AppError('auth', `Xbox 安全令牌 (XSTS) 申请失败${xsts.XErr !== undefined ? ` (XErr ${xsts.XErr})` : ''}`, xsts.Message)
      }
      const userHash = xsts.DisplayClaims?.Uhs?.[0] ?? xbl.DisplayClaims?.Uhs?.[0] ?? ''
      stage(sessionKey, { stage: 'live-ok', message: 'XSTS 安全令牌就绪' })

      const mc = await http.json<McTokenResponse>(ENDPOINTS.minecraftLoginWithXbox, {
        method: 'POST',
        headers: JSON_HDR,
        body: JSON.stringify({ identity: `XBL3.0 x=${userHash};${xsts.Token}` })
      })
      if (!mc.access_token) {
        throw new AppError('auth', 'Minecraft 登录失败', mc.errorMessage ?? mc.error ?? '响应中没有 access_token')
      }
      stage(sessionKey, { stage: 'minecraft-ok', message: 'Minecraft 访问令牌就绪' })

      const authInit: HttpInit = { headers: { Authorization: `Bearer ${mc.access_token}`, Accept: 'application/json' } }
      const profile = await http.json<McProfile>(ENDPOINTS.minecraftProfile, authInit)
      if (!profile.id || !profile.name) {
        throw new AppError('auth', '该 Microsoft 账户没有 Minecraft 档案（可能只购买了基岩版）', profile.errorMessage ?? profile.error)
      }
      const uuid = dashedUuid(profile.id)
      const expiresAt = now() + MS_FLOW.mcTokenLifetimeMs
      const skin = (profile.skins ?? []).find((s) => s.state === 'ACTIVE' && s.url)
      const cape = (profile.capes ?? []).find((c) => c.state === 'ACTIVE' && c.url)
      const account: Account = {
        id: uuid,
        type: 'microsoft',
        name: profile.name,
        uuid,
        selected: false,
        addedAt: now(),
        lastUsedAt: now(),
        tokenState: 'valid',
        expiresAt,
        label: profile.name,
        ...(skin?.url ? { skinUrl: skin.url } : {}),
        ...(cape?.url ? { capeUrl: cape.url } : {})
      }
      const secrets: MicrosoftSecrets = { accessToken: mc.access_token, refreshToken, expiresAt, userHash }
      stage(sessionKey, { stage: 'profile-ok', message: `已获取账户档案：${account.name}` })

      // Unowned copy is a warning, never a hard failure (per spec).
      let warning: string | undefined
      try {
        const ent = await http.json<Entitlements>(ENDPOINTS.minecraftEntitlements, authInit)
        const items = ent.items ?? []
        const ownsJava = items.some(
          (i) => /java/i.test(i.skuName ?? '') || i.skuId === '87AB312371C1' || i.isBaseGame === true
        )
        if (items.length > 0 && !ownsJava) {
          warning = '该 Microsoft 账户似乎未购买 Minecraft: Java 版，启动可能失败'
        }
      } catch (error) {
        log.warn(`entitlements 查询失败（忽略）：${String(error)}`)
      }

      const message = warning ? `登录完成（警告：${warning}）` : '登录完成'
      const progress = stage(sessionKey, { stage: 'done', message, account })
      return { ...progress, signIn: { account, secrets, warning } }
    } catch (error) {
      const e = AppError.from(error, 'auth')
      return stage(sessionKey, { stage: 'failed', message: e.message })
    }
  }

  return {
    async start(): Promise<MicrosoftStartResult> {
      // Sweep sessions that outlived their device code.
      const t = now()
      for (const [key, session] of sessions) {
        if (session.expiresAt < t || session.finished) sessions.delete(key)
      }

      const clientId = clientIdOf(deps.settings)
      const body = new URLSearchParams({ client_id: clientId, scope: MS_FLOW.scope }).toString()
      const { status, body: response } = await requestJson<DeviceCodeResponse>(ENDPOINTS.msDeviceCode, {
        method: 'POST',
        headers: FORM,
        body
      })
      if (status !== 200 || !response.device_code) {
        throw new AppError('auth', response.error_description ?? '无法发起 Microsoft 登录', response.error ?? `HTTP ${status}`)
      }
      const sessionKey = uid('msauth')
      const intervalSec = Math.max(1, response.interval ?? 5)
      const expiresInSec = Math.max(30, response.expires_in ?? 900)
      sessions.set(sessionKey, {
        deviceCode: response.device_code,
        intervalMs: intervalSec * 1000,
        expiresAt: now() + expiresInSec * 1000,
        nextAllowedPollAt: 0,
        controller: new AbortController(),
        finished: false
      })
      const verificationUri = response.verification_uri ?? ''
      const verificationUriComplete = response.verification_uri_complete ?? verificationUri
      const result: MicrosoftStartResult = {
        userCode: response.user_code ?? '',
        verificationUri,
        verificationUriComplete,
        expiresIn: expiresInSec,
        interval: intervalSec,
        sessionKey,
        message: `请在浏览器中打开 ${verificationUriComplete} 并输入代码 ${response.user_code ?? ''}`
      }
      stage(sessionKey, { stage: 'waiting-user', message: result.message })
      return result
    },

    async poll(sessionKey: string): Promise<MicrosoftPollResult> {
      const session = sessions.get(sessionKey)
      if (!session) return stage(sessionKey, { stage: 'failed', message: '登录会话不存在或已结束' })
      const t = now()
      if (session.finished) return stage(sessionKey, { stage: 'failed', message: '登录会话已结束' })
      if (t >= session.expiresAt) {
        session.finished = true
        sessions.delete(sessionKey)
        return stage(sessionKey, { stage: 'failed', message: '登录超时（设备代码已过期）' })
      }

      // Honour the server-provided interval between token polls.
      const wait = session.nextAllowedPollAt - t
      if (wait > 0) {
        try {
          await delay(wait, session.controller.signal)
        } catch {
          session.finished = true
          sessions.delete(sessionKey)
          return stage(sessionKey, { stage: 'failed', message: '登录已取消' })
        }
      }

      const clientId = clientIdOf(deps.settings)
      let response: { status: number; body: TokenResponse }
      try {
        response = await requestToken(
          { client_id: clientId, grant_type: MS_FLOW.deviceGrantType, device_code: session.deviceCode, scope: MS_FLOW.scope },
          session.controller.signal
        )
      } catch (error) {
        const e = AppError.from(error, 'network')
        if (e.code === 'cancelled') {
          session.finished = true
          sessions.delete(sessionKey)
          return stage(sessionKey, { stage: 'failed', message: '登录已取消' })
        }
        return stage(sessionKey, { stage: 'failed', message: e.message })
      }

      session.nextAllowedPollAt = now() + session.intervalMs
      const body = response.body

      if (body.access_token && body.refresh_token) {
        session.finished = true
        sessions.delete(sessionKey)
        return completeWithProfile(sessionKey, body.access_token, body.refresh_token)
      }

      switch (body.error) {
        case 'authorization_pending':
          return stage(sessionKey, { stage: 'waiting-user', message: body.error_description ?? '等待你在浏览器中完成授权…' })
        case 'slow_down':
          session.intervalMs += MS_FLOW.slowDownStepMs
          session.nextAllowedPollAt = now() + session.intervalMs
          return stage(sessionKey, { stage: 'waiting-user', message: '轮询过快，已自动放慢' })
        case 'expired_token':
          session.finished = true
          sessions.delete(sessionKey)
          return stage(sessionKey, { stage: 'failed', message: '设备代码已过期，请重新开始登录' })
        case 'access_denied':
          session.finished = true
          sessions.delete(sessionKey)
          return stage(sessionKey, { stage: 'failed', message: '你拒绝了授权请求' })
        default:
          session.finished = true
          sessions.delete(sessionKey)
          return stage(
            sessionKey,
            { stage: 'failed', message: body.error_description ?? `Microsoft 登录失败 (${body.error ?? `HTTP ${response.status}`})` }
          )
      }
    },

    cancel(sessionKey: string): void {
      const session = sessions.get(sessionKey)
      if (!session) return
      session.finished = true
      session.controller.abort()
      sessions.delete(sessionKey)
    },

    async refreshChain(refreshToken: string): Promise<MicrosoftSignIn> {
      const clientId = clientIdOf(deps.settings)
      const { status, body } = await requestToken({
        client_id: clientId,
        grant_type: MS_FLOW.refreshGrantType,
        refresh_token: refreshToken,
        scope: MS_FLOW.scope
      })
      if (!body.access_token || !body.refresh_token) {
        throw new AppError('auth', body.error_description ?? 'Microsoft 令牌刷新失败', body.error ?? `HTTP ${status}`, true)
      }
      const progress = await completeWithProfile('refresh', body.access_token, body.refresh_token)
      if (!progress.signIn) {
        throw new AppError('auth', progress.message, undefined, true)
      }
      return progress.signIn
    },

    pending(): string[] {
      return [...sessions.keys()]
    }
  }
}

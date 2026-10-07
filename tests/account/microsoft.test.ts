import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import { ENDPOINTS } from '@shared/constants'
import type { MicrosoftLoginProgress } from '@shared/types'
import { createMicrosoftFlow, dashedUuid, MS_FLOW } from '../../src/main/account/microsoft'
import { makeLogger, makeTempDir, microsoftStub, msFixtures, msSettings } from './fixtures'

/** Flow harness: injected clock + injected sleep so nothing actually waits. */
function harness(opts: Parameters<typeof microsoftStub>[0] = {}, clientId = 'test-client-id') {
  const tmp = makeTempDir('mouc-ms-')
  const log = makeLogger(tmp, 'ms-test')
  let clock = 1_700_000_000_000
  const waits: number[] = []
  const stages: MicrosoftLoginProgress[] = []
  const stub = microsoftStub(opts)
  const flow = createMicrosoftFlow({
    http: stub.http,
    settings: msSettings({ microsoftClientId: clientId }),
    log,
    now: () => clock,
    onStage: (p) => stages.push(p),
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    }
  })
  return { flow, stub, stages, waits, clock: () => clock, advance: (ms: number) => (clock += ms), tmp, log }
}

describe('createMicrosoftFlow.start', () => {
  it('without a client id throws the guidance AppError', async () => {
    const h = harness({}, '')
    const error = await h.flow.start().catch((e) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe('auth')
    expect(error.message).toBe('未配置 Microsoft OAuth 客户端 ID')
    expect(error.detail).toBe('在 设置→账户 中填入你自己的 Azure 应用 ID，README 有创建步骤')
  })

  it('requests a device code and returns the user-facing payload', async () => {
    const h = harness()
    const start = await h.flow.start()
    expect(start.userCode).toBe('ABCD-EFGH')
    expect(start.verificationUri).toBe('https://www.microsoft.com/link')
    expect(start.verificationUriComplete).toBe('https://www.microsoft.com/link?code=ABCD-EFGH')
    expect(start.expiresIn).toBe(900)
    expect(start.interval).toBe(1)
    expect(start.sessionKey).toMatch(/^msauth-/)
    expect(start.message).toContain('ABCD-EFGH')
    expect(h.stub.fetchUrls[0]).toBe(ENDPOINTS.msDeviceCode)
    expect(h.stages[0]!.stage).toBe('waiting-user')
  })
})

describe('createMicrosoftFlow.poll — full device-code chain', () => {
  it('authorization_pending -> slow_down -> success, honouring and growing the interval', async () => {
    const h = harness({
      tokenScript: [{ error: 'authorization_pending' }, { error: 'slow_down' }, msFixtures.tokenOk]
    })
    const start = await h.flow.start()

    const first = await h.flow.poll(start.sessionKey)
    expect(first.stage).toBe('waiting-user')
    expect(h.stub.tokenBodies).toHaveLength(1)
    const body = h.stub.tokenBodies[0]!
    expect(body.get('grant_type')).toBe(MS_FLOW.deviceGrantType)
    expect(body.get('device_code')).toBe('DEV-CODE-1')
    expect(body.get('client_id')).toBe('test-client-id')
    expect(body.get('scope')).toBe('XboxLive.signin offline_access')

    // Immediate re-poll must wait the server-provided interval (1s).
    const second = await h.flow.poll(start.sessionKey)
    expect(second.stage).toBe('waiting-user')
    expect(h.waits[0]).toBe(1000)
    expect(h.stub.tokenBodies).toHaveLength(2)

    // slow_down bumps the interval by 5s -> next wait is 6s, then success.
    const third = await h.flow.poll(start.sessionKey)
    expect(h.waits[1]).toBe(6000)
    expect(third.stage).toBe('done')
    expect(third.account?.name).toBe('Tester')
    expect(third.account?.uuid).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')
    expect(third.account?.type).toBe('microsoft')
    expect(third.signIn?.secrets.accessToken).toBe('MC-AT-1')
    expect(third.signIn?.secrets.refreshToken).toBe('MS-RT-1')
    expect(third.signIn?.warning).toBeUndefined()

    // Stage sequence pushed through onStage.
    const sequence = h.stages.map((p) => p.stage)
    expect(sequence).toEqual([
      'waiting-user', // start
      'waiting-user', // authorization_pending
      'waiting-user', // slow_down
      'microsoft-ok',
      'xbox-ok',
      'live-ok',
      'minecraft-ok',
      'profile-ok',
      'done'
    ])
  })

  it('posts the XBL/XSTS/login bodies exactly as MS_FLOW declares', async () => {
    const h = harness()
    const start = await h.flow.start()
    await h.flow.poll(start.sessionKey)

    const xbl = JSON.parse(h.stub.jsonBodies.get(ENDPOINTS.xboxUserAuth)!)
    expect(xbl).toEqual({
      RelyingParty: MS_FLOW.xboxRelyingParty,
      TokenType: MS_FLOW.tokenType,
      Properties: { AuthMethod: MS_FLOW.authMethod, UserToken: 'MS-AT-1', SandboxId: MS_FLOW.sandbox }
    })
    const xsts = JSON.parse(h.stub.jsonBodies.get(ENDPOINTS.xboxXsts)!)
    expect(xsts.Properties.UserToken).toBe('XBL-TOKEN')
    expect(xsts.RelyingParty).toBe(MS_FLOW.xstsRelyingParty)

    const mc = JSON.parse(h.stub.jsonBodies.get(ENDPOINTS.minecraftLoginWithXbox)!)
    expect(mc.identity).toBe('XBL3.0 x=UHS-1;XSTS-TOKEN')
    expect(h.stub.jsonHeaders.get(ENDPOINTS.minecraftProfile)?.Authorization).toBe('Bearer MC-AT-1')
  })

  it('expired_token surfaces as a failed stage', async () => {
    const h = harness({ tokenScript: [{ error: 'expired_token' }] })
    const start = await h.flow.start()
    const result = await h.flow.poll(start.sessionKey)
    expect(result.stage).toBe('failed')
    expect(result.message).toContain('过期')
    // Session is gone; another poll fails cleanly too.
    const again = await h.flow.poll(start.sessionKey)
    expect(again.stage).toBe('failed')
  })

  it('access_denied (user clicked Cancel) surfaces as a failed stage', async () => {
    const h = harness({ tokenScript: [{ error: 'access_denied' }] })
    const start = await h.flow.start()
    const result = await h.flow.poll(start.sessionKey)
    expect(result.stage).toBe('failed')
    expect(result.message).toContain('拒绝')
  })

  it('sessions expire after expires_in', async () => {
    const h = harness({ tokenScript: [{ error: 'authorization_pending' }] })
    const start = await h.flow.start()
    h.advance(start.expiresIn * 1000 + 1)
    const before = h.stub.tokenBodies.length
    const result = await h.flow.poll(start.sessionKey)
    expect(result.stage).toBe('failed')
    expect(result.message).toContain('超时')
    expect(h.stub.tokenBodies).toHaveLength(before) // no further network traffic
  })

  it('microsoftCancel stops a waiting session', async () => {
    const h = harness({ tokenScript: [{ error: 'authorization_pending' }] })
    const start = await h.flow.start()
    await h.flow.poll(start.sessionKey)
    expect(h.flow.pending()).toContain(start.sessionKey)
    h.flow.cancel(start.sessionKey)
    expect(h.flow.pending()).toEqual([])
    const result = await h.flow.poll(start.sessionKey)
    expect(result.stage).toBe('failed')
  })

  it('a failing XBL hop ends the stage machine with failed', async () => {
    const h = harness({ xbl: { DisplayClaims: { Uhs: ['UHS-1'] }, XErr: 2148916233 } })
    const start = await h.flow.start()
    const result = await h.flow.poll(start.sessionKey)
    expect(result.stage).toBe('failed')
    expect(result.message).toContain('Xbox Live 登录失败')
    expect(result.message).toContain('2148916233')
  })

  it('an unowned Java copy is a warning in the done progress, not a failure', async () => {
    const h = harness({ entitlements: msFixtures.entitlementsMissing })
    const start = await h.flow.start()
    const result = await h.flow.poll(start.sessionKey)
    expect(result.stage).toBe('done')
    expect(result.account).toBeDefined()
    expect(result.message).toContain('警告')
    expect(result.signIn?.warning).toContain('Java')
  })
})

describe('createMicrosoftFlow.refreshChain', () => {
  it('re-runs the whole chain from a refresh token', async () => {
    const h = harness({
      refreshScript: [{ access_token: 'MS-AT-2', refresh_token: 'MS-RT-2', expires_in: 3600 }],
      mcAuth: { access_token: 'MC-AT-2', username: 'Tester' }
    })
    const signIn = await h.flow.refreshChain('OLD-RT')
    const body = h.stub.refreshBodies[0]!
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('OLD-RT')
    expect(body.get('client_id')).toBe('test-client-id')
    expect(signIn.secrets.accessToken).toBe('MC-AT-2')
    expect(signIn.secrets.refreshToken).toBe('MS-RT-2')
    expect(signIn.account.name).toBe('Tester')
    const identity = JSON.parse(h.stub.jsonBodies.get(ENDPOINTS.minecraftLoginWithXbox)!).identity
    expect(identity).toBe('XBL3.0 x=UHS-1;XSTS-TOKEN')
  })

  it('a rejected refresh throws an auth AppError', async () => {
    const h = harness({ refreshScript: [{ error: 'invalid_grant' }] })
    await expect(h.flow.refreshChain('BAD-RT')).rejects.toMatchObject({ code: 'auth' })
  })
})

describe('dashedUuid', () => {
  it('formats Mojang undashed ids', () => {
    expect(dashedUuid('5627DD98E6BE3C21B8A8E92344183641')).toBe('5627dd98-e6be-3c21-b8a8-e92344183641')
  })
  it('passes through anything that is not 32 hex chars', () => {
    expect(dashedUuid('Already-Dashed-1234')).toBe('already-dashed-1234')
  })
})

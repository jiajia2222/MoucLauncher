import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account } from '@shared/types'
import { createAccountStore, accountsFileFor, type SecretCipher } from '../../src/main/account/store'
import { fakeCipher, makeTempDir } from './fixtures'

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
  const t = Date.now()
  return {
    id,
    type: 'microsoft',
    name: id,
    uuid: id,
    selected: false,
    addedAt: t,
    lastUsedAt: t,
    tokenState: 'valid',
    label: id,
    ...overrides
  }
}

describe('account store (encrypted at rest)', () => {
  let tmp = ''

  beforeEach(() => {
    tmp = makeTempDir('mouc-accounts-')
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('persists at <configDir>/accounts.json and never writes plaintext tokens', async () => {
    const store = createAccountStore({ appData: tmp, cipher: fakeCipher })
    await store.upsert(makeAccount('uuid-1'), { accessToken: 'tok-SECRET-VALUE', refreshToken: 'rt-SECRET-VALUE' })

    const file = accountsFileFor(tmp)
    expect(file).toBe(path.join(tmp, 'config', 'accounts.json'))
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('tok-SECRET-VALUE')
    expect(raw).not.toContain('rt-SECRET-VALUE')
    expect(raw).toContain('enc:')

    const secrets = await store.secrets('uuid-1')
    expect(secrets.accessToken).toBe('tok-SECRET-VALUE')
    expect(secrets.refreshToken).toBe('rt-SECRET-VALUE')
  })

  it('round-trips accounts and replaces secrets per upsert', async () => {
    const store = createAccountStore({ appData: tmp, cipher: fakeCipher })
    await store.upsert(makeAccount('a'), { accessToken: 'first' })
    await store.upsert({ ...makeAccount('a'), name: 'renamed' })
    const accounts = await store.list()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.name).toBe('renamed')
    // secrets survive when upsert omits them
    expect((await store.secrets('a')).accessToken).toBe('first')
    await store.replaceSecrets('a', { accessToken: 'second' })
    expect((await store.secrets('a')).accessToken).toBe('second')
  })

  it('keeps exactly one selected account', async () => {
    const store = createAccountStore({ appData: tmp, cipher: fakeCipher })
    await store.upsert(makeAccount('a', { selected: true }), {})
    await store.upsert(makeAccount('b', { selected: true }), {})
    let accounts = await store.list()
    expect(accounts.filter((a) => a.selected)).toHaveLength(1)

    const b = await store.select('b')
    expect(b.selected).toBe(true)
    accounts = await store.list()
    expect(accounts.find((a) => a.id === 'a')!.selected).toBe(false)
    expect(accounts.filter((a) => a.selected).map((a) => a.id)).toEqual(['b'])
  })

  it('remove() deletes the record; offline accounts need no secrets', async () => {
    const store = createAccountStore({ appData: tmp, cipher: fakeCipher })
    await store.upsert(makeAccount('x', { type: 'offline', tokenState: 'valid' }), {})
    await store.remove('x')
    expect(await store.list()).toEqual([])
    expect(await store.get('x')).toBeUndefined()
  })

  it('a corrupt/rotated ciphertext surfaces as tokenState=invalid instead of crashing', async () => {
    const brokenCipher: SecretCipher = {
      encrypt: (p) => 'enc:' + Buffer.from(p, 'utf8').toString('base64'),
      decrypt: () => {
        throw new Error('safeStorage unavailable')
      }
    }
    const store = createAccountStore({ appData: tmp, cipher: brokenCipher })
    await store.upsert(makeAccount('a'), { accessToken: 'tok' })
    const accounts = await store.list()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.tokenState).toBe('invalid')
    expect((await store.secrets('a'))).toEqual({})
  })

  it('survives a garbage file (readJsonSafe fallback)', async () => {
    const file = accountsFileFor(tmp)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json', 'utf8')
    const store = createAccountStore({ appData: tmp, cipher: fakeCipher })
    expect(await store.list()).toEqual([])
  })
})

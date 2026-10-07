/**
 * Account persistence at `<configDir>/accounts.json` (`configDir` = `<appData>/config`,
 * see core/paths). Tokens are NEVER stored in plaintext: the secrets bag of each
 * account is serialised, run through the INJECTED `SecretCipher`, and only the
 * ciphertext string lands on disk. Production wires Electron's safeStorage
 * (electronCipher.ts); tests inject a trivial reversible cipher.
 */
import path from 'node:path'
import type { Account, TokenState } from '@shared/types'
import { AppError } from '@shared/errors'
import { readJsonSafe, writeJsonAtomic } from '../core/fsx'

export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(cipherText: string): string
}

export type SecretsBag = Record<string, unknown>

interface PersistedAccount {
  account: Account
  /** Cipher.encrypt(JSON.stringify(secrets)); '' when there are no secrets. */
  secretsCipher: string
}

interface AccountsFile {
  version: number
  accounts: PersistedAccount[]
}

export interface AccountStore {
  file(): string
  list(): Promise<Account[]>
  get(id: string): Promise<Account | undefined>
  /** Decrypted secrets; `{}` when the account has none or has none stored. */
  secrets(id: string): Promise<SecretsBag>
  /** Insert or replace by id. `secrets` undefined = keep the existing bag. */
  upsert(account: Account, secrets?: SecretsBag): Promise<Account>
  replaceSecrets(id: string, secrets: SecretsBag): Promise<void>
  remove(id: string): Promise<void>
  /** Exactly one account ends up selected. */
  select(id: string): Promise<Account>
}

export function accountsFileFor(appData: string): string {
  return path.join(appData, 'config', 'accounts.json')
}

function ensureExactlyOneSelected(accounts: Account[]): Account[] {
  const selected = new Set(accounts.filter((a) => a.selected).map((a) => a.id))
  if (selected.size > 1) {
    let seen = false
    for (const account of accounts) {
      if (account.selected && seen) account.selected = false
      if (account.selected) seen = true
    }
  }
  if (accounts.length > 0 && !accounts.some((a) => a.selected)) accounts[0]!.selected = true
  return accounts
}

export function createAccountStore(deps: { appData: string; cipher: SecretCipher }): AccountStore {
  const file = accountsFileFor(deps.appData)

  async function read(): Promise<PersistedAccount[]> {
    const raw = await readJsonSafe<AccountsFile>(file, { version: 1, accounts: [] })
    return Array.isArray(raw.accounts) ? raw.accounts : []
  }

  async function write(entries: PersistedAccount[]): Promise<void> {
    const accounts = ensureExactlyOneSelected(entries.map((e) => ({ ...e.account })))
    const byId = new Map(entries.map((e) => [e.account.id, e]))
    const next: PersistedAccount[] = accounts.map((account) => ({
      account,
      secretsCipher: byId.get(account.id)?.secretsCipher ?? ''
    }))
    await writeJsonAtomic(file, { version: 1, accounts: next } satisfies AccountsFile)
  }

  function decrypt(cipherText: string): { secrets: SecretsBag; broken: boolean } {
    if (!cipherText) return { secrets: {}, broken: false }
    try {
      const parsed: unknown = JSON.parse(deps.cipher.decrypt(cipherText))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { secrets: parsed as SecretsBag, broken: false }
      return { secrets: {}, broken: true }
    } catch {
      return { secrets: {}, broken: true }
    }
  }

  return {
    file: () => file,

    async list(): Promise<Account[]> {
      const entries = await read()
      const accounts: Account[] = []
      for (const entry of entries) {
        const account = { ...entry.account }
        if (account.type !== 'offline') {
          const { secrets, broken } = decrypt(entry.secretsCipher)
          // A cipher that changed (or corrupt data) must not brick the list:
          // the account stays visible but its token is marked invalid.
          if (broken) {
            account.tokenState = 'invalid'
          } else if (account.tokenState === 'valid' && account.expiresAt && account.expiresAt <= Date.now()) {
            account.tokenState = 'needs-refresh'
          } else if (account.tokenState === 'none' && Object.keys(secrets).length > 0) {
            account.tokenState = 'valid'
          }
        }
        accounts.push(account)
      }
      return ensureExactlyOneSelected(accounts)
    },

    async get(id: string): Promise<Account | undefined> {
      return (await this.list()).find((a) => a.id === id)
    },

    async secrets(id: string): Promise<SecretsBag> {
      const entries = await read()
      const entry = entries.find((e) => e.account.id === id)
      if (!entry) throw new AppError('not-found', `账户 ${id} 不存在`, file)
      return decrypt(entry.secretsCipher).secrets
    },

    async upsert(account: Account, secrets?: SecretsBag): Promise<Account> {
      const entries = await read()
      const existing = entries.find((e) => e.account.id === account.id)
      let cipherText: string
      if (secrets === undefined) {
        cipherText = existing?.secretsCipher ?? ''
      } else {
        const keys = Object.keys(secrets)
        cipherText = keys.length === 0 ? '' : deps.cipher.encrypt(JSON.stringify(secrets))
      }
      const next = entries.filter((e) => e.account.id !== account.id)
      next.push({ account: { ...account }, secretsCipher: cipherText })
      await write(next)
      return account
    },

    async replaceSecrets(id: string, secrets: SecretsBag): Promise<void> {
      const entries = await read()
      const entry = entries.find((e) => e.account.id === id)
      if (!entry) throw new AppError('not-found', `账户 ${id} 不存在`, file)
      entry.secretsCipher = Object.keys(secrets).length === 0 ? '' : deps.cipher.encrypt(JSON.stringify(secrets))
      await write(entries)
    },

    async remove(id: string): Promise<void> {
      const entries = await read()
      await write(entries.filter((e) => e.account.id !== id))
    },

    async select(id: string): Promise<Account> {
      const entries = await read()
      const found = entries.find((e) => e.account.id === id)
      if (!found) throw new AppError('not-found', `账户 ${id} 不存在`, file)
      const t = Date.now()
      for (const entry of entries) {
        entry.account.selected = entry.account.id === id
        if (entry.account.id === id) entry.account.lastUsedAt = t
      }
      await write(entries)
      return { ...found.account, selected: true, lastUsedAt: t }
    }
  }
}

export type { TokenState }

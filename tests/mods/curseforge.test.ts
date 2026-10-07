import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import type { SearchQuery } from '@shared/types'
import { createCurseForgeProvider, __internals } from '../../src/main/mods/providers/curseforge'
import { makeStubHttp, readFixtureJson } from '../loader/helpers'

const query: SearchQuery = { provider: 'curseforge', kind: 'mod', keyword: 'jei', offset: 0, limit: 20 }

describe('curseforge missing-key guard', () => {
  it('throws AppError(unsupported) when the API key is empty (no silent fallback)', async () => {
    const provider = createCurseForgeProvider(makeStubHttp(() => ({})), '')
    await expect(provider.search(query)).rejects.toBeInstanceOf(AppError)
  })

  it('the thrown error carries the exact user-facing message', async () => {
    const provider = createCurseForgeProvider(makeStubHttp(() => ({})), '   ')
    const error: unknown = await provider.search(query).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AppError)
    const appError = error as AppError
    expect(appError.code).toBe('unsupported')
    expect(appError.message).toBe('未配置 CurseForge API Key')
  })
})

describe('curseforge mapping (documented Core API schema)', () => {
  it('maps a search hit into ModProject with loaders from categories', async () => {
    const provider = createCurseForgeProvider(
      makeStubHttp(() => readFixtureJson('mods/curseforge-search.json')),
      'secret-key'
    )
    const page = await provider.search(query)
    const jei = page.items[0]!
    expect(jei.provider).toBe('curseforge')
    expect(jei.id).toBe('306198')
    expect(jei.kind).toBe('mod')
    expect(jei.downloads).toBeGreaterThan(0)
    expect(jei.iconUrl).toMatch(/^https:\/\/media\.forgecdn\.net\//)
    expect(jei.loaders).toContain('forge')
    expect(jei.gameVersions).toContain('1.20.1')
    expect(jei.authors).toEqual(['mezz'])
  })

  it('uses the canonical download redirect when downloadUrl is null', () => {
    expect(__internals.downloadUrl(306198, 5000001)).toMatch(
      /\/306198\/files\/5000001\/download$/
    )
  })

  it('maps a file dependency type to a required/optional/incompatible kind', () => {
    expect(__internals.depKind(1)).toBe('required')
    expect(__internals.depKind(2)).toBe('optional')
    expect(__internals.depKind(4)).toBe('incompatible')
  })
})

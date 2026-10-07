import { describe, expect, it } from 'vitest'
import { ENDPOINTS } from '@shared/constants'
import type { SearchQuery } from '@shared/types'
import { buildFilters, createModrinthProvider, __mapVersion } from '../../src/main/mods/providers/modrinth'
import { makeStubHttp, readFixtureJson } from '../loader/helpers'

function query(patch: Partial<SearchQuery> = {}): SearchQuery {
  return { provider: 'modrinth', kind: 'mod', keyword: 'sodium', offset: 0, limit: 20, ...patch }
}

describe('modrinth filter encoding (RQL expression)', () => {
  it('builds the AND expression with the empirically-correct field names', () => {
    expect(buildFilters({ kind: 'mod', loader: 'fabric', gameVersion: '1.21.1' })).toBe(
      'project_types = "mod" AND categories = "fabric" AND game_versions = "1.21.1"'
    )
  })

  it('omits absent facets', () => {
    expect(buildFilters({ kind: 'mod' })).toBe('project_types = "mod"')
    expect(buildFilters({})).toBe('[]')
  })

  it('the search URL is fully query-encoded (brackets/quotes escaped)', () => {
    const provider = createModrinthProvider(makeStubHttp(() => readFixtureJson('mods/modrinth-search.json')))
    void provider
    const params = new URLSearchParams()
    params.set('filters', buildFilters({ kind: 'mod', loader: 'fabric', gameVersion: '1.21.1' }))
    expect(params.toString()).toContain('filters=project_types+%3D')
    expect(params.toString()).not.toMatch(/\[[a-z]/)
  })
})

describe('modrinth search -> ModProject mapping', () => {
  it('maps slug/downloads/icon CDN/categories/loaders/game_versions/date_modified', async () => {
    let requested = ''
    const provider = createModrinthProvider(
      makeStubHttp((url) => {
        requested = url
        return readFixtureJson('mods/modrinth-search.json')
      })
    )
    const page = await provider.search(query({ loader: 'fabric', gameVersion: '1.21.1' }))
    expect(requested.startsWith(ENDPOINTS.modrinthSearch)).toBe(true)
    expect(page.total).toBeGreaterThan(0)
    const sodium = page.items.find((p) => p.slug === 'sodium')!
    expect(sodium.provider).toBe('modrinth')
    expect(sodium.id).toBe('AANobbMI')
    expect(sodium.kind).toBe('mod')
    expect(sodium.downloads).toBeGreaterThan(0)
    expect(sodium.iconUrl).toMatch(/^https:\/\/cdn\.modrinth\.com\/data\//)
    expect(sodium.loaders).toContain('fabric')
    expect(sodium.gameVersions).toContain('1.21.1')
    expect(Array.isArray(sodium.authors)).toBe(true)
    expect(sodium.authors.length).toBeGreaterThan(0)
    expect(sodium.dateModified).toMatch(/^\d{4}-/)
  })
})

describe('modrinth project versions -> ProjectVersion + ModFile', () => {
  it('maps files with sha1/sha512 hashes, url, filename, size and dependencies', async () => {
    const provider = createModrinthProvider(
      makeStubHttp(() => readFixtureJson('mods/modrinth-project-versions.json'))
    )
    const versions = await provider.versions('sodium', '1.21.1', 'fabric')
    expect(versions.length).toBeGreaterThan(0)
    const first = versions[0]!
    expect(first.provider).toBe('modrinth')
    expect(first.projectId).toBe('AANobbMI')
    expect(first.loaders).toContain('fabric')
    expect(first.gameVersions).toContain('1.21.1')
    const file = first.files.find((f) => f.primary)!
    expect(file.fileName).toContain('sodium-fabric')
    expect(file.url).toMatch(/^https:\/\/cdn\.modrinth\.com\/data\/AANobbMI\/versions\//)
    expect(file.hashes.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(file.hashes.sha512).toMatch(/^[0-9a-f]{128}$/)
    expect(file.size).toBeGreaterThan(0)
    expect(file.versionId).toBe(first.id)
  })

  it('maps required dependencies from a version that declares them', () => {
    const raw = readFixtureJson<unknown[]>('mods/modrinth-modmenu-versions.json')
    const version = __mapVersion(raw[0] as never)
    const required = version.dependencies.filter((d) => d.kind === 'required')
    expect(required.length).toBe(2)
    expect(required[0]!.projectId).toBe('P7dR8mSH')
    expect(required[0]!.projectProvider).toBe('modrinth')
  })
})

import { describe, expect, it } from 'vitest'
import { OFFICIAL_HOSTS } from '@shared/constants'
import type { MirrorRule } from '@shared/types'
import { candidateUrls, rewriteUrl } from '../../src/main/download/mirror'
import { makeMirrorRule } from './fixtures'

function rule(hosts: Record<string, string>, priority = 1, enabled = true): MirrorRule {
  return makeMirrorRule(hosts, priority, enabled)
}

describe('rewriteUrl', () => {
  it('returns the official url untouched when no rules exist', () => {
    const url = 'https://piston-data.mojang.com/v1/objects/abc/client.jar'
    expect(rewriteUrl(url, [])).toEqual([url])
  })

  it('puts the rewritten url first and keeps the official url last', () => {
    const url = `https://${OFFICIAL_HOSTS.pistonData}/v1/objects/abc/client.jar`
    const rules = [rule({ [OFFICIAL_HOSTS.pistonData]: 'mirror.example.com' })]
    expect(rewriteUrl(url, rules)).toEqual(['https://mirror.example.com/v1/objects/abc/client.jar', url])
  })

  it('maps libraries under the /maven prefix on a BMCLAPI-style mirror', () => {
    const url = `https://${OFFICIAL_HOSTS.libraries}/com/mojang/logging/1.1.1/logging-1.1.1.jar`
    const rules = [rule({ [OFFICIAL_HOSTS.libraries]: 'mirror.example.com' })]
    const [rewritten] = rewriteUrl(url, rules)
    expect(rewritten).toBe(`https://mirror.example.com/maven/com/mojang/logging/1.1.1/logging-1.1.1.jar`)
  })

  it('leaves non-official hosts without a path prefix', () => {
    const url = 'https://api.modrinth.com/v2/files/x.jar'
    const rules = [rule({ 'api.modrinth.com': 'mirror.example.com' })]
    expect(rewriteUrl(url, rules)).toEqual(['https://mirror.example.com/v2/files/x.jar', url])
  })

  it('ignores disabled rules', () => {
    const url = `https://${OFFICIAL_HOSTS.pistonMeta}/mc/game/version_manifest_v2.json`
    const rules = [rule({ [OFFICIAL_HOSTS.pistonMeta]: 'mirror.example.com' }, 1, false)]
    expect(rewriteUrl(url, rules)).toEqual([url])
  })

  it('orders rewrites by ascending priority regardless of array order', () => {
    const url = `https://${OFFICIAL_HOSTS.pistonData}/x/y.jar`
    const rules = [
      rule({ [OFFICIAL_HOSTS.pistonData]: 'slow.example.com' }, 5),
      rule({ [OFFICIAL_HOSTS.pistonData]: 'fast.example.com' }, 1)
    ]
    expect(rewriteUrl(url, rules)).toEqual([
      'https://fast.example.com/x/y.jar',
      'https://slow.example.com/x/y.jar',
      url
    ])
  })

  it('only rewrites hosts that appear in the rule', () => {
    const url = `https://${OFFICIAL_HOSTS.resources}/aa/aabbd09...`
    const rules = [rule({ [OFFICIAL_HOSTS.pistonData]: 'mirror.example.com' })]
    expect(rewriteUrl(url, rules)).toEqual([url])
  })

  it('preserves query strings and mirror ports', () => {
    const url = 'https://libraries.minecraft.net/a/b.jar?token=xyz'
    const rules = [rule({ 'libraries.minecraft.net': 'mirror.example.com:8443' })]
    const [rewritten, official] = rewriteUrl(url, rules)
    expect(rewritten).toBe('https://mirror.example.com:8443/maven/a/b.jar?token=xyz')
    expect(official).toBe(url)
  })

  it('passes through unparsable or non-http urls', () => {
    expect(rewriteUrl('not a url', [rule({ x: 'y' })])).toEqual(['not a url'])
    expect(rewriteUrl('ftp://example.com/f', [rule({ 'example.com': 'mirror.example.com' })])).toEqual([
      'ftp://example.com/f'
    ])
  })

  it('deduplicates when a rule rewrites to the same host', () => {
    const url = `https://${OFFICIAL_HOSTS.pistonData}/a/b`
    const rules = [rule({ [OFFICIAL_HOSTS.pistonData]: OFFICIAL_HOSTS.pistonData })]
    expect(rewriteUrl(url, rules)).toEqual([url])
  })
})

describe('candidateUrls', () => {
  it('tries mirror of the primary, then primary, then mirror of fallbacks', () => {
    const primary = `https://${OFFICIAL_HOSTS.pistonMeta}/mc/game/version_manifest_v2.json`
    const fallback = `https://${OFFICIAL_HOSTS.launchermeta}/mc/game/version_manifest_v2.json`
    const rules = [
      rule({
        [OFFICIAL_HOSTS.pistonMeta]: 'mirror.example.com',
        [OFFICIAL_HOSTS.launchermeta]: 'mirror.example.com'
      })
    ]
    expect(candidateUrls(primary, [fallback], rules)).toEqual([
      'https://mirror.example.com/mc/game/version_manifest_v2.json',
      primary,
      fallback
    ])
  })

  it('keeps plain order without rules', () => {
    expect(candidateUrls('https://a.example/1', ['https://b.example/1'], [])).toEqual([
      'https://a.example/1',
      'https://b.example/1'
    ])
  })
})

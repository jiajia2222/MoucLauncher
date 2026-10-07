import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENDPOINTS } from '@shared/constants'
import type { LoaderOption } from '@shared/ipc'
import { loaderOptionVersions, profileToPlan } from '../../src/main/loader/fabric'
import type { FabricLoaderEntry, LoaderProfileJson } from '../../src/main/loader/types'
import { buildPaths } from '../../src/main/core/paths'
import { readFixtureJson } from './helpers'

const paths = buildPaths('/tmp/appdata', '/tmp/game')

describe('fabric profile json -> plan', () => {
  const profile = readFixtureJson<LoaderProfileJson>('loader/fabric-profile-1.21.1.json')

  it('uses the provider id verbatim', () => {
    const plan = profileToPlan(profile, paths, 'fabric')
    expect(plan.versionId).toBe('fabric-loader-0.19.5-1.21.1')
    expect(plan.versionJson.inheritsFrom).toBe('1.21.1')
    expect(plan.versionJson.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
  })

  it('resolves libraries against the maven repo each entry declares', () => {
    const plan = profileToPlan(profile, paths, 'fabric')
    const asm = plan.items.find((i) => i.url.includes('org/ow2/asm/asm/9.10.1/asm-9.10.1.jar'))
    expect(asm?.url).toBe(`${ENDPOINTS.fabricMaven}/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar`)
    expect(asm?.target).toBe(path.join(paths.librariesDir, 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar'))
    expect(asm?.sha1).toBe('ada2141c0cc52ee8f5c48cd5fa4ce0e794f22236')
    // intermediary + loader have no sha/size in the fixture; still resolved from the fabric repo.
    const loader = plan.items.find((i) => i.url.includes('net/fabricmc/fabric-loader/0.19.5/'))
    expect(loader?.url).toBe(`${ENDPOINTS.fabricMaven}/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar`)
    expect(loader?.sha1).toBeUndefined()
  })

  it('deduplicates targets', () => {
    const plan = profileToPlan(profile, paths, 'fabric')
    const targets = plan.items.map((i) => i.target)
    expect(new Set(targets).size).toBe(targets.length)
  })
})

describe('quilt profile json -> plan', () => {
  const profile = readFixtureJson<LoaderProfileJson>('loader/quilt-profile-1.21.1.json')

  it('resolves quilt-only artifacts under the quilt maven repo', () => {
    const plan = profileToPlan(profile, paths, 'quilt')
    expect(plan.versionId).toBe('quilt-loader-0.20.0-beta.9-1.21.1')
    const loader = plan.items.find((i) => i.url.includes('org/quiltmc/quilt-loader/0.20.0-beta.9/'))
    expect(loader?.url).toBe(`${ENDPOINTS.quiltMaven}/org/quiltmc/quilt-loader/0.20.0-beta.9/quilt-loader-0.20.0-beta.9.jar`)
    // a fabric-hosted lib inside the quilt profile keeps its own url
    const mixin = plan.items.find((i) => i.url.includes('net/fabricmc/sponge-mixin/'))
    expect(mixin?.url.startsWith(ENDPOINTS.fabricMaven)).toBe(true)
  })
})

describe('loaderOptionVersions', () => {
  it('marks stable and promotes the newest stable build to recommended', () => {
    const entries = readFixtureJson<FabricLoaderEntry[]>('loader/fabric-loader-list-1.21.1.json')
    const versions = loaderOptionVersions(entries)
    expect(versions.length).toBeGreaterThan(0)
    const rec = versions.filter((v) => v.recommended)
    expect(rec.length).toBe(1)
    expect(rec[0]!.stable).toBe(true)
  })

  it('treats beta builds as unstable (quilt naming)', () => {
    const entries = readFixtureJson<FabricLoaderEntry[]>('loader/quilt-loader-list-1.21.1.json')
    const versions = loaderOptionVersions(entries)
    const beta = versions.find((v) => v.version.includes('beta'))
    if (beta) expect(beta.stable).toBe(false)
  })
})

// Type-only guard: the option list shape matches the IPC contract.
const _guard: LoaderOption = { id: 'fabric', label: 'Fabric', versions: [] }
void _guard

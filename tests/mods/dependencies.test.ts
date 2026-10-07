import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { ModFile } from '@shared/types'
import { createModService } from '../../src/main/mods/service'
import type { ModService } from '../../src/main/core/contracts'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { zipAll } from '../../src/main/core/zip'
import { makeStubHttp, makeRecordingDownloader, type RecordingDownloader, fakeLogger, fakeSettings, makeTempWorkspace, type TempWorkspace } from '../loader/helpers'

let workspace: TempWorkspace
let store: InstanceStore
let service: ModService
let downloader: RecordingDownloader
let instanceId: string
let gameDir: string

beforeEach(() => {
  workspace = makeTempWorkspace('mods-deps')
  store = new InstanceStore(() => workspace.paths)
  downloader = makeRecordingDownloader()
  const instance = store.create({ name: 'deps', versionId: '1.21.1', gameVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.19.5' })
  instanceId = instance.id
  gameDir = store.gameDir(instance)
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true })
})
afterEach(() => fs.rmSync(path.dirname(workspace.appData), { recursive: true, force: true }))

/** A minimal ModFile for the primary mod being installed. */
function modFile(projectId: string, fileName: string, deps: ModFile['dependencies'] = []): ModFile {
  return {
    versionId: `v-${projectId}`,
    projectId,
    provider: 'modrinth',
    name: projectId,
    fileName,
    url: `https://cdn.modrinth.com/data/${projectId}/${fileName}`,
    size: 100,
    hashes: { sha1: 'a'.repeat(40) },
    loaders: ['fabric'],
    gameVersions: ['1.21.1'],
    dependencies: deps,
    primary: true
  }
}

/** Raw Modrinth version JSON keyed by project id, fed through the stub http. */
function resolver(map: Record<string, Array<{ projectId: string; deps: string[] }>>): (url: string) => unknown {
  return (url) => {
    const m = url.match(/\/project\/([^/]+)\/version/)
    const projectId = m?.[1]
    if (!projectId || !map[projectId]) throw new Error('unmapped ' + url)
    return map[projectId].map((v) => ({
      id: `vid-${v.projectId}`,
      project_id: v.projectId,
      name: v.projectId,
      version_number: '1.0.0',
      date_published: '2026-01-01T00:00:00+00:00',
      loaders: ['fabric'],
      game_versions: ['1.21.1'],
      files: [{ id: `f-${v.projectId}`, hashes: { sha1: 'b'.repeat(40) }, url: `https://cdn.modrinth.com/${v.projectId}.jar`, filename: `${v.projectId}.jar`, primary: true, size: 10 }],
      dependencies: v.deps.map((d) => ({ version_id: null, project_id: d, file_name: null, dependency_type: 'required' }))
    }))
  }
}

function newService(res: (url: string) => unknown): void {
  service = createModService({
    http: makeStubHttp(res),
    downloader,
    instances: store,
    settings: fakeSettings(),
    paths: workspace.paths,
    log: fakeLogger()
  })
}

describe('required dependency resolution', () => {
  it('adds missing required dependencies to the same plan', async () => {
    newService(resolver({ B: [{ projectId: 'B', deps: [] }] }))
    const primary = modFile('A', 'A.jar', [{ projectId: 'B', kind: 'required', projectProvider: 'modrinth' }])
    await service.install(instanceId, 'mod', primary, true)
    const plan = downloader.plans[0]!
    const names = plan.items.map((i) => path.basename(i.target)).sort()
    expect(names).toEqual(['A.jar', 'B.jar'])
    // provenance recorded for both.
    const prov = JSON.parse(fs.readFileSync(path.join(gameDir, '.mouc', 'mod-provenance.json'), 'utf8')) as Record<string, { projectId: string }>
    expect(prov['A.jar'].projectId).toBe('A')
    expect(prov['B.jar'].projectId).toBe('B')
  })

  it('skips a required dependency already installed in the instance', async () => {
    // Pre-install B so its provenance is present.
    newService(resolver({}))
    await service.install(instanceId, 'mod', modFile('B', 'B.jar'), false)
    // Now install A which requires B -> B should not be re-fetched.
    downloader.plans.length = 0
    newService(resolver({ B: [{ projectId: 'B', deps: [] }] }))
    await service.install(instanceId, 'mod', modFile('A', 'A.jar', [{ projectId: 'B', kind: 'required', projectProvider: 'modrinth' }]), true)
    const names = downloader.plans[0]!.items.map((i) => path.basename(i.target))
    expect(names).toEqual(['A.jar'])
  })

  it('guards against dependency cycles with a visited set', async () => {
    // A -> B -> A (cycle). visited prevents A from being re-added via B.
    newService(resolver({
      A: [{ projectId: 'A', deps: ['B'] }],
      B: [{ projectId: 'B', deps: ['A'] }]
    }))
    const primary = modFile('A', 'A.jar', [{ projectId: 'B', kind: 'required', projectProvider: 'modrinth' }])
    await service.install(instanceId, 'mod', primary, true)
    const names = downloader.plans[0]!.items.map((i) => path.basename(i.target)).sort()
    expect(names).toEqual(['A.jar', 'B.jar']) // terminates, no duplicate / infinite loop
  })

  it('caps recursion depth on a long dependency chain', async () => {
    // A -> B -> C -> ... -> H (8 nodes). MAX_DEP_DEPTH is 6, so it must stop early, not hang.
    const chain: Record<string, Array<{ projectId: string; deps: string[] }>> = {}
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
    for (let i = 0; i < letters.length - 1; i += 1) {
      chain[letters[i]!] = [{ projectId: letters[i]!, deps: [letters[i + 1]!] }]
    }
    chain[letters[letters.length - 1]!] = [{ projectId: letters[letters.length - 1]!, deps: [] }]
    newService(resolver(chain))
    const primary = modFile('A', 'A.jar', [{ projectId: 'B', kind: 'required', projectProvider: 'modrinth' }])
    const before = Date.now()
    await service.install(instanceId, 'mod', primary, true)
    const items = downloader.plans[0]!.items.map((i) => path.basename(i.target))
    // bounded by 1 (primary) + MAX_DEP_DEPTH (6) entries and always terminates quickly.
    expect(items.length).toBeLessThanOrEqual(7)
    expect(Date.now() - before).toBeLessThan(2000)
  })
})

// keep the zipAll import referenced for future jar-shaped dep fixtures
void zipAll

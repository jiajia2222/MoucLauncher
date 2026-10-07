import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { ModFile } from '@shared/types'
import { createModService } from '../../src/main/mods/service'
import type { ModService } from '../../src/main/core/contracts'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { zipAll } from '../../src/main/core/zip'
import { makeStubHttp, makeRecordingDownloader, fakeLogger, fakeSettings, makeTempWorkspace, type TempWorkspace } from '../loader/helpers'

let workspace: TempWorkspace
let store: InstanceStore
let instanceId: string
let gameDir: string
let modsDir: string

beforeEach(() => {
  workspace = makeTempWorkspace('mods-updates')
  store = new InstanceStore(() => workspace.paths)
  const instance = store.create({ name: 'upd', versionId: '1.21.1', gameVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.19.5' })
  instanceId = instance.id
  gameDir = store.gameDir(instance)
  modsDir = path.join(gameDir, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
})
afterEach(() => fs.rmSync(path.dirname(workspace.appData), { recursive: true, force: true }))

function writeJar(fileName: string, id: string, version: string): void {
  const zip = zipAll({ 'fabric.mod.json': Buffer.from(JSON.stringify({ id, version }), 'utf8') })
  fs.writeFileSync(path.join(modsDir, fileName), Buffer.from(zip))
}

function serviceReturningVersions(latestId: string, versionId: string): ModService {
  return createModService({
    http: makeStubHttp((url) => {
      if (!url.includes('/version')) throw new Error('unexpected ' + url)
      return [
        {
          id: versionId,
          project_id: 'AANobbMI',
          name: 'Sodium',
          version_number: '0.9.0',
          date_published: '2026-09-01T00:00:00+00:00',
          loaders: ['fabric'],
          game_versions: ['1.21.1'],
          files: [{ id: 'file-new', hashes: { sha1: 'c'.repeat(40) }, url: 'https://cdn.modrinth.com/x/sodium.jar', filename: 'sodium-new.jar', primary: true, size: 1 }],
          dependencies: []
        }
      ]
    }),
    downloader: makeRecordingDownloader(),
    instances: store,
    settings: fakeSettings(),
    paths: workspace.paths,
    log: fakeLogger()
  })
  void latestId
}

function modFile(): ModFile {
  return {
    versionId: 'OLDVER',
    projectId: 'AANobbMI',
    provider: 'modrinth',
    name: 'Sodium',
    fileName: 'sodium.jar',
    url: 'https://cdn.modrinth.com/data/AANobbMI/sodium.jar',
    size: 10,
    hashes: { sha1: 'd'.repeat(40) },
    loaders: ['fabric'],
    gameVersions: ['1.21.1'],
    dependencies: [],
    primary: true
  }
}

describe('checkUpdates', () => {
  it('flags an update when the provider has a newer version than provenance', async () => {
    const service = serviceReturningVersions('NEWVER', 'NEWVER')
    writeJar('sodium.jar', 'sodium', '0.8.13')
    // Install records provenance { projectId, versionId: OLDVER } keyed by sodium.jar.
    await service.install(instanceId, 'mod', modFile(), false)

    const [mod] = await service.checkUpdates(instanceId)
    expect(mod.projectId).toBe('AANobbMI')
    expect(mod.versionId).toBe('OLDVER')
    expect(mod.updateAvailable?.id).toBe('NEWVER')
  })

  it('reports no update when provenance already matches the newest version', async () => {
    const service = createModService({
      http: makeStubHttp(() => [
        {
          id: 'OLDVER',
          project_id: 'AANobbMI',
          name: 'Sodium',
          version_number: '0.8.13',
          date_published: '2026-01-01T00:00:00+00:00',
          loaders: ['fabric'],
          game_versions: ['1.21.1'],
          files: [{ id: 'file', hashes: { sha1: 'a'.repeat(40) }, url: 'https://cdn.modrinth.com/x.jar', filename: 'sodium.jar', primary: true, size: 1 }],
          dependencies: []
        }
      ]),
      downloader: makeRecordingDownloader(),
      instances: store,
      settings: fakeSettings(),
      paths: workspace.paths,
      log: fakeLogger()
    })
    writeJar('sodium.jar', 'sodium', '0.8.13')
    await service.install(instanceId, 'mod', modFile(), false)
    const [mod] = await service.checkUpdates(instanceId)
    expect(mod.updateAvailable).toBeUndefined()
  })

  it('leaves local/no-provenance jars untouched', async () => {
    const service = serviceReturningVersions('NEWVER', 'NEWVER')
    const zip = zipAll({ 'fabric.mod.json': Buffer.from(JSON.stringify({ id: 'standalone', version: '1' }), 'utf8') })
    fs.writeFileSync(path.join(modsDir, 'standalone.jar'), Buffer.from(zip))
    const [mod] = await service.checkUpdates(instanceId)
    expect(mod.projectId).toBeUndefined()
    expect(mod.updateAvailable).toBeUndefined()
  })
})

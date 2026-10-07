import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModService } from '../../src/main/core/contracts'
import { createModService } from '../../src/main/mods/service'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { zipAll } from '../../src/main/core/zip'
import { makeStubHttp, makeRecordingDownloader, fakeLogger, fakeSettings, makeTempWorkspace, type TempWorkspace } from '../loader/helpers'

let workspace: TempWorkspace
let store: InstanceStore
let service: ModService
let modsDir: string

beforeEach(() => {
  workspace = makeTempWorkspace('mods-installed')
  store = new InstanceStore(() => workspace.paths)
  service = createModService({
    http: makeStubHttp(() => {
      throw new Error('installed() must not hit the network')
    }),
    downloader: makeRecordingDownloader(),
    instances: store,
    settings: fakeSettings(),
    paths: workspace.paths,
    log: fakeLogger()
  })
  const instance = store.create({ name: 'mods', versionId: '1.21.1', gameVersion: '1.21.1' })
  modsDir = path.join(store.gameDir(instance), 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
})
afterEach(() => {
  fs.rmSync(path.dirname(workspace.appData), { recursive: true, force: true })
})

function writeJar(fileName: string, members: Record<string, string>): string {
  const zip: Record<string, Uint8Array> = {}
  for (const [name, text] of Object.entries(members)) zip[name] = Buffer.from(text, 'utf8')
  const target = path.join(modsDir, fileName)
  fs.writeFileSync(target, Buffer.from(zipAll(zip)))
  return target
}

function currentInstanceId(): string {
  return store.list()[0]!.id
}

describe('installed() metadata parsing', () => {
  it('reads fabric.mod.json', async () => {
    writeJar('sodium.jar', {
      'fabric.mod.json': JSON.stringify({ id: 'sodium', version: '0.8.13', name: 'Sodium', description: 'renderer' })
    })
    const [mod] = await service.installed(currentInstanceId())
    expect(mod.fileName).toBe('sodium.jar')
    expect(mod.modId).toBe('sodium')
    expect(mod.version).toBe('0.8.13')
    expect(mod.loader).toBe('fabric')
    expect(mod.disabled).toBe(false)
  })

  it('reads META-INF/mods.toml (forge shape)', async () => {
    writeJar('example.jar', {
      'META-INF/mods.toml': `modId = "examplemod"\nversion = "1.2.3"\ndisplayName = "Example Mod"\ndescription = "a mod"\n`
    })
    const [mod] = await service.installed(currentInstanceId())
    expect(mod.modId).toBe('examplemod')
    expect(mod.version).toBe('1.2.3')
    expect(mod.name).toBe('Example Mod')
    expect(mod.loader).toBe('forge')
  })

  it('reads neoforge mods.toml and detects the neoforge loader', async () => {
    writeJar('neo.jar', {
      'META-INF/mods.toml': `loaderVersion = "[4,)"\nlicense = "MIT"\n[[dependencies.neo]]\nmodId = "neoforge"\nversionRange = "[20.4,)"\n[[mods]]\nmodId = "neomods"\nversion = "9.9.9"\ndisplayName = "Neo"\n`
    })
    const [mod] = await service.installed(currentInstanceId())
    expect(mod.modId).toBe('neomods')
    expect(mod.loader).toBe('neoforge')
  })

  it('lists a jar without any descriptor by fileName only', async () => {
    writeJar('mystery.jar', { 'README.txt': 'no descriptor here' })
    const [mod] = await service.installed(currentInstanceId())
    expect(mod.fileName).toBe('mystery.jar')
    expect(mod.modId).toBeUndefined()
    expect(mod.size).toBeGreaterThan(0)
  })
})

describe('toggle() rename semantics', () => {
  it('appends .disabled to turn a mod off and strips it to turn it back on', async () => {
    writeJar('sodium.jar', { 'fabric.mod.json': JSON.stringify({ id: 'sodium', version: '1' }) })
    const id = currentInstanceId()

    const off = await service.toggle(id, 'sodium.jar', true)
    expect(off.fileName).toBe('sodium.jar.disabled')
    expect(off.disabled).toBe(true)
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar.disabled'))).toBe(true)
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar'))).toBe(false)

    const listed = await service.installed(id)
    expect(listed[0]!.disabled).toBe(true)
    expect(listed[0]!.modId).toBe('sodium') // metadata still parsed from the disabled jar

    const on = await service.toggle(id, 'sodium.jar.disabled', false)
    expect(on.fileName).toBe('sodium.jar')
    expect(on.disabled).toBe(false)
    expect(fs.existsSync(path.join(modsDir, 'sodium.jar'))).toBe(true)
  })

  it('throws not-found for a missing file', async () => {
    await expect(service.toggle(currentInstanceId(), 'ghost.jar', true)).rejects.toMatchObject({ code: 'not-found' })
  })
})

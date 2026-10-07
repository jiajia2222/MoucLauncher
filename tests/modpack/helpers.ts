/**
 * Offline test harness for the modpack service: a temp game root, a recording stub
 * downloader/version/mod service, and ZIP fixtures built with `core/zip.zipAll`
 * (so the tests read back exactly what the production code reads).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DownloadJob,
  DownloadPlan,
  InstalledMod,
  ModpackImportRequest,
  PathInfo,
  ProjectVersion,
  Settings
} from '@shared/types'
import type { ModpackService } from '../../src/main/core/contracts'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { buildPaths } from '../../src/main/core/paths'
import { Logger } from '../../src/main/core/log'
import { zipAll } from '../../src/main/core/zip'
import { createModpackService } from '../../src/main/modpack'
import type { ModpackServiceDeps } from '../../src/main/modpack/types'

export interface HarnessOptions {
  /** CurseForge api key the fake settings store reports. */
  curseForgeApiKey?: string
  /** Installed mods returned by the fake mod service. */
  installedMods?: InstalledMod[]
  /** Version list returned by `mods.versions` (CurseForge resolution). */
  projectVersions?: ProjectVersion[]
  /** Ids reported by `versions.installed`. */
  installedVersions?: string[]
  /** Version id reported back by `versions.install` (loader-patched ids differ). */
  installsAs?: string
  /** Makes `versions.install` reject. */
  installError?: Error
}

export interface Harness {
  deps: ModpackServiceDeps
  service: ModpackService
  root: string
  appData: string
  gameRoot: string
  paths: () => PathInfo
  instances: InstanceStore
  log: Logger
  plans: DownloadPlan[]
  installRequests: ModpackImportRequest[]
  versionsInstalledCalls: number
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-modpack-'))
  const appData = path.join(root, 'app')
  const gameRoot = path.join(root, 'game')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(gameRoot, { recursive: true })
  const paths = () => buildPaths(appData, gameRoot)
  const instances = new InstanceStore(paths)
  const log = new Logger('test', path.join(appData, 'logs'))
  const plans: DownloadPlan[] = []
  const installRequests: ModpackImportRequest[] = []
  let versionsInstalledCalls = 0
  let jobSeq = 0

  const job = (title: string, total: number, kind: DownloadPlan['kind'] = 'modpack'): DownloadJob => {
    jobSeq += 1
    return {
      id: `stub-job-${jobSeq}`,
      title,
      kind,
      status: 'queued',
      total,
      done: 0,
      failed: 0,
      skipped: 0,
      bytesTotal: 0,
      bytesDone: 0,
      startedAt: Date.now()
    }
  }

  const deps: ModpackServiceDeps = {
    paths,
    log,
    instances,
    downloader: {
      enqueue: async (plan: DownloadPlan) => {
        plans.push(plan)
        return job(plan.title, plan.items.length, plan.kind)
      },
      run: async (plan: DownloadPlan) => {
        plans.push(plan)
        return job(plan.title, plan.items.length, plan.kind)
      },
      ensure: async () => ({ item: { id: '', url: '', target: '', kind: 'mod' }, fetched: false }),
      ensureMany: async (items: { target: string }[], title: string, kind: DownloadPlan['kind']) =>
        job(title, items.length, kind),
      cancel: async () => true,
      retry: async () => job('retry', 0),
      jobs: () => [],
      job: () => undefined,
      failures: () => [],
      subscribe: () => () => undefined,
      cachedBytes: async () => 0
    } as never,
    versions: {
      installed: async () => {
        versionsInstalledCalls += 1
        return options.installedVersions ?? ['1.20.1', '1.21.4']
      },
      install: async (req: { id: string; loader?: { id: string; version: string } }) => {
        installRequests.push(req as never)
        if (options.installError) throw options.installError
        return { job: job(`安装 ${req.id}`, 1, 'version-json'), versionId: options.installsAs ?? req.id }
      },
      refresh: async () => [],
      list: async () => [],
      resolve: async () => ({}) as never,
      installPlan: async () => ({ title: '', kind: 'misc', items: [] }) as never,
      uninstall: async () => undefined,
      repair: async () => job('repair', 0),
      checkInstalled: async () => ({ ok: true, missing: [], sizeBytes: 0 })
    } as never,
    mods: {
      installed: async () => options.installedMods ?? [],
      versions: async () => options.projectVersions ?? [],
      search: async () => ({ items: [], total: 0, offset: 0 }),
      install: async () => job('mod', 1, 'mod'),
      toggle: async () => ({ fileName: '', size: 0, disabled: false, updatedAt: 0 }),
      remove: async () => undefined,
      checkUpdates: async () => [],
      installLocal: async () => ({ fileName: '', size: 0, disabled: false, updatedAt: 0 })
    } as never,
    settings: () => ({ curseForgeApiKey: options.curseForgeApiKey ?? '' } as Settings)
  }

  return {
    deps,
    service: createModpackService(deps),
    root,
    appData,
    gameRoot,
    paths,
    instances,
    log,
    plans,
    installRequests,
    get versionsInstalledCalls() {
      return versionsInstalledCalls
    }
  }
}

export async function cleanup(harness: Harness): Promise<void> {
  harness.log.close()
  await harness.instances.flush()
  try {
    fs.rmSync(harness.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 })
  } catch {
    /* locked temp dir: leave it for the OS to reclaim */
  }
}

/** Builds a ZIP archive on disk from a member map (deflate, like every real pack). */
export async function writeZip(file: string, members: Record<string, string | Uint8Array>): Promise<string> {
  const input: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(members)) {
    input[name] = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, Buffer.from(zipAll(input, 6)))
  return file
}

export const MRPACK_INDEX_FIXTURE = 'tests/fixtures/modpack/modrinth.index.json'

/** The trimmed, real Modrinth index (see tests/fixtures/modpack). */
export function mrpackIndexText(replace?: (json: Record<string, unknown>) => Record<string, unknown>): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const raw = fs.readFileSync(path.resolve(here, '../../', MRPACK_INDEX_FIXTURE), 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return JSON.stringify(replace ? replace(parsed) : parsed, null, 1)
}

export const CURSE_MANIFEST = JSON.stringify({
  minecraftVersion: '1.20.1',
  modLoaders: [{ id: 'forge-47.2.0', required: true }],
  files: [
    { projectID: 306770, fileID: 4382113, required: true },
    { projectID: 291737, fileID: 4000001, required: false }
  ]
})

export const MULTIMC_INSTANCE_CFG = [
  'instanceType=OneInstance',
  'IntendedVersion=1.20.1',
  'name=老伙伴实例',
  'MaxMemAlloc=3072',
  'JvmArgs=-XX:+UseG1GC',
  'JavaPath="C:/multi/jre-17/bin/javaw.exe"',
  '# comment line'
].join('\n')

export const MULTIMC_PACK_JSON = JSON.stringify({
  formatVersion: 1,
  intent: 'Normal',
  components: [
    { uid: 'net.minecraft', version: '1.20.1' },
    { uid: 'net.minecraftforge', version: '1.20.1-47.2.0' },
    { uid: 'org.lwjgl', version: '3.3.1', disabled: true }
  ]
})

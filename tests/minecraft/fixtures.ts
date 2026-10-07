/**
 * Offline fixtures + fakes for the Minecraft core tests.
 * The version jsons mirror the schema probed from piston-meta on 2026-10-07
 * (latest release "26.3", java-runtime-epsilon / majorVersion 25, assetIndex "36",
 * arguments.{game,jvm} with rules, logging.client.argument `-Dlog4j...=${path}`).
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type {
  Account,
  AccountType,
  DownloadItem,
  DownloadJob,
  DownloadPlan,
  DownloadProgress,
  Instance,
  JavaProvisionRequest,
  JavaProvisionResult,
  JavaRuntime,
  PathInfo,
  RawVersionJson,
  VersionManifest
} from '@shared/types'
import type {
  AccountService,
  Downloader,
  DownloadResult,
  GameService,
  HeadInfo,
  HttpClient,
  HttpInit,
  JavaService,
  VersionService
} from '../../src/main/core/contracts'
import { sha1Of } from '../../src/main/core/fsx'
import { zipAll } from '../../src/main/core/zip'
import { SettingsStore } from '../../src/main/core/config'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { Logger } from '../../src/main/core/log'
import { assetIndexPath, buildPaths, versionJsonPath } from '../../src/main/core/paths'
import { createVersionService, type MinecraftServiceDeps } from '../../src/main/minecraft/version'
import { createGameService, type GameServiceDeps, type SpawnFn } from '../../src/main/minecraft/launch'
import { assetObjectUrl } from '../../src/main/minecraft/assets'

/* ---------------------------------------------------------------- */
/* Binary payloads                                                   */
/* ---------------------------------------------------------------- */

export const CLIENT_JAR = Buffer.from('MOJCRAFT-CLIENT-JAR-26.3')
export const CLIENT_SHA = sha1Of(CLIENT_JAR)
export const PARENT_JAR = Buffer.from('MOJCRAFT-CLIENT-JAR-1.20.1')
export const PARENT_SHA = sha1Of(PARENT_JAR)
export const ANCIENT_JAR = Buffer.from('MOJCRAFT-CLIENT-JAR-1.5.2')
export const ANCIENT_SHA = sha1Of(ANCIENT_JAR)
export const GSON_JAR = Buffer.from('GSON-2.11.0-BYTES')
export const GSON_SHA = sha1Of(GSON_JAR)
export const GSON_OLD_JAR = Buffer.from('GSON-2.10.0-BYTES')
export const GSON_OLD_SHA = sha1Of(GSON_OLD_JAR)
export const LWJGL_JAR = Buffer.from('LWJGL-3.3.3-BYTES')
export const LWJGL_SHA = sha1Of(LWJGL_JAR)
export const FABRIC_JAR = Buffer.from('FABRIC-LOADER-0.15.0')
export const FABRIC_SHA = sha1Of(FABRIC_JAR)
export const GUAVA_JAR = Buffer.from('GUAVA-15.0')

export const NATIVES_ZIP = Buffer.from(
  zipAll({
    'lwjgl.dll': 'NATIVE-DLL-BYTES',
    'OpenAL64.dll': 'OPENAL-BYTES',
    'excluded/blob.bin': 'SHOULD-BE-EXCLUDED',
    'META-INF/MANIFEST.MF': 'MANIFEST',
    'META-INF/OK.SF': 'SIGNATURE',
    'META-INF/OK.DSA': 'DSA',
    'META-INF/OK.RSA': 'RSA',
    'META-INF/versions/9/module.class': 'MULTI-RELEASE'
  })
)
export const NATIVES_SHA = sha1Of(NATIVES_ZIP)

export const LOG_XML = Buffer.from('<?xml version="1.0"?><Configuration/>')
export const LOG_XML_SHA = sha1Of(LOG_XML)

export const ASSET_A = Buffer.from('ASSET-ALPHA')
export const ASSET_B = Buffer.from('ASSET-BETA')
export const ASSET_A_SHA = sha1Of(ASSET_A)
export const ASSET_B_SHA = sha1Of(ASSET_B)

const hex = (seed: string): string => sha1Of(Buffer.from(seed))

/* ---------------------------------------------------------------- */
/* URLs                                                             */
/* ---------------------------------------------------------------- */

export const URLS = {
  modernJson: `https://piston-meta.mojang.com/v1/objects/${hex('26.3')}/26.3.json`,
  parentJson: `https://piston-meta.mojang.com/v1/objects/${hex('1.20.1')}/1.20.1.json`,
  ancientJson: `https://piston-meta.mojang.com/v1/objects/${hex('1.5.2')}/1.5.2.json`,
  clientJar: `https://piston-data.mojang.com/v1/objects/${CLIENT_SHA}/client.jar`,
  parentClientJar: `https://piston-data.mojang.com/v1/objects/${PARENT_SHA}/client.jar`,
  ancientClientJar: `https://piston-data.mojang.com/v1/objects/${ANCIENT_SHA}/client.jar`,
  index36: `https://piston-meta.mojang.com/v1/objects/${hex('index36')}/36.json`,
  indexLegacy: `https://piston-meta.mojang.com/v1/objects/${hex('indexlegacy')}/legacy.json`,
  gson: 'https://libraries.minecraft.net/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar',
  gsonOld: 'https://libraries.minecraft.net/com/google/code/gson/gson/2.10.0/gson-2.10.0.jar',
  lwjgl: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
  lwjglNatives:
    'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
  macOnly: 'https://libraries.minecraft.net/com/mojang/mac-only/1.0/mac-only-1.0.jar',
  denyMe: 'https://libraries.minecraft.net/io/netty/deny-me/1.0/deny-me-1.0.jar',
  fabricLoader: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar',
  guava: 'https://libraries.minecraft.net/com/google/guava/guava/15.0/guava-15.0.jar',
  logXml: `https://piston-data.mojang.com/v1/objects/${LOG_XML_SHA}/client.xml`
}

/* ---------------------------------------------------------------- */
/* Asset indexes                                                     */
/* ---------------------------------------------------------------- */

export const INDEX_MODERN_DOC = {
  objects: {
    'minecraft/sounds/a.ogg': { hash: ASSET_A_SHA, size: ASSET_A.length },
    'minecraft/fonts/b.png': { hash: ASSET_B_SHA, size: ASSET_B.length }
  }
}
export const INDEX_MODERN_BODY = JSON.stringify(INDEX_MODERN_DOC)
export const INDEX_MODERN_SHA = sha1Of(Buffer.from(INDEX_MODERN_BODY))

/** Pre-1.7.3 shape: flat map whose values are bare hashes + map_to_resources. */
export const INDEX_LEGACY_DOC = {
  map_to_resources: true,
  start_of_time: 'b1.3',
  'mob/step1.ogg': ASSET_A_SHA,
  'mob/step2.ogg': ASSET_B_SHA
}
export const INDEX_LEGACY_BODY = JSON.stringify(INDEX_LEGACY_DOC)
export const INDEX_LEGACY_SHA = sha1Of(Buffer.from(INDEX_LEGACY_BODY))

/* ---------------------------------------------------------------- */
/* Version jsons                                                     */
/* ---------------------------------------------------------------- */

export const MODERN: RawVersionJson = {
  id: '26.3',
  type: 'release',
  time: '2026-09-30T10:00:00+00:00',
  releaseTime: '2026-09-30T10:00:00+00:00',
  minimumLauncherVersion: 21,
  complianceLevel: 3,
  mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { component: 'java-runtime-epsilon', majorVersion: 25 },
  assets: '36',
  assetIndex: {
    id: '36',
    sha1: INDEX_MODERN_SHA,
    size: Buffer.byteLength(INDEX_MODERN_BODY),
    totalSize: ASSET_A.length + ASSET_B.length,
    url: URLS.index36
  },
  downloads: {
    client: { sha1: CLIENT_SHA, size: CLIENT_JAR.length, url: URLS.clientJar }
  },
  logging: {
    client: {
      argument: '-Dlog4j.configurationFile=${path}',
      file: { id: 'client', sha1: LOG_XML_SHA, size: LOG_XML.length, url: URLS.logXml, path: 'client' },
      type: 'log4j2-xml'
    }
  },
  libraries: [
    {
      name: 'com.google.code.gson:gson:2.11.0',
      downloads: {
        artifact: {
          path: 'com/google/code/gson/gson/2.11.0/gson-2.11.0.jar',
          sha1: GSON_SHA,
          size: GSON_JAR.length,
          url: URLS.gson
        }
      }
    },
    {
      name: 'org.lwjgl:lwjgl:3.3.3',
      downloads: {
        artifact: {
          path: 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
          sha1: LWJGL_SHA,
          size: LWJGL_JAR.length,
          url: URLS.lwjgl
        },
        classifiers: {
          'natives-windows': {
            path: 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
            sha1: NATIVES_SHA,
            size: NATIVES_ZIP.length,
            url: URLS.lwjglNatives
          }
        }
      },
      natives: { windows: 'natives-windows', macos: 'natives-macos' },
      extract: { exclude: ['META-INF/versions/9', 'META-INF/*.SF', 'META-INF/*.DSA', 'META-INF/*.RSA', 'excluded/*'] },
      rules: [{ action: 'allow' }, { action: 'allow', os: { name: 'windows' } }]
    },
    {
      name: 'com.mojang:mac-only:1.0',
      downloads: {
        artifact: {
          path: 'com/mojang/mac-only/1.0/mac-only-1.0.jar',
          sha1: sha1Of(Buffer.from('MAC')),
          size: 3,
          url: URLS.macOnly
        }
      },
      rules: [{ action: 'allow', os: { name: 'osx' } }]
    },
    {
      name: 'io.netty:deny-me:1.0',
      downloads: {
        artifact: {
          path: 'io/netty/deny-me/1.0/deny-me-1.0.jar',
          sha1: sha1Of(Buffer.from('DENY')),
          size: 4,
          url: URLS.denyMe
        }
      },
      rules: [{ action: 'allow' }, { action: 'deny', os: { name: 'windows' } }]
    }
  ],
  arguments: {
    game: [
      '--username',
      '${auth_player_name}',
      '--version',
      '${version_name}',
      '--gameDir',
      '${game_directory}',
      '--assetsDir',
      '${assets_root}',
      '--assetIndex',
      '${assets_index_name}',
      '--uuid',
      '${auth_uuid}',
      '--accessToken',
      '${auth_access_token}',
      '--userType',
      '${user_type}',
      '--versionType',
      '${version_type}',
      { rules: [{ action: 'allow', features: { isDemoUser: true } }], value: '--demo' },
      {
        rules: [{ action: 'allow', features: { hasCustomResolution: true } }],
        value: ['--width', '${resolution_width}', '--height', '${resolution_height}']
      }
    ],
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:+IgnoreUnrecognizedVMOptions' },
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
      '-Djava.library.path=${natives_directory}',
      '-Dminecraft.launcher.brand=${launcher_name}',
      '-Dminecraft.launcher.version=${launcher_version}',
      '-cp',
      '${classpath}'
    ]
  }
}

export const PARENT_1201: RawVersionJson = {
  id: '1.20.1',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  assets: '36',
  assetIndex: {
    id: '36',
    sha1: INDEX_MODERN_SHA,
    size: Buffer.byteLength(INDEX_MODERN_BODY),
    url: URLS.index36
  },
  downloads: {
    client: { sha1: PARENT_SHA, size: PARENT_JAR.length, url: URLS.parentClientJar }
  },
  libraries: [
    {
      name: 'com.google.code.gson:gson:2.10.0',
      downloads: {
        artifact: {
          path: 'com/google/code/gson/gson/2.10.0/gson-2.10.0.jar',
          sha1: GSON_OLD_SHA,
          size: GSON_OLD_JAR.length,
          url: URLS.gsonOld
        }
      }
    },
    {
      name: 'org.lwjgl:lwjgl:3.3.3',
      downloads: {
        artifact: {
          path: 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
          sha1: LWJGL_SHA,
          size: LWJGL_JAR.length,
          url: URLS.lwjgl
        }
      }
    }
  ],
  arguments: {
    game: ['--username', '${auth_player_name}', '--version', '${version_name}'],
    jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}']
  }
}

export const LOADER_FABRIC: RawVersionJson = {
  id: '1.20.1-fabric',
  inheritsFrom: '1.20.1',
  jar: '1.20.1',
  type: 'release',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  libraries: [
    {
      name: 'net.fabricmc:fabric-loader:0.15.0',
      downloads: {
        artifact: {
          path: 'net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar',
          sha1: FABRIC_SHA,
          size: FABRIC_JAR.length,
          url: URLS.fabricLoader
        }
      }
    },
    // Child override with a deny rule: must still win over the parent's gson entry.
    {
      name: 'com.google.code.gson:gson:2.10.0',
      rules: [{ action: 'allow' }, { action: 'deny', os: { name: 'windows' } }]
    }
  ],
  arguments: { game: ['--fabricArg'] }
}

export const ANCIENT: RawVersionJson = {
  id: '1.5.2',
  type: 'release',
  mainClass: 'net.minecraft.client.Minecraft',
  minecraftArguments:
    '--username ${auth_player_name} --session ${auth_session} --version ${version_name} ' +
    '--gameDir ${game_directory} --assetsDir ${game_assets} --uuid ${auth_uuid} ' +
    '--accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}',
  assets: 'legacy',
  assetIndex: {
    id: 'legacy',
    sha1: INDEX_LEGACY_SHA,
    size: Buffer.byteLength(INDEX_LEGACY_BODY),
    url: URLS.indexLegacy
  },
  downloads: {
    client: { sha1: ANCIENT_SHA, size: ANCIENT_JAR.length, url: URLS.ancientClientJar }
  },
  libraries: [
    {
      name: 'com.google.guava:guava:15.0',
      downloads: {
        artifact: {
          path: 'com/google/guava/guava/15.0/guava-15.0.jar',
          sha1: sha1Of(GUAVA_JAR),
          size: GUAVA_JAR.length,
          url: URLS.guava
        }
      }
    },
    {
      // Legacy natives shape: no `downloads` block at all.
      name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.1-nightly.20130515',
      natives: { windows: 'natives-windows' },
      extract: { exclude: ['META-INF'] },
      rules: [{ action: 'allow' }, { action: 'allow', os: { name: 'windows' } }]
    }
  ]
}

export const ANCIENT_NATIVE_REL =
  'org/lwjgl/lwjgl/lwjgl-platform/2.9.1-nightly.20130515/lwjgl-platform-2.9.1-nightly.20130515-natives-windows.jar'

/* ---------------------------------------------------------------- */
/* Manifest                                                          */
/* ---------------------------------------------------------------- */

export const MANIFEST: VersionManifest = {
  latest: { release: '26.3', snapshot: '26.4-snapshot-3' },
  versions: [
    { id: '26.4-snapshot-3', type: 'snapshot', url: URLS.modernJson, time: '2026-10-01T10:00:00+00:00', releaseTime: '2026-10-01T10:00:00+00:00' },
    { id: '26.3', type: 'release', url: URLS.modernJson, time: '2026-09-30T10:00:00+00:00', releaseTime: '2026-09-30T10:00:00+00:00', complianceLevel: 3 },
    { id: '1.20.1', type: 'release', url: URLS.parentJson, time: '2023-06-12T10:00:00+00:00', releaseTime: '2023-06-12T10:00:00+00:00' },
    { id: '1.5.2', type: 'release', url: URLS.ancientJson, time: '2013-05-16T00:00:00+00:00', releaseTime: '2013-05-16T00:00:00+00:00' },
    { id: 'b1.9', type: 'old_beta', url: URLS.ancientJson, time: '2011-10-30T00:00:00+00:00', releaseTime: '2011-10-30T00:00:00+00:00' },
    { id: 'a1.1.2', type: 'old_alpha', url: URLS.ancientJson, time: '2010-09-30T00:00:00+00:00', releaseTime: '2010-09-30T00:00:00+00:00' }
  ]
}

/* ---------------------------------------------------------------- */
/* Fake HttpClient                                                   */
/* ---------------------------------------------------------------- */

export class FakeHttp implements HttpClient {
  calls: string[] = []
  routes = new Map<string, unknown>()
  /** When true the primary manifest endpoint fails so the fallback host is used. */
  failPrimaryManifest = false

  constructor() {
    this.routes.set(ENDPOINTS.versionManifest, MANIFEST)
    this.routes.set(ENDPOINTS.versionManifestLegacy, MANIFEST)
    this.routes.set(URLS.modernJson, MODERN)
    this.routes.set(URLS.parentJson, PARENT_1201)
    this.routes.set(URLS.ancientJson, ANCIENT)
    this.routes.set(URLS.index36, INDEX_MODERN_DOC)
    this.routes.set(URLS.indexLegacy, INDEX_LEGACY_DOC)
  }

  async json<T>(url: string, _init?: HttpInit): Promise<T> {
    this.calls.push(url)
    if (url === ENDPOINTS.versionManifest && this.failPrimaryManifest) {
      throw new AppError('network', 'primary manifest endpoint down')
    }
    const hit = this.routes.get(url)
    if (hit === undefined) throw new AppError('not-found', `FakeHttp: no route for ${url}`)
    // Deep-clone through JSON so callers cannot mutate the fixture.
    return JSON.parse(JSON.stringify(hit)) as T
  }

  async text(url: string): Promise<string> {
    return await this.json<string>(url)
  }

  async buffer(url: string): Promise<Buffer> {
    throw new AppError('unsupported', 'FakeHttp.buffer not used', url)
  }

  async head(url: string): Promise<HeadInfo> {
    void url
    return { status: 200, size: undefined, etag: undefined, acceptsRanges: false }
  }

  async fetch(url: string): Promise<Response> {
    throw new AppError('unsupported', 'FakeHttp.fetch not used', url)
  }
}

/* ---------------------------------------------------------------- */
/* Fake Downloader                                                   */
/* ---------------------------------------------------------------- */

export class FakeDownloader implements Downloader {
  plans: DownloadPlan[] = []
  private registry = new Map<string, DownloadJob>()
  private counter = 0

  constructor(private readonly files: Record<string, Buffer>) {}

  /** Materialises every item: fixture bytes by url, then by target, else placeholder. */
  private async settle(plan: DownloadPlan): Promise<DownloadJob> {
    const id = `job-${(this.counter += 1)}`
    const job: DownloadJob = {
      id,
      title: plan.title,
      kind: plan.kind,
      status: 'running',
      total: plan.items.length,
      done: 0,
      failed: 0,
      skipped: 0,
      bytesTotal: 0,
      bytesDone: 0,
      startedAt: Date.now()
    }
    this.registry.set(id, job)
    for (const item of plan.items) {
      const content = this.files[item.url] ?? this.files[item.target] ?? Buffer.from(`fake:${item.id}`)
      if (item.sha1 && sha1Of(content) !== item.sha1) {
        job.status = 'error'
        job.error = new AppError('checksum-mismatch', `fixture sha1 mismatch for ${item.id}`, item.url).toPayload()
        return job
      }
      fs.mkdirSync(path.dirname(item.target), { recursive: true })
      fs.writeFileSync(item.target, content)
      job.done += 1
      job.bytesDone += content.length
    }
    job.status = 'done'
    job.finishedAt = Date.now()
    return job
  }

  async enqueue(plan: DownloadPlan): Promise<DownloadJob> {
    this.plans.push(plan)
    return await this.settle(plan)
  }

  async run(plan: DownloadPlan): Promise<DownloadJob> {
    return await this.enqueue(plan)
  }

  async ensure(item: DownloadItem): Promise<DownloadResult> {
    await this.enqueue({ title: item.id, kind: item.kind, items: [item] })
    return { item, fetched: true }
  }

  async ensureMany(items: DownloadItem[], title: string, kind: DownloadPlan['kind']): Promise<DownloadJob> {
    return await this.enqueue({ title, kind, items })
  }

  async cancel(): Promise<boolean> {
    return false
  }

  clear(): void {
    for (const [id, job] of [...this.registry]) {
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') this.registry.delete(id)
    }
  }

  async retry(jobId: string): Promise<DownloadJob> {
    const job = this.registry.get(jobId)
    if (!job) throw new AppError('not-found', 'no job', jobId)
    return job
  }

  jobs(): DownloadJob[] {
    return [...this.registry.values()]
  }

  job(id: string): DownloadJob | undefined {
    return this.registry.get(id)
  }

  failures(): DownloadItem[] {
    return []
  }

  subscribe(_handler: (progress: DownloadProgress) => void): () => void {
    return () => undefined
  }

  async cachedBytes(): Promise<number> {
    return 0
  }
}

/* ---------------------------------------------------------------- */
/* Fake JavaService / AccountService                                 */
/* ---------------------------------------------------------------- */

export function createFakeJava(major = 25): JavaService {
  const runtime: JavaRuntime = {
    id: `java-${major}`,
    path: `C:/Java/jdk-${major}/bin/java.exe`,
    rawVersion: `openjdk version "${major}"`,
    major,
    vendor: 'Adoptium',
    arch: 'x64',
    source: 'scan',
    executable: `C:/Java/jdk-${major}/bin/javaw.exe`,
    canHeadless: true
  }
  return {
    async scan() {
      return [runtime]
    },
    async list() {
      return [runtime]
    },
    async provision(req: JavaProvisionRequest): Promise<JavaProvisionResult> {
      return { runtime: { ...runtime, major: req.major }, downloadedBytes: 0, fromCache: true }
    },
    async remove() {
      return undefined
    },
    async forInstance() {
      return runtime
    },
    async peek() {
      return { runtime, major: runtime.major }
    }
  }
}

export function makeAccount(type: AccountType): Account {
  return {
    id: `acc-${type}`,
    type,
    name: 'Steve',
    uuid: '5f1e4d8c-7a2b-4c3d-9e8f-0a1b2c3d4e5f',
    selected: true,
    addedAt: 0,
    lastUsedAt: 0,
    tokenState: 'valid',
    label: `Steve (${type})`
  }
}

export function createFakeAccounts(type: AccountType = 'offline'): AccountService {
  const account = makeAccount(type)
  return {
    async list() {
      return [account]
    },
    async current() {
      return account
    },
    async addOffline() {
      return account
    },
    async remove() {
      return undefined
    },
    async select() {
      return account
    },
    async refresh() {
      return account
    },
    async microsoftStart() {
      throw new AppError('unsupported', 'not used in tests')
    },
    async microsoftPoll() {
      throw new AppError('unsupported', 'not used in tests')
    },
    async microsoftCancel() {
      throw new AppError('unsupported', 'not used in tests')
    },
    async skin() {
      throw new AppError('unsupported', 'not used in tests')
    },
    async servers() {
      return []
    },
    async credentials(acc: Account) {
      return {
        uuid: acc.uuid,
        token: `TOKEN-${acc.name}`,
        type: acc.type === 'microsoft' ? 'mosauth' : 'legacy'
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* Fake child process for launch tests                               */
/* ---------------------------------------------------------------- */

export class FakeChild extends EventEmitter {
  pid = 42424
  stdout = new PassThrough()
  stderr = new PassThrough()
  killCalls: (string | number | undefined)[] = []
  kill(signal?: string | number): boolean {
    this.killCalls.push(signal)
    return true
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

export interface SpawnRecorder {
  fn: SpawnFn
  calls: { executable: string; args: string[]; options: SpawnOptions }[]
  children: FakeChild[]
}

export function createSpawnRecorder(): SpawnRecorder {
  const recorder: SpawnRecorder = {
    calls: [],
    children: [],
    fn: (executable: string, args: string[], options: SpawnOptions): ChildProcess => {
      const child = new FakeChild()
      recorder.calls.push({ executable, args, options })
      recorder.children.push(child)
      return child.asChild()
    }
  }
  return recorder
}

/* ---------------------------------------------------------------- */
/* End-to-end test environment                                       */
/* ---------------------------------------------------------------- */

export interface TestEnv {
  root: string
  paths: PathInfo
  settings: SettingsStore
  instances: InstanceStore
  log: Logger
  http: FakeHttp
  downloader: FakeDownloader
  deps: MinecraftServiceDeps
  versions: VersionService
  makeGame(overrides?: Partial<GameServiceDeps>): GameService
  writeVersionJson(json: RawVersionJson): void
  writeAssetIndex(id: string, body: string): void
  installFiles(id: string, preWrite?: Record<string, Buffer>): Promise<void>
  cleanup(): void
}

/** url/target-keyed file contents the fake downloader materialises. */
export function fixtureFiles(extra: Record<string, Buffer> = {}): Record<string, Buffer> {
  return {
    [URLS.clientJar]: CLIENT_JAR,
    [URLS.parentClientJar]: PARENT_JAR,
    [URLS.ancientClientJar]: ANCIENT_JAR,
    [URLS.gson]: GSON_JAR,
    [URLS.gsonOld]: GSON_OLD_JAR,
    [URLS.lwjgl]: LWJGL_JAR,
    [URLS.lwjglNatives]: NATIVES_ZIP,
    [URLS.fabricLoader]: FABRIC_JAR,
    [URLS.guava]: GUAVA_JAR,
    [URLS.logXml]: LOG_XML,
    [URLS.index36]: Buffer.from(INDEX_MODERN_BODY),
    [URLS.indexLegacy]: Buffer.from(INDEX_LEGACY_BODY),
    [assetObjectUrl(ASSET_A_SHA)]: ASSET_A,
    [assetObjectUrl(ASSET_B_SHA)]: ASSET_B,
    ...extra
  }
}

export function createTestEnv(options: { javaMajor?: number; accountType?: AccountType } = {}): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-mc-test-'))
  const appData = path.join(root, 'AppData')
  const gameRoot = path.join(root, 'game')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(gameRoot, { recursive: true })

  const settings = new SettingsStore(appData)
  settings.set({ gameRoot })
  const paths = () => buildPaths(appData, settings.get().gameRoot)
  const instances = new InstanceStore(paths)
  const log = new Logger('test', path.join(appData, 'logs'))

  const http = new FakeHttp()
  const files = fixtureFiles()
  const downloader = new FakeDownloader(files)
  const java = createFakeJava(options.javaMajor ?? 25)
  const accounts = createFakeAccounts(options.accountType ?? 'offline')

  const deps: MinecraftServiceDeps = { http, downloader, settings, instances, paths, java, accounts, log }
  const versions = createVersionService(deps)

  const currentPaths = paths()
  const env: TestEnv = {
    root,
    paths: currentPaths,
    settings,
    instances,
    log,
    http,
    downloader,
    deps,
    versions,
    makeGame(overrides = {}) {
      const spawnRecorder = overrides.spawnFn ? undefined : createSpawnRecorder()
      return createGameService({
        ...deps,
        spawnFn: spawnRecorder?.fn,
        ...overrides
      })
    },
    writeVersionJson(json) {
      const p = paths()
      fs.mkdirSync(path.dirname(versionJsonPath(p, json.id)), { recursive: true })
      fs.writeFileSync(versionJsonPath(p, json.id), JSON.stringify(json), 'utf8')
    },
    writeAssetIndex(id, body) {
      const p = paths()
      fs.mkdirSync(path.dirname(assetIndexPath(p, id)), { recursive: true })
      fs.writeFileSync(assetIndexPath(p, id), body, 'utf8')
    },
    async installFiles(id) {
      const json = id === '26.3' ? MODERN : id === '1.20.1' ? PARENT_1201 : id === '1.5.2' ? ANCIENT : undefined
      if (!json) throw new Error(`unknown fixture id ${id}`)
      env.writeVersionJson(json)
      if (json.assetIndex?.id === '36') env.writeAssetIndex('36', INDEX_MODERN_BODY)
      if (json.assetIndex?.id === 'legacy') env.writeAssetIndex('legacy', INDEX_LEGACY_BODY)
      await versions.install({ id })
    },
    cleanup() {
      log.close()
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* leave temp dirs to the OS */
      }
    }
  }
  // Legacy natives jars have a file-path "url" derived from the libraries dir.
  files[`${currentPaths.librariesDir}/${ANCIENT_NATIVE_REL}`] = NATIVES_ZIP
  return env
}

export function makeInstance(env: TestEnv, patch: Partial<Instance> & { versionId: string }): Instance {
  return env.instances.create({
    ...patch,
    name: patch.name ?? `inst-${patch.versionId}`,
    versionId: patch.versionId,
    gameVersion: patch.gameVersion ?? patch.versionId
  })
}

/** Reads a json file back for assertions. */
export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
}

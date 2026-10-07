/**
 * Believable in-memory data for the browser preview.
 *
 * Everything here mirrors what the main process would return after real work: ids look
 * like ids, sizes add up, the broken instance really is missing files, one instance needs
 * a Java major that is not installed, and the BMCLAPI mirror rule is shipped disabled
 * because every public route 404s (see src/shared/constants.ts).
 */
import { SETTINGS_VERSION } from '@shared/types'
import type {
  Account,
  CrashAnalysis,
  GameDirStats,
  GameLogLine,
  InstalledMod,
  Instance,
  InstanceState,
  InstanceSummary,
  JavaRuntime,
  LanGame,
  ModFile,
  ModProject,
  PathInfo,
  ProjectVersion,
  RelayStatus,
  ResolvedVersion,
  ServerEntry,
  Settings,
  VersionRef
} from '@shared/types'

const DAY = 86_400_000
const now = Date.now()

/* ------------------------------------------------------------------ paths */

export const PATHS: PathInfo = {
  appData: 'C:\\Users\\jiamou\\AppData\\Roaming\\MoucLauncher',
  gameRoot: 'D:\\Games\\Minecraft',
  versionsDir: 'D:\\Games\\Minecraft\\versions',
  librariesDir: 'D:\\Games\\Minecraft\\libraries',
  assetsDir: 'D:\\Games\\Minecraft\\assets',
  instancesDir: 'D:\\Games\\Minecraft\\instances',
  logsDir: 'D:\\Games\\Minecraft\\logs',
  javaStoreDir: 'C:\\Users\\jiamou\\AppData\\Roaming\\MoucLauncher\\java',
  configDir: 'C:\\Users\\jiamou\\AppData\\Roaming\\MoucLauncher\\config'
}

/* --------------------------------------------------------------- settings */

export const SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  language: 'zh-CN',
  theme: 'dark',
  gameRoot: PATHS.gameRoot,
  maxConcurrentDownloads: 8,
  resumeDownloads: true,
  strictDownload: false,
  mirrors: [
    {
      id: 'bmclapi',
      label: 'BMCLAPI（2026-10 全部路由 404）',
      enabled: false,
      hosts: {
        'piston-meta.mojang.com': 'bmclapi2.bangbang93.com',
        'piston-data.mojang.com': 'bmclapi2.bangbang93.com',
        'resources.download.minecraft.net': 'bmclapi2.bangbang93.com/-assets',
        'libraries.minecraft.net': 'bmclapi2.bangbang93.com/maven'
      },
      priority: 100
    },
    {
      id: 'mcms',
      label: '自建镜像 mcms.local',
      enabled: true,
      hosts: { 'libraries.minecraft.net': 'maven.mcms.local' },
      priority: 10
    }
  ],
  javaMode: 'auto',
  customJavaPath: '',
  javaScanDirs: ['C:\\Program Files\\Eclipse Adoptium', 'D:\\Java'],
  defaultMemoryMb: 4096,
  defaultResolution: { width: 854, height: 480, fullscreen: false },
  extraJvmArgs: '-XX:+UseG1GC -XX:MaxGCPauseMillis=50',
  closeAction: 'ask',
  showGameConsole: true,
  hideOnLaunch: false,
  curseForgeApiKey: '',
  modrinthBaseUrl: 'https://api.modrinth.com/v2',
  relayServerUrl: 'relay.mouc.local:25570',
  proxyUrl: '',
  microsoftClientId: 'e8f9d8b4-0000-4a1d-9b6e-mouc00000000',
  autoCheckUpdate: true,
  lastSeenVersion: '1.0.0'
}

/* ---------------------------------------------------------------- versions */

function ref(id: string, type: VersionRef['type'], daysAgo: number, compliance = 1): VersionRef {
  const ts = now - daysAgo * DAY
  const iso = new Date(ts).toISOString()
  return {
    id,
    type,
    url: `https://piston-meta.mojang.com/v1/packages/${hashOf(id)}/${id}.json`,
    time: iso,
    releaseTime: iso,
    complianceLevel: type === 'release' || type === 'snapshot' ? compliance : undefined
  }
}

/** Deterministic fake sha1 so the manifest excerpt never changes between reloads. */
function hashOf(seed: string): string {
  let a = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    a ^= seed.charCodeAt(i)
    a = Math.imul(a, 0x01000193) >>> 0
  }
  const hex = a.toString(16).padStart(8, '0')
  return (hex + hex + hex + hex + hex + hex.slice(0, 24)).slice(0, 40)
}

export const VERSIONS: VersionRef[] = [
  ref('26.4-snapshot-1', 'snapshot', 3),
  ref('26.3', 'release', 12),
  ref('26.2', 'release', 40),
  ref('26.1', 'release', 71),
  ref('1.21.8', 'release', 96),
  ref('1.21.4', 'release', 210),
  ref('1.21.1', 'release', 330),
  ref('1.20.4', 'release', 520),
  ref('1.20.2', 'release', 640),
  ref('1.19.4', 'release', 900),
  ref('1.18.2', 'release', 1_300),
  ref('1.16.5', 'release', 2_100),
  ref('1.12.2', 'release', 3_300, 0),
  ref('1.8.9', 'release', 4_300, 0),
  ref('b1.7.3', 'old_beta', 5_600, 0),
  ref('a1.2.6', 'old_alpha', 6_000, 0)
]

export const INSTALLED_VERSION_IDS = ['26.3', '1.21.8', '1.21.4', '1.21.1', '1.20.4', '1.12.2', '1.8.9']

export const LOADER_VERSIONS: Record<string, string[]> = {
  fabric: ['0.16.14', '0.16.10', '0.15.12', '0.14.24'],
  'legacy-fabric': ['1.13.1', '1.12.0'],
  quilt: ['0.27.0-beta.4', '0.26.0-beta.7', '0.25.0'],
  neoforge: ['21.4.90-beta', '20.4.148', '19.0.2'],
  forge: ['14.23.5.2859', '13.20.0.23']
}

export function resolvedVersion(id: string): ResolvedVersion {
  const major = javaMajorFor(id)
  return {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    gameArgs: ['--username', '${profile_name}', '--version', id, '--gameDir', '${game_dir}', '--assetsIndex', id],
    jvmArgs: ['-Djava.library.path=${natives_dir}', '-XstartOnFirstThread', 'cp'],
    libraries: [
      { name: 'com.mojang:patchy:2.2.10', downloads: { artifact: { url: 'https://libraries.minecraft.net/com/mojang/patchy/2.2.10/patchy-2.2.10.jar', sha1: hashOf(id + 'patchy'), size: 45_128 } } },
      { name: 'org.ow2.asm:asm:9.6', downloads: { artifact: { url: 'https://libraries.minecraft.net/org/ow2/asm/asm/9.6/asm-9.6.jar', sha1: hashOf(id + 'asm'), size: 123_512 } } }
    ],
    client: { url: `https://piston-data.mojang.com/v1/objects/${hashOf(id)}/client.jar`, sha1: hashOf(id), size: 24_800_000 },
    assetIndex: { id: major >= 21 ? '17' : 'legacy', sha1: hashOf(id + 'assets'), size: 420_000, totalSize: 620_000_000, url: 'https://piston-meta.mojang.com/v1/object/asset-index.json' },
    assetsVersion: major >= 21 ? '17' : 'legacy',
    javaVersion: { component: `java-runtime-delta`, majorVersion: major },
    jsonPath: `${PATHS.versionsDir}\\${id}\\${id}.json`,
    clientJarPath: `${PATHS.versionsDir}\\${id}\\${id}.jar`,
    raw: { id, type: 'release', mainClass: 'net.minecraft.client.main.Main' }
  }
}

/** Mojang's own java_version requirement, simplified to the majors we ship. */
export function javaMajorFor(id: string): number {
  if (id.startsWith('26.') || id.startsWith('1.21.[4-9]')) return 21
  if (id.startsWith('1.21')) return 21
  if (id >= '1.20.5' || id.startsWith('1.20')) return 21
  if (id.startsWith('1.18') || id.startsWith('1.19') || id.startsWith('1.17')) return 17
  return 8
}

/* --------------------------------------------------------------- instances */

function instance(partial: Partial<Instance> & Pick<Instance, 'id' | 'name' | 'versionId' | 'loader' | 'gameVersion'>): Instance {
  const created = now - 30 * DAY
  return {
    description: '',
    icon: partial.loader,
    isolated: true,
    java: { mode: 'auto' },
    memoryMb: SETTINGS.defaultMemoryMb,
    jvmArgs: '',
    gameArgs: '',
    resolution: { width: 1280, height: 720, fullscreen: false },
    createdAt: created,
    updatedAt: created + DAY,
    lastPlayedAt: created + 2 * DAY,
    playCount: 3,
    version: 1,
    ...partial
  }
}

export const INSTANCES: Instance[] = [
  instance({
    id: 'inst-fabric-1211',
    name: 'Fabric 1.21.1 测试场',
    description: 'sodium + fabric-api，用来验证渲染管线',
    versionId: '1.21.1+fabric.0.16.14',
    loader: 'fabric',
    loaderVersion: '0.16.14',
    gameVersion: '1.21.1',
    accountId: 'acc-offline',
    lastPlayedAt: now - 2 * 3_600_000,
    playCount: 41,
    quickAccess: true
  }),
  instance({
    id: 'inst-neoforge-263',
    name: 'NeoForge 26.3',
    description: '最新正式版 + NeoForge 前置',
    versionId: '26.3+neoforge.21.4.90-beta',
    loader: 'neoforge',
    loaderVersion: '21.4.90-beta',
    gameVersion: '26.3',
    memoryMb: 6144,
    lastPlayedAt: now - 5 * DAY,
    playCount: 12,
    quickAccess: true
  }),
  instance({
    id: 'inst-quilt-1214',
    name: 'Quilt 1.21.4',
    description: 'qfapi 兼容性实验',
    versionId: '1.21.4+quilt.0.27.0-beta.4',
    loader: 'quilt',
    loaderVersion: '0.27.0-beta.4',
    gameVersion: '1.21.4',
    lastPlayedAt: now - 9 * DAY,
    playCount: 4
  }),
  instance({
    id: 'inst-vanilla-1204',
    name: '原版 1.20.4',
    description: '纯净存档，不加任何前置',
    versionId: '1.20.4',
    loader: 'vanilla',
    gameVersion: '1.20.4',
    isolated: false,
    java: { mode: 'pinned', major: 17, path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\javaw.exe' },
    lastPlayedAt: now - 21 * DAY,
    playCount: 88
  }),
  instance({
    id: 'inst-forge-1122',
    name: 'Forge 1.12.2 整合包',
    description: '老整合包，Java 8 固定',
    versionId: '1.12.2-forge1.12.2-14.23.5.2859',
    loader: 'forge',
    loaderVersion: '14.23.5.2859',
    gameVersion: '1.12.2',
    java: { mode: 'pinned', major: 8, path: 'C:\\Program Files\\Java\\jre1.8.0_411\\bin\\javaw.exe' },
    memoryMb: 3072,
    lastPlayedAt: now - 60 * DAY,
    playCount: 7
  }),
  instance({
    id: 'inst-broken-1202',
    name: '损坏的旧实例',
    description: '版本 json 被手动删过，client jar 校验不过',
    versionId: '1.20.2+fabric.0.14.24',
    loader: 'fabric',
    loaderVersion: '0.14.24',
    gameVersion: '1.20.2',
    lastPlayedAt: now - 120 * DAY,
    playCount: 1
  }),
  instance({
    id: 'inst-snapshot-264',
    name: '26.4 快照',
    description: '每周快照，用来提前适配',
    versionId: '26.4-snapshot-1',
    loader: 'vanilla',
    gameVersion: '26.4-snapshot-1',
    lastPlayedAt: now - 3 * DAY,
    playCount: 2
  }),
  instance({
    id: 'inst-neoforge-dev',
    name: '模组开发（NeoForge）',
    description: '带客户端 debug 参数',
    versionId: '26.3+neoforge.21.4.90-beta',
    loader: 'neoforge',
    loaderVersion: '21.4.90-beta',
    gameVersion: '26.3',
    jvmArgs: '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005',
    server: { address: 'mc.example.net', port: 25565 },
    serverId: 'srv-survival',
    lastPlayedAt: now - 30 * 60_000,
    playCount: 156
  }),
  instance({
    id: 'inst-fabric-1218-shader',
    name: '光影展示 1.21.8',
    description: 'iris + complementary，截图用',
    versionId: '1.21.8+fabric.0.16.10',
    loader: 'fabric',
    loaderVersion: '0.16.10',
    gameVersion: '1.21.8',
    memoryMb: 8192,
    resolution: { width: 1920, height: 1080, fullscreen: true },
    lastPlayedAt: now - 7 * DAY,
    playCount: 23
  }),
  instance({
    id: 'inst-legacy-189',
    name: 'Legacy Fabric 1.8.9',
    description: 'PVP 客户端，需要 legacy-fabric',
    versionId: '1.8.9+legacy-fabric.1.13.1',
    loader: 'legacy-fabric',
    loaderVersion: '1.13.1',
    gameVersion: '1.8.9',
    java: { mode: 'pinned', major: 8 },
    memoryMb: 2048,
    lastPlayedAt: now - 15 * DAY,
    playCount: 30
  })
]

export const INSTANCE_STATES: Record<string, InstanceState> = {
  'inst-fabric-1211': state(true, 0, 1_340_000_000),
  'inst-neoforge-263': state(true, 0, 2_100_000_000),
  'inst-quilt-1214': state(true, 0, 1_890_000_000),
  'inst-vanilla-1204': state(true, 0, 780_000_000),
  'inst-forge-1122': state(true, 0, 3_400_000_000),
  'inst-broken-1202': {
    installed: true,
    versionResolved: false,
    clientJarOk: false,
    assetsOk: false,
    librariesOk: true,
    loaderOk: false,
    missingCount: 137,
    sizeBytes: 410_000_000,
    lastCheckedAt: now - 40 * DAY
  },
  'inst-snapshot-264': state(true, 0, 1_100_000_000),
  'inst-neoforge-dev': state(true, 0, 2_400_000_000),
  'inst-fabric-1218-shader': state(true, 3, 5_600_000_000),
  'inst-legacy-189': state(true, 0, 620_000_000)
}

function state(installed: boolean, missingCount: number, sizeBytes: number): InstanceState {
  return {
    installed,
    versionResolved: true,
    clientJarOk: true,
    assetsOk: missingCount === 0,
    librariesOk: true,
    loaderOk: true,
    missingCount,
    sizeBytes,
    lastCheckedAt: now - DAY
  }
}

export const MOD_COUNTS: Record<string, number> = {
  'inst-fabric-1211': 6,
  'inst-neoforge-263': 3,
  'inst-quilt-1214': 2,
  'inst-vanilla-1204': 0,
  'inst-forge-1122': 24,
  'inst-broken-1202': 1,
  'inst-snapshot-264': 0,
  'inst-neoforge-dev': 4,
  'inst-fabric-1218-shader': 8,
  'inst-legacy-189': 5
}

export function summaries(): InstanceSummary[] {
  return INSTANCES.map((instanceItem) => ({
    instance: instanceItem,
    state: INSTANCE_STATES[instanceItem.id] ?? state(false, 0, 0),
    modCount: MOD_COUNTS[instanceItem.id] ?? 0
  }))
}

/* -------------------------------------------------------------------- java */

export const JAVA_RUNTIMES: JavaRuntime[] = [
  {
    id: 'java-8-temurin',
    path: 'C:\\Program Files\\Eclipse Adoptium\\jre-8\\bin\\java.exe',
    rawVersion: 'openjdk version "1.8.0_412" (Temurin-8u412b08)',
    major: 8,
    vendor: 'Eclipse Temurin',
    arch: 'x64',
    source: 'system-path',
    executable: 'C:\\Program Files\\Eclipse Adoptium\\jre-8\\bin\\javaw.exe',
    canHeadless: true
  },
  {
    id: 'java-17-adoptium',
    path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\java.exe',
    rawVersion: 'openjdk version "17.0.11" 2024-04-16 LTS',
    major: 17,
    vendor: 'Eclipse Temurin',
    arch: 'x64',
    source: 'adoptium',
    executable: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\javaw.exe',
    canHeadless: true
  },
  {
    id: 'java-25-mojang',
    path: 'C:\\Users\\jiamou\\AppData\\Roaming\\MoucLauncher\\java\\25\\bin\\java.exe',
    rawVersion: 'openjdk version "25" 2025-09-16 LTS (Mojang runtime-gamma)',
    major: 25,
    vendor: 'Mojang Studios',
    arch: 'x64',
    source: 'mojang',
    executable: 'C:\\Users\\jiamou\\AppData\\Roaming\\MoucLauncher\\java\\25\\bin\\javaw.exe',
    canHeadless: true
  },
  {
    id: 'java-11-oracle',
    path: 'C:\\Program Files (x86)\\Java\\jre-11\\bin\\java.exe',
    rawVersion: 'java version "11.0.2" 2019-01-15 LTS',
    major: 11,
    vendor: 'Oracle',
    arch: 'x86',
    source: 'scan',
    executable: 'C:\\Program Files (x86)\\Java\\jre-11\\bin\\javaw.exe',
    canHeadless: false,
    broken: '32 位运行时，Windows 原生库无法加载'
  }
]

/** Major 21 is intentionally absent so `java.resolve` can hit the missing case. */
export const JAVA_MISSING_MAJORS = [21]

/* ----------------------------------------------------------------- accounts */

export const ACCOUNTS: Account[] = [
  {
    id: 'acc-offline',
    type: 'offline',
    name: 'jiamou',
    uuid: '8f2c1d33-4a5b-4c6d-9e0f-1a2b3c4d5e6f',
    selected: true,
    addedAt: now - 300 * DAY,
    lastUsedAt: now - 30 * 60_000,
    tokenState: 'none',
    label: '离线模式',
    skinUrl: 'http://textures.minecraft.net/texture/' + hashOf('jiamou')
  },
  {
    id: 'acc-ms',
    type: 'microsoft',
    name: 'jiajia2222',
    uuid: '5b6a7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
    selected: false,
    addedAt: now - 90 * DAY,
    lastUsedAt: now - 6 * DAY,
    tokenState: 'needs-refresh',
    // expiring in ~35 min: the UI has to show a warning and offer a refresh
    expiresAt: now + 35 * 60_000,
    label: 'msa:ji****22@example.com',
    skinUrl: 'http://textures.minecraft.net/texture/' + hashOf('jiajia2222'),
    capeUrl: 'http://textures.minecraft.net/texture/' + hashOf('cape')
  }
]

/* ------------------------------------------------------------------ servers */

export const SERVERS: ServerEntry[] = [
  {
    id: 'srv-survival',
    name: '生存服',
    address: 'mc.example.net',
    port: 25565,
    acceptTextures: 1,
    lastPingAt: now - 20 * 60_000
  },
  {
    id: 'srv-skyblock',
    name: '空岛',
    address: 'play.sky.example',
    port: 25565,
    acceptTextures: 1,
    lastPingAt: now - 3 * DAY
  },
  {
    id: 'srv-lan',
    name: '家里的局域网服',
    address: '192.168.1.23',
    port: 51_234,
    hidden: false,
    lastPingAt: now - 8 * DAY
  }
]

export const LAN_GAMES: LanGame[] = [
  {
    motd: '§a从副本里出来的世界',
    address: '192.168.1.23',
    port: 51_234,
    versionName: '1.21.1',
    protocol: 767,
    gameMode: '生存',
    from: '192.168.1.23:51_234',
    seenAt: now - 40_000,
    serverProperties: { motd: '从副本里出来的世界', maxPlayers: '8' }
  },
  {
    motd: '§e创造模式测试',
    address: '192.168.1.44',
    port: 49_551,
    versionName: '26.3',
    protocol: 772,
    gameMode: '创造',
    from: '192.168.1.44:49551',
    seenAt: now - 12_000,
    serverProperties: { motd: '创造模式测试', maxPlayers: '4' }
  }
]

export const RELAY_IDLE: RelayStatus = { state: 'idle', peers: [], message: '未连接' }

/* --------------------------------------------------------------------- mods */

function project(partial: Partial<ModProject> & Pick<ModProject, 'id' | 'slug' | 'title'>): ModProject {
  return {
    provider: 'modrinth',
    kind: 'mod',
    description: '',
    authors: ['MoucDev'],
    downloads: 120_000,
    categories: ['utility'],
    loaders: ['fabric', 'quilt'],
    gameVersions: ['1.21.1', '1.21.4', '26.3'],
    dateModified: new Date(now - 12 * DAY).toISOString(),
    license: 'MIT',
    sourceUrl: `https://modrinth.com/mod/${partial.slug}`,
    ...partial
  }
}

export const MOD_PROJECTS: ModProject[] = [
  project({
    id: 'sodium',
    slug: 'sodium',
    title: 'Sodium',
    description: '现代渲染引擎重写，显著提升帧率',
    authors: ['jellysquid3'],
    downloads: 32_400_000,
    categories: ['performance', 'optimization'],
    loaders: ['fabric', 'neoforge'],
    gameVersions: ['1.21.1', '1.21.4', '1.21.8', '26.3']
  }),
  project({
    id: 'lithium',
    slug: 'lithium',
    title: 'Lithium',
    description: '通用游戏逻辑优化，不改机制',
    authors: ['jellysquid3'],
    downloads: 18_900_000,
    categories: ['performance']
  }),
  project({
    id: 'fabric-api',
    slug: 'fabric-api',
    title: 'Fabric API',
    description: '大多数 Fabric 模组的前置库',
    authors: ['FabricMC'],
    downloads: 41_200_000,
    categories: ['library'],
    loaders: ['fabric']
  }),
  project({
    id: 'iris',
    slug: 'iris',
    title: 'Iris Shaders',
    description: 'OptiFine 兼容的光影加载器',
    authors: ['coderbot'],
    downloads: 12_300_000,
    categories: ['visual', 'shaders'],
    loaders: ['fabric', 'quilt']
  }),
  project({
    id: 'xaeros-worldmap',
    slug: 'xaeros-world-map',
    title: "Xaero's World Map",
    description: '全屏世界地图，支持服务器同步',
    authors: ['xaero96'],
    downloads: 22_100_000,
    categories: ['map', 'utility']
  }),
  project({
    id: 'jei',
    slug: 'jei',
    title: 'Just Enough Items',
    description: '物品与配方浏览器',
    authors: ['mezz'],
    downloads: 61_000_000,
    categories: ['inventory'],
    provider: 'curseforge',
    loaders: ['forge', 'neoforge']
  }),
  project({
    id: 'create',
    slug: 'create',
    title: 'Create',
    description: '机械动力：自动化与旋转机械',
    authors: ['simibubi'],
    downloads: 48_700_000,
    categories: ['technology', 'adventure'],
    provider: 'curseforge',
    loaders: ['forge', 'neoforge']
  }),
  project({
    id: 'complementary',
    slug: 'complementary-shaders',
    title: 'Complementary Reimagined',
    kind: 'shader',
    description: '兼顾性能与观感的光影包',
    categories: ['shaders'],
    downloads: 4_300_000
  }),
  project({
    id: 'faithful-32',
    slug: 'faithful',
    title: 'Faithful 32x',
    kind: 'resourcepack',
    description: '把原版纹理提升到 32x，保持原版风格',
    categories: ['texture'],
    downloads: 7_800_000
  }),
  project({
    id: 'skin-dungeon-pack',
    slug: 'skin-dungeon-cards',
    title: '卡牌地牢整合包',
    kind: 'modpack',
    description: '128 个模组，卡牌 + 地牢主题',
    loaders: ['neoforge'],
    provider: 'curseforge',
    categories: ['game-mechanics', 'magic'],
    downloads: 1_900_000
  })
]

export const PROJECT_VERSIONS: Record<string, ProjectVersion[]> = {
  sodium: [
    {
      id: 'sodium-0.6.6',
      projectId: 'sodium',
      provider: 'modrinth',
      name: 'Sodium 0.6.6',
      versionNumber: '0.6.6',
      changelog: '修复 26.3 上的 GUI 图层顺序问题。',
      datePublished: new Date(now - 12 * DAY).toISOString(),
      loaders: ['fabric'],
      gameVersions: ['1.21.1', '1.21.4', '26.3'],
      dependencies: [],
      files: [modFile('sodium-fabric-0.6.6.jar', 'sodium', 0.6_120_000)]
    },
    {
      id: 'sodium-0.5.11',
      projectId: 'sodium',
      provider: 'modrinth',
      name: 'Sodium 0.5.11',
      versionNumber: '0.5.11',
      datePublished: new Date(now - 220 * DAY).toISOString(),
      loaders: ['fabric', 'quilt'],
      gameVersions: ['1.20.2', '1.20.4'],
      dependencies: [],
      files: [modFile('sodium-fabric-0.5.11.jar', 'sodium', 5_400_000)]
    }
  ],
  'fabric-api': [
    {
      id: 'fabric-api-0.114.0',
      projectId: 'fabric-api',
      provider: 'modrinth',
      name: 'Fabric API 0.114.0+1.21.1',
      versionNumber: '0.114.0',
      datePublished: new Date(now - 5 * DAY).toISOString(),
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      dependencies: [{ projectId: 'fabric-api-deps', kind: 'required' }],
      files: [modFile('fabric-api-0.114.0+1.21.1.jar', 'fabric-api', 2_100_000)]
    }
  ],
  lithium: [
    {
      id: 'lithium-0.14.7',
      projectId: 'lithium',
      provider: 'modrinth',
      name: 'Lithium 0.14.7',
      versionNumber: '0.14.7',
      datePublished: new Date(now - 40 * DAY).toISOString(),
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      dependencies: [],
      files: [modFile('lithium-fabric-0.14.7.jar', 'lithium', 820_000)]
    }
  ],
  iris: [
    {
      id: 'iris-1.8.4',
      projectId: 'iris',
      provider: 'modrinth',
      name: 'Iris 1.8.4',
      versionNumber: '1.8.4',
      datePublished: new Date(now - 18 * DAY).toISOString(),
      loaders: ['fabric', 'quilt'],
      gameVersions: ['1.21.1', '1.21.8'],
      dependencies: [{ projectId: 'sodium', kind: 'optional' }],
      files: [modFile('iris-fabric-1.8.4.jar', 'iris', 1_640_000)]
    }
  ]
}

function modFile(fileName: string, projectId: string, size: number): ModFile {
  return {
    versionId: projectId + '-' + fileName,
    projectId,
    provider: 'modrinth',
    name: fileName.replace('.jar', ''),
    fileName,
    url: `https://cdn.modrinth.com/data/${projectId}/versions/${fileName}`,
    size,
    hashes: { sha1: hashOf(fileName), sha512: hashOf(fileName + '512') + hashOf(fileName + '512b') },
    loaders: ['fabric'],
    gameVersions: ['1.21.1'],
    dependencies: [],
    primary: true
  }
}

export const INSTALLED_MODS: Record<string, InstalledMod[]> = {
  'inst-fabric-1211': [
    installed('sodium-fabric-0.6.6.jar', 'sodium', 'Sodium', '0.6.6', 6_120_000),
    installed('lithium-fabric-0.14.7.jar', 'lithium', 'Lithium', '0.14.7', 820_000, { disabled: true }),
    installed('fabric-api-0.114.0+1.21.1.jar', 'fabric-api', 'Fabric API', '0.114.0', 2_100_000),
    installed('xaeros-worldmap-21.1.14.jar', "xaeros-worldmap", "Xaero's World Map", '21.1.14', 3_900_000, {
      updateAvailable: PROJECT_VERSIONS.lithium?.[0]
    }),
    installed('fabric-shader-tweaks.jar', 'shader-tweaks', 'Shader Tweaks', '1.0.2', 210_000, { loader: 'quilt' })
  ],
  'inst-neoforge-dev': [
    installed('create-26.3-0.6.2.jar', 'create', 'Create', '0.6.2', 18_400_000, { provider: 'curseforge', loader: 'neoforge' }),
    installed('jei-26.3-17.1.3.jar', 'jei', 'Just Enough Items', '17.1.3', 9_800_000, { provider: 'curseforge', loader: 'neoforge' }),
    installed('mouc-debug.jar', 'mouc-debug', '本地调试模组', 'dev', 44_000, { provider: 'local', loader: 'neoforge' })
  ],
  'inst-broken-1202': [installed('old-compat-layer.jar', 'old-compat', '旧兼容层', '0.2.0', 96_000, { disabled: true })]
}

function installed(
  fileName: string,
  projectId: string,
  name: string,
  version: string,
  size: number,
  extra: Partial<InstalledMod> = {}
): InstalledMod {
  return {
    fileName,
    modId: projectId,
    name,
    version,
    description: `${name} ${version}`,
    loader: 'fabric',
    gameVersions: ['1.21.1'],
    size,
    disabled: false,
    updatedAt: now - 6 * DAY,
    projectId,
    provider: 'modrinth',
    versionId: projectId + '-' + version,
    ...extra
  }
}

/* ------------------------------------------------------------------- crash */

export const CRASH_SAMPLE: CrashAnalysis = {
  title: '模组与 NeoForge 版本不匹配',
  cause: 'create-26.3-0.6.2.jar 依赖 neoforge 21.4.90+，当前实例为 20.4.148。',
  suggestion: '把实例的 NeoForge 升级到 21.4.90-beta，或改用对应旧版 Create。',
  severity: 'critical',
  evidence: [
    'Caused by: java.lang.NoSuchMethodError: net.neoforged.neoforge.client.renderlevel.RenderLevelEvent.<init>',
    '\tat com.simibubi.create.AllRenderPipelines.<clinit>(AllRenderPipelines.java:41)',
    '\tat java.base/java.lang.Class.forName(Class.java:1541)',
    'Failing in phase SETUP, 3 mods loaded of 127'
  ],
  tags: ['mod-conflict', 'neoforge', 'setup-phase'],
  reportPath: 'D:\\Games\\Minecraft\\crash-reports\\crash-2026-10-07_14.22.09-client.txt'
}

export const LOG_TAIL: GameLogLine[] = [
  { instanceId: 'inst-fabric-1211', ts: now - 20_000, level: 'system', text: 'Minecraft 1.21.1 (fabric-loader 0.16.14) 启动' },
  { instanceId: 'inst-fabric-1211', ts: now - 18_000, level: 'info', text: 'Backend library: LWJGL version 3.3.3-snapshot' },
  { instanceId: 'inst-fabric-1211', ts: now - 14_000, level: 'info', text: 'Sodium: Detected processor with 12 cores' },
  { instanceId: 'inst-fabric-1211', ts: now - 9_000, level: 'warn', text: "Xaero's World Map: 世界地图尺寸超过 512MB，建议清理" },
  { instanceId: 'inst-fabric-1211', ts: now - 4_000, level: 'info', text: 'Loaded 6 mods, 0 disabled' },
  { instanceId: 'inst-fabric-1211', ts: now - 1_000, level: 'error', text: 'Failed to fetch skin texture: textures.minecraft.net (超时)' }
]

/* ------------------------------------------------------------------- stats */

export const DIR_STATS: GameDirStats = {
  exists: true,
  sizeBytes: 21_400_000_000,
  fileCount: 412_887,
  versions: INSTALLED_VERSION_IDS.length,
  instances: INSTANCES.length,
  mods: Object.values(MOD_COUNTS).reduce((acc, n) => acc + n, 0),
  screenshots: 63
}

export const LAUNCHER_VERSION = '1.0.0'

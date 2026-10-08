/**
 * Every endpoint in this file was probed on 2026-10-07 from a CN network.
 * Status codes are recorded in docs/endpoints.md. If an endpoint stops working,
 * change it here and re-run `npm test` — nothing else hardcodes URLs.
 */

export const OFFICIAL_HOSTS = {
  pistonMeta: 'piston-meta.mojang.com',
  launchermeta: 'launchermeta.mojang.com',
  pistonData: 'piston-data.mojang.com',
  resources: 'resources.download.minecraft.net',
  libraries: 'libraries.minecraft.net'
} as const

export const ENDPOINTS = {
  /** 200 on 2026-10-07. `latest.release` was "26.3". */
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  /** Legacy host, same document, kept as a fallback url. */
  versionManifestLegacy: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',

  fabricLoaderList: 'https://meta.fabricmc.net/v2/versions/loader',
  fabricGameVersions: 'https://meta.fabricmc.net/v2/versions/game',
  fabricMaven: 'https://maven.fabricmc.net',
  legacyFabricMeta: 'https://meta.legacyfabric.net/v2/versions/loader',
  legacyFabricMaven: 'https://maven.quiltmc.org/repository/release',
  quiltLoaderList: 'https://meta.quiltmc.org/v3/versions/loader',
  quiltMaven: 'https://maven.quiltmc.org/repository/release',

  neoforgeMavenMetadata: 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml',
  neoforgeMaven: 'https://maven.neoforged.net/releases',
  /** 200 on 2026-10-07: promotions_slim.json. */
  forgePromotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  forgeMavenMetadata: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
  forgeMaven: 'https://maven.minecraftforge.net',

  modrinthSearch: 'https://api.modrinth.com/v2/search',
  modrinthProject: 'https://api.modrinth.com/v2/project',
  modrinthVersions: 'https://api.modrinth.com/v2/project/{id}/version',
  curseForgeMods: 'https://api.curseforge.com/v1/mods',
  curseForgeFiles: 'https://api.curseforge.com/v1/mods/{id}/files',

  /** 200 for majors 8/17/21/25 on 2026-10-07 (x64 windows jre/jdk). */
  adoptiumLatest: 'https://api.adoptium.net/v3/assets/latest',
  adoptiumReleaseList: 'https://api.adoptium.net/v3/assets/feature_releases',

  authlibInjectorLatest: 'https://authlib-injector.yushi.moe/artifact/latest.json',

  /** Device-code flow. Reachable on 2026-10-07 (POST-only). */
  msDeviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  msToken: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xboxUserAuth: 'https://user.auth.xboxlive.com/user/authenticate',
  xboxXsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  minecraftLoginWithXbox: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  minecraftProfile: 'https://api.minecraftservices.com/minecraft/profile',
  minecraftEntitlements: 'https://api.minecraftservices.com/minecraft/entitlements',
  skinBlobServer: 'http://textures.minecraft.net/texture',

  githubApi: 'https://api.github.com',
  /** Self-update source. */
  updateRepo: 'jiajia2222/MoucX'
} as const

/**
 * BMCLAPI used to be the default CN accelerator. As of 2026-07..10 every public
 * route we tried on bmclapi2.bangbang93.com returns 404 (`/`, `/manifest/minecraft`,
 * `/minecraft/manifest/minecraft`, `/bmc/version.json`, `/v3/mirrors`, and
 * openbmclapi.bangbang93.com/mirrors). We therefore ship *no* public mirror by
 * default and let users add their own through Settings -> 下载源: a mirror only has
 * to serve the same path under a different host (see `rewriteUrl`).
 */
export const BMCLAPI_STATUS = {
  base: 'https://bmclapi2.bangbang93.com',
  verified: '2026-10-07',
  working: false
} as const

/** Official host -> the path prefix a BMCLAPI-style mirror expects. */
export const OFFICIAL_TO_MIRROR: Record<string, string> = {
  [OFFICIAL_HOSTS.pistonMeta]: '',
  [OFFICIAL_HOSTS.launchermeta]: '',
  [OFFICIAL_HOSTS.pistonData]: '',
  [OFFICIAL_HOSTS.resources]: '',
  [OFFICIAL_HOSTS.libraries]: '/maven'
}

export const MANIFEST_CACHE_MS = 6 * 60 * 60 * 1000

/** Vanilla needs these feature flags to be reported; we support none of the optional ones. */
export const SUPPORTED_FEATURES: Record<string, boolean> = {
  isDemoUser: false,
  hasCustomResolution: true,
  hasIntegratedServer: false,
  showsSplashScreen: true,
  allowsUnknownRes: false,
  isJava13Plus: true
}

export const DEFAULT_SETTINGS_CONST = {
  memoryMb: 4096,
  minMemoryMb: 1024,
  maxConcurrentDownloads: 8,
  width: 854,
  height: 480,
  relayPort: 25565,
  /**
   * Java Edition publishes LAN worlds by multicasting `[MOTD]…[/MOTD][AD]…[/AD]`
   * to 224.0.2.60:4445 (49550 is the Bedrock Edition port, not this one).
   * Sourced in docs/lan.md.
   */
  mcLanPort: 4445,
  defaultConnectTimeoutMs: 15_000,
  defaultReadTimeoutMs: 60_000
} as const

export const PROTOCOL = {
  /** Handshake/`status` ping. `-1` tells the server "version unknown", which every
   *  real server accepts; we do not pin a per-version protocol number because Mojang
   *  does not publish it in the version manifest. */
  pingProtocol: -1,
  handshakeNext: 0x01
} as const

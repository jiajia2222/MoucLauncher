/**
 * Public surface of the Minecraft core. The container wires these two factories;
 * everything else in this folder is an implementation detail (exported for tests).
 */
export { createVersionService, type MinecraftServiceDeps } from './version'
export {
  createGameService,
  COMMAND_LINE_LIMIT,
  detectLogLevel,
  quickPlayArgs,
  type GameServiceDeps,
  type SpawnFn
} from './launch'
export { createManifest, manifestCacheFile, type ManifestService, type ManifestDeps } from './manifest'
export {
  createResolver,
  mergeVersionJson,
  toResolvedVersion,
  type VersionResolver,
  type ResolverDeps,
  type ResolvedCacheFile
} from './resolve'
export { createInstaller, waitForJob, type VersionInstaller, type InstallerDeps } from './install'
export { checkItems, checkPlan, type PlanCheck } from './verify'
export {
  buildArguments,
  libraryClasspath,
  finalizeClasspath,
  launcherFeatures,
  loggingClientPath,
  nativeJarFiles,
  osRuleContext,
  plannedLibraryFiles,
  placeholderTable,
  quoteArg,
  substitute,
  CLASSIC_JVM_ARGS,
  LAUNCHER_NAME,
  type BuiltArguments,
  type ArgumentBuildContext,
  type PlaceholderContext,
  type AccountPlaceholders,
  type Resolution
} from './arguments'
export {
  assetObjects,
  assetIndexItem,
  assetObjectItems,
  assetObjectUrl,
  mapsToResources,
  virtualAssetsDir,
  writeVirtualCopies,
  type AssetObject,
  type AssetIndexDoc
} from './assets'
export {
  extractNativeJar,
  ensureNatives,
  needsReextract,
  shouldSkipNativeEntry,
  NATIVES_MARKER
} from './natives'

import path from 'node:path'
import type { Instance, PathInfo } from '@shared/types'
import { AppError } from '@shared/errors'
import { isSafeName } from '@shared/utils'

/** True when `child` is `base` or lives under it, compared on normalized absolute paths. */
export function isPathInside(base: string, child: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Guards for strings that arrive from the network (version ids, library `path`,
 * asset names, jar entry names). A hostile or broken mirror must not be able to
 * steer a write outside the directory the caller already chose.
 */
function safeSegment(value: string, what: string): string {
  if (!isSafeName(value)) throw new AppError('invalid-input', `${what}不是合法的目录名`, value)
  return value
}

function safeRelative(relative: string, what: string): string {
  const windows = relative.replace(/\\/g, '/')
  if (windows.length === 0 || path.isAbsolute(windows) || windows.startsWith('../') || windows === '..') {
    throw new AppError('invalid-input', `${what}试图写出目标目录`, relative)
  }
  return relative
}

/** All on-disk locations derive from `appData` (launcher state) + `gameRoot` (Minecraft). */
export function buildPaths(appData: string, gameRoot: string): PathInfo {
  return {
    appData,
    gameRoot,
    versionsDir: path.join(gameRoot, 'versions'),
    librariesDir: path.join(gameRoot, 'libraries'),
    assetsDir: path.join(gameRoot, 'assets'),
    instancesDir: path.join(gameRoot, 'instances'),
    logsDir: path.join(appData, 'logs'),
    javaStoreDir: path.join(appData, 'java'),
    configDir: path.join(appData, 'config')
  }
}

export function defaultGameRoot(appData: string, documents?: string): string {
  return documents && documents.length > 0 ? path.join(documents, 'MoucLauncher') : path.join(appData, 'minecraft')
}

export function launcherStateDir(appData: string): string {
  return path.join(appData, 'state')
}

export function instanceRootFile(paths: PathInfo): string {
  return path.join(paths.gameRoot, '.mouc', 'instances.json')
}

export function versionJsonPath(paths: PathInfo, id: string): string {
  return path.join(paths.versionsDir, safeSegment(id, '版本号'), `${safeSegment(id, '版本号')}.json`)
}

export function versionJarPath(paths: PathInfo, id: string): string {
  return path.join(paths.versionsDir, safeSegment(id, '版本号'), `${safeSegment(id, '版本号')}.jar`)
}

export function versionDir(paths: PathInfo, id: string): string {
  return path.join(paths.versionsDir, safeSegment(id, '版本号'))
}

export function nativesDir(paths: PathInfo, id: string): string {
  return path.join(versionDir(paths, id), `natives-windows`)
}

export function assetIndexPath(paths: PathInfo, id: string): string {
  return path.join(paths.assetsDir, 'indexes', `${safeSegment(id, '资源索引')}.json`)
}

export function assetObjectPath(paths: PathInfo, sha1: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new AppError('invalid-input', '资源哈希不是 40 位十六进制', sha1)
  return path.join(paths.assetsDir, 'objects', sha1.slice(0, 2), sha1)
}

export function assetVirtualPath(paths: PathInfo, indexId: string, relative: string): string {
  return path.join(paths.assetsDir, 'virtual', safeSegment(indexId, '资源索引'), safeRelative(relative, '资源名'))
}

export function libraryPath(paths: PathInfo, relativePath: string): string {
  return path.join(paths.librariesDir, safeRelative(relativePath, '库路径'))
}

/** Directory the game is actually run from (`.minecraft`-equivalent for this instance). */
export function instanceGameDir(instance: Instance, paths: PathInfo): string {
  return instance.isolated ? path.join(paths.instancesDir, instance.id) : paths.gameRoot
}

export function instanceModsDir(instance: Instance, paths: PathInfo): string {
  return path.join(instanceGameDir(instance, paths), 'mods')
}

export function instanceLogsDir(instance: Instance, paths: PathInfo): string {
  return path.join(instanceGameDir(instance, paths), 'logs')
}

export function instanceConfigFile(instance: Instance, paths: PathInfo): string {
  return path.join(instanceGameDir(instance, paths), '.mouc-instance.json')
}

export function screenshotDir(instance: Instance, paths: PathInfo): string {
  return path.join(instanceGameDir(instance, paths), 'screenshots')
}

export function crashReportsDir(instance: Instance, paths: PathInfo): string {
  return path.join(instanceLogsDir(instance, paths), 'latest')
}

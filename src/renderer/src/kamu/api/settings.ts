/**
 * Settings domain for the ported KAMUCL renderer layer.
 *
 * Upstream (`src/renderer/src/api.ts`) had one flat function per IPC channel that
 * returned the unwrapped value and rejected on failure. MoucLauncher's main process only
 * speaks `Result<T>`, so every function here funnels through `api/core.ts` and keeps the
 * upstream call shape. Nothing else in the ported renderer talks to `window.mouc`.
 *
 * The surface is deliberately small and additive: `getSettings`, `saveSettings`,
 * `getPaths`, `getStats`, `getSystemMemoryMb` are the core reads, the rest are the
 * dialogs and app actions the settings page needs. Never remove an export — other layers
 * may already depend on it.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT for its own
 * contributions — see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import type { GameDirStats, JavaRuntime, PathInfo, Settings, UpdateInfo } from '@shared/types'
import { api, call, plain } from './core'

/* --------------------------------------------------------------- the record */

export function getSettings(): Promise<Settings> {
  return call(api().settings.get())
}

/**
 * Partial write; the process always returns the whole record, which the caller must
 * adopt so the UI reflects what was really stored (clamped or rejected fields included).
 */
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return call(api().settings.set(plain(patch)))
}

/* ----------------------------------------------------------------- system */

export function getPaths(): Promise<PathInfo> {
  return call(api().app.paths())
}

export function getStats(): Promise<GameDirStats> {
  return call(api().app.stats())
}

export function getLauncherVersion(): Promise<string> {
  return call(api().app.version())
}

/**
 * Physical memory in MB, used as the ceiling for the memory slider. The main process
 * exposes no memory channel, so this uses the browser's coarse `deviceMemory` hint and
 * returns 0 when the hint is missing — callers then fall back to a conservative ceiling.
 */
export function getSystemMemoryMb(): number {
  // `deviceMemory` is not in the project's DOM lib version, so read it defensively.
  const hint = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return typeof hint === 'number' && Number.isFinite(hint) && hint > 0 ? Math.round(hint * 1024) : 0
}

/** Runtimes the main process can see right now (registry, PATH, game root, stores). */
export function scanJava(): Promise<JavaRuntime[]> {
  return call(api().java.scan())
}

/* ------------------------------------------------------------ dialogs/app */

export async function pickFolder(
  title: string,
  defaultPath?: string
): Promise<string | undefined> {
  return call(api().app.pickFolder(title, defaultPath))
}

export async function pickJavaFile(title: string): Promise<string | undefined> {
  return call(
    api().app.pickFile(title, [
      { name: 'Java 可执行文件', extensions: ['exe'] },
      { name: '所有文件', extensions: ['*'] }
    ])
  )
}

export function openPath(target: string): Promise<boolean> {
  return call(api().app.openPath(target))
}

export function openExternal(url: string): Promise<boolean> {
  return call(api().app.openExternal(url))
}

export function checkUpdate(): Promise<UpdateInfo> {
  return call(api().app.checkUpdate())
}

export function relaunch(): Promise<boolean> {
  return call(api().app.relaunch())
}

export function quit(): Promise<boolean> {
  return call(api().app.quit())
}

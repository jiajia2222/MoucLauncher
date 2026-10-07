/**
 * Shell bridge — the slice of `window.mouc` the chrome talks to.
 *
 * Upstream's shell (`App.vue`) reads settings/paths/stats, subscribes to progress +
 * game-exit pushes and drives the frameless window through one flat `api.ts` whose
 * functions return plain values and reject on failure. `kamu/api/core.ts` is the
 * `Result<T>` translator, so this file keeps upstream's call shape: `call()` for reads the
 * shell must have, `maybe()` for the live-status reads that may legitimately be
 * unavailable (offline, no jobs yet, browser preview).
 *
 * It lives under `kamu/shell/` rather than `kamu/api/settings.ts` on purpose: that module is
 * the settings *view*'s data layer and is being written concurrently; the shell must not
 * race it for the same file.
 */
import { EVENTS, type EventName, type WindowState } from '@shared/ipc'
import type {
  DownloadJob,
  GameDirStats,
  GameProcessInfo,
  InstanceSummary,
  LauncherStatus,
  ModpackImportRequest,
  ModpackManifest,
  PathInfo,
  UpdateInfo
} from '@shared/types'
import { ApiError, call, maybe, plain } from '../api/core'

export { ApiError, EVENTS as SHELL_EVENTS }

/** Never throws: the mock is installed before mount, but a stale window must stay clickable. */
function bridge(): Window['mouc'] | null {
  return window.mouc ?? null
}

/**
 * Subscribe to a main-process push event and return the unsubscribe function.
 * Without a bridge it degrades to a no-op so the preview never throws.
 */
export function onEvent(event: EventName, handler: (payload: unknown) => void): () => void {
  const mouc = bridge()
  if (!mouc || typeof mouc.on !== 'function') return () => undefined
  try {
    return mouc.on(event, handler)
  } catch {
    return () => undefined
  }
}

/* ---------------------------------------------------------------- live status */

export function readStatus(): Promise<LauncherStatus | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.status(), null) : Promise.resolve(null)
}

export function readPaths(): Promise<PathInfo | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.paths(), null) : Promise.resolve(null)
}

export function readStats(): Promise<GameDirStats | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.stats(), null) : Promise.resolve(null)
}

export function readVersion(): Promise<string> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.version(), '') : Promise.resolve('')
}

export function readInstances(): Promise<InstanceSummary[]> {
  const mouc = bridge()
  return mouc ? maybe(mouc.instance.list(), []) : Promise.resolve([])
}

/* ------------------------------------------------------------------- download */

export function readJobs(): Promise<DownloadJob[]> {
  const mouc = bridge()
  return mouc ? maybe(mouc.download.jobs(), []) : Promise.resolve([])
}

export function cancelJob(jobId: string): Promise<boolean> {
  const mouc = bridge()
  return mouc ? maybe(mouc.download.cancel(jobId), false) : Promise.resolve(false)
}

export function retryJob(jobId: string): Promise<DownloadJob | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.download.retry(jobId), null) : Promise.resolve(null)
}

export function clearJobs(): Promise<boolean> {
  const mouc = bridge()
  return mouc ? maybe(mouc.download.clear(), false) : Promise.resolve(false)
}

/* ----------------------------------------------------------------------- game */

export function readRunningGames(): Promise<GameProcessInfo[]> {
  const mouc = bridge()
  return mouc ? maybe(mouc.game.running(), []) : Promise.resolve([])
}

export function killGame(instanceId: string): Promise<boolean> {
  const mouc = bridge()
  return mouc ? maybe(mouc.game.kill(instanceId), false) : Promise.resolve(false)
}

/* --------------------------------------------------------------------- window */

const IDLE_WINDOW: WindowState = { maximized: false, fullscreen: false, alwaysOnTop: false }

export function readWindowState(): Promise<WindowState> {
  const mouc = bridge()
  return mouc ? maybe(mouc.win.state(), IDLE_WINDOW) : Promise.resolve(IDLE_WINDOW)
}

export function toggleMaximize(): Promise<WindowState | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.win.toggleMaximize(), null) : Promise.resolve(null)
}

export function setAlwaysOnTop(value: boolean): Promise<WindowState | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.win.setAlwaysOnTop(value), null) : Promise.resolve(null)
}

/** `win.minimize()` / `win.close()` are `void` in the contract: fire and forget. */
export function winMinimize(): void {
  try {
    bridge()?.win.minimize()
  } catch {
    /* nothing to minimise in the browser preview */
  }
}

export function winClose(): void {
  try {
    bridge()?.win.close()
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- app/other */

export function checkUpdate(): Promise<UpdateInfo | null> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.checkUpdate(), null) : Promise.resolve(null)
}

export function openExternal(url: string): Promise<boolean> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.openExternal(url), false) : Promise.resolve(false)
}

export function quitApp(): Promise<boolean> {
  const mouc = bridge()
  return mouc ? maybe(mouc.app.quit(), false) : Promise.resolve(false)
}

/** 导入 button: pick a pack, then let the download centre own the job. Rejects like upstream. */
export function pickPackFile(title: string): Promise<string | undefined> {
  const mouc = bridge()
  if (!mouc) return Promise.resolve(undefined)
  return call(mouc.app.pickFile(title, [
    { name: 'Modpack', extensions: ['mrpack', 'zip'] }
  ]))
}

export function importModpack(request: ModpackImportRequest): Promise<{ job: DownloadJob; manifest: ModpackManifest }> {
  const mouc = bridge()
  if (!mouc) return Promise.reject(new ApiError({ code: 'internal', message: '渲染桥接未注入', retryable: false }))
  return call(mouc.instance.importModpack(plain(request)))
}

/* ------------------------------------------------------------------ text errors */

/** Ported from upstream `api.ts#errText()`: any rejection collapses to one line. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'error' in error) {
    const payload = (error as { error?: { message?: string; detail?: string } }).error
    if (payload && typeof payload.message === 'string') {
      return payload.detail ? `${payload.message} — ${payload.detail}` : payload.message
    }
  }
  return String(error)
}

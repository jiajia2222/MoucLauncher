/**
 * Launch / runtime adapters for the ported KAMUCL views.
 *
 * Upstream's `launchGame()` only acknowledged the request and streamed `LaunchState` events;
 * MoucX resolves the spawn itself (`GameProcessInfo`) and reports the exit through
 * `mouc:game-exit`, so the home view drives its launching state from the promise plus the
 * live download progress of any files the pre-launch check had to fetch.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL) — see /THIRD_PARTY_NOTICES.md.
 */
import { EVENTS } from '@shared/ipc'
import type { CrashAnalysis, GameExitInfo, GameLogLine, GameProcessInfo, LaunchPlan, LaunchRequest } from '@shared/types'
import { api, call, plain } from './core'

/** Resolves once the JVM is up; rejects with `ApiError` when the pre-launch check fails. */
export function launchGame(request: LaunchRequest): Promise<GameProcessInfo> {
  return call(api().game.launch(plain(request)))
}

export function runningGames(): Promise<GameProcessInfo[]> {
  return call(api().game.running())
}

export function killGame(instanceId: string): Promise<boolean> {
  return call(api().game.kill(instanceId))
}

/** Full argv the instance would start with — upstream only showed this in its own page. */
export function previewLaunch(instanceId: string): Promise<LaunchPlan> {
  return call(api().game.preview(instanceId))
}

export function gameLogs(instanceId: string, lines = 200): Promise<GameLogLine[]> {
  return call(api().game.logs(instanceId, lines))
}

/** Text -> root cause, used when a launch fails so the toast says something useful. */
export function analyzeCrash(text: string): Promise<CrashAnalysis> {
  return call(api().game.analyze(plain(text)))
}

export function crashReports(instanceId: string): Promise<CrashAnalysis[]> {
  return call(api().game.scanCrashReports(instanceId))
}

/** Reveal a crash report / log file in the OS file manager. */
export function openPath(target: string): Promise<boolean> {
  return call(api().app.openPath(target))
}

/** Streamed game output (`mouc:log`). */
export function onGameLog(handler: (line: GameLogLine) => void): () => void {
  return api().on(EVENTS.log, (payload) => handler(payload as GameLogLine))
}

export function onGameExit(handler: (exit: GameExitInfo) => void): () => void {
  return api().on(EVENTS.gameExit, (payload) => handler(payload as GameExitInfo))
}

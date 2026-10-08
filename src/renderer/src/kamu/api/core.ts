/**
 * Shared plumbing for the ported KAMUCL renderer layer.
 *
 * The upstream code calls a flat, typed `api.ts` whose functions return plain values
 * and reject on failure. MoucX's main process exposes a namespaced `window.mouc`
 * whose every method resolves to `Result<T>`. This module is the translation layer, so
 * ported views keep upstream call shapes instead of being rewritten.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT for its own
 * contributions — see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import type { AppErrorPayload, Result } from '@shared/types'

/** Upstream views expect a rejection, not a `{ok:false}` envelope. */
export class ApiError extends Error {
  readonly payload: AppErrorPayload
  constructor(payload: AppErrorPayload) {
    super(payload.detail ? `${payload.message} — ${payload.detail}` : payload.message)
    this.name = 'ApiError'
    this.payload = payload
  }
}

/**
 * Electron's structured clone refuses Vue reactive proxies ("An object could not be
 * cloned"), which upstream also hit; every argument leaving the renderer is sanitised.
 */
export function plain<T>(value: T): T {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

/** Unwrap a `Result`, throwing the upstream-shaped rejection on failure. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data
  throw new ApiError(result.error)
}

export async function call<T>(promise: Promise<Result<T>>): Promise<T> {
  return unwrap(await promise)
}

/** Best-effort variant for non-critical reads that may legitimately be unavailable. */
export async function maybe<T>(promise: Promise<Result<T>>, fallback: T): Promise<T> {
  const result = await promise
  return result.ok ? result.data : fallback
}

export function api(): Window['mouc'] {
  const bridge = window.mouc
  if (!bridge) throw new ApiError({ code: 'internal', message: '渲染桥接未注入', retryable: false })
  return bridge
}

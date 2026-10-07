import type { AppErrorPayload, ErrorCode, Result } from './types'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: string
  readonly retryable: boolean
  readonly status?: number

  constructor(code: ErrorCode, message: string, detail?: string, retryable = false, status?: number) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
    this.retryable = retryable
    this.status = status
  }

  toPayload(): AppErrorPayload {
    const p: AppErrorPayload = { code: this.code, message: this.message, retryable: this.retryable }
    if (this.detail !== undefined) p.detail = this.detail
    if (this.status !== undefined) p.status = this.status
    return p
  }

  static from(error: unknown, fallback: ErrorCode = 'internal'): AppError {
    if (error instanceof AppError) return error
    if (error instanceof Error) {
      const code = guessCode(error)
      return new AppError(code, error.message, undefined, code === 'network')
    }
    return new AppError(fallback, String(error))
  }
}

function guessCode(error: Error): ErrorCode {
  const name = error.name.toLowerCase()
  const msg = error.message.toLowerCase()
  if (name.includes('aborterror') || msg.includes('aborted')) return 'cancelled'
  if (name.includes('typeerror') && msg.includes('fetch')) return 'network'
  if (msg.includes('econn') || msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('proxy')) {
    return 'network'
  }
  if (msg.includes('enoent') || msg.includes('eacces') || msg.includes('eperm')) return 'disk'
  return 'internal'
}

export function networkError(message: string, detail?: string): AppError {
  return new AppError('network', message, detail, true)
}

export function httpStatusError(status: number, url: string): AppError {
  const retryable = status === 408 || status === 429 || status >= 500
  return new AppError('http-status', `请求失败 (HTTP ${status})`, url, retryable, status)
}

export function notFound(what: string, detail?: string): AppError {
  return new AppError('not-found', `${what}不存在`, detail)
}

export function invalidInput(message: string, detail?: string): AppError {
  return new AppError('invalid-input', message, detail)
}

export function cancelled(what = '任务'): AppError {
  return new AppError('cancelled', `${what}已取消`)
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail<T = never>(error: unknown): Result<T> {
  const e = AppError.from(error)
  return { ok: false, error: e.toPayload() }
}

/** Wraps an async handler so every IPC call returns a Result instead of rejecting. */
export async function intoResult<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (error) {
    return fail<T>(error)
  }
}

export function payloadOf(error: unknown): AppErrorPayload {
  return AppError.from(error).toPayload()
}

export function describe(payload: AppErrorPayload | undefined): string {
  if (!payload) return ''
  return payload.detail ? `${payload.message} — ${payload.detail}` : payload.message
}

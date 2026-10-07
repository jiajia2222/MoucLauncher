/**
 * Formatting helpers for the renderer.
 *
 * Deliberately local copies of the main-process formatters: `src/shared/utils.ts`
 * imports `node:path`, which the renderer bundle must never pull in. The output
 * strings match those helpers byte for byte so both sides agree.
 */
import { t } from '../i18n'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(digits)} ${UNITS[unit]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond, 1)}/s`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--'
  return formatDuration(seconds * 1000)
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return clamp(Math.round((done / total) * 1000) / 10, 0, 100)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`
}

export function formatDate(ts: number | string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Locale-aware "刚刚 / 3 天前" stamp for meta rows. */
export function formatRelative(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return t('time.never')
  const diff = now - ts
  if (diff < 0) return formatDate(ts)
  const second = 1_000
  const minute = 60 * second
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < 45 * second) return t('time.justNow')
  if (diff < hour) return t('time.minutesAgo', { n: Math.max(1, Math.round(diff / minute)) })
  if (diff < day) return t('time.hoursAgo', { n: Math.max(1, Math.round(diff / hour)) })
  if (diff < 30 * day) return t('time.daysAgo', { n: Math.max(1, Math.round(diff / day)) })
  return formatDate(ts)
}

/** Thousands separator for download counters. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function truncateMiddle(text: string, max = 48): string {
  if (text.length <= max) return text
  const side = Math.floor((max - 1) / 2)
  return `${text.slice(0, side)}…${text.slice(-side)}`
}

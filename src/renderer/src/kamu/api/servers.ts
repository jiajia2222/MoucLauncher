/**
 * Server-list adapter for the ported KAMUCL servers page.
 *
 * Upstream calls a flat `api.ts` whose functions return plain values and reject on
 * failure (`listServers()`, `pingServer(address)`, …). MoucLauncher stores servers per
 * instance behind `window.mouc.server.*`, where every method resolves a `Result<T>`.
 * These wrappers keep the upstream call shapes so the ported view stays recognisable:
 * they unwrap the envelope through `call()` and sanitise arguments with `plain()`
 * before they cross IPC (Electron cannot structured-clone Vue reactive proxies).
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT for its own
 * contributions — see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import type { GameProcessInfo, ServerEntry, ServerPingResult } from '@shared/types'
import { api, call, plain } from './core'

/** Minecraft's default Java server port. */
export const DEFAULT_PORT = 25565

/** Turns a rejection (including `ApiError`) into short text fit for a toast. */
export function errText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') || '未知错误'
}

/**
 * `host`, `host:port` or a bare `host` → the pair the backend wants. The port is only
 * reported when the user actually typed one, so an edited row cannot lose its stored
 * port by re-saving an address written without one.
 */
export function splitAddress(address: string): { host: string; port?: number } {
  const trimmed = address.trim()
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return { host: trimmed }
  const head = trimmed.slice(0, separator)
  const tail = Number(trimmed.slice(separator + 1))
  const usable = !head.includes(':') && !head.includes(' ') && Number.isInteger(tail) && tail > 0 && tail <= 65_535
  return usable ? { host: head, port: tail } : { host: trimmed }
}

/** Port this entry is reached at, whichever of the two places it was written in. */
export function resolvePort(entry: Pick<ServerEntry, 'address' | 'port'>): number {
  return entry.port ?? splitAddress(entry.address).port ?? DEFAULT_PORT
}

/** Canonical `host:port` label for rows and detail panels. */
export function formatAddress(entry: Pick<ServerEntry, 'address' | 'port'>): string {
  return `${splitAddress(entry.address).host}:${resolvePort(entry)}`
}

/** Servers of one instance; `hidden` rows are LAN scratch entries and stay out. */
export async function listServers(instanceId: string): Promise<ServerEntry[]> {
  const list = await call(api().server.list(instanceId))
  return list.filter((entry) => !entry.hidden)
}

/**
 * Create or update a row. An empty `id` lets the backend mint one, so callers must
 * re-read the list afterwards instead of trusting the returned identifier.
 */
export async function saveServer(instanceId: string, entry: ServerEntry): Promise<ServerEntry> {
  const { host, port } = splitAddress(entry.address)
  return call(
    api().server.save(
      instanceId,
      plain({
        ...entry,
        name: entry.name.trim(),
        address: host,
        port: port ?? entry.port ?? DEFAULT_PORT
      })
    )
  )
}

export async function removeServer(instanceId: string, id: string): Promise<boolean> {
  return call(api().server.remove(instanceId, id))
}

/** SLP status of one address; an unreachable server rejects, the caller shows it offline. */
export async function pingServer(address: string, port?: number): Promise<ServerPingResult> {
  const { host, port: inline } = splitAddress(address)
  return call(api().server.ping(host, port ?? inline ?? DEFAULT_PORT))
}

/** Launch the selected instance straight into this server. */
export async function joinServer(instanceId: string, entry: ServerEntry): Promise<GameProcessInfo> {
  return call(api().server.join(instanceId, plain(entry)))
}

/** Clipboard write with the legacy `execCommand` fallback, like upstream's helper. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const copied = document.execCommand('copy')
      area.remove()
      return copied
    } catch {
      return false
    }
  }
}

/**
 * LAN discovery + cross-network relay room adapter for the ported servers page.
 *
 * Upstream drives these panels from P2P hole punching (VoxLink), FRP tunnels and the
 * Terracotta engine. MoucX has one mechanism instead: a relay server that
 * forwards a local game port for a room (`window.mouc.server.relay*`), plus vanilla
 * LAN broadcast discovery (`server.lanScan` + the `mouc:lan-game` push channel).
 * Both are push/state streams, so the subscriptions return their unsubscribe handle.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT for its own
 * contributions — see /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt.
 */
import { EVENTS } from '@shared/ipc'
import type { InstanceSummary, LanGame, RelayStatus } from '@shared/types'
import { api, call, plain } from './core'

/** A LAN broadcast nobody re-announced within this window is dropped from the list. */
export const LAN_TTL_MS = 60_000

/** Instances are read-only here: the instances domain owns their lifecycle. */
export async function listInstances(): Promise<InstanceSummary[]> {
  const list = await call(api().instance.list())
  return [...list].sort((a, b) => Number(!!b.instance.quickAccess) - Number(!!a.instance.quickAccess) || a.instance.name.localeCompare(b.instance.name))
}

/** Instance label used by the selector and the room panel: `名字 · 1.21.1 · fabric`. */
export function instanceLabel(summary: InstanceSummary): string {
  const { name, gameVersion, loader, loaderVersion, isolated } = summary.instance
  const loaderText = loader && loader !== 'vanilla' ? ` · ${loader}${loaderVersion ? ` ${loaderVersion}` : ''}` : ''
  return `${name} · ${gameVersion}${loaderText}${isolated ? '（隔离）' : ''}`
}

export async function lanScan(instanceId?: string): Promise<boolean> {
  return call(api().server.lanScan(instanceId))
}

export async function lanStop(): Promise<boolean> {
  return call(api().server.lanStop())
}

/** Subscribe to LAN broadcasts; returns the unsubscribe function. */
export function onLanGame(handler: (game: LanGame) => void): () => void {
  return api().on(EVENTS.lan, (payload) => handler(payload as LanGame))
}

/** LAN MOTDs carry legacy section codes (`§7`); strip them before rendering. */
export function plainMotd(text: string): string {
  return text.replace(/§[0-9a-fk-orx]/gi, '').trim()
}

/** Join address of a broadcast: the UDP source is authoritative, not the hostname. */
export function lanAddress(game: LanGame): string {
  return `${game.address || game.from}:${game.port}`
}

export function isLanFresh(game: LanGame, now: number): boolean {
  return now - game.seenAt < LAN_TTL_MS
}

export async function relayStatus(): Promise<RelayStatus> {
  return call(api().server.relayStatus())
}

/** Open a room for the local game port; the relay assigns the room code when omitted. */
export async function relayHost(targetPort: number, room?: string, password?: string): Promise<RelayStatus> {
  return call(api().server.relayHost(plain({ targetPort, room: room?.trim() || undefined, password: password || undefined })))
}

export async function relayJoin(room: string, password?: string): Promise<RelayStatus> {
  return call(api().server.relayJoin(room.trim(), password || undefined))
}

export async function relayStop(): Promise<RelayStatus> {
  return call(api().server.relayStop())
}

/** Subscribe to relay transitions; returns the unsubscribe function. */
export function onRelayStatus(handler: (status: RelayStatus) => void): () => void {
  return api().on(EVENTS.relay, (payload) => handler(payload as RelayStatus))
}

/** Where the relay endpoint is configured; empty means the room panel cannot run. */
export async function getRelayEndpoint(): Promise<string> {
  const settings = await call(api().settings.get())
  return settings.relayServerUrl.trim()
}

export async function saveRelayEndpoint(url: string): Promise<string> {
  const settings = await call(api().settings.set(plain({ relayServerUrl: url.trim() })))
  return settings.relayServerUrl.trim()
}

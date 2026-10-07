/**
 * Container-facing factories for the multiplayer subsystem.
 *
 * `src/main/core/contracts.ts` declares the interfaces; these are the plain
 * functions the container calls to fill `Container.servers` and
 * `Container.relay`. Nothing here imports Electron, so all of it is testable
 * with a temp directory and an in-process fake transport.
 */

import type { LanGame, RelayStatus, ServerEntry, ServerPingResult } from '@shared/types'
import type { RelayService, ServerService } from '../core/contracts'
import { pingHost } from './serverPing'
import { ServersDat } from './serversDat'
import { createLanScanner, type LanLogger, type LanScanner } from './lanScanner'
import { createRelayClient, type RelayClient, type RelayClientDeps } from './relay/client'

export interface ServerServiceDeps {
  log: LanLogger
  /**
   * Where a instance's `servers.dat` lives: the game root for a shared instance,
   * `instances/<id>` for an isolated one. The container resolves that (it owns
   * `InstanceStore` + `paths()`), we only ask for the directory.
   */
  gameDirOf(instanceId: string): string | Promise<string>
  /** Milliseconds before a status ping is reported as timed out. */
  pingTimeoutMs?: number
}

export interface OnlineServerService extends ServerService {
  /** The live LAN scanner, once `startLanScan` has run at least once. */
  lanScanner(): LanScanner | undefined
  dispose(): Promise<void>
}

export interface OnlineRelayService extends RelayService {
  client: RelayClient
  dispose(): Promise<void>
}

export function createServerService(deps: ServerServiceDeps): OnlineServerService {
  let scanner: LanScanner | undefined
  const unsubscribers: Array<() => void> = []

  const store = async (instanceId: string): Promise<ServersDat> => {
    const gameDir = await deps.gameDirOf(instanceId)
    return new ServersDat(gameDir)
  }

  const ensureScanner = async (): Promise<LanScanner> => {
    if (scanner) return scanner
    scanner = createLanScanner({ log: deps.log })
    await scanner.start()
    return scanner
  }

  const stopLanScan = async (): Promise<void> => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    if (!scanner) return
    const closing = scanner
    scanner = undefined
    await closing.stop()
  }

  return {
    async list(instanceId: string): Promise<ServerEntry[]> {
      return (await store(instanceId)).list()
    },

    async save(instanceId: string, entry: ServerEntry): Promise<ServerEntry> {
      return (await store(instanceId)).save(entry)
    },

    async remove(instanceId: string, id: string): Promise<void> {
      await (await store(instanceId)).remove(id)
    },

    async ping(address: string, port?: number): Promise<ServerPingResult> {
      return pingHost(address, port, deps.pingTimeoutMs ? { timeoutMs: deps.pingTimeoutMs } : {})
    },

    async startLanScan(handler: (game: LanGame) => void): Promise<void> {
      const active = await ensureScanner()
      unsubscribers.push(
        active.subscribe((game, kind) => {
          if (kind === 'seen') handler(game)
        })
      )
    },

    stopLanScan,

    lanScanner(): LanScanner | undefined {
      return scanner
    },

    async dispose(): Promise<void> {
      await stopLanScan()
    }
  }
}

/**
 * `Container.relay`. `deps.settings` is the container's `SettingsStore`
 * (structurally `{ get(): Settings }`) and `deps.onStatus` is usually
 * `emitRelay` from `src/main/core/bus.ts`.
 */
export function createRelayService(deps: RelayClientDeps): OnlineRelayService {
  const client = createRelayClient(deps)
  const handlers = new Set<(status: RelayStatus) => void>()
  const unsubscribeClient = client.subscribe((status) => {
    for (const handler of handlers) {
      try {
        handler(status)
      } catch (error) {
        deps.log.warn(`中继状态回调异常: ${String(error)}`)
      }
    }
  })

  return {
    client,
    status(): RelayStatus {
      return client.status()
    },
    async host(targetPort: number, room?: string, password?: string): Promise<RelayStatus> {
      return client.host(targetPort, room, password)
    },
    async join(room: string, password?: string): Promise<RelayStatus> {
      return client.join(room, password)
    },
    async stop(): Promise<RelayStatus> {
      return client.stop()
    },
    subscribe(handler: (status: RelayStatus) => void): () => void {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async dispose(): Promise<void> {
      unsubscribeClient()
      handlers.clear()
      await client.dispose()
    }
  }
}

/** One call wires both halves of the multiplayer subsystem. */
export function createOnlineServices(deps: {
  log: LanLogger
  settings: { get(): import('@shared/types').Settings }
  gameDirOf(instanceId: string): string | Promise<string>
  onRelayStatus?: (status: RelayStatus) => void
}): { servers: OnlineServerService; relay: OnlineRelayService; dispose: () => Promise<void> } {
  const servers = createServerService({ log: deps.log, gameDirOf: deps.gameDirOf })
  const relay = createRelayService({
    settings: deps.settings,
    log: deps.log,
    ...(deps.onRelayStatus ? { onStatus: deps.onRelayStatus } : {})
  })
  return {
    servers,
    relay,
    dispose: async (): Promise<void> => {
      await servers.dispose()
      await relay.dispose()
    }
  }
}

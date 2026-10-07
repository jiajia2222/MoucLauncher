/**
 * LAN world discovery: the UDP multicast a Minecraft Java client/server emits
 * when a world is published ("Open to LAN") or when `publish` is enabled.
 *
 * Verified 2026-10-07 against these public sources (constants and packet text
 * are the only things taken; the parser is written from scratch):
 * - FabricMC/yarn mapping javadoc for `net/minecraft/client/network/LanServerPinger`
 *   ("These multicasts will always be sent to {@code 224.0.2.60:4445}", and the
 *   `createAnnouncement` example `[MOTD]A Player's Server[/MOTD][AD]192.168.0.33[/AD]`)
 *   https://github.com/FabricMC/yarn/blob/1.21.11/mappings/net/minecraft/client/network/LanServerPinger.mapping
 * - MinecraftForge's patch of `net/minecraft/client/server/LanServerDetection.java`
 *   (`new MulticastSocket(4445)`, `InetAddress.getByName("224.0.2.60")`,
 *   `joinGroup`, and the join address = UDP source address + parsed port)
 *   https://github.com/MinecraftForge/MinecraftForge/blob/26.3/patches/minecraft/net/minecraft/client/server/LanServerDetection.java.patch
 * - Obsidian `LanBroadcasterService.cs` (third-party broadcaster of the same
 *   packets: `224.0.2.60:4445`, UTF-8 `[MOTD]<motd>[/MOTD][AD]<port>[/AD]`,
 *   every 1.5 s, `[`/`]` inside the MOTD escaped to `(`/`)`)
 *   https://github.com/ObsidianMC/Obsidian/blob/1.21.x/Obsidian/Services/LanBroadcasterService.cs
 * - Arch Linux "Minecraft" page: "UDP port 4445 to broadcast your game"
 *   https://wiki.archlinux.org/title/Minecraft
 * - PCL-CE `BroadcastListener.cs` (dual-stack listener; IPv6 group
 *   `ff75:230::60` on the same port) — the IPv6 group is ONLY sourced here and
 *   is therefore best-effort, see docs/lan.md.
 *   https://github.com/PCL-Community/PCL-CE/blob/dev/PCL.Core/Link/BroadcastListener.cs
 *
 * The pre-1.x space-separated `[MOTD:…] [ip:…] [port:…] [gamemode:…]` text and
 * the raw-NBT announcement could not be confirmed against a primary source; they
 * are parsed as tolerant fallbacks and flagged in docs/lan.md.
 *
 * NOTE: `DEFAULT_SETTINGS_CONST.mcLanPort` in `src/shared/constants.ts` is 49550,
 * which does not match the verified 4445; the constant is frozen, so this module
 * uses its own {@link LAN_MULTICAST_PORT}.
 */

import dgram from 'node:dgram'
import { AppError } from '@shared/errors'
import { parseServerAddress } from '@shared/utils'
import type { LanGame } from '@shared/types'
import { asCompound, asString, isCompound, looksLikeNbt, lookup, num, read, type NbtCompound } from './nbt'

export const LAN_MULTICAST_GROUP = '224.0.2.60'
/** Reported by PCL-CE only; unverified against Mojang, so it is optional. */
export const LAN_MULTICAST_GROUP_V6 = 'ff75:230::60'
export const LAN_MULTICAST_PORT = 4445
/** Hosts re-announce on this cadence; anything older than the TTL is dropped. */
export const LAN_ANNOUNCE_INTERVAL_MS = 1500
export const LAN_ENTRY_TTL_MS = 60_000
export const LAN_ANNOUNCE_MARKER = {
  motdOpen: '[MOTD]',
  motdClose: '[/MOTD]',
  addressOpen: '[AD]',
  addressClose: '[/AD]'
} as const

const MAX_TRACKED = 200
const MAX_PACKET_BYTES = 4096

export interface LanLogger {
  debug?(text: string): void
  info(text: string): void
  warn(text: string): void
  error(text: string, error?: unknown): void
}

/** A parsed announcement; `address` is absent when the packet only carried a port. */
export interface LanAnnouncement {
  motd: string
  port: number
  address?: string
  gameMode?: string
  versionName?: string
  protocol?: number
  serverProperties?: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* Pure parsing                                                        */
/* ------------------------------------------------------------------ */

/** `[MOTD]<text>[/MOTD]` — the shape Mojang and Obsidian actually broadcast. */
const MODERN_MOTD = /\[MOTD]([\s\S]*?)\[\/MOTD]/
const MODERN_MOTD_COLON = /\[MOTD:([^\]]*)\]\[\/MOTD]/
const MODERN_ADDRESS = /\[AD]([\s\S]*?)\[\/AD]/
const MODERN_ADDRESS_COLON = /\[AD:([^\]]*)\]\[\/AD]/
const LEGACY_MOTD = /\[MOTD:([^\]]*)]/
const LEGACY_IP = /\[ip:([^\]]*)]/
const LEGACY_PORT = /\[port:(\d{1,5})]/
const LEGACY_GAMEMODE = /\[gamemode:([^\]]*)]/

function capture(text: string, ...patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return (match[1] ?? '').trim()
  }
  return undefined
}

/** `[AD]` carries either a bare port or `host:port` (also `[v6]:port`). */
export function parseAddressPort(value: string): { address?: string; port?: number } {
  const trimmed = value.trim()
  if (trimmed.length === 0) return {}
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed)
    return port >= 1 && port <= 65535 ? { port } : {}
  }
  // An address form is only accepted when it spells its port out; otherwise we
  // would silently invent 25565 for a malformed packet.
  const explicitPort = /\]\:\d{1,5}$/.test(trimmed) || /[^:]:\d{1,5}$/.test(trimmed)
  if (!explicitPort) return {}
  const parsed = parseServerAddress(trimmed)
  if (!parsed) return {}
  return { address: parsed.host, port: parsed.port }
}

/** Text announcement: modern `[MOTD]…[/MOTD][AD]…[/AD]` or legacy key:value form. */
export function parseAnnouncementText(text: string): LanAnnouncement | undefined {
  const modernMotd = capture(text, MODERN_MOTD, MODERN_MOTD_COLON)
  const modernAddress = capture(text, MODERN_ADDRESS, MODERN_ADDRESS_COLON)
  if (modernMotd !== undefined || modernAddress !== undefined) {
    const target = parseAddressPort(modernAddress ?? '')
    if (target.port === undefined) return undefined
    return { motd: modernMotd ?? '', port: target.port, ...(target.address ? { address: target.address } : {}) }
  }

  // Legacy: `[MOTD:…] [ip:…] [port:…] [gamemode:…]`. `ip` and `gamemode` are
  // optional because older builds omitted them; `port` is required.
  const legacyPort = capture(text, LEGACY_PORT)
  const legacyMotd = capture(text, LEGACY_MOTD)
  if (legacyPort === undefined || legacyMotd === undefined) return undefined
  const port = Number(legacyPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  const ip = capture(text, LEGACY_IP)
  const gameMode = capture(text, LEGACY_GAMEMODE)
  const out: LanAnnouncement = { motd: legacyMotd, port }
  if (ip) {
    const parsed = parseServerAddress(ip)
    if (parsed) out.address = parsed.host
  }
  if (gameMode) out.gameMode = gameMode
  return out
}

function nbtStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

/** Pre-1.3 style NBT announcement: a compound with MOTD / Address / Port / Version. */
export function parseAnnouncementNbt(buffer: Buffer): LanAnnouncement | undefined {
  let root: NbtCompound
  try {
    const node = read(buffer)
    if (!isCompound(node.value)) return undefined
    root = node.value
  } catch {
    return undefined
  }
  const motd = asString(lookup(root, 'MOTD', 'motd')) ?? ''
  const port = num(lookup(root, 'Port', 'port'))
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  const out: LanAnnouncement = { motd, port }
  const address = asString(lookup(root, 'Address', 'address', 'ip'))
  if (address) out.address = address
  const gameMode = asString(lookup(root, 'GameMode', 'gameMode', 'gamemode'))
  if (gameMode) out.gameMode = gameMode

  const version = asCompound(lookup(root, 'Version', 'version'))
  if (version) {
    const name = asString(lookup(version, 'Name', 'name')) ?? asString(lookup(version, 'Brand', 'brand'))
    if (name) out.versionName = name
    const protocol = num(lookup(version, 'Protocol', 'protocol'))
    if (protocol !== undefined) out.protocol = protocol
  }
  const players = asCompound(lookup(root, 'Players', 'players'))
  const properties: Record<string, string> = {}
  if (players) {
    const online = num(lookup(players, 'Online', 'online'))
    const max = num(lookup(players, 'Max', 'max'))
    if (online !== undefined) properties.playersOnline = String(online)
    if (max !== undefined) properties.playersMax = String(max)
  }
  const mods = nbtStringList(lookup(root, 'Mods', 'mods'))
  if (mods.length > 0) properties.mods = mods.join(',')
  if (Object.keys(properties).length > 0) out.serverProperties = properties
  return out
}

/**
 * Decodes one UDP datagram. `from` is the UDP source address, which is the
 * address a vanilla client joins through, so it always beats an embedded `ip`.
 */
export function parseLanPacket(data: Buffer, from: string, now = Date.now()): LanGame | undefined {
  if (data.length === 0 || data.length > MAX_PACKET_BYTES) return undefined
  const announcement = looksLikeNbt(data)
    ? parseAnnouncementNbt(data) ?? parseAnnouncementText(data.toString('utf8'))
    : parseAnnouncementText(data.toString('utf8'))
  if (!announcement) return undefined
  return gameFromAnnouncement(announcement, from, now)
}

export function gameFromAnnouncement(announcement: LanAnnouncement, from: string, now = Date.now()): LanGame {
  const game: LanGame = {
    motd: announcement.motd,
    // The embedded address is frequently the broadcaster's own (possibly stale or
    // IPv6) address; the UDP source is what vanilla itself joins.
    address: announcement.address ?? from,
    port: announcement.port,
    versionName: announcement.versionName ?? '',
    protocol: announcement.protocol ?? 0,
    from,
    seenAt: now
  }
  if (announcement.gameMode) game.gameMode = announcement.gameMode
  if (announcement.serverProperties) game.serverProperties = announcement.serverProperties
  return game
}

/** Where to connect to actually play in this LAN world. */
export function lanJoinTarget(game: LanGame): { host: string; port: number } {
  return { host: game.from, port: game.port }
}

export function lanDedupeKey(game: LanGame): string {
  return `${game.from}:${game.port}`
}

/* ------------------------------------------------------------------ */
/* Socket plumbing                                                     */
/* ------------------------------------------------------------------ */

export interface LanScanOptions {
  log?: LanLogger
  /** Multicast group to join; `''` skips membership and only listens. */
  group?: string
  groupV6?: string
  /** `0` asks the OS for an ephemeral port (tests); production wants 4445. */
  port?: number
  bindAddress?: string
  listenV6?: boolean
  expireMs?: number
  sweepMs?: number
  now?: () => number
  onGame?: (game: LanGame) => void
  onExpire?: (game: LanGame) => void
}

export interface LanScanner {
  start(): Promise<void>
  stop(): Promise<void>
  games(): LanGame[]
  subscribe(handler: (game: LanGame, kind: 'seen' | 'expired') => void): () => void
  boundPorts(): { v4: number; v6: number }
  joinTarget(game: LanGame): { host: string; port: number }
  /** Feeds one datagram; also usable for announcements relayed over TCP. */
  handlePacket(data: Buffer, from: string): LanGame | undefined
  running(): boolean
}

type SocketKind = 'v4' | 'v6'

export function createLanScanner(options: LanScanOptions = {}): LanScanner {
  const log = options.log
  const now = options.now ?? Date.now
  const port = options.port ?? LAN_MULTICAST_PORT
  const group = options.group ?? LAN_MULTICAST_GROUP
  const expireMs = options.expireMs ?? LAN_ENTRY_TTL_MS
  const sweepMs = options.sweepMs ?? Math.max(1000, Math.floor(expireMs / 4))
  const entries = new Map<string, LanGame>()
  const handlers = new Set<(game: LanGame, kind: 'seen' | 'expired') => void>()
  const sockets: { socket: dgram.Socket; kind: SocketKind }[] = []
  const bound: Record<SocketKind, number> = { v4: 0, v6: 0 }
  let sweep: NodeJS.Timeout | undefined
  let started = false

  const emit = (game: LanGame, kind: 'seen' | 'expired'): void => {
    for (const handler of handlers) {
      try {
        handler(game, kind)
      } catch (error) {
        log?.warn(`LAN 订阅回调异常: ${String(error)}`)
      }
    }
    if (kind === 'seen') options.onGame?.(game)
    else options.onExpire?.(game)
  }

  const ingest = (game: LanGame): LanGame | undefined => {
    const key = lanDedupeKey(game)
    const previous = entries.get(key)
    if (previous) {
      const changed = previous.motd !== game.motd || previous.gameMode !== game.gameMode
      entries.set(key, game)
      if (changed) emit(game, 'seen')
      return undefined
    }
    if (entries.size >= MAX_TRACKED) {
      // Drop the oldest announcement instead of growing without a bound.
      const oldest = [...entries.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0]
      if (oldest) entries.delete(oldest[0])
    }
    entries.set(key, game)
    emit(game, 'seen')
    return game
  }

  const handlePacket = (data: Buffer, from: string): LanGame | undefined => {
    const game = parseLanPacket(data, from, now())
    if (!game) return undefined
    return ingest(game)
  }

  const expire = (): void => {
    const cutoff = now() - expireMs
    for (const [key, game] of [...entries.entries()]) {
      if (game.seenAt <= cutoff) {
        entries.delete(key)
        emit(game, 'expired')
      }
    }
  }

  const bindOne = (kind: SocketKind): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket({ type: kind === 'v4' ? 'udp4' : 'udp6', reuseAddr: true })
      sockets.push({ socket, kind })

      socket.on('message', (data: Buffer, rinfo: dgram.RemoteInfo) => {
        handlePacket(data, rinfo.address)
      })
      socket.on('error', (error: Error) => {
        // Windows raises WSAEACCES/EADDRINUSE when another listener owns 4445.
        log?.warn(`LAN 监听套接字错误(${kind}): ${error.message}`)
      })

      const finish = (): void => {
        bound[kind] = socket.address().port
        try {
          socket.setBroadcast(true)
        } catch (error) {
          log?.debug?.(`setBroadcast 失败(${kind}): ${String(error)}`)
        }
        if (group.length > 0) {
          const membership = kind === 'v4' ? group : (options.groupV6 ?? LAN_MULTICAST_GROUP_V6)
          try {
            socket.addMembership(membership, options.bindAddress)
          } catch (error) {
            // No multicast route (VPN / adapter without one) is not fatal: the
            // broadcast listener still works on the local subnet.
            log?.warn(`加入组播组 ${membership} 失败(${kind}): ${String((error as Error).message ?? error)}`)
          }
        }
        resolve()
      }

      try {
        socket.bind(
          { port, address: kind === 'v4' ? (options.bindAddress ?? '0.0.0.0') : '::', exclusive: false },
          finish
        )
      } catch (error) {
        reject(AppError.from(error, 'network'))
      }
    })

  const stop = async (): Promise<void> => {
    if (sweep) clearInterval(sweep)
    sweep = undefined
    started = false
    for (const { socket } of sockets) {
      await new Promise<void>((done) => {
        try {
          socket.close(() => done())
        } catch {
          done()
        }
      })
    }
    sockets.length = 0
    bound.v4 = 0
    bound.v6 = 0
    entries.clear()
  }

  const start = async (): Promise<void> => {
    if (started) return
    started = true
    try {
      await bindOne('v4')
      if (options.listenV6) {
        await bindOne('v6').catch((error: unknown) => {
          log?.warn(`IPv6 LAN 监听不可用: ${String(error)}`)
        })
      }
    } catch (error) {
      started = false
      await stop()
      throw AppError.from(error, 'network')
    }
    sweep = setInterval(expire, sweepMs)
    sweep.unref()
    log?.info(`局域网联机监听已启动 (${LAN_MULTICAST_GROUP}:${port}, ${expireMs / 1000}s 过期)`)
  }

  return {
    start,
    stop,

    games(): LanGame[] {
      expire()
      return [...entries.values()].sort((a, b) => b.seenAt - a.seenAt)
    },

    subscribe(handler): () => void {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },

    boundPorts(): { v4: number; v6: number } {
      return { ...bound }
    },

    joinTarget(game: LanGame): { host: string; port: number } {
      return lanJoinTarget(game)
    },

    handlePacket,

    running(): boolean {
      return started
    }
  }
}

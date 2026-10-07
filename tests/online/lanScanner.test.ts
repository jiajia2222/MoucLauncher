import { describe, expect, it } from 'vitest'
import dgram from 'node:dgram'
import {
  LAN_ENTRY_TTL_MS,
  LAN_MULTICAST_GROUP,
  LAN_MULTICAST_PORT,
  createLanScanner,
  gameFromAnnouncement,
  lanDedupeKey,
  lanJoinTarget,
  parseAddressPort,
  parseAnnouncementNbt,
  parseAnnouncementText,
  parseLanPacket
} from '../../src/main/online/lanScanner'
import { Tag, nbtList, toGzip, withTags, write, type NbtCompound } from '../../src/main/online/nbt'

/** The format Minecraft publishes today: [MOTD]…[/MOTD][AD]…[/AD], UTF-8. */
const MODERN = '[MOTD]A Player\'s Server[/MOTD][AD]51234[/AD]'
/** Same packet, but the AD field carries the address as well. */
const MODERN_WITH_ADDRESS = '[MOTD]§a局域网世界[/MOTD][AD]192.168.1.20:44444[/AD]'
/** The pre-1.x style text form (unverified against Mojang, see docs/lan.md). */
const LEGACY = '[MOTD:§b我的地图] [ip:192.168.1.9] [port:25567] [gamemode:survival]'

function nbtAnnouncement(): Buffer {
  const version = withTags({ Name: Tag.String, Protocol: Tag.Int }, { Name: '1.20.4', Protocol: 763 })
  const players = withTags({ Online: Tag.Int, Max: Tag.Int }, { Online: 2, Max: 20 })
  const root: NbtCompound = withTags(
    { MOTD: Tag.String, Address: Tag.String, Port: Tag.Short, Version: Tag.Compound, Players: Tag.Compound, GameMode: Tag.String },
    { MOTD: '§6Old School', Address: '192.168.1.42', Port: 4321, Version: version, Players: players, GameMode: 'creative' }
  )
  return write(root, '')
}

describe('lan announcement parsing', () => {
  it('parses the modern [MOTD]…[/MOTD][AD]…[/AD] text', () => {
    const parsed = parseAnnouncementText(MODERN)
    expect(parsed).toEqual({ motd: "A Player's Server", port: 51234 })
    const withAddress = parseAnnouncementText(MODERN_WITH_ADDRESS)
    expect(withAddress).toEqual({ motd: '§a局域网世界', port: 44444, address: '192.168.1.20' })
  })

  it('parses the legacy key:value text form', () => {
    const parsed = parseAnnouncementText(LEGACY)
    expect(parsed).toEqual({ motd: '§b我的地图', port: 25567, address: '192.168.1.9', gameMode: 'survival' })
    // `ip` and `gamemode` are optional in the wild.
    expect(parseAnnouncementText('[MOTD:only] [port:12345]')).toEqual({ motd: 'only', port: 12345 })
  })

  it('refuses anything without a usable port or markers', () => {
    expect(parseAnnouncementText('')).toBeUndefined()
    expect(parseAnnouncementText('hello world')).toBeUndefined()
    expect(parseAnnouncementText('[MOTD]no address[/MOTD]')).toBeUndefined()
    expect(parseAnnouncementText('[MOTD]x[/MOTD][AD]99999999[/AD]')).toBeUndefined()
    expect(parseAnnouncementText('[port:25565]')).toBeUndefined()
    expect(parseAddressPort('')).toEqual({})
    expect(parseAddressPort('[fd00::1]:25565')).toEqual({ address: 'fd00::1', port: 25565 })
  })

  it('parses the NBT form through the codec', () => {
    const bytes = nbtAnnouncement()
    const parsed = parseAnnouncementNbt(bytes)
    expect(parsed?.motd).toBe('§6Old School')
    expect(parsed?.port).toBe(4321)
    expect(parsed?.address).toBe('192.168.1.42')
    expect(parsed?.versionName).toBe('1.20.4')
    expect(parsed?.protocol).toBe(763)
    expect(parsed?.gameMode).toBe('creative')
    expect(parsed?.serverProperties).toEqual({ playersOnline: '2', playersMax: '20' })
    // Compressed announcements are sniffed too.
    expect(parseAnnouncementNbt(toGzip(bytes))?.port).toBe(4321)
    expect(parseAnnouncementNbt(Buffer.from([0x0a, 0x00, 0x00, 0x00]))).toBeUndefined()
  })

  it('builds a LanGame whose join target is the UDP source', () => {
    const game = parseLanPacket(Buffer.from(MODERN, 'utf8'), '10.0.0.7', 1234)
    expect(game).toEqual({
      motd: "A Player's Server",
      address: '10.0.0.7',
      port: 51234,
      versionName: '',
      protocol: 0,
      from: '10.0.0.7',
      seenAt: 1234
    })
    expect(lanJoinTarget(game!)).toEqual({ host: '10.0.0.7', port: 51234 })
    expect(lanDedupeKey(game!)).toBe('10.0.0.7:51234')

    const nbtGame = parseLanPacket(nbtAnnouncement(), '192.168.1.42')
    expect(nbtGame?.versionName).toBe('1.20.4')
    expect(nbtGame?.protocol).toBe(763)
    expect(parseLanPacket(Buffer.alloc(0), '1.2.3.4')).toBeUndefined()
    expect(parseLanPacket(Buffer.from([0x00, 0x01, 0x02]), '1.2.3.4')).toBeUndefined()
  })

  it('documents the verified multicast constants and keeps the interval', () => {
    expect(LAN_MULTICAST_GROUP).toBe('224.0.2.60')
    expect(LAN_MULTICAST_PORT).toBe(4445)
    expect(LAN_ENTRY_TTL_MS).toBe(60_000)
    expect(gameFromAnnouncement({ motd: 'x', port: 1 }, '127.0.0.1', 0)).toMatchObject({ from: '127.0.0.1', seenAt: 0 })
  })

  it('tolerates the colon variant of the modern markers', () => {
    expect(parseAnnouncementText('[MOTD:colon][/MOTD][AD:25566][/AD]')).toEqual({ motd: 'colon', port: 25566 })
    expect(parseLanPacket(write(nbtList([1], Tag.Byte), ''), '1.1.1.1')).toBeUndefined()
  })
})

describe('lan scanner socket plumbing', () => {
  it('receives a datagram, dedupes, expires and stops', async () => {
    let clock = 1_000_000
    const seen: Array<{ game: { motd: string; port: number }; kind: string }> = []
    const scanner = createLanScanner({
      port: 0,
      group: '',
      now: () => clock,
      expireMs: 50,
      sweepMs: 10
    })
    scanner.subscribe((game, kind) => seen.push({ game, kind }))
    await scanner.start()
    expect(scanner.running()).toBe(true)
    const bound = scanner.boundPorts().v4
    expect(bound).toBeGreaterThan(0)

    const sender = dgram.createSocket('udp4')
    const send = (text: string): Promise<void> =>
      new Promise<void>((resolve) => sender.send(Buffer.from(text, 'utf8'), bound, '127.0.0.1', () => resolve()))

    try {
      await send(MODERN)
      await send(LEGACY)
      await send(MODERN) // duplicate from the same source: must not re-announce
      await send('not an announcement')
      await new Promise((resolve) => setTimeout(resolve, 60))

      const games = scanner.games()
      expect(games).toHaveLength(2)
      expect(games.map((game) => game.port).sort()).toEqual([25567, 51234])
      expect(games.find((game) => game.port === 51234)?.from).toBe('127.0.0.1')
      expect(seen.filter((entry) => entry.kind === 'seen')).toHaveLength(2)

      // Same source + port after the TTL: one entry disappears, an expiry fires.
      clock += LAN_ENTRY_TTL_MS + 1
      expect(scanner.games()).toHaveLength(0)
      expect(seen.some((entry) => entry.kind === 'expired')).toBe(true)

      await send(MODERN_WITH_ADDRESS)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const revived = scanner.games()
      expect(revived[0]?.address).toBe('192.168.1.20')
      expect(scanner.joinTarget(revived[0]!)).toEqual({ host: '127.0.0.1', port: 44444 })
    } finally {
      await new Promise<void>((resolve) => sender.close(() => resolve()))
      await scanner.stop()
    }
    expect(scanner.running()).toBe(false)
    expect(scanner.games()).toEqual([])
    await scanner.stop() // idempotent
  })

  it('accepts a packet handed over by another transport', () => {
    const scanner = createLanScanner({ port: 0, group: '' })
    const game = scanner.handlePacket(Buffer.from(LEGACY, 'utf8'), '192.168.5.5')
    expect(game?.port).toBe(25567)
    expect(scanner.handlePacket(Buffer.from('junk'), '192.168.5.5')).toBeUndefined()
    expect(scanner.games()).toHaveLength(1)
  })
})

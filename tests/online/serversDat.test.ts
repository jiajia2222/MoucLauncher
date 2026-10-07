import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ServerEntry } from '@shared/types'
import { AppError } from '@shared/errors'
import {
  ServersDat,
  listServerEntries,
  loadServersDat,
  parseServersDat,
  saveServersDat,
  serialiseServersDat,
  serversDatPath
} from '../../src/main/online/serversDat'
import { Tag, childTag, nbtList, read, toGzip, withTags, write, type NbtCompound } from '../../src/main/online/nbt'

const SERVER_TAGS = {
  name: Tag.String,
  ip: Tag.String,
  id: Tag.String,
  acceptTextures: Tag.Byte,
  hidden: Tag.Byte,
  icon: Tag.String,
  iconBytes: Tag.ByteArray,
  magic: Tag.Short,
  magicHigh: Tag.Int,
  flavor: Tag.String,
  seatCount: Tag.Long
} as const

/** A file written by "someone else": known fields plus keys we have never heard of. */
function fixtureRoot(): NbtCompound {
  const servers = [
    withTags(SERVER_TAGS, {
      name: '局域网世界',
      ip: '192.168.1.20:51234',
      id: 'aaaa',
      acceptTextures: 1,
      hidden: 0,
      icon: 'iVBORw0KGgo=',
      magic: 42,
      flavor: 'keep me'
    }),
    withTags(SERVER_TAGS, {
      name: 'Hypixel',
      ip: 'mc.hypixel.net',
      id: 'bbbb',
      acceptTextures: 0,
      hidden: 1,
      iconBytes: Buffer.from([1, 2, 3]),
      magicHigh: 70000,
      flavor: 'vanilla wrote this',
      seatCount: 9007199254740993n
    })
  ]
  return withTags({ servers: Tag.List, version: Tag.Int }, { servers: nbtList(servers, Tag.Compound), version: 27 })
}

function fixtureBytes(): Buffer {
  return write(fixtureRoot(), '')
}

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mouc-servers-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('serversDat', () => {
  it('reads the known fields, including a port inside ip', async () => {
    await fs.writeFile(serversDatPath(dir), fixtureBytes())
    const entries = await new ServersDat(dir).list()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: 'aaaa', name: '局域网世界', address: '192.168.1.20', port: 51234, acceptTextures: 1, hidden: false, iconPngBase64: 'iVBORw0KGgo=' })
    expect(entries[1]).toMatchObject({ id: 'bbbb', name: 'Hypixel', address: 'mc.hypixel.net', hidden: true })
    expect(entries[1].port).toBeUndefined()
  })

  it('tolerates a missing file as an empty list and then creates it', async () => {
    const store = ServersDat.forGameDir(dir)
    expect(await store.list()).toEqual([])
    const entry: ServerEntry = { id: 'cccc', name: '新服务器', address: 'play.example.net', port: 25566, acceptTextures: 1 }
    const saved = await store.save(entry)
    expect(saved.id).toBe('cccc')
    expect(await store.list()).toEqual([expect.objectContaining({ address: 'play.example.net', port: 25566 })])
  })

  it('keeps unknown keys and their tag ids when updating a known entry', async () => {
    const file = serversDatPath(dir)
    await fs.writeFile(file, fixtureBytes())
    const store = new ServersDat(dir)
    const before = await store.list()
    await store.save({ ...before[0]!, name: '改名了' })

    const document = await loadServersDat(file)
    expect(listServerEntries(document)).toHaveLength(2)
    const first = document.servers[0]!
    expect(first.name).toBe('改名了')
    // Foreign keys survive untouched, with the tag ids they were written with.
    expect(first.magic).toBe(42)
    expect(first.flavor).toBe('keep me')
    expect(childTag(first, 'magic')).toBe(Tag.Short)
    expect(childTag(first, 'flavor')).toBe(Tag.String)
    expect(childTag(first, 'acceptTextures')).toBe(Tag.Byte)
    expect(childTag(first, 'hidden')).toBe(Tag.Byte)
    expect(childTag(first, 'ip')).toBe(Tag.String)
    const second = document.servers[1]!
    expect(second.iconBytes).toBeInstanceOf(Buffer)
    expect((second.iconBytes as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true)
    expect(childTag(second, 'iconBytes')).toBe(Tag.ByteArray)
    expect(childTag(second, 'magicHigh')).toBe(Tag.Int)
    expect(childTag(second, 'seatCount')).toBe(Tag.Long)
    expect(second.seatCount).toBe(9007199254740993n)
    // The root keeps its own extra field too.
    expect(document.root.version).toBe(27)
    expect(childTag(document.root, 'version')).toBe(Tag.Int)
  })

  it('is byte-identical through load + save when nothing changed', async () => {
    const bytes = fixtureBytes()
    const document = parseServersDat(serversDatPath(dir), bytes)
    expect(serialiseServersDat(document).equals(bytes)).toBe(true)
  })

  it('preserves an ip that already carried a port', async () => {
    const file = serversDatPath(dir)
    await fs.writeFile(file, fixtureBytes())
    const store = new ServersDat(dir)
    const entries = await store.list()
    await store.save(entries[1]!)
    const document = await loadServersDat(file)
    expect(document.servers[1]!.ip).toBe('mc.hypixel.net')
    expect(document.servers[0]!.ip).toBe('192.168.1.20:51234')
  })

  it('drops a removed entry and reports an unknown id as a no-op', async () => {
    const file = serversDatPath(dir)
    await fs.writeFile(file, fixtureBytes())
    const store = new ServersDat(dir)
    expect(await store.remove('aaaa')).toBe(true)
    expect(await store.remove('nope')).toBe(false)
    const entries = await store.list()
    expect(entries.map((entry) => entry.id)).toEqual(['bbbb'])
  })

  it('accepts a gzipped servers.dat', async () => {
    await fs.writeFile(serversDatPath(dir), toGzip(fixtureBytes()))
    const entries = await new ServersDat(dir).list()
    expect(entries).toHaveLength(2)
  })

  it('writes a replacement list atomically and rewrites the port only when set', async () => {
    const store = new ServersDat(dir)
    await store.replaceAll([
      { id: 'x1', name: 'one', address: 'a.example', port: 25565 },
      { id: 'x2', name: 'two', address: 'b.example' }
    ])
    const document = await loadServersDat(serversDatPath(dir))
    expect(document.servers[0]!.ip).toBe('a.example:25565')
    expect(document.servers[1]!.ip).toBe('b.example')
    expect(childTag(document.servers[0]!, 'acceptTextures')).toBe(Tag.Byte)
    expect((await store.list()).map((entry) => entry.name)).toEqual(['one', 'two'])
  })

  it('reports a corrupt file as a typed error instead of guessing', async () => {
    const file = serversDatPath(dir)
    await fs.writeFile(file, Buffer.from([0x0a, 0x00, 0x05, 0x73, 0x65]))
    let thrown: AppError | undefined
    try {
      await loadServersDat(file)
    } catch (error) {
      thrown = error instanceof AppError ? error : undefined
    }
    expect(thrown?.code).toBe('invalid-input')
    // A root that is a compound but has no `servers` list still reads as empty.
    await fs.writeFile(file, write(withTags({ other: Tag.Int }, { other: 1 })))
    expect(await new ServersDat(dir).list()).toEqual([])
    expect(read(await fs.readFile(file)).name).toBe('')
  })

  it('saves a document it produced (round trip through the file API)', async () => {
    const file = serversDatPath(dir)
    const document = parseServersDat(file, fixtureBytes())
    await saveServersDat(document)
    const again = await loadServersDat(file)
    expect(again.servers.length).toBe(2)
    expect(again.servers[1]!.flavor).toBe('vanilla wrote this')
  })
})

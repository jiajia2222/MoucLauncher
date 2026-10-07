/**
 * `<gameDir>/servers.dat` — the vanilla multiplayer server list.
 *
 * Shape (see https://minecraft.wiki/w/Nbt_format and the `servers.dat` section
 * of the Java Edition data storage docs): a root compound holding a `servers`
 * **List of compounds**, each with `name`/`ip`/`id` as String and
 * `acceptTextures`/`hidden` as Byte, plus an optional `icon` String.
 *
 * The file belongs to the game: keys we do not know about (a loader or a newer
 * vanilla version may add more) are parsed, kept and written back untouched,
 * including their tag ids — that is what the {@link nbt} tag hints are for.
 * A missing file reads as an empty list instead of failing.
 */

import path from 'node:path'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import { AppError } from '@shared/errors'
import { parseServerAddress } from '@shared/utils'
import type { ServerEntry } from '@shared/types'
import { ensureDir } from '../core/fsx'
import {
  Tag,
  asString,
  carryTags,
  childTag,
  isCompound,
  listTag,
  lookup,
  nbtList,
  num,
  read,
  withTags,
  write,
  type NbtCompound,
  type NbtValue,
  type TagId
} from './nbt'

export const SERVERS_DAT_NAME = 'servers.dat'
/** `ip` without a port means this one; we only spell a port out when it is set. */
export const DEFAULT_SERVER_PORT = 25565

export interface ServersDatDocument {
  file: string
  /** Root compound as parsed; unknown keys and their tag ids survive a rewrite. */
  root: NbtCompound
  rootName: string
  servers: NbtCompound[]
}

export function serversDatPath(gameDir: string): string {
  return path.join(gameDir, SERVERS_DAT_NAME)
}

/** A random 32 hex string, the shape vanilla writes into `id`. */
export function newServerId(): string {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * A foreign `servers.dat` can carry an empty id. Derive a stable one from the address
 * rather than a random id, which would change row identity on every read.
 */
export function stableServerId(name: string, ip: string): string {
  return crypto.createHash('sha1').update(`${name} ${ip}`).digest('hex').slice(0, 16)
}

/* ------------------------------------------------------------------ */
/* Entry <-> compound                                                  */
/* ------------------------------------------------------------------ */

function ipCarriesPort(ip: string): boolean {
  return /^\[[^\]]+\]:\d+$/.test(ip) || /^[^:[\]]+:\d+$/.test(ip)
}

export function serverEntryFromCompound(raw: NbtCompound): ServerEntry {
  const ip = asString(lookup(raw, 'ip')) ?? ''
  const parsed = parseServerAddress(ip, DEFAULT_SERVER_PORT)
  const storedId = asString(lookup(raw, 'id'))
  const name = asString(lookup(raw, 'name')) ?? parsed?.host ?? ip
  const entry: ServerEntry = {
    id: storedId && storedId.length > 0 ? storedId : stableServerId(name, ip),
    name,
    address: parsed?.host ?? ip
  }
  // Only remember a port the file actually spelled out, so a rewrite is lossless.
  if (parsed && ipCarriesPort(ip)) entry.port = parsed.port
  const textures = num(lookup(raw, 'acceptTextures'))
  if (textures !== undefined) entry.acceptTextures = textures ? 1 : 0
  const hidden = num(lookup(raw, 'hidden'))
  if (hidden !== undefined) entry.hidden = hidden !== 0
  const icon = asString(lookup(raw, 'icon'))
  if (icon && icon.length > 0) entry.iconPngBase64 = icon
  return entry
}

/** `[v6::addr]:port` when the host needs brackets; the port is kept when set. */
export function joinServerIp(address: string, port?: number): string {
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
  return port === undefined ? host : `${host}:${port}`
}

/** Tag ids the vanilla file uses for these keys; we never write them otherwise. */
const FORCED_TAGS: Record<string, TagId> = {
  name: Tag.String,
  ip: Tag.String,
  id: Tag.String,
  acceptTextures: Tag.Byte,
  hidden: Tag.Byte,
  icon: Tag.String
}

/**
 * Merges `entry` onto the compound that was read from disk (`previous`), so
 * unknown keys stay and known keys keep their original tag ids.
 */
export function serverCompound(entry: ServerEntry, previous?: NbtCompound): NbtCompound {
  const raw: NbtCompound = { ...(previous ?? {}) }
  raw.name = entry.name
  raw.ip = joinServerIp(entry.address, entry.port)
  raw.id = entry.id.length > 0 ? entry.id : newServerId()

  if (entry.acceptTextures !== undefined) raw.acceptTextures = entry.acceptTextures ? 1 : 0
  else if (!hasKey(raw, 'acceptTextures')) raw.acceptTextures = 0

  if (entry.hidden !== undefined) raw.hidden = entry.hidden ? 1 : 0
  else if (!hasKey(raw, 'hidden')) raw.hidden = 0

  if (entry.iconPngBase64 !== undefined) {
    if (entry.iconPngBase64.length > 0) raw.icon = entry.iconPngBase64
    else delete raw.icon
  }

  const tags: Partial<Record<string, TagId>> = {}
  for (const key of Object.keys(raw)) {
    const forced = FORCED_TAGS[key]
    if (forced) tags[key] = forced
  }
  withTags(tags, raw)
  carryTags(
    previous ?? {},
    raw,
    Object.keys(raw).filter((key) => tags[key] === undefined)
  )
  return raw
}

/* ------------------------------------------------------------------ */
/* File access                                                         */
/* ------------------------------------------------------------------ */

function hasKey(compound: NbtCompound, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(compound, key)
}

function emptyRoot(): NbtCompound {
  return withTags({ servers: Tag.List }, { servers: nbtList([], Tag.Compound) })
}

/** Reads and parses the file; a missing or unreadable file yields an empty list. */
export function parseServersDat(file: string, buffer: Buffer): ServersDatDocument {
  const node = read(buffer)
  if (!isCompound(node.value)) {
    throw new AppError('invalid-input', 'servers.dat 根节点不是 Compound', file)
  }
  const root = node.value
  const list = lookup(root, 'servers')
  const servers: NbtCompound[] = Array.isArray(list) ? list.filter((item: NbtValue): item is NbtCompound => isCompound(item)) : []
  return { file, root, rootName: node.name, servers }
}

export async function loadServersDat(file: string): Promise<ServersDatDocument> {
  let buffer: Buffer
  try {
    buffer = await fsp.readFile(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Missing file is normal (a fresh instance) -> empty list, no error.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { file, root: emptyRoot(), rootName: '', servers: [] }
    throw new AppError('disk', 'servers.dat 读取失败', `${file}: ${code ?? String(error)}`)
  }
  try {
    return parseServersDat(file, buffer)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('invalid-input', 'servers.dat 解析失败', `${file}: ${String(error)}`)
  }
}

/** Serialises the document uncompressed (vanilla accepts both, we write plain NBT). */
export function serialiseServersDat(document: ServersDatDocument): Buffer {
  const root = document.root
  // The root's hint for `servers` is the *field* tag (List); the element tag lives
  // on the list itself and has to survive, otherwise vanilla sees an empty list.
  const elementTag = listTag(document.servers) ?? Tag.Compound
  const list = nbtList(document.servers, elementTag)
  const next: NbtCompound = { ...root, servers: list }
  withTags({ ...tagsOf(root), servers: childTag(root, 'servers') ?? Tag.List }, next)
  return write(next, document.rootName)
}

function tagsOf(compound: NbtCompound): Partial<Record<string, TagId>> {
  const out: Partial<Record<string, TagId>> = {}
  for (const key of Object.keys(compound)) {
    const tag = childTag(compound, key)
    if (tag !== undefined) out[key] = tag
  }
  return out
}

export async function saveServersDat(document: ServersDatDocument): Promise<void> {
  const buffer = serialiseServersDat(document)
  await ensureDir(path.dirname(document.file))
  const tmp = `${document.file}.mouc-tmp`
  await fsp.writeFile(tmp, buffer)
  await fsp.rename(tmp, document.file)
}

/* ------------------------------------------------------------------ */
/* High level list / save / remove                                     */
/* ------------------------------------------------------------------ */

export function listServerEntries(document: ServersDatDocument): ServerEntry[] {
  return document.servers.map(serverEntryFromCompound)
}

function indexOfId(document: ServersDatDocument, id: string): number {
  return document.servers.findIndex((raw) => asString(lookup(raw, 'id')) === id)
}

/** Insert or update by `id`, keeping every unknown key of the old record. */
export async function upsertServerEntry(file: string, entry: ServerEntry): Promise<ServerEntry> {
  const document = await loadServersDat(file)
  const at = indexOfId(document, entry.id)
  if (at >= 0) {
    document.servers[at] = serverCompound(entry, document.servers[at])
  } else {
    document.servers.push(serverCompound(entry))
  }
  await saveServersDat(document)
  return serverEntryFromCompound(document.servers[at >= 0 ? at : document.servers.length - 1]!)
}

export async function removeServerEntry(file: string, id: string): Promise<boolean> {
  const document = await loadServersDat(file)
  const at = indexOfId(document, id)
  if (at < 0) return false
  document.servers.splice(at, 1)
  await saveServersDat(document)
  return true
}

export async function replaceServerEntries(file: string, entries: ServerEntry[]): Promise<ServerEntry[]> {
  const document = await loadServersDat(file)
  const byId = new Map(document.servers.map((raw) => [asString(lookup(raw, 'id')) ?? '', raw]))
  document.servers = entries.map((entry) => serverCompound(entry, byId.get(entry.id)))
  await saveServersDat(document)
  return listServerEntries(document)
}

/** Convenience facade bound to one game directory (what `ServerService` uses). */
export class ServersDat {
  readonly file: string

  constructor(gameDirOrFile: string) {
    this.file = gameDirOrFile.endsWith(SERVERS_DAT_NAME) ? gameDirOrFile : serversDatPath(gameDirOrFile)
  }

  static forGameDir(gameDir: string): ServersDat {
    return new ServersDat(gameDir)
  }

  async list(): Promise<ServerEntry[]> {
    return listServerEntries(await loadServersDat(this.file))
  }

  async save(entry: ServerEntry): Promise<ServerEntry> {
    return upsertServerEntry(this.file, entry)
  }

  async remove(id: string): Promise<boolean> {
    return removeServerEntry(this.file, id)
  }

  async replaceAll(entries: ServerEntry[]): Promise<ServerEntry[]> {
    return replaceServerEntries(this.file, entries)
  }
}

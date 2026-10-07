import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS_CONST } from '@shared/constants'
import type { Instance, PathInfo } from '@shared/types'
import { sanitizeName } from '@shared/utils'
import { instanceConfigFile, instanceGameDir, instanceRootFile } from './paths'

/**
 * Instances live in `<gameRoot>/.mouc/instances.json`; each isolated instance owns
 * `<gameRoot>/instances/<id>/`. Shared instances point at the game root itself and
 * therefore only exist in the registry.
 */
export class InstanceStore {
  private cached: Instance[] | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly paths: () => PathInfo) {}

  private get file(): string {
    return instanceRootFile(this.paths())
  }

  list(): Instance[] {
    if (this.cached) return this.cached
    this.cached = this.readDisk()
    return this.cached
  }

  private readDisk(): Instance[] {
    const file = this.file
    if (!fs.existsSync(file)) return []
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { instances?: unknown }
      const list = Array.isArray(raw.instances) ? raw.instances : []
      return list.filter((item): item is Instance => isInstance(item)).map(normalize)
    } catch {
      try {
        fs.copyFileSync(file, `${file}.bad-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return []
    }
  }

  get(id: string): Instance | undefined {
    return this.list().find((i) => i.id === id)
  }

  /** Throws when the id is unknown; used by every IPC handler. */
  require(id: string): Instance {
    const found = this.get(id)
    if (!found) throw Object.assign(new Error(`实例 ${id} 不存在`), { code: 'not-found' })
    return found
  }

  gameDir(instance: Instance): string {
    return instanceGameDir(instance, this.paths())
  }

  create(input: Partial<Instance> & { name: string; versionId: string; gameVersion: string }): Instance {
    const existing = this.list()
    const baseName = sanitizeName(input.name, '新建实例')
    const id = uniqueId(baseName, existing)
    const now = Date.now()
    const instance: Instance = {
      id,
      name: displayName(baseName, id, existing),
      description: input.description ?? '',
      icon: input.icon ?? 'cube',
      versionId: input.versionId,
      loader: input.loader ?? 'vanilla',
      gameVersion: input.gameVersion,
      isolated: input.isolated ?? true,
      java: input.java ?? { mode: 'auto' },
      memoryMb: input.memoryMb ?? DEFAULT_SETTINGS_CONST.memoryMb,
      jvmArgs: input.jvmArgs ?? '',
      gameArgs: input.gameArgs ?? '',
      resolution: input.resolution ?? {
        width: DEFAULT_SETTINGS_CONST.width,
        height: DEFAULT_SETTINGS_CONST.height,
        fullscreen: false
      },
      createdAt: now,
      updatedAt: now,
      playCount: 0,
      version: 1,
      ...(input.loaderVersion ? { loaderVersion: input.loaderVersion } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.server ? { server: input.server } : {})
    }
    if (instance.isolated) fs.mkdirSync(this.gameDir(instance), { recursive: true })
    this.replace([...existing, instance])
    return instance
  }

  update(id: string, patch: Partial<Instance>): Instance {
    const current = this.require(id)
    const next: Instance = {
      ...current,
      ...patch,
      id: current.id,
      // `name` changes are cosmetic; the folder id stays so files are never orphaned.
      name: patch.name ? sanitizeName(patch.name, current.name) : current.name,
      updatedAt: Date.now(),
      version: current.version + 1
    }
    this.replace(this.list().map((i) => (i.id === id ? next : i)))
    return next
  }

  markLaunched(id: string): Instance {
    const current = this.require(id)
    const next: Instance = { ...current, lastPlayedAt: Date.now(), playCount: current.playCount + 1 }
    this.replace(this.list().map((i) => (i.id === id ? next : i)))
    return next
  }

  duplicate(id: string, name: string): Instance {
    const source = this.require(id)
    const copy = this.create({
      ...source,
      name,
      versionId: source.versionId,
      gameVersion: source.gameVersion,
      description: source.description,
      icon: source.icon,
      loader: source.loader,
      loaderVersion: source.loaderVersion,
      isolated: true
    })
    const from = this.gameDir(source)
    const to = this.gameDir(copy)
    if (source.isolated && fs.existsSync(from)) {
      // Mods / config / saves travel with the copy; `versions` and `libraries` are shared.
      for (const entry of fs.readdirSync(from)) {
        if (entry === '.mouc-instance.json') continue
        try {
          fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true })
        } catch {
          /* a half-copied instance is still usable; the user sees it in the list */
        }
      }
    }
    return copy
  }

  remove(id: string, deleteFiles: boolean): void {
    const instance = this.require(id)
    this.replace(this.list().filter((i) => i.id !== id))
    if (deleteFiles && instance.isolated) {
      const dir = this.gameDir(instance)
      const root = this.paths().instancesDir
      // Refuse to rm anything outside `<gameRoot>/instances`.
      if (path.dirname(path.resolve(dir)) === path.resolve(root)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  }

  /** Writes the per-instance marker so a hand-made folder is still recognisable. */
  private writeInstanceConfig(instance: Instance): void {
    try {
      fs.mkdirSync(this.gameDir(instance), { recursive: true })
      fs.writeFileSync(instanceConfigFile(instance, this.paths()), JSON.stringify(instance, null, 2), 'utf8')
    } catch {
      /* registry file is authoritative */
    }
  }

  private replace(next: Instance[]): void {
    this.cached = next.map(normalize)
    for (const instance of next) this.writeInstanceConfig(instance)
    const file = this.file
    const payload = JSON.stringify({ version: 1, instances: this.cached }, null, 2)
    this.writing = this.writing.then(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, file)
    })
  }

  flush(): Promise<void> {
    return this.writing
  }

  /** Picks up instances created by hand (folder with a `.mouc-instance.json`). */
  rescan(): Instance[] {
    const root = this.paths().instancesDir
    this.cached = undefined
    const disk = this.readDisk()
    if (!fs.existsSync(root)) return disk
    const known = new Set(disk.map((i) => i.id))
    const found = [...disk]
    for (const entry of safeReadDir(root)) {
      if (known.has(entry)) continue
      const marker = path.join(root, entry, '.mouc-instance.json')
      if (!fs.existsSync(marker)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as unknown
        if (isInstance(parsed)) found.push(normalize({ ...parsed, id: entry }))
      } catch {
        /* ignore broken marker */
      }
    }
    this.cached = found
    return found
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function isInstance(value: unknown): value is Instance {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.versionId === 'string'
}

function normalize(value: Instance): Instance {
  const out: Instance = {
    ...value,
    isolated: value.isolated !== false,
    loader: (value.loader ?? 'vanilla') as Instance['loader'],
    java: value.java?.mode ? value.java : { mode: 'auto' },
    memoryMb: Number.isFinite(value.memoryMb) ? value.memoryMb : DEFAULT_SETTINGS_CONST.memoryMb,
    resolution: value.resolution ?? { width: 854, height: 480, fullscreen: false },
    playCount: Number.isFinite(value.playCount) ? value.playCount : 0,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
  }
  return out
}

function uniqueId(base: string, existing: Instance[]): string {
  const taken = new Set(existing.map((i) => i.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function displayName(base: string, id: string, existing: Instance[]): string {
  const taken = new Set(existing.map((i) => i.name))
  if (!taken.has(base)) return base
  return `${base} (${id})`
}

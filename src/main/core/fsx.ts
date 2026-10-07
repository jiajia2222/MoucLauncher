import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export async function exists(pathname: string): Promise<boolean> {
  try {
    await fsp.access(pathname)
    return true
  } catch {
    return false
  }
}

export async function isFile(pathname: string): Promise<boolean> {
  try {
    return (await fsp.stat(pathname)).isFile()
  } catch {
    return false
  }
}

export async function sizeOf(pathname: string): Promise<number> {
  try {
    return (await fsp.stat(pathname)).size
  } catch {
    return 0
  }
}

export async function readJsonSafe<T>(pathname: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(pathname, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(pathname: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(pathname))
  const tmp = `${pathname}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, pathname)
}

/** Streaming SHA-1; used on multi-hundred-MB jars so memory stays flat. */
export function streamSha1(pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(pathname)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function sha1Of(buffer: Buffer): string {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

export function md5Of(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

/** True when the file exists and either matches `sha1` or, with no hash, matches `size`. */
export async function fileMatches(pathname: string, sha1?: string, size?: number): Promise<boolean> {
  if (!(await isFile(pathname))) return false
  if (sha1) return (await streamSha1(pathname)) === sha1.toLowerCase()
  if (size && size > 0) return (await sizeOf(pathname)) === size
  return (await sizeOf(pathname)) > 0
}

export async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const stat = await fsp.stat(full)
        bytes += stat.size
        files += 1
      } catch {
        /* unreadable entries are skipped */
      }
    }
  }
  return { bytes, files }
}

export async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

export async function copyFile(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to))
  await fsp.copyFile(from, to)
}

/** `.part` -> target. Kept here so every writer produces the same atomicity. */
export async function rename(part: string, target: string): Promise<void> {
  await ensureDir(path.dirname(target))
  await fsp.rename(part, target)
}

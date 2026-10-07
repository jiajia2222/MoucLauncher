import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectDir, openZip, unzipAll, zipAll } from '../../src/main/core/zip'

let dir: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mouc-zip-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Long names make every central-directory record bigger than its fixed 46 bytes. */
function longName(index: number): string {
  return `META-INF/versions/${index}/net/fabricmc/loader/impl/discovery/${'deep'.repeat(6)}-${index}.json`
}

describe('core/zip central directory', () => {
  it('lists every entry when names are long', async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 120; i += 1) files[longName(i)] = Buffer.from(JSON.stringify({ i }))
    const file = path.join(dir, 'long-names.zip')
    await fs.writeFile(file, Buffer.from(zipAll(files)))

    const zip = await openZip(file)
    try {
      expect(zip.names().length).toBe(120)
      for (let i = 0; i < 120; i += 1) {
        expect(zip.has(longName(i)), longName(i)).toBe(true)
        expect(JSON.parse((await zip.read(longName(i))).toString('utf8'))).toEqual({ i })
      }
    } finally {
      await zip.close()
    }
  })

  it('reads a stored entry and a deflated entry from the same archive', async () => {
    const file = path.join(dir, 'mixed.zip')
    const payload = Buffer.from('x'.repeat(5000)).toString('base64')
    await fs.writeFile(
      file,
      Buffer.from(zipAll({ 'tiny.json': Buffer.from('{"a":1}'), 'big.bin': Buffer.from(payload) }, 0))
    )
    const zip = await openZip(file)
    try {
      expect(JSON.parse((await zip.read('tiny.json')).toString('utf8'))).toEqual({ a: 1 })
      expect((await zip.read('big.bin')).toString()).toBe(payload)
    } finally {
      await zip.close()
    }
  })

  it('extracts with an exclusion filter and refuses to write outside the target', async () => {
    const file = path.join(dir, 'extract.zip')
    await fs.writeFile(
      file,
      Buffer.from(
        zipAll({
          'lwjgl.dll': Buffer.from('dll'),
          'META-INF/signatures.SF': Buffer.from('signed'),
          'META-INF/versions/9/module-info.class': Buffer.from('class'),
          'assets/minecraft/lang/en_us.json': Buffer.from('{}')
        })
      )
    )
    const out = path.join(dir, 'natives')
    const zip = await openZip(file)
    let written: string[] = []
    try {
      written = await zip.extractTo(out, (name) => /^META-INF\/.*\.(SF|DSA|RSA)$/.test(name))
    } finally {
      await zip.close()
    }
    expect(
      written.map((w) => path.relative(out, w).replace(/\\/g, '/')).sort()
    ).toEqual(['META-INF/versions/9/module-info.class', 'assets/minecraft/lang/en_us.json', 'lwjgl.dll'])
    expect(await fs.readFile(path.join(out, 'lwjgl.dll'), 'utf8')).toBe('dll')
    await expect(fs.readFile(path.join(out, 'META-INF/signatures.SF'), 'utf8')).rejects.toThrow()
  })

  it('rejects a non-zip file with a clear error', async () => {
    const file = path.join(dir, 'not-a-zip.jar')
    await fs.writeFile(file, Buffer.from('this is definitely not a zip archive, not even close to one'))
    await expect(openZip(file)).rejects.toThrow(/ZIP/)
  })

  it('collectDir + unzipAll round-trip a directory tree', async () => {
    const root = path.join(dir, 'tree')
    await fs.mkdir(path.join(root, 'overrides', 'config'), { recursive: true })
    await fs.writeFile(path.join(root, 'a.txt'), 'A')
    await fs.writeFile(path.join(root, 'overrides', 'config', 'b.toml'), 'B')
    const collected = await collectDir(root)
    expect(Object.keys(collected).sort()).toEqual(['a.txt', 'overrides/config/b.toml'])
    const unpacked = unzipAll(Buffer.from(zipAll(collected)))
    expect(Buffer.from(unpacked['overrides/config/b.toml']).toString()).toBe('B')
  })
})

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractNativeJar, needsReextract, shouldSkipNativeEntry, NATIVES_MARKER } from '../../src/main/minecraft/natives'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-natives-'))
}

describe('shouldSkipNativeEntry', () => {
  it('always drops signature files and the multi-release block', () => {
    for (const name of ['META-INF/OK.SF', 'META-INF/sub/OK.DSA', 'META-INF/OK.RSA', 'META-INF/ok.sig'.replace('.sig', '.RSA')]) {
      expect(shouldSkipNativeEntry(name)).toBe(true)
    }
    expect(shouldSkipNativeEntry('META-INF/versions/9/module.class')).toBe(true)
    expect(shouldSkipNativeEntry('lwjgl.dll')).toBe(false)
    expect(shouldSkipNativeEntry('META-INF/MANIFEST.MF')).toBe(false)
  })

  it('honours Mojang exclude globs and bare directory names', () => {
    expect(shouldSkipNativeEntry('META-INF/x.SF', ['META-INF/*.SF'])).toBe(true)
    expect(shouldSkipNativeEntry('excluded/blob.bin', ['excluded/*'])).toBe(true)
    expect(shouldSkipNativeEntry('META-INF/MANIFEST.MF', ['META-INF'])).toBe(true)
    expect(shouldSkipNativeEntry('lwjgl.dll', ['META-INF'])).toBe(false)
  })
})

describe('extractNativeJar', () => {
  it('extracts only the usable entries and writes the marker', async () => {
    const dir = tempDir()
    try {
      const jar = path.join(dir, 'natives-windows.jar')
      const out = path.join(dir, 'natives')
      // The fixture zip carries dlls + signed files + META-INF/versions + excludables.
      const { NATIVES_ZIP } = await import('./fixtures')
      fs.writeFileSync(jar, NATIVES_ZIP)

      const written = await extractNativeJar(jar, out, [
        'META-INF/versions/9',
        'META-INF/*.SF',
        'META-INF/*.DSA',
        'META-INF/*.RSA',
        'excluded/*'
      ])
      const names = written.map((w) => path.relative(out, w).replace(/\\/g, '/')).sort()
      expect(names).toEqual(['META-INF/MANIFEST.MF', 'OpenAL64.dll', 'lwjgl.dll'])
      expect(fs.existsSync(path.join(out, 'META-INF', 'OK.SF'))).toBe(false)
      expect(fs.existsSync(path.join(out, 'META-INF', 'OK.DSA'))).toBe(false)
      expect(fs.existsSync(path.join(out, 'META-INF', 'OK.RSA'))).toBe(false)
      expect(fs.existsSync(path.join(out, 'META-INF', 'versions', '9', 'module.class'))).toBe(false)
      expect(fs.existsSync(path.join(out, 'excluded', 'blob.bin'))).toBe(false)
      // MANIFEST.MF is not a signature and survives.
      expect(fs.existsSync(path.join(out, 'META-INF', 'MANIFEST.MF'))).toBe(true)
      expect(fs.existsSync(path.join(out, NATIVES_MARKER))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips the second pass until the jar is newer than the marker', async () => {
    const dir = tempDir()
    try {
      const jar = path.join(dir, 'natives-windows.jar')
      const out = path.join(dir, 'natives')
      const { NATIVES_ZIP } = await import('./fixtures')
      fs.writeFileSync(jar, NATIVES_ZIP)

      const first = await extractNativeJar(jar, out, ['META-INF/*.SF'])
      expect(first.length).toBeGreaterThan(0)
      expect(needsReextract(jar, out)).toBe(false)
      const second = await extractNativeJar(jar, out, ['META-INF/*.SF'])
      expect(second).toEqual([])

      const future = new Date(Date.now() + 60_000)
      fs.utimesSync(jar, future, future)
      expect(needsReextract(jar, out)).toBe(true)
      const third = await extractNativeJar(jar, out, ['META-INF/*.SF'])
      expect(third.length).toBeGreaterThan(0)
      expect(needsReextract(jar, out)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

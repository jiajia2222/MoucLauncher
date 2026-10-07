import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assetIndexPath,
  assetObjectPath,
  assetVirtualPath,
  buildPaths,
  libraryPath,
  nativesDir,
  versionDir,
  versionJarPath,
  versionJsonPath
} from '../../src/main/core/paths'
import type { PathInfo } from '../../src/shared/types'

const paths: PathInfo = buildPaths(path.join(os.tmpdir(), 'mouc-appdata'), path.join(os.tmpdir(), 'mouc-game'))

describe('core/paths rejects metadata that would escape its root', () => {
  it('accepts the shapes real metadata uses', () => {
    expect(versionJsonPath(paths, '1.20.4')).toBe(path.join(paths.versionsDir, '1.20.4', '1.20.4.json'))
    expect(versionJarPath(paths, '26.3')).toBe(path.join(paths.versionsDir, '26.3', '26.3.jar'))
    expect(versionDir(paths, '1.16.5-forge-36.2.39')).toContain('1.16.5-forge-36.2.39')
    expect(nativesDir(paths, '1.20.4')).toContain('natives-windows')
    expect(assetIndexPath(paths, '36')).toContain(path.join('indexes', '36.json'))
    expect(libraryPath(paths, 'com/google/guava/guava/21.0/guava-21.0.jar')).toBe(
      path.join(paths.librariesDir, 'com/google/guava/guava/21.0/guava-21.0.jar')
    )
    expect(assetObjectPath(paths, 'a'.repeat(40))).toContain(path.join('objects', 'aa', 'a'.repeat(40)))
  })

  const escaping = ['../evil', '..\\..\\evil', '../../outside/lib.jar', '/etc/passwd', 'C:\\Windows\\system32\\x.dll']
  for (const relative of escaping) {
    it(`refuses libraryPath ${relative}`, () => {
      expect(() => libraryPath(paths, relative)).toThrow(/游戏|越界|非法|目标目录/)
    })
  }

  for (const id of ['../x', '..', 'a/b', 'con', '', '.hidden']) {
    it(`refuses version id ${JSON.stringify(id)}`, () => {
      expect(() => versionDir(paths, id)).toThrow()
      expect(() => versionJsonPath(paths, id)).toThrow()
    })
  }

  it('refuses a non-hex asset hash', () => {
    expect(() => assetObjectPath(paths, 'zz'.repeat(20))).toThrow(/十六进制/)
    expect(() => assetObjectPath(paths, 'short')).toThrow(/十六进制/)
  })

  it('refuses traversal in a virtual asset name but allows nested names', () => {
    expect(assetVirtualPath(paths, '1.7.3', 'minecraft/skins/steve.png')).toContain(
      path.join('virtual', '1.7.3', 'minecraft/skins/steve.png')
    )
    expect(() => assetVirtualPath(paths, '1.7.3', '../steve.png')).toThrow()
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPaths } from '../../src/main/core/paths'
import { Logger } from '../../src/main/core/log'
import type { DownloadItem } from '@shared/types'
import type { DownloadResult, Downloader, HttpClient } from '../../src/main/core/contracts'
import {
  adoptiumLatestUrl,
  adoptiumListUrl,
  createAdoptiumProvisioner,
  findRuntimeRoot,
  loadRegistry,
  pickAdoptiumPackage,
  registryFilePath
} from '../../src/main/java/adoptium'
import { adoptiumReleaseFixture, adoptiumUrls, FIXTURE_TOP_FOLDER, makeAdoptiumZip, makeTempDir, touch } from './fixtures'
import type { PathInfo } from '@shared/types'

function fakeDownloader(zipBytes: Buffer): { downloader: Downloader; ensured: DownloadItem[] } {
  const ensured: DownloadItem[] = []
  const downloader = {
    async ensure(item: DownloadItem): Promise<DownloadResult> {
      ensured.push(item)
      fs.mkdirSync(path.dirname(item.target), { recursive: true })
      fs.writeFileSync(item.target, zipBytes)
      return { item, fetched: true }
    }
  } as unknown as Downloader
  return { downloader, ensured }
}

function fakeHttp(latestPayload: unknown, listPayload: unknown): { http: HttpClient; urls: string[] } {
  const urls: string[] = []
  const http = {
    async json<T>(url: string): Promise<T> {
      urls.push(url)
      const { latest, list } = adoptiumUrls(21)
      if (url === latest) return latestPayload as T
      if (url === list) return listPayload as T
      throw new Error(`unexpected url ${url}`)
    }
  } as unknown as HttpClient
  return { http, urls }
}

describe('adoptium urls + package picking', () => {
  it('builds the verified latest endpoint shape', () => {
    const url = adoptiumLatestUrl(17)
    expect(url).toBe('https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse')
    expect(adoptiumListUrl(9)).toContain('/v3/assets/feature_releases/9?feature_version=9')
    expect(adoptiumListUrl(9)).toContain('image_type=jre&os=windows&vendor=eclipse')
  })

  it('picks the windows x64 package and survives a jdk-only answer', () => {
    const fixture = adoptiumReleaseFixture(21)
    const releases = [
      { release_name: 'linux', binary: { os: 'linux', architecture: 'x64', image_type: 'jre', package: { link: 'https://x/linux.tar.gz' } } },
      fixture.release
    ]
    const picked = pickAdoptiumPackage(releases, 'jre')
    expect(picked?.link).toBe(fixture.release.binary.package.link)

    const jdkOnly = [{ ...fixture.release, binary: { ...fixture.release.binary!, image_type: 'jdk' } }]
    expect(pickAdoptiumPackage(jdkOnly, 'jre')?.link).toContain('.zip')

    expect(pickAdoptiumPackage([], 'jre')).toBeUndefined()
    expect(pickAdoptiumPackage(undefined, 'jre')).toBeUndefined()
  })
})

describe('findRuntimeRoot (nested archive folders)', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = makeTempDir('mouc-root-')
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('finds bin/javaw.exe recursively up to depth 3 and returns the ROOT', async () => {
    touch(path.join(tmp, 'a', 'b', 'c', 'bin', 'javaw.exe'))
    const root = await findRuntimeRoot(tmp, 3)
    expect(root).toBe(path.join(tmp, 'a', 'b', 'c'))
  })

  it('returns undefined beyond maxDepth', async () => {
    touch(path.join(tmp, 'a', 'b', 'c', 'd', 'bin', 'javaw.exe'))
    expect(await findRuntimeRoot(tmp, 3)).toBeUndefined()
  })

  it('falls back to java.exe when javaw.exe is missing', async () => {
    touch(path.join(tmp, 'top', 'bin', 'java.exe'))
    expect(await findRuntimeRoot(tmp, 3)).toBe(path.join(tmp, 'top'))
  })
})

describe('provisioning + registry', () => {
  let tmp = ''
  let paths: () => PathInfo = () => buildPaths('x', 'y')
  let log: Logger

  beforeEach(() => {
    tmp = makeTempDir('mouc-adoptium-')
    paths = () => buildPaths(tmp, path.join(tmp, 'game'))
    log = new Logger('test-adoptium', path.join(tmp, 'logs'))
  })
  afterEach(() => {
    log.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('downloads via Adoptium, extracts the nested root and writes registry.json; second call is fromCache', async () => {
    const zip = makeAdoptiumZip(21, FIXTURE_TOP_FOLDER)
    const fixture = adoptiumReleaseFixture(21, 'jre', zip)
    const { http, urls } = fakeHttp([fixture.release], [])
    const { downloader, ensured } = fakeDownloader(zip)
    const provisioner = createAdoptiumProvisioner({ http, downloader, paths, log })

    const result = await provisioner.provision({ major: 21 })
    expect(ensured).toHaveLength(1)
    expect(ensured[0]!.url).toBe(fixture.release.binary.package.link)
    expect(ensured[0]!.kind).toBe('java')
    expect(ensured[0]!.target).toBe(path.join(tmp, 'java', '_cache', fixture.release.binary.package.name))
    expect(urls[0]).toBe(adoptiumLatestUrl(21, 'jre'))

    expect(result.fromCache).toBe(false)
    expect(result.downloadedBytes).toBe(zip.length)
    expect(result.runtime.source).toBe('adoptium')
    expect(result.runtime.major).toBe(21)
    expect(result.runtime.vendor).toBe('Eclipse Temurin')
    // The archive's single top folder is descended into, but the RUNTIME ROOT is returned.
    expect(result.runtime.path).toBe(path.join(tmp, 'java', '21', FIXTURE_TOP_FOLDER))
    expect(result.runtime.executable).toBe(path.join(tmp, 'java', '21', FIXTURE_TOP_FOLDER, 'bin', 'javaw.exe'))
    expect(fs.existsSync(result.runtime.executable)).toBe(true)

    const reg = await loadRegistry(paths().javaStoreDir)
    expect(reg.entries).toHaveLength(1)
    expect(reg.entries[0]!.id).toBe('temurin-21')
    expect(fs.existsSync(registryFilePath(paths().javaStoreDir))).toBe(true)

    // Idempotency: second provision hits the registry, downloads nothing.
    const again = await provisioner.provision({ major: 21 })
    expect(again.fromCache).toBe(true)
    expect(again.downloadedBytes).toBe(0)
    expect(ensured).toHaveLength(1)

    const listed = await provisioner.listProvisioned()
    expect(listed.map((r) => r.id)).toEqual(['temurin-21'])

    const pinned = await provisioner.lookupByPath(result.runtime.executable)
    expect(pinned?.id).toBe('temurin-21')
  })

  it('falls back to the feature_releases list endpoint when latest yields nothing', async () => {
    const zip = makeAdoptiumZip(21, FIXTURE_TOP_FOLDER)
    const fixture = adoptiumReleaseFixture(21, 'jre', zip)
    const { http, urls } = fakeHttp([], [fixture.release])
    const { downloader, ensured } = fakeDownloader(zip)
    const provisioner = createAdoptiumProvisioner({ http, downloader, paths, log })

    const result = await provisioner.provision({ major: 21 })
    expect(urls).toEqual([adoptiumLatestUrl(21, 'jre'), adoptiumListUrl(21, 'jre')])
    expect(ensured).toHaveLength(1)
    expect(result.runtime.major).toBe(21)
  })

  it('throws not-found when neither endpoint offers a package', async () => {
    const { http } = fakeHttp([], [])
    const { downloader } = fakeDownloader(Buffer.from('unused'))
    const provisioner = createAdoptiumProvisioner({ http, downloader, paths, log })
    await expect(provisioner.provision({ major: 21 })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('remove() deletes the provisioned folder and the registry entry', async () => {
    const zip = makeAdoptiumZip(21, FIXTURE_TOP_FOLDER)
    const fixture = adoptiumReleaseFixture(21, 'jre', zip)
    const { http } = fakeHttp([fixture.release], [])
    const { downloader } = fakeDownloader(zip)
    const provisioner = createAdoptiumProvisioner({ http, downloader, paths, log })
    const first = await provisioner.provision({ major: 21 })
    expect(fs.existsSync(first.runtime.path)).toBe(true)

    await provisioner.remove('temurin-21')
    expect(fs.existsSync(first.runtime.path)).toBe(false)
    const reg = await loadRegistry(paths().javaStoreDir)
    expect(reg.entries).toHaveLength(0)
    await expect(provisioner.remove('temurin-21')).rejects.toMatchObject({ code: 'not-found' })
  })
})

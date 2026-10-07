import { describe, expect, it } from 'vitest'
import { parseMavenMetadata, parseMavenVersions, decodeXmlText } from '../../src/main/loader/xml'
import { readFixtureText } from './helpers'

describe('loader/xml maven-metadata parsing', () => {
  it('extracts versions from the real Forge maven-metadata.xml fixture', () => {
    const xml = readFixtureText('loader/forge-maven-metadata.xml')
    const versions = parseMavenVersions(xml)
    expect(versions.length).toBeGreaterThan(5)
    // Every value has the `game-build` shape (e.g. 1.21.1-52.1.0 / 26.3-66.0.9).
    for (const v of versions) expect(v).toMatch(/.+-\d+\.\d+\.\d+/)
    // Odd/unsorted entries are preserved in file order, not deduplicated by sort.
    expect(versions).toEqual(Array.from(new Set(versions)))
  })

  it('reads latest/release pointers from the NeoForge fixture', () => {
    const xml = readFixtureText('loader/neoforge-maven-metadata.xml')
    const meta = parseMavenMetadata(xml)
    expect(meta.latest).toBe('1.20.1-47.1.106')
    expect(meta.release).toBe('1.20.1-47.1.106')
    expect(meta.versions).toContain('1.20.1-47.1.106')
  })

  it('handles CDATA, entities, blank and duplicated <version> entries', () => {
    const xml = `<metadata><versioning><versions>
      <version><![CDATA[1.19.2-43.2.0]]></version>
      <version>  1.18.2-40.2.9  </version>
      <version>1.18.2-40.2.9</version>
      <version></version>
      <version>1.17.1-37.1.1 &amp; test</version>
    </versions></versioning></metadata>`
    const versions = parseMavenVersions(xml)
    expect(versions).toEqual(['1.19.2-43.2.0', '1.18.2-40.2.9', '1.17.1-37.1.1 & test'])
  })

  it('decodes numeric entities', () => {
    expect(decodeXmlText('a&#65;b&#x43;c')).toBe('aAbCc')
  })
})

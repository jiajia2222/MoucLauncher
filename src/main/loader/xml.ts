/**
 * Minimal, dependency-free Maven `maven-metadata.xml` reader.
 * We only need the `<version>` list plus the `<latest>`/`<release>` markers, so a
 * small regex extractor beats pulling in an XML parser. Handles:
 *  - CDATA sections, XML entities, leading/trailing whitespace
 *  - duplicated and unsorted entries (Forge publishes them out of order)
 *  - malformed/blank tags (skipped)
 */

const VERSION_TAG = /<version>([\s\S]*?)<\/version>/g
const LATEST_TAG = /<latest>([\s\S]*?)<\/latest>/
const RELEASE_TAG = /<release>([\s\S]*?)<\/release>/
const LAST_UPDATED_TAG = /<lastUpdated>([\s\S]*?)<\/lastUpdated>/

/** Unwraps CDATA and decodes the handful of entities Maven ever emits. */
export function decodeXmlText(raw: string): string {
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  const text = cdata ? cdata[1]! : raw
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

export interface MavenMetadata {
  latest?: string
  release?: string
  lastUpdated?: string
  versions: string[]
}

/** Extracts every non-empty `<version>` value, in file order, de-duplicated. */
export function parseMavenVersions(xml: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of xml.matchAll(VERSION_TAG)) {
    const value = decodeXmlText(match[1] ?? '')
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Full metadata document: versions plus the recommended/latest pointers. */
export function parseMavenMetadata(xml: string): MavenMetadata {
  const meta: MavenMetadata = { versions: parseMavenVersions(xml) }
  const latest = xml.match(LATEST_TAG)
  if (latest) {
    const v = decodeXmlText(latest[1] ?? '')
    if (v) meta.latest = v
  }
  const release = xml.match(RELEASE_TAG)
  if (release) {
    const v = decodeXmlText(release[1] ?? '')
    if (v) meta.release = v
  }
  const updated = xml.match(LAST_UPDATED_TAG)
  if (updated) meta.lastUpdated = decodeXmlText(updated[1] ?? '')
  return meta
}

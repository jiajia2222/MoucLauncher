/**
 * Mirror rewriting. A `MirrorRule` maps official hosts to mirror hosts; users
 * configure the rules through Settings -> 下载源. Because no public BMCLAPI route
 * verified today (see constants.ts), this module must stay fully generic: a mirror
 * only has to serve the official path (optionally under a prefix such as
 * `/maven` for libraries) on its own host.
 */
import { OFFICIAL_TO_MIRROR } from '@shared/constants'
import type { MirrorRule } from '@shared/types'

/**
 * Candidate order for one official URL: every enabled rule whose `hosts` table
 * contains the URL's host contributes a rewritten URL (rules are applied in
 * ascending `priority`, lower number wins), and the official URL is ALWAYS kept
 * as the final fallback. Returns `[url]` when no rule matches.
 */
export function rewriteUrl(url: string, mirrors: MirrorRule[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }

  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {
    return [url]
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [url]

  const rules = mirrors
    .filter((rule) => rule.enabled && lookupHost(rule, parsed!) !== undefined)
    .sort((a, b) => a.priority - b.priority)

  for (const rule of rules) {
    const mirrorHost = lookupHost(rule, parsed)
    if (!mirrorHost) continue
    const rewritten = rewriteTo(parsed, mirrorHost)
    if (rewritten) push(rewritten)
  }
  // The official URL is the last candidate, even when it is also the first.
  push(url)
  return out
}

function lookupHost(rule: MirrorRule, url: URL): string | undefined {
  return rule.hosts[url.host] ?? rule.hosts[url.hostname]
}

function rewriteTo(url: URL, mirrorHost: string): string | undefined {
  try {
    const next = new URL(url.toString())
    next.host = mirrorHost
    const prefix = OFFICIAL_TO_MIRROR[url.hostname] ?? OFFICIAL_TO_MIRROR[url.host] ?? ''
    if (prefix) next.pathname = joinPath(prefix, next.pathname)
    return next.toString()
  } catch {
    return undefined
  }
}

function joinPath(prefix: string, pathname: string): string {
  const head = prefix.replace(/\/+$/, '')
  const tail = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${head}${tail}`
}

/**
 * Full candidate list for a download item: `item.url` first (mirror-rewritten),
 * then each fallback url (mirror-rewritten), always ending with the official URLs.
 * Duplicates are removed while the first occurrence order is kept.
 */
export function candidateUrls(
  url: string,
  fallbackUrls: string[] | undefined,
  mirrors: MirrorRule[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const source of [url, ...(fallbackUrls ?? [])]) {
    for (const candidate of rewriteUrl(source, mirrors)) {
      if (!seen.has(candidate)) {
        seen.add(candidate)
        out.push(candidate)
      }
    }
  }
  return out
}

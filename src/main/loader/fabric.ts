/**
 * Fabric / Quilt / Legacy-Fabric share one meta shape (`.../versions/loader` list and
 * `.../profile/json`). This module turns those responses into a download plan. The
 * version JSON is written verbatim by the service; its `libraries` use the classic
 * "Maven repo + coordinate" shape (`{ name, url, sha1?, size? }`) rather than Mojang's
 * `downloads` shape, so each coordinate resolves to `${repo}/${mavenPath(name)}`.
 */
import path from 'node:path'
import { ENDPOINTS, OFFICIAL_HOSTS } from '@shared/constants'
import type { LoaderOption } from '@shared/ipc'
import type { DownloadItem, PathInfo } from '@shared/types'
import { compareVersionIds, mavenPath } from '@shared/utils'
import type { FabricLoaderEntry, FabricLikeLibrary, LoaderProfileJson, LoaderPlan } from './types'

/** The provider-specific Maven repo a `url`-less library falls back to. */
const FALLBACK_REPO: Record<string, string> = {
  fabric: ENDPOINTS.fabricMaven,
  'legacy-fabric': ENDPOINTS.legacyFabricMaven,
  quilt: ENDPOINTS.quiltMaven
}

function normaliseRepo(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.replace(/\/$/, '')
}

/**
 * Turns one loader library entry into a download item targeting the shared `libraries`
 * dir. Returns `undefined` for a coordinate that cannot be turned into a Maven path.
 */
export function profileLibraryToItem(
  lib: FabricLikeLibrary,
  paths: PathInfo,
  loaderId: string
): DownloadItem | undefined {
  const rel = mavenPath(lib.name)
  if (!rel) return undefined
  const repoBase = normaliseRepo(lib.url) ?? FALLBACK_REPO[loaderId] ?? ENDPOINTS.fabricMaven
  const url = `${repoBase}/${rel}`
  const target = path.join(paths.librariesDir, rel)
  const item: DownloadItem = {
    id: target,
    url,
    target,
    kind: 'library',
    label: path.basename(rel),
    // libraries minecraft.net never serves the fabric/asm artifacts; keep official fallback.
    fallbackUrls: [`https://${OFFICIAL_HOSTS.libraries}/${rel}`]
  }
  if (lib.sha1) item.sha1 = lib.sha1
  if (typeof lib.size === 'number') item.size = lib.size
  return item
}

/** Download items for every library in a profile json (deduplicated by target). */
export function profileLibraryItems(
  profile: LoaderProfileJson,
  paths: PathInfo,
  loaderId: string
): DownloadItem[] {
  const seen = new Set<string>()
  const items: DownloadItem[] = []
  for (const lib of profile.libraries ?? []) {
    const item = profileLibraryToItem(lib, paths, loaderId)
    if (!item || seen.has(item.target)) continue
    seen.add(item.target)
    items.push(item)
  }
  return items
}

/**
 * Builds the plan for a fabric/quilt profile json. `versionId` comes straight from the
 * provider (`fabric-loader-0.19.5-1.21.1`); `items` are the library downloads. The
 * version json body itself is written by the service from `versionJson`.
 */
export function profileToPlan(
  profile: LoaderProfileJson,
  paths: PathInfo,
  loaderId: string
): LoaderPlan {
  return {
    versionId: profile.id,
    versionJson: profile,
    items: profileLibraryItems(profile, paths, loaderId)
  }
}

/**
 * Maps a loader list response into `LoaderOption.versions`. Fabric/Quilt only flag
 * `stable`; there is no provider "recommended" marker, so the newest stable build is
 * promoted to recommended (matching the official installer's default selection).
 */
export function loaderOptionVersions(entries: FabricLoaderEntry[]): LoaderOption['versions'] {
  const versions = entries
    .filter((e) => e.loader?.version)
    .map((e) => ({
      version: e.loader.version,
      stable: Boolean(e.loader.stable ?? !/-beta|-alpha|-rc|\.dev|_/i.test(e.loader.version)),
      recommended: false
    }))
  let best: (typeof versions)[number] | undefined
  for (const v of versions) {
    if (!v.stable) continue
    if (!best || compareVersionIds(v.version, best.version) > 0) best = v
  }
  if (best) best.recommended = true
  return versions
}

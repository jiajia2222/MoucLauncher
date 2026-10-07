/**
 * Asset index parsing + download-item generation.
 * Supports the three shapes Mojang has shipped:
 *   modern: { objects: { "<name>": { hash, size } } }
 *   legacy (pre-1.7.3): flat map whose values are bare sha1 strings
 *   virtual: an index carrying `"map_to_resources": true` also needs named copies
 *            under `assets/virtual/<indexId>/<name>`.
 */
import path from 'node:path'
import { OFFICIAL_HOSTS } from '@shared/constants'
import type { AssetIndexRef, DownloadItem, PathInfo } from '@shared/types'
import { copyFile, exists } from '../core/fsx'
import { assetIndexPath, assetObjectPath, assetVirtualPath } from '../core/paths'

export interface AssetObject {
  name: string
  hash: string
  size?: number
}

/** Raw asset index document (modern or legacy). */
export type AssetIndexDoc = Record<string, unknown>

const NON_OBJECT_KEYS = new Set(['objects', 'analyze', 'start_of_time', 'map_to_resources'])

/** True when assets must also exist as named files (the old `map_to_resources` flag). */
export function mapsToResources(index: AssetIndexDoc): boolean {
  return index.map_to_resources === true
}

export function assetObjects(index: AssetIndexDoc): AssetObject[] {
  const source = index.objects
  const entries: [string, unknown][] =
    source && typeof source === 'object'
      ? Object.entries(source as Record<string, unknown>)
      : Object.entries(index).filter(([key]) => !NON_OBJECT_KEYS.has(key))

  const out: AssetObject[] = []
  for (const [name, value] of entries) {
    if (typeof value === 'string') {
      // Pre-1.7.3 shape: the value is the bare object hash.
      if (/^[0-9a-f]{40}$/.test(value)) out.push({ name, hash: value })
      continue
    }
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>
      if (typeof v.hash === 'string' && /^[0-9a-f]{40}$/.test(v.hash)) {
        const size = typeof v.size === 'number' ? v.size : undefined
        out.push(size === undefined ? { name, hash: v.hash } : { name, hash: v.hash, size })
      }
    }
  }
  return out
}

/** `<assetsDir>/indexes/<id>.json` — the index file itself is a download item. */
export function assetIndexItem(index: AssetIndexRef, paths: PathInfo): DownloadItem {
  return {
    id: assetIndexPath(paths, index.id),
    url: index.url,
    target: assetIndexPath(paths, index.id),
    sha1: index.sha1,
    size: index.size,
    kind: 'asset-index',
    label: `${index.id}.json`
  }
}

export function assetObjectUrl(hash: string): string {
  return `https://${OFFICIAL_HOSTS.resources}/${hash.slice(0, 2)}/${hash}`
}

export function assetObjectItems(objects: AssetObject[], paths: PathInfo): DownloadItem[] {
  return objects.map((object) => {
    const target = assetObjectPath(paths, object.hash)
    const item: DownloadItem = {
      id: target,
      url: assetObjectUrl(object.hash),
      target,
      sha1: object.hash,
      kind: 'asset',
      label: object.name
    }
    if (object.size !== undefined) item.size = object.size
    return item
  })
}

/** Directory holding the named copies for a `map_to_resources` index. */
export function virtualAssetsDir(paths: PathInfo, indexId: string): string {
  return path.join(paths.assetsDir, 'virtual', indexId)
}

/**
 * Copies every object file to `assets/virtual/<indexId>/<name>` so old versions that
 * read `assets/virtual/...` find real files. Missing sources are skipped quietly.
 */
export async function writeVirtualCopies(
  paths: PathInfo,
  indexId: string,
  objects: AssetObject[]
): Promise<number> {
  let written = 0
  for (const object of objects) {
    const source = assetObjectPath(paths, object.hash)
    if (!(await exists(source))) continue
    const target = assetVirtualPath(paths, indexId, object.name)
    if (await exists(target)) continue
    try {
      await copyFile(source, target)
      written += 1
    } catch {
      /* a half-populated virtual dir is repaired on the next install */
    }
  }
  return written
}

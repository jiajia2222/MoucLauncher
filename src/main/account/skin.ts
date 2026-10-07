/**
 * Skin fetching + caching. Microsoft skins: the profile response already told us
 * the skin URL (stored on the account); we rewrite it to the public blob server
 * and download into `<configDir>/cache/skins/<uuid>.png` through the downloader
 * so repeat calls reuse the cache. Offline skins: v1 limitation documented below.
 */
import path from 'node:path'
import type { Account, PathInfo, SkinInfo } from '@shared/types'
import { ENDPOINTS } from '@shared/constants'
import { isFile, sizeOf } from '../core/fsx'
import type { Downloader } from '../core/contracts'

export interface SkinDeps {
  downloader: Downloader
  paths: () => PathInfo
}

export function skinCacheFile(paths: PathInfo, uuid: string): string {
  return path.join(paths.configDir, 'cache', 'skins', `${uuid}.png`)
}

export function offlineSkinFile(gameRoot: string, name: string): string {
  return path.join(gameRoot, 'skins', `${name}.png`)
}

/**
 * The profile `skins[].url` points at api.minecraftservices.com and needs a
 * bearer token, which the generic downloader does not attach. The last path
 * segment is the texture hash, and textures.minecraft.net serves it without
 * auth — the same substitution other launchers do (unverified end-to-end
 * without a real account; see docs/microsoft-auth.md).
 */
export function textureUrlFromProfileUrl(url: string): string {
  const clean = url.split('?')[0]!
  const textureMatch = /\/texture\/([0-9a-f]+)$/i.exec(clean)
  if (textureMatch) return `${ENDPOINTS.skinBlobServer}/${textureMatch[1]}`
  const hash = clean.split('/').filter((s) => s.length > 0).pop() ?? ''
  if (/^[0-9a-f]{40,}$/i.test(hash)) return `${ENDPOINTS.skinBlobServer}/${hash}`
  return url
}

/** Pick the classic-variant skin URL from a profile response shape. */
export function profileSkinUrl(skins: { state?: string; url?: string; variant?: string }[] | undefined): string | undefined {
  if (!skins) return undefined
  const active = skins.filter((s) => s.state === 'ACTIVE' && typeof s.url === 'string')
  const classic = active.find((s) => (s.variant ?? 'classic').toLowerCase() !== 'slim')
  const chosen = classic ?? active[0]
  return chosen?.url
}

export function profileCapeUrl(capes: { state?: string; url?: string; visible?: boolean }[] | undefined): string | undefined {
  if (!capes) return undefined
  const active = capes.filter((c) => c.state === 'ACTIVE' && typeof c.url === 'string')
  const visible = active.find((c) => c.visible !== false)
  return (visible ?? active[0])?.url
}

export async function skinForMicrosoft(deps: SkinDeps, account: Account): Promise<SkinInfo> {
  const base: SkinInfo = { accountId: account.id, name: account.name, previewPng: '', model: 'classic', source: 'none' }
  if (!account.skinUrl) return base
  const target = skinCacheFile(deps.paths(), account.uuid)
  if ((await isFile(target)) && (await sizeOf(target)) > 0) {
    return { ...base, previewPng: target, source: 'microsoft', ...(account.capeUrl ? { capeUrl: account.capeUrl } : {}) }
  }
  await deps.downloader.ensure({
    id: target,
    url: textureUrlFromProfileUrl(account.skinUrl),
    target,
    kind: 'misc',
    label: `皮肤 ${account.name}`,
    overwrite: false
  })
  if (!(await isFile(target))) return base
  return { ...base, previewPng: target, source: 'microsoft', ...(account.capeUrl ? { capeUrl: account.capeUrl } : {}) }
}

/**
 * v1 LIMITATION (offline skins): we found no verified mechanism to *inject* a
 * skin for offline accounts without an authlib-injector-style agent (out of
 * scope here — do not invent one). We only surface a PNG the user placed at
 * `<gameRoot>/skins/<name>.png` as `offline-store`.
 */
export async function skinForOffline(deps: SkinDeps, account: Account): Promise<SkinInfo> {
  const target = offlineSkinFile(deps.paths().gameRoot, account.name)
  if (await isFile(target)) {
    return { accountId: account.id, name: account.name, previewPng: target, model: 'classic', source: 'offline-store' }
  }
  return { accountId: account.id, name: account.name, previewPng: '', model: 'classic', source: 'none' }
}

/**
 * CurseForge provider.
 *
 * The CurseForge Core API rejects every request without an `x-access-token` (verified:
 * 403 "API Key missing or invalid" on 2026-10-07), so unlike other providers we surface
 * a hard error instead of a silent empty result. Because the 403 blocked live probing,
 * the field mapping below follows the documented Core API v1 schema (mods/search -> data[],
 * mods/{id}/files -> data[]); see the report. Download URLs come back `null` in the docs,
 * so the canonical redirect `${ENDPOINTS.curseForgeMods}/{modId}/files/{fileId}/download`
 * is used instead.
 */
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { LoaderId, ModDependency, ModFile, ModProject, ProjectVersion, SearchPage, SearchQuery } from '@shared/types'
import type { HttpClient } from '../../core/contracts'

interface CfLogo {
  url?: string
  thumbnail?: string
}
interface CfAuthor {
  name?: string
}
interface CfHash {
  value: string
  algorithm: number // 1 = sha1, 2 = md5
}
interface CfCategory {
  name?: string
}
interface CfFileDependency {
  modId: number
  type: number // 1 required, 2 optional, 3 tool, 4 incompatible, 5 include
}
interface CfFile {
  id: number
  modId: number
  displayName?: string
  fileName?: string
  downloadUrl?: string | null
  fileLength?: number
  hashes?: CfHash[]
  gameVersions?: string[]
  dependencies?: CfFileDependency[]
}
interface CfMod {
  id: number
  name: string
  slug?: string
  description?: string
  authors?: CfAuthor[]
  primaryAuthor?: CfAuthor
  logo?: CfLogo
  downloadCount?: number
  dateModified?: number
  latestFiles?: CfFile[]
  categories?: CfCategory[]
}
interface CfListing<T> {
  data?: T[]
  pagination?: { totalCount?: number }
}

function sha1Of(hashes: CfHash[] | undefined): string | undefined {
  return hashes?.find((h) => h.algorithm === 1)?.value
}

function depKind(type: number): ModDependency['kind'] {
  if (type === 4) return 'incompatible'
  if (type === 2 || type === 3 || type === 5) return 'optional'
  return 'required'
}

function mapDependencies(deps: CfFileDependency[] | undefined): ModDependency[] {
  return (deps ?? []).map((d) => ({ projectId: String(d.modId), kind: depKind(d.type), projectProvider: 'curseforge' as const }))
}

function loadersFromCategories(categories: CfCategory[] | undefined): LoaderId[] {
  const names = new Set((categories ?? []).map((c) => (c.name ?? '').toLowerCase()))
  const out: LoaderId[] = []
  if (names.has('fabric')) out.push('fabric')
  if (names.has('neoforge')) out.push('neoforge')
  if (names.has('forge')) out.push('forge')
  if (names.has('quilt')) out.push('quilt')
  if (names.has('legacy-fabric')) out.push('legacy-fabric')
  return out
}

function downloadUrl(modId: number, fileId: number): string {
  // Canonical redirect host: the API root with an explicit `.../download` suffix.
  return `${ENDPOINTS.curseForgeMods}/${modId}/files/${fileId}/download`
}

function mapFile(file: CfFile): ModFile {
  return {
    versionId: String(file.id),
    projectId: String(file.modId),
    provider: 'curseforge',
    name: file.displayName ?? file.fileName ?? String(file.id),
    fileName: file.fileName ?? `${file.id}.jar`,
    url: file.downloadUrl || downloadUrl(file.modId, file.id),
    size: file.fileLength ?? 0,
    hashes: { sha1: sha1Of(file.hashes) },
    loaders: [],
    gameVersions: file.gameVersions ?? [],
    dependencies: mapDependencies(file.dependencies),
    primary: true
  }
}

function mapMod(mod: CfMod): ModProject {
  return {
    provider: 'curseforge',
    id: String(mod.id),
    slug: mod.slug ?? String(mod.id),
    kind: 'mod',
    title: mod.name,
    description: mod.description ?? '',
    authors: (mod.authors ?? (mod.primaryAuthor ? [mod.primaryAuthor] : [])).map((a) => a.name ?? '').filter(Boolean),
    iconUrl: mod.logo?.url,
    downloads: mod.downloadCount ?? 0,
    categories: (mod.categories ?? []).map((c) => c.name ?? '').filter(Boolean),
    loaders: loadersFromCategories(mod.categories),
    gameVersions: [...new Set((mod.latestFiles ?? []).flatMap((f) => f.gameVersions ?? []))],
    dateModified: mod.dateModified ? new Date(mod.dateModified).toISOString() : ''
  }
}

function fileToVersion(file: CfFile): ProjectVersion {
  return {
    id: String(file.id),
    projectId: String(file.modId),
    provider: 'curseforge',
    name: file.displayName ?? file.fileName ?? String(file.id),
    versionNumber: file.fileName ?? String(file.id),
    datePublished: '',
    files: [mapFile(file)],
    loaders: [],
    gameVersions: file.gameVersions ?? [],
    dependencies: mapDependencies(file.dependencies)
  }
}

export interface CurseForgeProvider {
  search(query: SearchQuery): Promise<SearchPage<ModProject>>
  versions(projectId: string, gameVersion?: string): Promise<ProjectVersion[]>
  fileUrl(file: ModFile): string
}

/** `apiRoot` is `.../v1/mods`; derived from `ENDPOINTS.curseForgeMods`. */
export function createCurseForgeProvider(
  http: HttpClient,
  apiKey: string,
  apiRoot = ENDPOINTS.curseForgeMods
): CurseForgeProvider {
  const headers = (): Record<string, string> => {
    const key = apiKey.trim()
    if (!key) throw new AppError('unsupported', '未配置 CurseForge API Key')
    return { 'x-access-token': key, 'user-agent': 'MoucX' }
  }

  return {
    async search(query: SearchQuery): Promise<SearchPage<ModProject>> {
      const params = new URLSearchParams()
      params.set('gameId', '432')
      params.set('searchFilter', query.keyword ?? '')
      params.set('pageSize', String(Math.min(50, Math.max(1, query.limit || 20))))
      params.set('index', String(query.offset || 0))
      if (query.gameVersion) params.set('gameVersion', query.gameVersion)
      const res = await http.json<CfListing<CfMod>>(`${apiRoot}/search?${params.toString()}`, { headers: headers() })
      const items = (res.data ?? []).map(mapMod)
      return { items, total: res.pagination?.totalCount ?? items.length, offset: query.offset }
    },

    async versions(projectId: string, gameVersion?: string): Promise<ProjectVersion[]> {
      const res = await http.json<CfListing<CfFile>>(
        `${apiRoot}/${encodeURIComponent(projectId)}/files?pageSize=50`,
        { headers: headers() }
      )
      let files = res.data ?? []
      if (gameVersion) files = files.filter((f) => (f.gameVersions ?? []).includes(gameVersion))
      return files.map(fileToVersion)
    },

    fileUrl(file: ModFile): string {
      return file.url
    }
  }
}

export const __internals = { mapMod, mapFile, depKind, downloadUrl }

/**
 * Modrinth provider.
 *
 * Endpoints (both verified 2026-10-07 against `tests/fixtures/mods/`):
 *   GET /v2/search   ?query&limit&offset&index&filters
 *   GET /v2/project/{id}/version?game_versions=["x"]&loaders=["fabric"]
 *
 * IMPORTANT: the search `filters` parameter is NO LONGER the old JSON array of facets.
 * The live API now expects an RQL-ish boolean expression (space operators), e.g.
 *   project_types = "mod" AND categories = "fabric" AND game_versions = "1.21.1"
 * Field names were confirmed empirically: `project_types` (not `project_type`),
 * `categories` for the loader, `game_versions` (not `versions`) for the Minecraft line.
 */
import { ENDPOINTS } from '@shared/constants'
import { AppError } from '@shared/errors'
import type {
  LoaderId,
  ModDependency,
  ModFile,
  ModProject,
  ProjectKind,
  ProjectVersion,
  SearchPage,
  SearchQuery
} from '@shared/types'
import type { HttpClient } from '../../core/contracts'

const LOADER_IDS: LoaderId[] = ['fabric', 'legacy-fabric', 'quilt', 'forge', 'neoforge', 'optifine', 'liteloader', 'cleanroom']

interface ModrinthHit {
  project_id: string
  project_type: string
  slug: string
  title: string
  description: string
  author: string
  categories: string[]
  versions: string[]
  downloads: number
  icon_url: string
  date_modified: string
  license?: string
}

interface ModrinthSearchResponse {
  hits: ModrinthHit[]
  total_hits: number
  offset: number
}

interface ModrinthFile {
  id: string
  hashes: { sha1?: string; sha512?: string }
  url: string
  filename: string
  primary: boolean
  size: number
  file_type?: string | null
}

interface ModrinthDependency {
  version_id: string | null
  project_id: string | null
  file_name: string | null
  dependency_type: string
}

interface ModrinthVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  changelog?: string
  date_published: string
  loaders: string[]
  game_versions: string[]
  files: ModrinthFile[]
  dependencies: ModrinthDependency[]
}

function kindFromProjectType(type: string): ProjectKind {
  switch (type) {
    case 'modpack':
      return 'modpack'
    case 'resourcepack':
      return 'resourcepack'
    case 'shader':
      return 'shader'
    case 'mod':
    default:
      return 'mod'
  }
}

function loadersOf(categories: string[]): LoaderId[] {
  return categories.filter((c): c is LoaderId => (LOADER_IDS as string[]).includes(c))
}

function depKind(type: string): ModDependency['kind'] {
  if (type === 'optional') return 'optional'
  if (type === 'incompatible') return 'incompatible'
  return 'required'
}

function mapDependencies(deps: ModrinthDependency[] | undefined): ModDependency[] {
  return (deps ?? [])
    .filter((d) => d.project_id || d.file_name)
    .map((d) => ({
      projectId: d.project_id ?? d.file_name ?? '',
      kind: depKind(d.dependency_type),
      projectProvider: 'modrinth' as const
    }))
}

function mapProject(hit: ModrinthHit): ModProject {
  return {
    provider: 'modrinth',
    id: hit.project_id,
    slug: hit.slug,
    kind: kindFromProjectType(hit.project_type),
    title: hit.title,
    description: hit.description,
    authors: hit.author ? [hit.author] : [],
    iconUrl: hit.icon_url || undefined,
    downloads: hit.downloads ?? 0,
    categories: hit.categories ?? [],
    loaders: loadersOf(hit.categories ?? []),
    gameVersions: hit.versions ?? [],
    dateModified: hit.date_modified,
    license: hit.license
  }
}

function mapFile(v: ModrinthVersion, file: ModrinthFile): ModFile {
  return {
    versionId: v.id,
    projectId: v.project_id,
    provider: 'modrinth',
    name: v.name,
    fileName: file.filename,
    url: file.url,
    size: file.size ?? 0,
    hashes: { sha1: file.hashes?.sha1, sha512: file.hashes?.sha512 },
    loaders: loadersOf(v.loaders ?? []),
    gameVersions: v.game_versions ?? [],
    dependencies: mapDependencies(v.dependencies),
    primary: Boolean(file.primary)
  }
}

function mapVersion(v: ModrinthVersion): ProjectVersion {
  const files = v.files ?? []
  return {
    id: v.id,
    projectId: v.project_id,
    provider: 'modrinth',
    name: v.name,
    versionNumber: v.version_number,
    changelog: v.changelog,
    datePublished: v.date_published,
    files: files.map((f) => mapFile(v, f)),
    loaders: loadersOf(v.loaders ?? []),
    gameVersions: v.game_versions ?? [],
    dependencies: mapDependencies(v.dependencies)
  }
}

/** Builds the RQL filter expression from a search query. */
export function buildFilters(
  query: Partial<Pick<SearchQuery, 'kind' | 'loader' | 'gameVersion' | 'category'>>
): string {
  const parts: string[] = []
  if (query.kind) parts.push(`project_types = ${quote(query.kind === 'mod' ? 'mod' : query.kind)}`)
  if (query.loader) parts.push(`categories = ${quote(query.loader)}`)
  if (query.gameVersion) parts.push(`game_versions = ${quote(query.gameVersion)}`)
  if (query.category) parts.push(`categories = ${quote(query.category)}`)
  return parts.length > 0 ? parts.join(' AND ') : '[]'
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

const INDEX_FOR_SORT: Record<NonNullable<SearchQuery['sort']>, string> = {
  relevance: 'relevance',
  downloads: 'downloads',
  follows: 'follows',
  newest: 'newest',
  updated: 'updated'
}

export interface ModrinthProvider {
  search(query: SearchQuery): Promise<SearchPage<ModProject>>
  versions(projectId: string, gameVersion?: string, loader?: string): Promise<ProjectVersion[]>
  fileUrl(file: ModFile): string
}

export function createModrinthProvider(http: HttpClient, base = ENDPOINTS.modrinthSearch): ModrinthProvider {
  // `base` is `.../v2/search`; derive the API root for the project/version routes.
  const root = base.replace(/\/search$/, '')
  const searchUrl = /\/search$/.test(base) ? base : `${root}/search`
  return {
    async search(query: SearchQuery): Promise<SearchPage<ModProject>> {
      const params = new URLSearchParams()
      params.set('query', query.keyword ?? '')
      params.set('limit', String(clampLimit(query.limit)))
      params.set('offset', String(Math.max(0, query.offset)))
      params.set('index', INDEX_FOR_SORT[query.sort ?? 'relevance'])
      params.set('filters', buildFilters(query))
      const res = await http.json<ModrinthSearchResponse>(`${searchUrl}?${params.toString()}`, {
        headers: { 'user-agent': 'MoucLauncher' }
      })
      const hits = res.hits ?? []
      return { items: hits.map(mapProject), total: res.total_hits ?? hits.length, offset: res.offset ?? query.offset }
    },

    async versions(projectId: string, gameVersion?: string, loader?: string): Promise<ProjectVersion[]> {
      const params = new URLSearchParams()
      if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
      if (loader) params.set('loaders', JSON.stringify([loader]))
      const qs = params.toString()
      const url = `${root}/project/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ''}`
      const res = await http.json<ModrinthVersion[]>(url, { headers: { 'user-agent': 'MoucLauncher' } })
      if (!Array.isArray(res)) throw new AppError('not-found', 'Modrinth 项目不存在', projectId)
      return res.map(mapVersion)
    },

    fileUrl(file: ModFile): string {
      return file.url
    }
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 20
  return Math.min(100, Math.max(1, Math.round(limit)))
}

/** Exported for mapping-only tests. */
export const __mapProject = mapProject
export const __mapVersion = mapVersion

/**
 * Dependency bag for the modpack service.
 *
 * `settings` is optional on purpose: the frozen container does not pass it yet, and
 * CurseForge resolution is the only thing that needs it (see curse.ts — without a key
 * the import still creates the instance, it just reports every file as unresolved).
 * `fs` lets a test (or a future sandbox) swap the archive write/read layer.
 */
import type fsp from 'node:fs/promises'
import type { DownloadJob, Instance, ModpackManifest, PathInfo } from '@shared/types'
import type { Downloader, ModService, SettingsReader, VersionService } from '../core/contracts'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'

export type FsLike = Pick<typeof fsp, 'readFile' | 'writeFile' | 'stat' | 'readdir' | 'mkdir'>

export interface ModpackServiceDeps {
  downloader: Downloader
  versions: VersionService
  instances: InstanceStore
  mods: ModService
  paths: () => PathInfo
  log: Logger
  /** Optional: only CurseForge needs the api key. */
  settings?: SettingsReader
  /** Optional IO override. */
  fs?: Partial<FsLike>
}

/** What an importer returns once the instance exists and the files are queued. */
export interface ImportOutcome {
  job: DownloadJob
  manifest: ModpackManifest
  instance: Instance
}

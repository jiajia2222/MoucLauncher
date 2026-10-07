/**
 * Modpack service: detect / import / export.
 *
 * Supported formats (see `ModpackFormat` in `@shared/types`):
 * - `mrpack`     — Modrinth, member `modrinth.index.json` (+ legacy `mrmodpack.json`).
 * - `curse-zip`  — CurseForge, member `manifest.json` with `projectID`/`fileID`.
 * - `zip-multimc`— MultiMC/Prism instance, `instance.cfg` and/or `mmc-pack.json`.
 *
 * `import()` sniffs the archive first and only falls back to the caller's declared
 * `req.format` when the file cannot be read at all, so a mislabelled extension never
 * sends the wrong parser down the wrong path.
 */
import type { ModpackImportRequest } from '@shared/types'
import type { ModpackService } from '../core/contracts'
import { AppError } from '@shared/errors'
import { detect, detectWithZip } from './detect'
import { importMrpack } from './mrpack'
import { importCurse } from './curse'
import { importMultiMc } from './multimc'
import { exportModpack } from './exporter'
import type { ModpackServiceDeps } from './types'

export function createModpackService(deps: ModpackServiceDeps): ModpackService {
  const log = deps.log.child('modpack')

  async function pickFormat(req: ModpackImportRequest): Promise<ModpackImportRequest['format']> {
    const sniffed = detect(req.file) ?? (await detectWithZip(req.file))
    if (sniffed) return sniffed
    if (req.format) {
      log.warn(`无法读取归档内容，按调用方声明的格式 ${req.format} 处理：${req.file}`)
      return req.format
    }
    throw new AppError('unsupported', '无法识别整合包格式', req.file)
  }

  return {
    detect: (file: string) => detect(file),

    async import(req: ModpackImportRequest) {
      const format = await pickFormat(req)
      log.info(`导入整合包（${format}）：${req.file}`)
      if (format === 'mrpack') return importMrpack(deps, { ...req, format })
      if (format === 'curse-zip') return importCurse(deps, { ...req, format })
      return importMultiMc(deps, { ...req, format })
    },

    export(instanceId: string, target: string, format: 'mrpack' | 'zip') {
      return exportModpack(deps, instanceId, target, format)
    }
  }
}

export { detect, detectWithZip, chooseFormat, curseFileEntries } from './detect'
export { importMrpack, parseMrpackIndex, readMrpack, clientVisible } from './mrpack'
export { importCurse, parseCurseIndex, readCurse } from './curse'
export { importMultiMc, parseInstanceCfg, parseMmcPack, readMultiMc } from './multimc'
export { exportModpack, buildMrpack, buildPortableZip, collectTree, modrinthCdnUrl, SHARED_DIRS } from './exporter'
export { MAX_EXPORT_ENTRY_BYTES, MAX_EXPORT_FILES } from './common'
export type { ModpackServiceDeps, ImportOutcome } from './types'
export type { MrpackIndex, MrpackFileEntry } from './mrpack'
export type { CurseIndex, CurseFileEntry } from './curse'
export type { MultiMcIndex, MmcComponent } from './multimc'

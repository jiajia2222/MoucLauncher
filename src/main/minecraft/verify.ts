/**
 * On-disk verification of a download plan: every item is compared with
 * `fsx.fileMatches` (sha1 when known, size otherwise).
 */
import type { DownloadItem, DownloadPlan } from '@shared/types'
import { fileMatches, sizeOf } from '../core/fsx'

export interface PlanCheck {
  ok: boolean
  missing: DownloadItem[]
  sizeBytes: number
}

export async function checkItems(items: DownloadItem[]): Promise<PlanCheck> {
  const missing: DownloadItem[] = []
  let sizeBytes = 0
  for (const item of items) {
    const present = await fileMatches(item.target, item.sha1, item.size)
    if (!present) {
      missing.push(item)
      continue
    }
    sizeBytes += await sizeOf(item.target)
  }
  return { ok: missing.length === 0, missing, sizeBytes }
}

export async function checkPlan(plan: DownloadPlan): Promise<PlanCheck> {
  return checkItems(plan.items)
}

/**
 * Crash analysis service.
 *
 * `analyze()` is synchronous (it is the IPC handler for "分析这段文本"), while
 * `reports()` is the async one that can ask the mod service for the instance's mod
 * list — that is what lets the duplicate-mod / missing-dependency rules name real
 * jars instead of guessing.
 *
 * Rule order decides ties: highest severity wins, then the earliest table entry.
 * Nothing is ever asserted that the text does not contain — evidence lines are
 * copied verbatim from the report, and an unmatched report degrades to `info`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CrashAnalysis, InstalledMod, PathInfo } from '@shared/types'
import type { CrashService, ModService } from '../core/contracts'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'
import { instanceGameDir, instanceLogsDir } from '../core/paths'
import { readdirSafe, sizeOf } from '../core/fsx'
import { buildCrashModel, isExceptionLine, MAX_ANALYZED_CHARS, type CrashModel } from './parse'
import {
  CRASH_RULES,
  FALLBACK_ANALYSIS,
  SEVERITY_RANK,
  modNamesInReport,
  type CrashMatchContext,
  type CrashRule
} from './rules'

/** Newest reports we look at per instance; the UI shows a list, not a flood. */
export const MAX_REPORTS = 20

/** How many lines we quote back. */
const MAX_EVIDENCE = 6
const MAX_EVIDENCE_CHARS = 320

/** Bytes read from the tail of `logs/latest.log` when no report file exists. */
const LOG_TAIL_BYTES = 256 * 1024

export interface CrashServiceDeps {
  instances: InstanceStore
  paths: () => PathInfo
  mods: ModService
  log: Logger
}

interface RuleHit {
  rule: CrashRule
  index: number
  ctx: CrashMatchContext
}

function clip(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_EVIDENCE_CHARS ? `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…` : trimmed
}

function pushUnique(out: string[], value: string | undefined): void {
  if (!value) return
  const clean = clip(value)
  if (clean.length === 0) return
  if (!out.includes(clean)) out.push(clean)
}

/** Lines of the report that literally contain the rule's own pattern. */
function matchedLines(rule: CrashRule, model: CrashModel): string[] {
  const out: string[] = []
  if (!(rule.test instanceof RegExp)) return []
  for (const line of model.lines) {
    if (out.length >= MAX_EVIDENCE) break
    if (rule.test.test(line)) pushUnique(out, line)
  }
  return out
}

/** Nothing matched by the rule pattern: quote the cause chain instead. */
function chainEvidence(model: CrashModel, limit = MAX_EVIDENCE): string[] {
  const out: string[] = []
  for (const cause of [...model.causes].reverse()) pushUnique(out, cause)
  pushUnique(out, model.headline)
  pushUnique(out, model.description ? `Description: ${model.description}` : undefined)
  for (const line of model.head) pushUnique(out, line)
  for (const frame of model.frames.slice(0, 2)) pushUnique(out, frame)
  return out.slice(0, limit)
}

function collectEvidence(hit: RuleHit | undefined, model: CrashModel): string[] {
  const out: string[] = []
  if (hit?.ctx.note?.evidence) for (const line of hit.ctx.note.evidence) pushUnique(out, line)
  if (hit) for (const line of matchedLines(hit.rule, model)) pushUnique(out, line)
  for (const line of chainEvidence(model)) pushUnique(out, line)
  return out.slice(0, MAX_EVIDENCE)
}

/** Installed mod files whose id/stem the report actually mentions. */
function installedHint(model: CrashModel, mods: InstalledMod[]): string | undefined {
  if (mods.length === 0) return undefined
  const named = modNamesInReport(model).filter((n) => n.length >= 4)
  if (named.length === 0) return undefined
  const hits: string[] = []
  for (const mod of mods) {
    const keys = [mod.modId?.toLowerCase(), mod.fileName.toLowerCase()]
    for (const key of keys) {
      if (!key || key.length < 4) continue
      if (named.some((n) => n === key || key.startsWith(n) || n.startsWith(key))) {
        hits.push(mod.fileName)
        break
      }
    }
  }
  const unique = [...new Set(hits)].slice(0, 3)
  return unique.length > 0 ? `本实例 mods/ 里相关的是：${unique.join('、')}。` : undefined
}

/** Reads at most `bytes` from the end of a file, dropping the partial first line. */
async function readTail(file: string, bytes: number): Promise<string> {
  const total = await sizeOf(file)
  if (total === 0) return ''
  const length = Math.min(total, bytes)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, total - length)
    const text = buffer.toString('utf8')
    const firstBreak = text.indexOf('\n')
    return firstBreak >= 0 && firstBreak < text.length - 1 ? text.slice(firstBreak + 1) : text
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Pulls the crash block out of a log tail: the embedded report if the vanilla header
 * is there, otherwise the last exception line that is followed by stack frames.
 */
export function extractCrashBlock(text: string): string | undefined {
  const marker = text.lastIndexOf('---- Minecraft Crash Report ----')
  if (marker >= 0) return text.slice(marker, marker + MAX_ANALYZED_CHARS)
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    if (!isExceptionLine(line)) continue
    const ahead = lines.slice(i + 1, i + 41).join('\n')
    if (/\n\s*(?:at\s+\S|\.\.\.\s*\d+\s+more|Caused by:)/.test(ahead)) {
      return lines.slice(i).join('\n').slice(0, MAX_ANALYZED_CHARS)
    }
  }
  return undefined
}

export function createCrashService(deps: CrashServiceDeps): CrashService {
  const log = deps.log.child('crash')

  async function installedOf(instanceId: string): Promise<InstalledMod[]> {
    try {
      return await deps.mods.installed(instanceId)
    } catch (error) {
      log.warn(`读取模组列表失败: ${String(error)}`)
      return []
    }
  }

  function runRules(model: CrashModel, mods: InstalledMod[]): RuleHit | undefined {
    const haystack = model.text.toLowerCase()
    let best: RuleHit | undefined
    for (let index = 0; index < CRASH_RULES.length; index += 1) {
      const rule = CRASH_RULES[index]
      if (!rule) continue
      const ctx: CrashMatchContext = { model, haystack, mods }
      let matched = false
      try {
        matched = typeof rule.test === 'function' ? rule.test(ctx) : rule.test.test(haystack)
      } catch (error) {
        log.debug(`规则 ${rule.id} 判定异常: ${String(error)}`)
        matched = false
      }
      if (!matched) continue
      if (!best || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[best.rule.severity]) {
        best = { rule, index, ctx }
      }
    }
    return best
  }

  function analyzeText(text: string, opts: { reportPath?: string; mods?: InstalledMod[] }): CrashAnalysis {
    const model = buildCrashModel(text)
    const mods = opts.mods ?? []
    const hit = runRules(model, mods)
    const evidence = collectEvidence(hit, model)
    const result: CrashAnalysis = hit
      ? {
          title: hit.rule.title,
          cause: hit.ctx.note?.cause ?? hit.rule.cause,
          suggestion: appendHint(hit.rule.suggestion, hit.ctx.note?.suggestion, model, mods),
          severity: hit.rule.severity,
          evidence: evidence.length > 0 ? evidence : chainEvidence(model),
          tags: [...new Set([...hit.rule.tags, ...(hit.ctx.note?.tags ?? [])])]
        }
      : {
          title: FALLBACK_ANALYSIS.title,
          cause: model.lastException
            ? `${FALLBACK_ANALYSIS.cause}最后一条异常是：${clip(model.lastException)}`
            : FALLBACK_ANALYSIS.cause,
          suggestion: FALLBACK_ANALYSIS.suggestion,
          severity: 'info',
          evidence: evidence.length > 0 ? evidence : model.lastException ? [clip(model.lastException)] : [],
          tags: ['未分类']
        }
    if (opts.reportPath) result.reportPath = opts.reportPath
    return result
  }

  function appendHint(base: string, extra: string | undefined, model: CrashModel, mods: InstalledMod[]): string {
    const parts: string[] = [extra ?? base]
    const hint = installedHint(model, mods)
    if (hint && !parts[0]?.includes(hint)) parts.push(hint)
    return parts.join(' ')
  }

  async function reportFiles(gameDir: string): Promise<{ file: string; mtime: number }[]> {
    const dirs = [path.join(gameDir, 'crash-reports'), path.join(gameDir, 'logs', 'crash-reports')]
    const out: { file: string; mtime: number }[] = []
    for (const dir of dirs) {
      for (const name of await readdirSafe(dir)) {
        if (!/\.txt$/i.test(name)) continue
        const file = path.join(dir, name)
        const stat = await fs.stat(file).catch(() => undefined)
        if (!stat?.isFile()) continue
        out.push({ file, mtime: stat.mtimeMs })
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_REPORTS)
  }

  return {
    analyze: (text: string, reportPath?: string) => analyzeText(text, reportPath ? { reportPath } : {}),

    async reports(instanceId: string): Promise<CrashAnalysis[]> {
      const instance = deps.instances.get(instanceId)
      if (!instance) {
        log.warn(`分析崩溃报告时找不到实例 ${instanceId}`)
        return []
      }
      const gameDir = instanceGameDir(instance, deps.paths())
      const mods = await installedOf(instanceId)
      const files = await reportFiles(gameDir)
      if (files.length > 0) {
        const out: CrashAnalysis[] = []
        for (const entry of files) {
          const text = await fs.readFile(entry.file, 'utf8').catch(() => '')
          if (text.length === 0) continue
          out.push(analyzeText(text, { reportPath: entry.file, mods }))
        }
        if (out.length > 0) return out
      }

      // No report file: the game may have died before the writer ran, so mine the log tail.
      const latestLog = path.join(instanceLogsDir(instance, deps.paths()), 'latest.log')
      const tail = await readTail(latestLog, LOG_TAIL_BYTES)
      const block = tail.length > 0 ? extractCrashBlock(tail) : undefined
      if (!block) return []
      const analysis = analyzeText(block, { reportPath: latestLog, mods })
      analysis.tags = [...analysis.tags, '取自日志']
      log.info(`从 ${latestLog} 提取到崩溃信息：${analysis.title}`)
      return [analysis]
    }
  }
}

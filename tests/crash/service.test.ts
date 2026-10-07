import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstalledMod, PathInfo } from '@shared/types'
import { InstanceStore } from '../../src/main/core/instanceStore'
import { buildPaths } from '../../src/main/core/paths'
import { Logger } from '../../src/main/core/log'
import { createCrashService, MAX_REPORTS } from '../../src/main/crash/analyzer'
import { extractCrashBlock } from '../../src/main/crash/analyzer'
import {
  DUPLICATE_MOD_FILES,
  HEAP_OOM,
  LATEST_LOG_WITHOUT_CRASH,
  UNKNOWN_CRASH,
  latestLogTailWithCrash
} from './samples'

const installed = (fileName: string, modId: string): InstalledMod => ({
  fileName,
  modId,
  size: 2048,
  disabled: false,
  updatedAt: 1
})

describe('crash service', () => {
  let root = ''
  let appData = ''
  let gameRoot = ''
  let paths: () => PathInfo
  let instances: InstanceStore
  let log: Logger
  let mods: InstalledMod[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouc-crash-'))
    appData = path.join(root, 'app')
    gameRoot = path.join(root, 'game')
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(gameRoot, { recursive: true })
    paths = () => buildPaths(appData, gameRoot)
    instances = new InstanceStore(paths)
    log = new Logger('test', path.join(appData, 'logs'))
    mods = []
  })

  afterEach(async () => {
    log.close()
    await instances.flush()
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 })
    } catch {
      /* a locked temp dir is not worth failing the run over */
    }
  })

  function service() {
    return createCrashService({
      instances,
      paths,
      mods: { installed: async () => mods } as never,
      log
    })
  }

  function makeInstance(name: string): { id: string; gameDir: string } {
    const instance = instances.create({ name, versionId: '1.21.4', gameVersion: '1.21.4' })
    return { id: instance.id, gameDir: instances.gameDir(instance) }
  }

  function writeReport(dir: string, name: string, text: string, mtimeMs: number): string {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, text, 'utf8')
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
    return file
  }

  it('scans <gameDir>/crash-reports newest first and caps the list', async () => {
    const { id, gameDir } = makeInstance('崩溃排序')
    const dir = path.join(gameDir, 'crash-reports')
    const base = Date.parse('2026-10-07T10:00:00Z')
    const files: string[] = []
    for (let i = 0; i < MAX_REPORTS + 5; i += 1) {
      const text = i === MAX_REPORTS + 4 ? HEAP_OOM : UNKNOWN_CRASH
      files.push(writeReport(dir, `crash-${String(i).padStart(2, '0')}.txt`, text, base + i * 1000))
    }
    const analyses = await service().reports(id)
    expect(analyses).toHaveLength(MAX_REPORTS)
    expect(analyses[0]?.reportPath).toBe(files[MAX_REPORTS + 4])
    expect(analyses[0]?.title).toBe('内存不足（Java 堆）')
    // descending mtime
    const times = analyses.map((a) => Number(path.basename(a.reportPath ?? '').match(/\d+/)?.[0] ?? 0))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('ignores non-txt files and a missing crash-reports folder', async () => {
    const { id, gameDir } = makeInstance('只有非文本')
    writeReport(path.join(gameDir, 'crash-reports'), 'notes.md', HEAP_OOM, Date.now())
    expect(await service().reports(id)).toEqual([])
  })

  it('mines the tail of logs/latest.log when no report exists', async () => {
    const { id, gameDir } = makeInstance('日志挖掘')
    const logs = path.join(gameDir, 'logs')
    fs.mkdirSync(logs, { recursive: true })
    const noise = `${'setting user: Player42\n'.repeat(50)}${latestLogTailWithCrash()}`
    fs.writeFileSync(path.join(logs, 'latest.log'), noise, 'utf8')
    const analyses = await service().reports(id)
    expect(analyses).toHaveLength(1)
    expect(analyses[0]?.title).toBe('内存不足（Java 堆）')
    expect(analyses[0]?.reportPath).toBe(path.join(logs, 'latest.log'))
    expect(analyses[0]?.tags).toContain('取自日志')
  })

  it('returns nothing for a clean log and for an unknown instance', async () => {
    const { id, gameDir } = makeInstance('干净日志')
    fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(gameDir, 'logs', 'latest.log'), LATEST_LOG_WITHOUT_CRASH, 'utf8')
    expect(await service().reports(id)).toEqual([])
    expect(await service().reports('no-such-instance')).toEqual([])
  })

  it('names the real jars of a duplicate mod through the instance mod list', async () => {
    const { id, gameDir } = makeInstance('重复模组')
    writeReport(
      path.join(gameDir, 'crash-reports'),
      'crash-dup.txt',
      DUPLICATE_MOD_FILES,
      Date.now()
    )
    mods = [
      installed('sodium-fabric-0.58.0.jar', 'sodium'),
      installed('sodium-0.60.0+mc1.21.4.jar', 'sodium'),
      installed('iris-fabric-1.7.2.jar', 'iris')
    ]
    const analyses = await service().reports(id)
    expect(analyses).toHaveLength(1)
    expect(analyses[0]?.title).toBe('模组重复')
    expect(analyses[0]?.cause).toContain('sodium-fabric-0.58.0.jar')
    expect(analyses[0]?.cause).toContain('sodium-0.60.0+mc1.21.4.jar')
    expect(analyses[0]?.suggestion).toContain('mods/')
  })

  it('quotes lines that really exist in the report', async () => {
    const { id, gameDir } = makeInstance('证据可溯')
    const file = writeReport(path.join(gameDir, 'crash-reports'), 'crash-mem.txt', HEAP_OOM, Date.now())
    const [analysis] = await service().reports(id)
    const text = fs.readFileSync(file, 'utf8')
    expect(analysis?.evidence.length).toBeGreaterThan(0)
    for (const line of analysis?.evidence ?? []) {
      expect(text.replace(/\r/g, '')).toContain(line.replace(/…$/, ''))
    }
  })

  it('extractCrashBlock prefers the embedded vanilla report', () => {
    const block = extractCrashBlock(`some noise\n${HEAP_OOM}\ntrailing`)
    expect(block?.startsWith('---- Minecraft Crash Report ----')).toBe(true)
    expect(extractCrashBlock('nothing interesting here')).toBeUndefined()
  })

  it('analyze() works without any instance context', () => {
    const analysis = service().analyze(DUPLICATE_MOD_FILES, 'C:/mp/crash.txt')
    expect(analysis.reportPath).toBe('C:/mp/crash.txt')
    expect(analysis.title).toBe('模组重复')
    expect(analysis.severity).toBe('critical')
    // No mod list available: the message still quotes the loader's own line.
    expect(analysis.evidence.join('\n')).toContain('DuplicateModsFoundException')
  })
})

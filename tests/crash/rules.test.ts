import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { InstalledMod } from '@shared/types'
import { createCrashService } from '../../src/main/crash/analyzer'
import { buildCrashModel } from '../../src/main/crash/parse'
import {
  CLASS_FILE_MAJOR_TO_JAVA,
  CRASH_RULES,
  PACKAGE_PREFIX_TO_MOD,
  javaForClassMajor,
  likelyModForClass,
  type CrashMatchContext
} from '../../src/main/crash/rules'
import { SAMPLES } from './samples'

const RULES_BY_ID = new Map(CRASH_RULES.map((rule) => [rule.id, rule]))

function analyze(report: string) {
  const service = createCrashService({
    instances: { get: () => undefined } as never,
    paths: () => ({ gameRoot: '', instancesDir: '', logsDir: '' } as never),
    mods: { installed: async () => [] } as never,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as never
  })
  return service.analyze(report)
}

function contextFor(report: string, mods: InstalledMod[] = []): CrashMatchContext {
  const model = buildCrashModel(report)
  return { model, haystack: model.text.toLowerCase(), mods }
}

function runRule(id: string, ctx: CrashMatchContext): boolean {
  const rule = RULES_BY_ID.get(id)
  if (!rule) throw new Error(`没有规则 ${id}`)
  return typeof rule.test === 'function' ? rule.test(ctx) : rule.test.test(ctx.haystack)
}

const mod = (fileName: string, modId?: string, disabled = false): InstalledMod => ({
  fileName,
  modId,
  size: 1024,
  disabled,
  updatedAt: 1
})

describe('crash rule table', () => {
  it('covers every rule with at least one realistic sample', () => {
    const covered = new Set(SAMPLES.map((s) => s.ruleId).filter((id) => id !== '__fallback__'))
    for (const rule of CRASH_RULES) {
      expect(covered.has(rule.id), `规则 ${rule.id} 没有样本`).toBe(true)
    }
    expect(CRASH_RULES.length).toBe(covered.size)
  })

  it.each(SAMPLES)('matches $ruleId from a real-shaped report', ({ ruleId, report }) => {
    const analysis = analyze(report)
    if (ruleId === '__fallback__') {
      expect(analysis.severity).toBe('info')
      expect(analysis.title).toBe('未识别的崩溃')
      return
    }
    const rule = RULES_BY_ID.get(ruleId)
    expect(rule).toBeDefined()
    expect(analysis.title).toBe(rule?.title)
    expect(analysis.severity).toBe(rule?.severity)
    expect(analysis.tags).toEqual(expect.arrayContaining([rule!.tags[0]!]))
  })

  it('quotes evidence verbatim from the report', () => {
    for (const sample of SAMPLES) {
      const analysis = analyze(sample.report)
      expect(analysis.evidence.length, sample.ruleId).toBeGreaterThan(0)
      for (const line of analysis.evidence) {
        expect(sample.report.replace(/\r/g, '')).toContain(line.replace(/…$/, '').trim())
      }
    }
  })

  it('falls back to info + the last exception line when nothing matches', () => {
    const analysis = analyze(SAMPLES.find((s) => s.ruleId === '__fallback__')!.report!)
    expect(analysis.severity).toBe('info')
    expect(analysis.cause).toContain('com.example.WeirdProblem: nope')
    expect(analysis.suggestion).toContain('报告')
  })

  it('names both jars of a duplicate mod when the instance mod list is known', () => {
    const ctx = contextFor(
      SAMPLES.find((s) => s.ruleId === 'duplicate-mod')!.report!,
      [mod('sodium-fabric-0.58.0.jar', 'sodium'), mod('sodium-0.60.0+mc1.21.4.jar', 'sodium'), mod('iris.jar', 'iris')]
    )
    expect(runRule('duplicate-mod', ctx)).toBe(true)
    expect(ctx.note?.cause).toContain('sodium-fabric-0.58.0.jar')
    expect(ctx.note?.cause).toContain('sodium-0.60.0+mc1.21.4.jar')
    expect(ctx.note?.suggestion).toContain('移出 mods/')
  })

  it('does not treat Fabric\'s "Inconsistency found in dependent mods" as a duplicate', () => {
    const ctx = contextFor(
      SAMPLES.find((s) => s.ruleId === 'missing-dependency')!.report! +
        '\nCaused by: net.fabricmc.loader.impl.metadata.ModDependencyException: Inconsistency found in dependent mods. Please contact the mod author.'
    )
    expect(runRule('duplicate-mod', ctx)).toBe(false)
    expect(runRule('missing-dependency', ctx)).toBe(true)
  })

  it('resolves the class-file table through the cited mapping', () => {
    expect(javaForClassMajor(65)).toBe('21')
    expect(javaForClassMajor(61)).toBe('17')
    expect(javaForClassMajor(52)).toBe('8')
    expect(javaForClassMajor(44)).toBeUndefined()
    const ctx = contextFor(SAMPLES[0]!.report!)
    expect(runRule('java-class-version', ctx)).toBe(true)
    expect(ctx.note?.cause).toContain('Java 21')
    expect(ctx.note?.cause).toContain('Java 17')
    expect(ctx.note?.suggestion).toContain('21')
  })

  it('keeps the class-file table\'s citation in a comment', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const source = fs.readFileSync(path.resolve(here, '../../src/main/crash/rules.ts'), 'utf8')
    expect(source).toContain('docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html')
    expect(source).toContain('表 4.1-A')
    // The table itself must be a single const, and only the verified rows are certain.
    expect(Object.keys(CLASS_FILE_MAJOR_TO_JAVA).length).toBeGreaterThanOrEqual(21)
  })

  it('points at a likely mod for a missing class prefix', () => {
    expect(PACKAGE_PREFIX_TO_MOD.length).toBeGreaterThan(10)
    expect(likelyModForClass('org/joml/Matrix4f')).toContain('JOML')
    expect(likelyModForClass('net/fabricmc/api/FabricLoader')).toContain('Fabric API')
    expect(likelyModForClass('java/util/List')).toBeUndefined()
    const ctx = contextFor(SAMPLES.find((s) => s.ruleId === 'missing-dependency' && s.report.includes('NoClassDefFoundError'))!.report!)
    expect(runRule('missing-dependency', ctx)).toBe(true)
    expect(ctx.note?.cause).toContain('org.joml.Matrix4f')
    expect(ctx.note?.cause).toContain('JOML')
  })

  it('names the missing prerequisite of a mod', () => {
    const ctx = contextFor(SAMPLES.find((s) => s.ruleId === 'missing-dependency' && s.report.includes('ModResolutionException'))!.report!)
    expect(runRule('missing-dependency', ctx)).toBe(true)
    expect(ctx.note?.cause).toContain('sodium')
    expect(ctx.note?.suggestion).toContain('sodium')
  })

  it('reports a disabled prerequisite as disabled, not missing', () => {
    const ctx = contextFor(SAMPLES.find((s) => s.ruleId === 'missing-dependency' && s.report.includes('ModResolutionException'))!.report!, [
      mod('sodium-0.5.8.jar', 'sodium', true)
    ])
    expect(runRule('missing-dependency', ctx)).toBe(true)
    expect(ctx.note?.cause).toContain('已被禁用')
    expect(ctx.note?.suggestion).toContain('sodium-0.5.8.jar')
  })

  it('calls an installed-but-wrong prerequisite a version mismatch', () => {
    const ctx = contextFor(SAMPLES.find((s) => s.ruleId === 'missing-dependency' && s.report.includes('ModResolutionException'))!.report!, [
      mod('sodium-0.5.8.jar', 'sodium')
    ])
    expect(runRule('missing-dependency', ctx)).toBe(true)
    expect(ctx.note?.cause).toContain('版本不合适')
  })

  it('rejects a text that merely mentions requires in a satisfied dependency', () => {
    const ctx = contextFor('---- Minecraft Crash Report ----\njava.lang.IllegalStateException: unrelated\n\tat Foo.bar(Foo.java:1)\nMod menu requires nothing special here\n')
    // `requires` with a satisfied mod and no "not present" phrase must not fire.
    expect(runRule('missing-dependency', ctx)).toBe(false)
  })
})

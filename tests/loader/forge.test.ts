import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RawVersionJson } from '@shared/types'
import { AppError } from '@shared/errors'
import {
  buildProcessorCommands,
  isProcessable,
  planFromProfile,
  resolveLibraryArtifact,
  runProcessors
} from '../../src/main/loader/forge'
import type { ExecRunner, ForgeInstallProfile, ProcessorCommand } from '../../src/main/loader/types'
import { readFixtureJson } from './helpers'

function profilePair(dir: string): { profile: ForgeInstallProfile; versionJson: RawVersionJson } {
  return {
    profile: readFixtureJson<ForgeInstallProfile>(`loader/${dir}-install_profile.json`),
    versionJson: readFixtureJson<RawVersionJson>(`loader/${dir}-version.json`)
  }
}

const LIB_DIR = '/tmp/game/libraries'

const ctx = {
  libraryDir: LIB_DIR,
  root: '/tmp/game/instances/demo',
  minecraftJar: '/tmp/game/versions/1.21.1/1.21.1.jar',
  installer: path.join(LIB_DIR, 'net/minecraftforge/forge/1.21.1-52.1.0/forge-1.21.1-52.1.0-installer.jar'),
  java: '/tmp/java/bin/java.exe',
  minecraftVersion: '1.21.1',
  side: 'client' as const
}

describe('forge planFromProfile (real 1.21.1-52.1.0 installer)', () => {
  const { profile, versionJson } = profilePair('forge')

  it('is detected as processable (has processors + json member)', () => {
    expect(isProcessable(profile)).toBe(true)
    expect(profile.json).toBe('/version.json')
    expect(profile.versionInfo).toBeUndefined()
  })

  it('writes the embedded version json id and pulls its libraries', () => {
    const plan = planFromProfile(profile, versionJson, { libraryDir: LIB_DIR })
    expect(plan.versionId).toBe('1.21.1-forge-52.1.0')
    expect(plan.versionJson.inheritsFrom).toBe('1.21.1')
    const universal = plan.items.find((i) => i.target.includes('forge-1.21.1-52.1.0-universal.jar'))
    expect(universal).toBeDefined()
    expect(universal!.url).toMatch(/^https:\/\//)
    // install_profile libraries (bootstrap/gson/...) are merged in as well.
    const gson = plan.items.find((i) => i.target.endsWith(path.join('com/google/code/gson/gson/2.10.1/gson-2.10.1.jar')))
    expect(gson?.url).toBe('https://libraries.minecraft.net/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar')
  })

  it('resolveLibraryArtifact handles the downloads.artifact shape', () => {
    const art = resolveLibraryArtifact({ name: 'x:y:1', downloads: { artifact: { path: 'x/y/1/y-1.jar', url: 'https://r/x/y/1/y-1.jar', sha1: 'a'.repeat(40), size: 1 } } })
    expect(art).toEqual({ rel: 'x/y/1/y-1.jar', url: 'https://r/x/y/1/y-1.jar', sha1: 'a'.repeat(40), size: 1 })
  })

  it('substitutes processor tokens and skips server-only processors', async () => {
    const commands = buildProcessorCommands(profile, versionJson, ctx)
    // No server-only processor should appear (client side run).
    for (const c of commands) {
      expect(c.args.join(' ')).not.toContain('BUNDLER_EXTRACT') // BUNDLER_EXTRACT is server-scope here
      expect(c.args.join(' ')).not.toContain('--to {ROOT}/run.bat')
    }
    // {ROOT}/{INSTALLER} resolved from ctx; no unresolved server tokens remain in client args.
    const allArgs = commands.map((c) => c.args.join(' ')).join(' ')
    expect(allArgs).not.toContain('{ROOT}')
    expect(allArgs).not.toContain('{INSTALLER}')
    expect(allArgs).not.toContain('{SIDE}')
    // binpatcher: {MC_OFF}/{PATCHED}/{BINPATCH} all resolve to filesystem paths.
    const patcher = commands.find((c) => c.jar.includes('binarypatcher'))!
    expect(patcher).toBeDefined()
    const clean = patcher.args[patcher.args.indexOf('--clean') + 1]
    expect(clean).toContain(path.join(LIB_DIR, 'net/minecraft'))
    const apply = patcher.args[patcher.args.indexOf('--apply') + 1]
    expect(apply).toContain('installer.jar!/data/client.lzma')
    // classpath is joined absolute library paths.
    expect(patcher.classpath).toContain(path.join(LIB_DIR, 'net/minecraftforge/binarypatcher/1.2.0/'))
  })

  it('runProcessors feeds argv + stdin JSON to the injected exec runner', async () => {
    const recorded: ProcessorCommand[] = []
    const runner: ExecRunner = async (cmd) => {
      recorded.push(cmd)
    }
    await runProcessors(profile, versionJson, ctx, runner)
    expect(recorded.length).toBeGreaterThan(0)
    const payload = JSON.parse(recorded[0]!.stdin) as Record<string, unknown>
    expect(payload.root).toBe(ctx.root)
    expect(payload.side).toBe('client')
    expect(payload.minecraft_jar).toBe(ctx.minecraftJar)
    expect((payload.data as Record<string, string>).PATCHED).toContain('forge-1.21.1-52.1.0')
  })
})

describe('neoforge planFromProfile (real 1.20.1-47.1.106 installer)', () => {
  const { profile, versionJson } = profilePair('neoforge')

  it('maps the embedded version json + libraries', () => {
    const plan = planFromProfile(profile, versionJson, { libraryDir: LIB_DIR })
    expect(plan.versionId).toBe('1.20.1-forge-47.1.106')
    const loader = plan.items.find((i) => i.url.includes('net/neoforged/fancymodloader/loader/47.2.2/'))
    expect(loader?.url).toContain('https://maven.neoforged.net/releases/')
  })

  it('resolves MCP_VERSION / jarsplitter tokens for the client side', () => {
    const commands = buildProcessorCommands(profile, versionJson, ctx)
    const splitter = commands.find((c) => c.jar.includes('jarsplitter'))!
    expect(splitter).toBeDefined()
    const extra = splitter.args[splitter.args.indexOf('--extra') + 1]
    expect(extra).toContain(path.join(LIB_DIR, 'net/minecraft/client'))
    const merged = commands.find((c) => c.args.includes('{MERGED_MAPPINGS}') || c.args.some((a) => a.includes('mappings-merged')))
    // The merged mappings maven path must be substituted (no raw token left).
    for (const c of commands) expect(c.args.join(' ')).not.toContain('{MERGED_MAPPINGS}')
    void merged
  })
})

describe('legacy Forge (<=1.12) is rejected', () => {
  it('isProcessable false when there are no processors', () => {
    const legacy: ForgeInstallProfile = { version: '1.8.9-11.15.1.2318-1.8.9', minecraft: '1.8.9', versionInfo: { id: 'x' } }
    expect(isProcessable(legacy)).toBe(false)
    expect(() => {
      if (!isProcessable(legacy)) throw new AppError('unsupported', '请使用 Fabric/Quilt 或手动安装')
    }).toThrow(AppError)
  })
})

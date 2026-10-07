import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import { libraryPath, nativesDir, versionJarPath } from '../../src/main/core/paths'
import {
  CLASSIC_JVM_ARGS,
  buildArguments,
  finalizeClasspath,
  launcherFeatures,
  libraryClasspath,
  loggingClientPath,
  nativeJarFiles,
  osRuleContext,
  plannedLibraryFiles,
  placeholderTable,
  quoteArg,
  substitute,
  type ArgumentBuildContext,
  type Resolution
} from '../../src/main/minecraft/arguments'
import { createTestEnv, MODERN, ANCIENT, type TestEnv } from './fixtures'

let env: TestEnv | undefined
afterEach(() => {
  env?.cleanup()
  env = undefined
})

const DEFAULT_RES: Resolution = { width: 854, height: 480, fullscreen: false }
const CUSTOM_RES: Resolution = { width: 1280, height: 720, fullscreen: false }

function ctxBase(over: Partial<ArgumentBuildContext> = {}): ArgumentBuildContext {
  const p = env!.paths
  const r: import('@shared/types').ResolvedVersion = {
    id: '26.3',
    type: 'release',
    mainClass: MODERN.mainClass!,
    gameArgs: MODERN.arguments!.game!,
    jvmArgs: MODERN.arguments!.jvm!,
    libraries: MODERN.libraries!,
    client: MODERN.downloads!.client,
    assetIndex: MODERN.assetIndex,
    assetsVersion: '36',
    javaVersion: MODERN.javaVersion!,
    logging: MODERN.logging,
    jsonPath: '',
    clientJarPath: versionJarPath(p, '26.3'),
    raw: MODERN
  }
  const base: ArgumentBuildContext = {
    resolved: r,
    paths: p,
    account: { name: 'Steve', uuid: '5f1e4d8c-7a2b-4c3d-9e8f-0a1b2c3d4e5f', token: 'TOKEN-Steve', userType: 'legacy' },
    gameDir: p.gameRoot,
    versionName: '26.3',
    resolution: DEFAULT_RES,
    classpath: libraryClasspath(r, p, osRuleContext({})),
    virtualAssets: false,
    nativesDirectory: nativesDir(p, '26.3'),
    features: launcherFeatures(DEFAULT_RES, DEFAULT_RES),
    ...over
  }
  return base
}

describe('library selection (windows ctx)', () => {
  it('picks the windows native classifier and skips denied/os-mismatched libs', async () => {
    env = createTestEnv()
    const resolved = await env.versions.resolve('26.3')
    const ctx = osRuleContext({})

    const natives = nativeJarFiles(resolved, env.paths, ctx)
    expect(natives).toHaveLength(1)
    expect(natives[0]!.file).toBe(libraryPath(env.paths, 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'))
    expect(natives[0]!.exclude).toContain('META-INF/*.SF')

    const cp = libraryClasspath(resolved, env.paths, ctx)
    expect(cp).toContain(libraryPath(env.paths, 'com/google/code/gson/gson/2.11.0/gson-2.11.0.jar'))
    expect(cp).toContain(libraryPath(env.paths, 'org/lwjgl/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar'))
    // deny-on-windows + osx-only rules -> not on the classpath at all
    expect(cp.some((p) => p.includes('deny-me'))).toBe(false)
    expect(cp.some((p) => p.includes('mac-only'))).toBe(false)
    // natives never join the classpath
    expect(cp.some((p) => p.includes('natives-windows'))).toBe(false)
  })

  it('falls back to the maven coordinate for download-less legacy libraries', () => {
    env = createTestEnv()
    const ctx = osRuleContext({})
    const legacy = {
      name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.1-nightly.20130515',
      natives: { windows: 'natives-windows' },
      rules: [{ action: 'allow' as const }]
    }
    const files = plannedLibraryFiles(legacy, ctx, env.paths.librariesDir)
    expect(files).toHaveLength(1)
    expect(files[0]!.isNative).toBe(true)
    expect(files[0]!.relativePath.replace(/\\/g, '/')).toBe(
      'org/lwjgl/lwjgl/lwjgl-platform/2.9.1-nightly.20130515/lwjgl-platform-2.9.1-nightly.20130515-natives-windows.jar'
    )
  })
})

describe('placeholder substitution', () => {
  it('covers the full documented placeholder table', () => {
    env = createTestEnv()
    const table = placeholderTable(ctxBase())
    for (const key of [
      'auth_player_name',
      'version_name',
      'game_directory',
      'assets_root',
      'game_assets',
      'assets_index_name',
      'auth_uuid',
      'auth_access_token',
      'clientid',
      'auth_xuid',
      'user_type',
      'user_properties',
      'version_type',
      'resolution_width',
      'resolution_height',
      'natives_directory',
      'classpath',
      'launcher_name',
      'launcher_version'
    ]) {
      expect(table, `missing ${key}`).toHaveProperty(key)
    }
    expect(table.auth_player_name).toBe('Steve')
    expect(table.auth_uuid).toBe('5f1e4d8c7a2b4c3d9e8f0a1b2c3d4e5f') // dashes stripped
    expect(table.user_type).toBe('legacy')
    expect(table.user_properties).toBe('{}')
    expect(table.version_type).toBe('release')
    expect(table.launcher_name).toBe('MoucLauncher')
    expect(table.assets_index_name).toBe('36')
    expect(table.game_assets).toBe(path.join(env.paths.assetsDir, 'objects'))
    expect(substitute('${auth_player_name}|${unknown_key}', table)).toBe('Steve|${unknown_key}')
  })

  it('switches game_assets to the virtual tree only for map_to_resources indexes', () => {
    env = createTestEnv()
    const virtual = placeholderTable(ctxBase({ virtualAssets: true }))
    const hashed = placeholderTable(ctxBase({ virtualAssets: false }))
    expect(virtual.game_assets).toContain(path.join('virtual', '36'))
    expect(hashed.game_assets).toBe(path.join(env.paths.assetsDir, 'objects'))
  })

  it('classpath is ;-joined, quoted whole, with the vanilla jar last and no dupes', () => {
    env = createTestEnv()
    const a = libraryPath(env.paths, 'com/google/code/gson/gson/2.11.0/gson-2.11.0.jar')
    const jar = versionJarPath(env.paths, '26.3')
    const cp = finalizeClasspath([a, a, jar], jar)
    expect(cp).toEqual([a, jar])
    const built = buildArguments(ctxBase({ classpath: [a, a, jar] }))
    expect(built.classpath.at(-1)).toBe(jar)
    expect(built.jvmArgs).toContain(`"${[a, jar].join(';')}"`)
    expect(built.jvmArgs.indexOf('-cp')).toBeGreaterThanOrEqual(0)
    expect(built.jvmArgs[built.jvmArgs.indexOf('-cp') + 1]).toBe(`"${built.classpath.join(';')}"`)
  })
})

describe('rule filtering with activeArgs', () => {
  it('keeps windows-only jvm args and drops osx/demo-gated ones', () => {
    env = createTestEnv()
    const built = buildArguments(ctxBase())
    expect(built.jvmArgs).toContain('-XX:+IgnoreUnrecognizedVMOptions')
    expect(built.jvmArgs).not.toContain('-XstartOnFirstThread')
    expect(built.gameArgs).not.toContain('--demo')
  })

  it('hasCustomResolution is true only when the resolution was changed', () => {
    env = createTestEnv()
    const same = buildArguments(ctxBase())
    expect(same.gameArgs).not.toContain('--width')

    const changed = buildArguments(ctxBase({
      resolution: CUSTOM_RES,
      features: launcherFeatures(CUSTOM_RES, DEFAULT_RES)
    }))
    expect(changed.gameArgs).toContain('--width')
    expect(changed.gameArgs).toContain('1280')
    expect(changed.gameArgs).toContain('--height')
    expect(changed.gameArgs).toContain('720')

    expect(launcherFeatures(CUSTOM_RES, DEFAULT_RES).hasCustomResolution).toBe(true)
    expect(launcherFeatures(DEFAULT_RES, DEFAULT_RES).hasCustomResolution).toBe(false)
  })

  it('substitutes every core placeholder inside the game args', () => {
    env = createTestEnv()
    const built = buildArguments(ctxBase())
    const i = built.gameArgs.indexOf('--username')
    expect(built.gameArgs[i + 1]).toBe('Steve')
    expect(built.gameArgs[built.gameArgs.indexOf('--uuid') + 1]).toBe('5f1e4d8c7a2b4c3d9e8f0a1b2c3d4e5f')
    expect(built.gameArgs[built.gameArgs.indexOf('--accessToken') + 1]).toBe('TOKEN-Steve')
    expect(built.gameArgs[built.gameArgs.indexOf('--gameDir') + 1]).toBe(env.paths.gameRoot)
    expect(built.gameArgs.join(' ')).not.toMatch(/\$\{auth_|assets_|version_|user_|natives_|resolution_|classpath\}/)
  })

  it('appends the logging.client.argument with ${path} resolved to the xml file', () => {
    env = createTestEnv()
    const built = buildArguments(ctxBase())
    const logArg = built.jvmArgs.find((a) => a.startsWith('-Dlog4j.configurationFile='))
    expect(logArg).toBe(`-Dlog4j.configurationFile=${loggingClientPath(env.paths, 'client')}`)
  })

  it('launcher brand/version system properties are substituted', () => {
    env = createTestEnv()
    const built = buildArguments(ctxBase({ launcherVersion: '1.0.0' }))
    expect(built.jvmArgs).toContain('-Dminecraft.launcher.brand=MoucLauncher')
    expect(built.jvmArgs).toContain('-Dminecraft.launcher.version=1.0.0')
    expect(built.jvmArgs).toContain(`-Djava.library.path=${nativesDir(env.paths, '26.3')}`)
  })
})

describe('legacy (1.5.2, minecraftArguments only)', () => {
  it('falls back to the classic jvm arg set and expands minecraftArguments', async () => {
    env = createTestEnv()
    env.writeVersionJson(ANCIENT)
    const resolved = await env.versions.resolve('1.5.2')
    expect(resolved.jvmArgs).toEqual([])

    const built = buildArguments(ctxBase({
      resolved: {
        ...resolved,
        jvmArgs: resolved.jvmArgs,
        gameArgs: resolved.gameArgs
      },
      classpath: libraryClasspath(resolved, env.paths, osRuleContext({})),
      versionName: '1.5.2',
      virtualAssets: true,
      nativesDirectory: nativesDir(env.paths, '1.5.2')
    }))

    // Classic set from CLASSIC_JVM_ARGS, substituted.
    expect(CLASSIC_JVM_ARGS).toEqual(['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'])
    expect(built.jvmArgs[0]).toBe(`-Djava.library.path=${nativesDir(env.paths, '1.5.2')}`)
    expect(built.jvmArgs[1]).toBe('-cp')
    expect(built.jvmArgs[2]).toBe(`"${built.classpath.join(';')}"`)
    expect(built.mainClass).toBe('net.minecraft.client.Minecraft')

    expect(built.gameArgs.slice(0, 2)).toEqual(['--username', 'Steve'])
    const sessionIdx = built.gameArgs.indexOf('--session')
    expect(built.gameArgs[sessionIdx + 1]).toBe('TOKEN-Steve')
    expect(built.gameArgs[built.gameArgs.indexOf('--assetsDir') + 1]).toContain(path.join('virtual', 'legacy'))
    // Legacy classpath ends with the 1.5.2 client jar.
    expect(built.classpath.at(-1)).toBe(versionJarPath(env.paths, '1.5.2'))
  })

  it('quoteArg leaves already-quoted tokens alone', () => {
    expect(quoteArg('"a;b"')).toBe('"a;b"')
    expect(quoteArg('plain')).toBe('"plain"')
  })
})

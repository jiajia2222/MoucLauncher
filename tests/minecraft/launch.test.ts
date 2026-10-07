import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { GameLogLine } from '@shared/types'
import { versionJarPath } from '../../src/main/core/paths'
import {
  COMMAND_LINE_LIMIT,
  detectLogLevel,
  quickPlayArgs
} from '../../src/main/minecraft/launch'
import { createSpawnRecorder, createTestEnv, makeInstance, MODERN, type TestEnv } from './fixtures'

let env: TestEnv | undefined
afterEach(() => {
  env?.cleanup()
  env = undefined
})

describe('quickPlayArgs selection by version', () => {
  it('1.20+ (and 26.x) use --quickPlayMultiplayer, older use --server/--port', () => {
    expect(quickPlayArgs('26.3', 'mc.example', 25566)).toEqual(['--quickPlayMultiplayer', 'mc.example:25566'])
    expect(quickPlayArgs('1.20', 'mc.example', 25565)).toEqual(['--quickPlayMultiplayer', 'mc.example:25565'])
    expect(quickPlayArgs('1.20.1', 'h', 1)).toEqual(['--quickPlayMultiplayer', 'h:1'])
    expect(quickPlayArgs('1.19.4', 'h', 2)).toEqual(['--server', 'h', '--port', '2'])
    expect(quickPlayArgs('1.5.2', 'h', 3)).toEqual(['--server', 'h', '--port', '3'])
    expect(quickPlayArgs('b1.9', 'h', 4)).toEqual(['--server', 'h', '--port', '4'])
  })
})

describe('detectLogLevel', () => {
  it('classifies ERROR/WARN/Caused by and stack continuation lines', () => {
    expect(detectLogLevel('Loading starts', 'info')).toBe('info')
    expect(detectLogLevel('[main/ERROR] boom', 'info')).toBe('error')
    expect(detectLogLevel('[main/WARN] careful', 'info')).toBe('warn')
    expect(detectLogLevel('Caused by: java.lang.RuntimeException', 'info')).toBe('error')
    expect(detectLogLevel('    at com.example.Foo.bar(Foo.java:1)', 'error')).toBe('error')
    expect(detectLogLevel('    at com.example.Foo.bar(Foo.java:1)', 'warn')).toBe('warn')
    expect(detectLogLevel('    at com.example.Foo.bar(Foo.java:1)', 'info')).toBe('error')
    expect(detectLogLevel('... 12 more', 'error')).toBe('error')
  })
})

describe('launch with an injected spawnFn', () => {
  it('spawns java with the built argv, cwd and env; streams logs; records exit', async () => {
    env = createTestEnv()
    await env.installFiles('26.3')

    const recorder = createSpawnRecorder()
    const pushed: GameLogLine[] = []
    const game = env.makeGame({ spawnFn: recorder.fn, onLog: (l) => pushed.push(l) })
    const instance = makeInstance(env, { versionId: '26.3', name: 'L26' })

    const info = await game.launch({ instanceId: instance.id })
    expect(recorder.calls).toHaveLength(1)
    const call = recorder.calls[0]!
    expect(call.executable).toBe('C:/Java/jdk-25/bin/javaw.exe')
    expect(call.options.cwd).toBe(env.instances.gameDir(instance))
    expect(call.options.cwd).toBe(path.join(env.paths.instancesDir, instance.id))
    expect(call.options.windowsHide).toBe(true)
    expect(call.options.detached).toBe(false)
    expect(call.options.env).toBeTypeOf('object')
    expect(call.options.env!['PATH'] ?? call.options.env!['Path']).toBeTruthy()
    // Short command line -> no @argfile.
    expect(call.args[0]).not.toMatch(/^@/)

    expect(info.pid).toBe(42424)
    expect(info.instanceId).toBe(instance.id)
    expect(game.running()).toHaveLength(1)

    // argv: -cp with quoted classpath ending in the vanilla jar, main class, game args.
    const cpIdx = call.args.indexOf('-cp')
    expect(cpIdx).toBeGreaterThanOrEqual(0)
    const cpValue = call.args[cpIdx + 1]!
    expect(cpValue.startsWith('"') && cpValue.endsWith('"')).toBe(true)
    expect(cpValue.slice(1, -1).split(';').at(-1)).toBe(versionJarPath(env.paths, '26.3'))

    const mainIdx = call.args.indexOf('net.minecraft.client.main.Main')
    expect(mainIdx).toBeGreaterThan(0)
    expect(call.args[mainIdx + 1]).toBe('--username')
    expect(call.args[mainIdx + 2]).toBe('Steve')
    expect(call.args).toContain('-Xmx4096M')
    expect(call.args.some((a) => a.startsWith('-Dlog4j.configurationFile='))).toBe(true)
    // Natives jars are extracted, never on the command line.
    expect(call.args.join(' ')).not.toContain('lwjgl-3.3.3-natives-windows')
    expect(fs.existsSync(path.join(env.paths.versionsDir, '26.3', 'natives-windows', 'lwjgl.dll'))).toBe(true)

    // markLaunched bumped the instance.
    const after = env.instances.get(instance.id)!
    expect(after.playCount).toBe(1)
    expect(after.lastPlayedAt).toBeTypeOf('number')

    // Log streaming with level detection.
    const child = recorder.children[0]!
    child.stdout.write('[main/INFO] Loading\r\n[main/ERROR] Text component\r\n')
    child.stdout.write('partial line without newline')
    child.stderr.write('Something is WARNing\n')
    const logs = game.logs(instance.id)
    const textLevels = new Map(logs.filter((l) => !l.text.startsWith('启动')).map((l) => [l.text, l.level]))
    expect(textLevels.get('[main/INFO] Loading')).toBe('info')
    expect(textLevels.get('[main/ERROR] Text component')).toBe('error')
    expect(textLevels.get('Something is WARNing')).toBe('warn')
    // The flush of the tail line happens at stream end (async 'end' event).
    child.stdout.end()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(game.logs(instance.id).some((l) => l.text === 'partial line without newline')).toBe(true)
    expect(pushed.length).toBeGreaterThan(0)

    child.emit('exit', 0, null)
    const exit = await game.exited(instance.id)
    expect(exit).toMatchObject({ instanceId: instance.id, pid: 42424, code: 0, signal: null })
    expect(exit.analysis).toBeUndefined()
    expect(exit.durationMs).toBeGreaterThanOrEqual(0)
    expect(game.running()).toHaveLength(0)
  }, 30_000)

  it('appends quickPlay targets from the instance and from the request override', async () => {
    env = createTestEnv()
    await env.installFiles('26.3')
    const game = env.makeGame()
    const instance = makeInstance(env, {
      versionId: '26.3',
      server: { address: 'play.example', port: 25566 }
    })
    const plan = await game.buildPlan({ instanceId: instance.id })
    expect(plan.gameArgs.slice(-2)).toEqual(['--quickPlayMultiplayer', 'play.example:25566'])

    const overridden = await game.buildPlan({
      instanceId: instance.id,
      server: { address: '1.2.3.4', port: 25567 }
    })
    expect(overridden.gameArgs.slice(-2)).toEqual(['--quickPlayMultiplayer', '1.2.3.4:25567'])
  }, 30_000)

  it('pre-1.20 instances get --server/--port instead', async () => {
    env = createTestEnv()
    await env.installFiles('1.5.2')
    const game = env.makeGame()
    const instance = makeInstance(env, {
      versionId: '1.5.2',
      server: { address: 'old.example', port: 25565 }
    })
    const plan = await game.buildPlan({ instanceId: instance.id })
    const tail = plan.gameArgs.slice(-4)
    expect(tail).toEqual(['--server', 'old.example', '--port', '25565'])
  }, 30_000)

  it('writes a @argfile when the command line is too long, but only for Java 9+', async () => {
    env = createTestEnv({ javaMajor: 25 })
    await env.installFiles('26.3')
    const recorder = createSpawnRecorder()
    const game = env.makeGame({ spawnFn: recorder.fn })
    const junk = `-Djunk=${'X'.repeat(COMMAND_LINE_LIMIT + 500)}`
    const instance = makeInstance(env, { versionId: '26.3', jvmArgs: junk })

    const info = await game.launch({ instanceId: instance.id })
    expect(info.pid).toBe(42424)
    const call = recorder.calls[0]!
    expect(call.args).toHaveLength(1)
    expect(call.args[0]).toMatch(/^@.*\.txt$/)
    const argFile = call.args[0]!.slice(1)
    const body = fs.readFileSync(argFile, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
    expect(body.length).toBeGreaterThan(10)
    expect(body.every((line) => line.startsWith('"') && line.endsWith('"'))).toBe(true)
    expect(body.some((line) => line === `"${junk}"`)).toBe(true)

    // Java 8 cannot read @argfiles -> a clear AppError instead.
    const oldJava = createTestEnv({ javaMajor: 8 })
    await oldJava.installFiles('1.5.2')
    const recorder8 = createSpawnRecorder()
    const game8 = oldJava.makeGame({ spawnFn: recorder8.fn })
    const inst8 = makeInstance(oldJava, { versionId: '1.5.2', jvmArgs: junk })
    await expect(game8.launch({ instanceId: inst8.id })).rejects.toMatchObject({ code: 'unsupported' })
    expect(recorder8.calls).toHaveLength(0)
    oldJava.cleanup()
  }, 60_000)

  it('offline launch skips the pre-launch repair download', async () => {
    env = createTestEnv()
    env.writeVersionJson(MODERN)
    const recorder = createSpawnRecorder()
    const game = env.makeGame({ spawnFn: recorder.fn })
    const instance = makeInstance(env, { versionId: '26.3' })
    const info = await game.launch({ instanceId: instance.id, offline: true })
    expect(info.pid).toBe(42424)
    // Offline -> the missing files are noted, but never downloaded.
    expect(env.downloader.plans.filter((p) => p.title.startsWith('启动前修复'))).toHaveLength(0)
    const child = recorder.children[0]!
    child.emit('exit', 1, null)
    const exit = await game.exited(instance.id)
    expect(exit.code).toBe(1)
  }, 30_000)
})

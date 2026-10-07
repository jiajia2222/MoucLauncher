/**
 * GameService: resolve -> verify -> (repair) -> natives -> spawn.
 * The child-process call site is injectable (`spawnFn`) so tests can assert the
 * exact argv / cwd / env without starting Java.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { AppError } from '@shared/errors'
import type {
  Account,
  GameExitInfo,
  GameLogLine,
  GameProcessInfo,
  Instance,
  LaunchPlan,
  LaunchRequest,
  LogLevel,
  PathInfo,
  ResolvedVersion
} from '@shared/types'
import { compareVersionIds, parseServerAddress, uid } from '@shared/utils'
import { ensureDir } from '../core/fsx'
import { nativesDir as nativesDirFor } from '../core/paths'
import type {
  AccountService,
  Downloader,
  GameService,
  HttpClient,
  JavaService
} from '../core/contracts'
import type { SettingsStore } from '../core/config'
import type { InstanceStore } from '../core/instanceStore'
import type { Logger } from '../core/log'
import {
  buildArguments,
  launcherFeatures,
  libraryClasspath,
  nativeJarFiles,
  osRuleContext,
  quoteArg,
  type AccountPlaceholders
} from './arguments'
import { assetObjects, mapsToResources, writeVirtualCopies, type AssetIndexDoc } from './assets'
import { createInstaller, waitForJob } from './install'
import { createManifest } from './manifest'
import { ensureNatives } from './natives'
import { createResolver } from './resolve'

/** Windows command-line budget before we must switch to a `@argfile`. */
export const COMMAND_LINE_LIMIT = 30_000
const RING_BUFFER = 2000

export type SpawnFn = (executable: string, args: string[], options: SpawnOptions) => ChildProcess

export interface GameServiceDeps {
  http: HttpClient
  downloader: Downloader
  settings: SettingsStore
  instances: InstanceStore
  paths: () => PathInfo
  java: JavaService
  accounts: AccountService
  log: Logger
  /** Push every game log line somewhere (renderer event bus). */
  onLog?: (line: GameLogLine) => void
  /** Test seam around node:child_process.spawn. */
  spawnFn?: SpawnFn
  /** Launcher version string shown in the command line / system property. */
  launcherVersion?: string
}

interface Session {
  info: GameProcessInfo
  child: ChildProcess
  lines: GameLogLine[]
  startedAt: number
  lastLevel: LogLevel
  exited: Promise<GameExitInfo>
  resolveExit: (exit: GameExitInfo) => void
  finished: boolean
}

/** Level detection for raw game output. */
export function detectLogLevel(text: string, lastLevel: LogLevel): LogLevel {
  if (text.includes('ERROR')) return 'error'
  if (text.includes('WARN')) return 'warn'
  if (text.includes('Caused by')) return 'error'
  // Stack continuation: "    at ..." / "... 12 more".
  if (/^\s+at\s/.test(text) || /^\s*\.\.\.\s*\d+\s+more/.test(text)) {
    return lastLevel === 'warn' ? 'warn' : 'error'
  }
  return 'info'
}

/** `--quickPlayMultiplayer` exists from 1.20 on; older builds need --server/--port. */
export function quickPlayArgs(versionId: string, address: string, port: number): string[] {
  const base = versionId.split('-')[0] ?? versionId
  if (compareVersionIds(base, '1.20') >= 0) {
    return ['--quickPlayMultiplayer', `${address}:${port}`]
  }
  return ['--server', address, '--port', String(port)]
}

async function readIndexDoc(paths: PathInfo, resolved: ResolvedVersion, deps: GameServiceDeps): Promise<AssetIndexDoc | undefined> {
  if (!resolved.assetIndex) return undefined
  try {
    const raw = await fs.promises.readFile(assetIndexLocal(paths, resolved), 'utf8')
    return JSON.parse(raw) as AssetIndexDoc
  } catch {
    try {
      return await deps.http.json<AssetIndexDoc>(resolved.assetIndex.url)
    } catch {
      return undefined
    }
  }
}

function assetIndexLocal(paths: PathInfo, resolved: ResolvedVersion): string {
  return path.join(paths.assetsDir, 'indexes', `${resolved.assetIndex?.id ?? resolved.assetsVersion}.json`)
}

function splitArgs(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0)
}

export function createGameService(deps: GameServiceDeps): GameService {
  const manifest = createManifest(deps)
  const resolver = createResolver({ http: deps.http, paths: deps.paths, manifest, log: deps.log })
  const installer = createInstaller({
    http: deps.http,
    downloader: deps.downloader,
    instances: deps.instances,
    paths: deps.paths,
    manifest,
    resolver,
    log: deps.log
  })
  const sessions = new Map<string, Session>()

  function requireRunning(instanceId: string): Session {
    const session = sessions.get(instanceId)
    if (!session) throw new AppError('not-found', `实例 ${instanceId} 没有正在运行的游戏`)
    return session
  }

  function accountPlaceholders(account: Account, creds: { uuid: string; token: string; type: string }): AccountPlaceholders {
    const userType =
      account.type === 'microsoft' ? 'Mojang' : account.type === 'offline' ? 'legacy' : creds.type || 'Mojang'
    return { name: account.name, uuid: creds.uuid, token: creds.token, userType }
  }

  async function assemble(
    request: LaunchRequest
  ): Promise<{ plan: LaunchPlan; argv: string[]; resolved: ResolvedVersion; instance: Instance }> {
    const paths = deps.paths()
    const instance = deps.instances.require(request.instanceId)
    const resolved = await resolver.resolve(instance.versionId)

    const account = request.accountId
      ? (await deps.accounts.list()).find((a) => a.id === request.accountId)
      : await deps.accounts.current()
    if (!account) throw new AppError('auth', '没有可用的游戏账号，请先添加账号')
    const creds = await deps.accounts.credentials(account)

    const runtime = await deps.java.forInstance(instance, resolved)
    const gameDir = deps.instances.gameDir(instance)
    const settings = deps.settings.get()

    const indexDoc = await readIndexDoc(paths, resolved, deps)
    const virtual = indexDoc ? mapsToResources(indexDoc) : false

    const features = launcherFeatures(instance.resolution, settings.defaultResolution)
    const ruleCtx = osRuleContext(features)
    const libraryClasspathEntries = libraryClasspath(resolved, paths, ruleCtx)
    const natives = nativesDirFor(paths, resolved.id)

    const target = request.server ?? instance.server
    const extraGame: string[] = [...splitArgs(instance.gameArgs), ...(request.gameArgs ?? [])]
    if (target) {
      const parsed = parseServerAddress(target.address, target.port) ?? { host: target.address, port: target.port }
      const versionForQuickPlay = resolved.raw.inheritsFrom ?? instance.gameVersion ?? resolved.id
      extraGame.push(...quickPlayArgs(versionForQuickPlay, parsed.host, parsed.port))
    }

    const built = buildArguments({
      resolved,
      paths,
      account: accountPlaceholders(account, creds),
      gameDir,
      versionName: resolved.id,
      resolution: instance.resolution,
      classpath: libraryClasspathEntries,
      virtualAssets: virtual,
      nativesDirectory: natives,
      launcherVersion: deps.launcherVersion,
      features,
      extraJvmArgs: ['-Xmx' + instance.memoryMb + 'M', '-Xms' + instance.memoryMb + 'M', ...splitArgs(instance.jvmArgs), ...splitArgs(settings.extraJvmArgs)],
      extraGameArgs: extraGame
    })

    const argv = [...built.jvmArgs, built.mainClass, ...built.gameArgs]
    const commandLine = [runtime.executable, ...argv].map(quoteArg).join(' ')

    const plan: LaunchPlan = {
      javaExecutable: runtime.executable,
      jvmArgs: built.jvmArgs,
      gameArgs: built.gameArgs,
      commandLine,
      classpath: built.classpath,
      nativesDir: natives,
      gameDir,
      versionName: resolved.id,
      javaMajor: runtime.major,
      notes: []
    }
    return { plan, argv, resolved, instance }
  }

  function attachOutput(session: Session, instanceId: string): void {
    const handle = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split(/\r?\n/)
        pending = parts.pop() ?? ''
        for (const line of parts) pushLine(line)
      })
      stream.on('end', () => {
        if (pending.length > 0) pushLine(pending)
      })
      const pushLine = (text: string): void => {
        if (text.length === 0) return
        const level = detectLogLevel(text, session.lastLevel)
        session.lastLevel = level
        const line: GameLogLine = { instanceId, ts: Date.now(), level, text }
        session.lines.push(line)
        if (session.lines.length > RING_BUFFER) session.lines.splice(0, session.lines.length - RING_BUFFER)
        try {
          deps.onLog?.(line)
        } catch {
          /* the bus must never break the game pipe */
        }
      }
    }
    handle(session.child.stdout)
    handle(session.child.stderr)
  }

  return {
    async buildPlan(request) {
      const { plan } = await assemble(request)
      return plan
    },

    async preview(instanceId) {
      const { plan } = await assemble({ instanceId })
      return plan
    },

    async launch(request): Promise<GameProcessInfo> {
      const instanceId = request.instanceId
      if (sessions.has(instanceId) && !sessions.get(instanceId)!.finished) {
        throw new AppError('busy', `实例 ${instanceId} 已在运行`)
      }
      const { plan, argv, resolved, instance } = await assemble(request)
      const paths = deps.paths()

      // Pre-launch file check.
      const check = await installer.checkInstalled(instance.versionId)
      if (!check.ok) {
        if (request.offline) {
          plan.notes.push(`离线启动：${check.missing.length} 个文件缺失`)
        } else {
          const job = await deps.downloader.enqueue({
            title: `启动前修复 ${instance.versionId}`,
            kind: 'misc',
            items: check.missing
          })
          await waitForJob(deps.downloader, job.id)
          plan.notes.push(`启动前补全了 ${check.missing.length} 个文件`)
          await installer.postInstall(instance.versionId)
        }
      }

      // Natives must be unpacked even when nothing was downloaded this run.
      const ruleCtx = osRuleContext(launcherFeatures(instance.resolution, deps.settings.get().defaultResolution))
      await ensureNatives(paths, resolved.id, nativeJarFiles(resolved, paths, ruleCtx))
      if (resolved.assetIndex) {
        const indexDoc = await readIndexDoc(paths, resolved, deps)
        if (indexDoc && mapsToResources(indexDoc)) {
          await writeVirtualCopies(paths, resolved.assetIndex.id, assetObjects(indexDoc))
        }
      }

      await ensureDir(plan.gameDir)

      // Windows 8.1+ command budget: fall back to a Java @argfile (supported on Java 9+).
      let spawnArgs = argv
      const joined = argv.join(' ')
      if (joined.length > COMMAND_LINE_LIMIT) {
        if (plan.javaMajor < 9) {
          throw new AppError(
            'unsupported',
            `命令行长度 ${joined.length} 超过 ${COMMAND_LINE_LIMIT}，而 Java ${plan.javaMajor} 不支持 @argfile；请使用 Java 9+ 或精简 classpath`,
            plan.gameDir
          )
        }
        const argFile = path.join(paths.configDir, 'cache', 'launch', `args-${uid('launch')}.txt`)
        await ensureDir(path.dirname(argFile))
        await fs.promises.writeFile(argFile, argv.map(quoteArg).join('\r\n') + '\r\n', 'utf8')
        spawnArgs = [`@${argFile}`]
        plan.notes.push(`命令行过长，已改用参数文件 ${argFile}`)
      }

      const spawnFn: SpawnFn = deps.spawnFn ?? ((exe, args, options) => nodeSpawn(exe, args, options))
      const env: NodeJS.ProcessEnv = { ...process.env }
      const child = spawnFn(plan.javaExecutable, spawnArgs, {
        cwd: plan.gameDir,
        windowsHide: true,
        detached: false,
        env
      })

      const startedAt = Date.now()
      const info: GameProcessInfo = {
        pid: child.pid ?? 0,
        instanceId,
        startedAt,
        commandLine: plan.commandLine,
        javaExecutable: plan.javaExecutable,
        gameDir: plan.gameDir
      }
      let resolveExit: (exit: GameExitInfo) => void = () => undefined
      const exited = new Promise<GameExitInfo>((resolve) => {
        resolveExit = resolve
      })
      const session: Session = { info, child, lines: [], startedAt, lastLevel: 'info', exited, resolveExit, finished: false }
      sessions.set(instanceId, session)

      const systemLine = (text: string): void => {
        const line: GameLogLine = { instanceId, ts: Date.now(), level: 'system', text }
        session.lines.push(line)
        try {
          deps.onLog?.(line)
        } catch {
          /* ignore */
        }
      }
      systemLine(`启动 ${instance.name} (${resolved.id})，PID ${info.pid}`)

      attachOutput(session, instanceId)

      child.on('exit', (code, signal) => {
        session.finished = true
        const exitInfo: GameExitInfo = {
          instanceId,
          pid: info.pid,
          code,
          signal,
          durationMs: Date.now() - startedAt
          // `analysis` is intentionally left undefined; the container adds it.
        }
        systemLine(`游戏退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`)
        resolveExit(exitInfo)
      })
      child.on('error', (error) => {
        deps.log.error(`启动失败: ${String(error)}`)
        systemLine(`启动失败: ${error.message}`)
      })

      deps.instances.markLaunched(instanceId)
      return info
    },

    async kill(instanceId) {
      const session = requireRunning(instanceId)
      session.child.kill()
    },

    running() {
      return [...sessions.values()].filter((s) => !s.finished).map((s) => s.info)
    },

    logs(instanceId, lines = 200) {
      const session = sessions.get(instanceId)
      if (!session) return []
      return session.lines.slice(-Math.max(1, lines))
    },

    async exited(instanceId) {
      return requireRunning(instanceId).exited
    }
  }
}

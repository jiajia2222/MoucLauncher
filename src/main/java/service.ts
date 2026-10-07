/**
 * JavaService: resolves the runtime an instance should launch with.
 *
 * Priority (per spec): instance.java.mode==='custom'&&path -> pinned id in the
 * Adoptium registry -> settings.customJavaPath -> a scanned runtime with the
 * exact required major, else the smallest major >= it (Temurin/Microsoft and
 * x64 preferred) -> auto-provision following settings.javaMode.
 */
import type { Instance, JavaProvisionRequest, JavaProvisionResult, JavaRuntime, JavaSource, PathInfo, ResolvedVersion, Settings } from '@shared/types'
import { AppError } from '@shared/errors'
import type { JavaService } from '../core/contracts'
import type { Downloader, HttpClient } from '../core/contracts'
import type { Logger } from '../core/log'
import { createAdoptiumProvisioner } from './adoptium'
import { defaultExecRunner, locateExecutable, probeRuntime, scanJava, type JavaExecRunner, type SettingsLike } from './scanner'

export interface JavaServiceDeps {
  downloader: Downloader
  http: HttpClient
  settings: SettingsLike
  paths: () => PathInfo
  log: Logger
  /** Overridable so tests never execute real Java. */
  execRunner?: JavaExecRunner
}

/** The message the user sees when they picked the Mojang component mode. */
export const MOJANG_RUNTIME_UNREACHABLE =
  'Mojang 的 java-runtime 元数据接口当前不可用（所有已知 URL 均返回 404），无法自动下载官方组件；请在 设置 中改用 Adoptium 自动下载。'

function requiredMajor(instance: Instance, resolved: ResolvedVersion): number {
  const pinned = instance.java?.major
  if (typeof pinned === 'number' && pinned > 0) return pinned
  return resolved.javaVersion?.majorVersion ?? 17
}

function vendorScore(vendor: string): number {
  return /temurin|adoptium|microsoft/i.test(vendor) ? 0 : 1
}

function archScore(arch: JavaRuntime['arch']): number {
  switch (arch) {
    case 'x64':
      return 0
    case 'arm64':
      return 1
    case 'unknown':
      return 2
    default:
      return 3
  }
}

/** Exact major first, then the smallest major >= required; Temurin/Microsoft then x64. */
export function selectRuntime(pool: JavaRuntime[], required: number): JavaRuntime | null {
  const usable = pool.filter((r) => !r.broken && r.major >= required)
  usable.sort(
    (a, b) =>
      a.major - b.major ||
      vendorScore(a.vendor) - vendorScore(b.vendor) ||
      archScore(a.arch) - archScore(b.arch) ||
      a.source.localeCompare(b.source) ||
      a.executable.localeCompare(b.executable)
  )
  return usable[0] ?? null
}

export function createJavaService(deps: JavaServiceDeps): JavaService {
  const runner = deps.execRunner ?? defaultExecRunner()
  const adoptium = createAdoptiumProvisioner({
    http: deps.http,
    downloader: deps.downloader,
    paths: deps.paths,
    log: deps.log
  })

  const settings = (): Settings => deps.settings.get()

  /** Build a runtime record from any user-supplied path (dir, bin dir or exe). */
  async function runtimeFromPath(p: string, source: JavaSource): Promise<JavaRuntime | undefined> {
    const located = await locateExecutable(p)
    if (!located) return undefined
    return probeRuntime(located.exe, located.root, source, runner)
  }

  /** Scanned + provisioned runtimes, deduplicated by executable path. */
  async function collectAll(): Promise<JavaRuntime[]> {
    const [scanned, provisioned] = await Promise.all([scanJava({ settings: deps.settings, execRunner: runner }), adoptium.listProvisioned()])
    const byExe = new Map<string, JavaRuntime>()
    for (const runtime of [...provisioned, ...scanned]) {
      const key = runtime.executable.toLowerCase()
      if (!byExe.has(key)) byExe.set(key, runtime)
    }
    return [...byExe.values()]
  }

  async function autoProvision(major: number): Promise<JavaRuntime> {
    const mode = settings().javaMode
    if (mode === 'custom') {
      throw new AppError('java-missing', `未找到 Java ${major}，且当前为“仅使用本机 Java”模式`, '在 设置→Java 中添加扫描目录或关闭该模式')
    }
    if (mode === 'mojang-component') {
      throw new AppError('unsupported', MOJANG_RUNTIME_UNREACHABLE, 'javaMode=mojang-component')
    }
    // 'adoptium' and 'auto' both provision from Adoptium (Mojang metadata is dead).
    const result = await adoptium.provision({ major, imageType: 'jre' })
    return result.runtime
  }

  async function search(
    instance: Instance,
    resolved: ResolvedVersion,
    allowProvision: boolean
  ): Promise<{ runtime: JavaRuntime | null; major: number }> {
    const required = requiredMajor(instance, resolved)
    const s = settings()

    // 1. Explicit custom path on the instance.
    if (instance.java?.mode === 'custom' && instance.java.path) {
      const runtime = await runtimeFromPath(instance.java.path, 'manual')
      if (runtime && !runtime.broken) return { runtime, major: required }
      deps.log.warn(`实例钉定的 Java 路径不可用：${instance.java.path}${runtime?.broken ? `（${runtime.broken}）` : ''}`)
    }

    // 2. Pinned id/path in our own registry.
    if (instance.java?.mode === 'pinned' && instance.java.path) {
      const provisioned = await adoptium.lookupByPath(instance.java.path)
      if (provisioned) return { runtime: provisioned, major: required }
      const scanned = (await collectAll()).find((r) => !r.broken && r.executable.toLowerCase() === instance.java!.path!.toLowerCase())
      if (scanned) return { runtime: scanned, major: required }
    }

    // 3. Global custom path.
    if (s.customJavaPath && s.customJavaPath.trim().length > 0) {
      const runtime = await runtimeFromPath(s.customJavaPath, 'manual')
      if (runtime && !runtime.broken) return { runtime, major: required }
    }

    // 4. Scanned/provisioned runtimes.
    const pick = selectRuntime(await collectAll(), required)
    if (pick) return { runtime: pick, major: required }

    // 5. Auto-provision (skipped by peek).
    if (!allowProvision) return { runtime: null, major: required }
    const runtime = await autoProvision(required)
    return { runtime, major: required }
  }

  return {
    async scan(): Promise<JavaRuntime[]> {
      return scanJava({ settings: deps.settings, execRunner: runner })
    },

    async list(): Promise<JavaRuntime[]> {
      return collectAll()
    },

    async provision(req: JavaProvisionRequest): Promise<JavaProvisionResult> {
      return adoptium.provision({ major: req.major, imageType: req.imageType ?? 'jre', targetDir: req.targetDir })
    },

    async remove(id: string): Promise<void> {
      await adoptium.remove(id)
    },

    async forInstance(instance: Instance, resolved: ResolvedVersion): Promise<JavaRuntime> {
      const result = await search(instance, resolved, true)
      if (!result.runtime) {
        // search() throws instead of returning null when provisioning is allowed,
        // but keep a hard fail for safety.
        throw new AppError('java-missing', `未找到可用的 Java ${result.major}`)
      }
      return result.runtime
    },

    async peek(instance: Instance, resolved: ResolvedVersion): Promise<{ runtime: JavaRuntime | null; major: number }> {
      return search(instance, resolved, false)
    }
  }
}

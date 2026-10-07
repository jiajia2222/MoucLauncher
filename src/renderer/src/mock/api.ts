/**
 * Browser-preview implementation of `MoucApi`.
 *
 * Installed by main.ts whenever `window.mouc` is absent, so the renderer runs with no
 * main process. It is a *full* implementation: every method in the interface exists, is
 * typed against it, returns a `Result`, and the interesting ones behave like the real
 * thing — download jobs advance on a timer and push `EVENTS.progress` / `EVENTS.jobFinished`,
 * relay hosting walks through its states, Microsoft login polls through stages, settings
 * round-trip and broadcast `EVENTS.settings`.
 *
 * `?empty` swaps every collection for an empty one so empty states are reachable.
 */
import { EVENTS } from '@shared/ipc'
import { AppError, ok, fail } from '@shared/errors'
import type { EventName, MoucApi, WindowState, LoaderOption, RelayHostRequest as IpcRelayHostRequest } from '@shared/ipc'
import type {
  Account,
  CrashAnalysis,
  DownloadJob,
  DownloadProgress,
  ErrorCode,
  GameDirStats,
  GameExitInfo,
  GameLogLine,
  GameProcessInfo,
  DownloadKind,
  Instance,
  InstanceSummary,
  ProjectKind,
  JavaProvisionResult,
  JavaRuntime,
  LanGame,
  LauncherStatus,
  LaunchPlan,
  MicrosoftLoginProgress,
  ModpackManifest,
  InstalledMod,
  ProjectVersion,
  RelayStatus,
  Result,
  ServerPingResult,
  Settings,
  SkinInfo,
  UpdateInfo
} from '@shared/types'
import * as seed from './seed'

type Handler = (payload: unknown) => void

let idSeq = 0

/** Instance/job/session ids, shaped like the main process ones. */
function nextId(prefix: string): string {
  return `${prefix}-${(++idSeq).toString(36)}-${Date.now().toString(36).slice(-4)}`
}

const TICK_MS = 250

export interface MockOptions {
  /** Zero-state: no instances, versions, accounts, jobs. */
  empty?: boolean
}

export function createMockApi(options: MockOptions = {}): MoucApi {
  const empty = options.empty === true

  /* ----------------------------------------------------------- live state */
  const instances: Instance[] = empty ? [] : clone(seed.INSTANCES)
  const instanceStates = empty ? {} : { ...seed.INSTANCE_STATES }
  const modCounts: Record<string, number> = empty ? {} : { ...seed.MOD_COUNTS }
  const modsByInstance: Record<string, InstalledMod[]> = empty ? {} : clone(seed.INSTALLED_MODS)
  const versions = empty ? [] : [...seed.VERSIONS]
  const installedVersionIds = empty ? [] : [...seed.INSTALLED_VERSION_IDS]
  const runtimes: JavaRuntime[] = empty ? [] : [...seed.JAVA_RUNTIMES]
  const accounts: Account[] = empty ? [] : [...seed.ACCOUNTS]
  const servers = empty ? [] : [...seed.SERVERS]
  const projects = empty ? [] : [...seed.MOD_PROJECTS]
  const settings: Settings = { ...seed.SETTINGS }
  if (empty) settings.mirrors = []

  const running: GameProcessInfo[] = []
  const jobs = new Map<string, DownloadJob>()
  const jobMeta = new Map<string, { speed: number; failAfter: number | null }>()
  const listeners = new Map<EventName, Set<Handler>>()
  const sessions = new Map<string, { stage: number; account: Account | null }>()

  let windowState: WindowState = { maximized: false, fullscreen: false, alwaysOnTop: false }
  let relay: RelayStatus = { state: 'idle', peers: [], message: empty ? '未连接' : '未连接' }
  let relayTimer: number | null = null
  let lanTimer: number | null = null
  let ticker: number | null = null


  /* ------------------------------------------------------------- plumbing */
  function emit(event: EventName, payload: unknown): void {
    const set = listeners.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(payload)
      } catch {
        /* a broken subscriber must not stop the mock */
      }
    }
  }

  function delay<T>(value: T, ms = 90): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms))
  }

  function err<T = never>(code: ErrorCode, message: string, detail?: string, retryable = false): Result<T> {
    return fail<T>(new AppError(code, message, detail, retryable))
  }

  /* ------------------------------------------------------- download jobs */
  function startJob(title: string, kind: DownloadJob['kind'], bytesTotal: number, itemCount: number, failAfterRatio?: number): DownloadJob {
    const job: DownloadJob = {
      id: nextId('job'),
      title,
      kind,
      status: 'running',
      total: itemCount,
      done: 0,
      failed: 0,
      skipped: 0,
      bytesTotal,
      bytesDone: 0,
      startedAt: Date.now()
    }
    jobs.set(job.id, job)
    jobMeta.set(job.id, { speed: 1_200_000 + Math.random() * 9_000_000, failAfter: failAfterRatio ?? null })
    ensureTicker()
    pushProgress(job)
    return job
  }

  function ensureTicker(): void {
    if (ticker !== null) return
    ticker = window.setInterval(tick, TICK_MS)
  }

  function stopTicker(): void {
    if (ticker !== null && jobs.size === 0) {
      window.clearInterval(ticker)
      ticker = null
    }
  }

  function tick(): void {
    const seconds = TICK_MS / 1000
    for (const job of jobs.values()) {
      const meta = jobMeta.get(job.id)
      if (!meta || job.status !== 'running') continue

      // Random-walk the speed so the number in the status bar moves believably.
      meta.speed = Math.max(120_000, meta.speed * (0.86 + Math.random() * 0.3))
      const chunk = meta.speed * seconds
      job.bytesDone = Math.min(job.bytesTotal, job.bytesDone + chunk)
      job.done = Math.min(job.total, Math.max(job.done, Math.round((job.bytesDone / Math.max(1, job.bytesTotal)) * job.total)))

      if (meta.failAfter !== null && job.bytesDone / Math.max(1, job.bytesTotal) >= meta.failAfter) {
        job.status = 'error'
        job.failed = Math.max(1, job.total - job.done)
        job.finishedAt = Date.now()
        job.error = new AppError('network', '下载中断', 'resources.download.minecraft.net 连接被重置', true).toPayload()
        finish(job)
        continue
      }

      if (job.bytesDone >= job.bytesTotal) {
        job.bytesDone = job.bytesTotal
        job.done = job.total
        job.status = 'done'
        job.finishedAt = Date.now()
        finish(job)
        continue
      }
      pushProgress(job, meta.speed)
    }
    if (jobs.size === 0) stopTicker()
  }

  function pushProgress(job: DownloadJob, speedOverride?: number): void {
    const meta = jobMeta.get(job.id)
    const speed = speedOverride ?? meta?.speed ?? 0
    const remaining = Math.max(0, job.bytesTotal - job.bytesDone)
    const payload: DownloadProgress = {
      jobId: job.id,
      status: job.status,
      total: job.total,
      done: job.done,
      failed: job.failed,
      bytesTotal: job.bytesTotal,
      bytesDone: job.bytesDone,
      speedBps: job.status === 'running' ? speed : 0,
      etaSeconds: speed > 0 ? remaining / speed : 0,
      currentLabel: `${job.title} · ${job.done}/${job.total}`,
      percent: job.bytesTotal > 0 ? Math.round((job.bytesDone / job.bytesTotal) * 1000) / 10 : 0
    }
    emit(EVENTS.progress, payload)
  }

  function finish(job: DownloadJob): void {
    jobMeta.delete(job.id)
    emit(EVENTS.jobFinished, job)
    if (job.status === 'done' && job.kind === 'java') refreshJavaList(job)
  }

  function refreshJavaList(job: DownloadJob): void {
    const major = Number(/\d+/.exec(job.title)?.[0] ?? 0)
    if (major > 0 && !runtimes.some((runtime) => runtime.major === major)) {
      runtimes.push({
        id: `java-${major}-mojang`,
        path: `${settings.gameRoot}\\java\\${major}\\bin\\java.exe`,
        rawVersion: `openjdk version "${major}" (downloaded by MoucLauncher)`,
        major,
        vendor: 'Mojang Studios',
        arch: 'x64',
        source: 'mojang',
        executable: `${settings.gameRoot}\\java\\${major}\\bin\\javaw.exe`,
        canHeadless: true
      })
    }
  }

  /** Seed one job so the status bar has something to show on first paint. */
  if (!empty) {
    const job = startJob('下载 1.21.8 资产文件', 'asset', 184_000_000, 2_812)
    job.bytesDone = 24_000_000
    job.done = 380
    pushProgress(job)
  }

  /* -------------------------------------------------------------- helpers */
  function findInstance(id: string): Instance | undefined {
    return instances.find((instanceItem) => instanceItem.id === id)
  }

  function summaryOf(instanceItem: Instance): InstanceSummary {
    return {
      instance: clone(instanceItem),
      state: instanceStates[instanceItem.id] ?? {
        installed: false,
        versionResolved: false,
        clientJarOk: false,
        assetsOk: false,
        librariesOk: false,
        loaderOk: false,
        missingCount: 0,
        sizeBytes: 0,
        lastCheckedAt: Date.now()
      },
      modCount: modCounts[instanceItem.id] ?? (modsByInstance[instanceItem.id]?.length ?? 0)
    }
  }

  function selectedAccount(): Account | undefined {
    return accounts.find((account) => account.selected) ?? accounts[0]
  }

  function broadcastSettings(): void {
    emit(EVENTS.settings, clone(settings))
  }

  /* --------------------------------------------------------------- the API */
  const api: MoucApi = {
    app: {
      async status() {
        const active = [...jobs.values()].find((job) => job.status === 'running' || job.status === 'paused')
        const data: LauncherStatus = {
          version: seed.LAUNCHER_VERSION,
          electron: '44.6.0',
          node: processlessNodeVersion(),
          platform: 'win32',
          arch: 'x64',
          gameRoot: settings.gameRoot,
          online: !empty,
          java: runtimes.length,
          instances: instances.length,
          accounts: accounts.length
        }
        if (active) data.activeJob = clone(active)
        const game = running[0]
        if (game) data.runningGame = clone(game)
        return ok(data)
      },
      async paths() {
        return ok(empty ? { ...seed.PATHS, gameRoot: '', versionsDir: '', instancesDir: '' } : seed.PATHS)
      },
      async version() {
        return ok(seed.LAUNCHER_VERSION)
      },
      async stats(): Promise<Result<GameDirStats>> {
        if (empty) return ok<GameDirStats>({ exists: false, sizeBytes: 0, fileCount: 0, versions: 0, instances: 0, mods: 0, screenshots: 0 })
        const stats: GameDirStats = { ...seed.DIR_STATS, instances: instances.length, versions: installedVersionIds.length, mods: Object.values(modCounts).reduce((acc, n) => acc + n, 0) }
        return ok(stats)
      },
      async openExternal(url) {
        if (!/^https?:\/\//.test(url)) return err<boolean>('invalid-input', '只能打开 http(s) 链接', url)
        window.open(url, '_blank', 'noopener')
        return ok(true)
      },
      async openPath(target) {
        // No shell in a browser: pretend the folder opened and log it.
        console.info('[mock] openPath', target)
        return ok(true)
      },
      async pickFolder(title, defaultPath) {
        console.info('[mock] pickFolder', title ?? '', defaultPath ?? '')
        return ok<string | undefined>(empty ? undefined : 'D:\\Games\\Minecraft')
      },
      async pickFile(title, filters) {
        console.info('[mock] pickFile', title ?? '', filters?.map((entry) => entry.extensions.join(',')).join('|') ?? '')
        return ok<string | undefined>(empty ? undefined : 'C:\\Users\\jiamou\\Downloads\\sodium-fabric-0.6.6.jar')
      },
      async checkUpdate(): Promise<Result<UpdateInfo>> {
        if (empty) return err<UpdateInfo>('network', '离线状态，无法检查更新', undefined, true)
        return ok<UpdateInfo>({
          available: true,
          current: seed.LAUNCHER_VERSION,
          latest: '1.1.0',
          url: 'https://github.com/jiajia2222/MoucLauncher/releases/tag/v1.1.0',
          notes: '修复 Forge 1.12.2 的 natives 解压；新增跨网联机。',
          assets: ['MoucLauncher-Setup-1.1.0.exe', 'latest.yml']
        })
      },
      async relaunch() {
        console.info('[mock] relaunch')
        return ok(true)
      },
      async quit() {
        console.info('[mock] quit')
        return ok(true)
      }
    },

    settings: {
      async get() {
        return ok(clone(settings))
      },
      async set(patch) {
        const next: Settings = { ...settings, ...patch }
        if (!Number.isFinite(next.maxConcurrentDownloads) || next.maxConcurrentDownloads < 1) {
          return err<Settings>('invalid-input', '并发数必须大于 0', String(patch.maxConcurrentDownloads))
        }
        if (patch.gameRoot !== undefined && patch.gameRoot.trim().length === 0) {
          return err<Settings>('invalid-input', '游戏根目录不能为空')
        }
        Object.assign(settings, next)
        broadcastSettings()
        return ok(clone(settings))
      },
      async reset() {
        Object.assign(settings, { ...seed.SETTINGS })
        broadcastSettings()
        return ok(clone(settings))
      }
    },

    version: {
      async refresh() {
        if (empty) return err('network', '无法访问版本清单', seed.PATHS.versionsDir, true)
        return ok([...versions])
      },
      async list() {
        return ok([...versions])
      },
      async installed() {
        return ok([...installedVersionIds])
      },
      async install(request) {
        if (!request.id) return err('invalid-input', '缺少版本 id')
        if (installedVersionIds.includes(request.id) && !request.loader) {
          return err('already-exists', '该版本已安装', request.id)
        }
        installedVersionIds.push(request.id)
        const job = startJob(`下载 ${request.id}`, 'client-jar', 24_800_000, 1)
        const loader = request.loader
        if (loader) {
          startJob(`安装 ${loader.id} ${loader.version}`, loader.id as DownloadJob['kind'], 3_400_000, 12)
        }
        if (request.createInstance) {
          instances.push(buildNewInstance(request.instanceName ?? request.id, request.id, loader?.id))
        }
        return ok(clone(job))
      },
      async uninstall(id) {
        const at = installedVersionIds.indexOf(id)
        if (at === -1) return err<boolean>('not-found', '版本未安装', id)
        installedVersionIds.splice(at, 1)
        return ok(true)
      },
      async repair(id) {
        const job = startJob(`校验修复 ${id}`, 'library', 62_000_000, 486)
        return ok(clone(job))
      },
      async resolved(id) {
        if (!versions.some((entry) => entry.id === id)) return err('not-found', '清单里没有这个版本', id)
        return ok(seed.resolvedVersion(id))
      }
    },

    instance: {
      async list(): Promise<Result<InstanceSummary[]>> {
        return ok(instances.map(summaryOf))
      },
      async create(request) {
        if (!request.name) return err<Instance>('invalid-input', '实例名称不能为空')
        if (!/^[^<>:"/\\|?*]{1,64}$/.test(request.name)) {
          return err<Instance>('invalid-input', '实例名称包含非法字符', request.name)
        }
        if (instances.some((entry) => entry.name === request.name)) {
          return err<Instance>('already-exists', '已经有同名实例', request.name)
        }
        const created = buildNewInstance(request.name, request.versionId, request.loader?.id, request.loader?.version)
        created.isolated = request.isolated ?? true
        created.description = request.description ?? ''
        created.accountId = request.accountId
        created.memoryMb = request.memoryMb ?? settings.defaultMemoryMb
        instances.push(created)
        instanceStates[created.id] = {
          installed: false,
          versionResolved: true,
          clientJarOk: installedVersionIds.includes(created.versionId),
          assetsOk: false,
          librariesOk: false,
          loaderOk: created.loader !== 'vanilla',
          missingCount: 1_024,
          sizeBytes: 0,
          lastCheckedAt: Date.now()
        }
        modCounts[created.id] = 0
        return ok(clone(created))
      },
      async update(patch) {
        const target = findInstance(patch.id)
        if (!target) return err<Instance>('not-found', '实例不存在', patch.id)
        Object.assign(target, patch, { version: target.version + 1, updatedAt: Date.now() })
        return ok(clone(target))
      },
      async remove(id) {
        const at = instances.findIndex((entry) => entry.id === id)
        if (at === -1) return err<boolean>('not-found', '实例不存在', id)
        instances.splice(at, 1)
        delete instanceStates[id]
        delete modCounts[id]
        delete modsByInstance[id]
        return ok(true)
      },
      async duplicate(id, name) {
        const source = findInstance(id)
        if (!source) return err<Instance>('not-found', '实例不存在', id)
        const copy = clone(source)
        copy.id = nextId('inst')
        copy.name = name || `${source.name} 副本`
        copy.createdAt = Date.now()
        copy.updatedAt = Date.now()
        copy.playCount = 0
        copy.lastPlayedAt = undefined
        copy.quickAccess = false
        instances.push(copy)
        instanceStates[copy.id] = clone(instanceStates[id] ?? instanceStates['inst-fabric-1211']!)
        modCounts[copy.id] = modCounts[id] ?? 0
        return ok(clone(copy))
      },
      async state(id) {
        const target = findInstance(id)
        if (!target) return err<InstanceSummary>('not-found', '实例不存在', id)
        return ok(summaryOf(target))
      },
      async importModpack(request) {
        if (!request.file) return err('invalid-input', '没有选择整合包文件')
        const manifest: ModpackManifest = {
          name: request.name || '卡牌地牢',
          author: 'MoucDev',
          version: '1.4.2',
          gameVersion: '26.3',
          loader: { id: 'neoforge', version: '21.4.90-beta' },
          files: 128
        }
        const created = buildNewInstance(manifest.name, manifest.gameVersion, 'neoforge', manifest.loader.version)
        created.description = `来自 ${manifest.author} 的整合包 v${manifest.version}`
        instances.push(created)
        instanceStates[created.id] = { ...instanceStates['inst-neoforge-263']! }
        modCounts[created.id] = manifest.files
        const job = startJob(`导入整合包 ${manifest.name}`, 'modpack', 742_000_000, manifest.files)
        return ok({ job: clone(job), manifest })
      },
      async exportModpack(id, target, format) {
        if (!findInstance(id)) return err('not-found', '实例不存在', id)
        const job = startJob(`导出 ${format === 'mrpack' ? 'mrpack' : '压缩包'}`, 'modpack', 128_000_000, 96)
        console.info('[mock] export to', target)
        return ok(clone(job))
      },
      async openDir(id) {
        if (!findInstance(id)) return err<boolean>('not-found', '实例不存在', id)
        console.info('[mock] open', `${seed.PATHS.instancesDir}\\${id}`)
        return ok(true)
      }
    },

    java: {
      async scan() {
        // A real scan takes a moment; the broken x86 runtime is only found by scanning.
        await delay(null, 400)
        return ok([...runtimes])
      },
      async list() {
        return ok([...runtimes])
      },
      async provision(request) {
        const existing = runtimes.find((runtime) => runtime.major === request.major)
        if (existing) {
          return ok<JavaProvisionResult>({ runtime: clone(existing), downloadedBytes: 0, fromCache: true })
        }
        const job = startJob(`下载 Java ${request.major}`, 'java', 68_000_000, 1)
        const made: JavaRuntime = {
          id: `java-${request.major}-${Date.now().toString(36)}`,
          path: `${settings.gameRoot}\\java\\${request.major}\\bin\\java.exe`,
          rawVersion: `openjdk version "${request.major}" (downloaded by MoucLauncher)`,
          major: request.major,
          vendor: 'Eclipse Temurin',
          arch: 'x64',
          source: request.imageType === 'jdk' ? 'adoptium' : 'mojang',
          executable: `${settings.gameRoot}\\java\\${request.major}\\bin\\javaw.exe`,
          canHeadless: true
        }
        runtimes.push(made)
        void job
        return ok<JavaProvisionResult>({ runtime: clone(made), downloadedBytes: 68_000_000, fromCache: false })
      },
      async remove(id) {
        const at = runtimes.findIndex((runtime) => runtime.id === id)
        if (at === -1) return err<boolean>('not-found', '运行时不存在', id)
        runtimes.splice(at, 1)
        return ok(true)
      },
      async resolve(instanceId) {
        const target = findInstance(instanceId)
        if (!target) return err('not-found', '实例不存在', instanceId)
        const major = target.java.major ?? seed.javaMajorFor(target.gameVersion)
        const usable = runtimes.filter((runtime) => runtime.major === major && !runtime.broken)
        return ok({ runtime: usable.length > 0 ? clone(usable[0]!) : null, major })
      }
    },

    account: {
      async list() {
        return ok(accounts.map(clone))
      },
      async addOffline(request) {
        if (!request.name) return err<Account>('invalid-input', '请输入游戏名')
        if (!/^[A-Za-z0-9_]{1,16}$/.test(request.name)) {
          return err<Account>('invalid-input', '游戏名只能是 1-16 位字母、数字或下划线', request.name)
        }
        const created: Account = {
          id: nextId('acc'),
          type: 'offline',
          name: request.name,
          uuid: request.uuid ?? crypto.randomUUID(),
          selected: accounts.length === 0,
          addedAt: Date.now(),
          lastUsedAt: 0,
          tokenState: 'none',
          label: '离线模式'
        }
        accounts.push(created)
        return ok(clone(created))
      },
      async remove(id) {
        const at = accounts.findIndex((account) => account.id === id)
        if (at === -1) return err<boolean>('not-found', '账户不存在', id)
        const wasSelected = accounts[at]?.selected
        accounts.splice(at, 1)
        if (wasSelected && accounts.length > 0) accounts[0]!.selected = true
        return ok(true)
      },
      async select(id) {
        const target = accounts.find((account) => account.id === id)
        if (!target) return err<Account>('not-found', '账户不存在', id)
        for (const account of accounts) account.selected = account.id === id
        target.lastUsedAt = Date.now()
        return ok(clone(target))
      },
      async refresh(id) {
        const target = accounts.find((account) => account.id === id)
        if (!target) return err<Account>('not-found', '账户不存在', id)
        if (target.type === 'offline') return err<Account>('unsupported', '离线账户没有令牌可刷新')
        target.tokenState = 'valid'
        target.expiresAt = Date.now() + 30 * 60_000
        return ok(clone(target))
      },
      async microsoftStart() {
        const sessionKey = nextId('msa')
        sessions.set(sessionKey, { stage: 0, account: null })
        return ok({
          userCode: 'WXYZ-PQRT',
          verificationUri: 'https://www.microsoft.com/link',
          verificationUriComplete: 'https://www.microsoft.com/link?code=WXYZ-PQRT',
          expiresIn: 900,
          interval: 5,
          sessionKey,
          message: '在浏览器里输入代码完成登录'
        })
      },
      async microsoftPoll(sessionKey) {
        const session = sessions.get(sessionKey)
        if (!session) return err<MicrosoftLoginProgress>('not-found', '登录会话已过期')
        session.stage += 1
        const stages: MicrosoftLoginProgress['stage'][] = ['waiting-user', 'microsoft-ok', 'xbox-ok', 'live-ok', 'minecraft-ok', 'profile-ok', 'done']
        const stage = stages[Math.min(session.stage, stages.length - 1)]!
        const progress: MicrosoftLoginProgress = { sessionKey, stage, message: loginStageMessage(stage) }
        if (stage === 'done') {
          const created: Account = {
            id: nextId('acc'),
            type: 'microsoft',
            name: 'MoucPlayer',
            uuid: crypto.randomUUID(),
            selected: false,
            addedAt: Date.now(),
            lastUsedAt: 0,
            tokenState: 'valid',
            expiresAt: Date.now() + 30 * 60_000,
            label: 'msa:mouc****@outlook.com'
          }
          accounts.push(created)
          progress.account = clone(created)
          sessions.delete(sessionKey)
        }
        emit(EVENTS.microsoft, progress)
        return ok(progress)
      },
      async microsoftCancel(sessionKey) {
        sessions.delete(sessionKey)
        return ok(true)
      },
      async skin(accountId) {
        const target = accounts.find((account) => account.id === accountId)
        if (!target) return err<SkinInfo>('not-found', '账户不存在', accountId)
        return ok<SkinInfo>({
          accountId,
          name: target.name,
          // In the real app this is a temp PNG path; a data URL keeps the preview working.
          previewPng: skinDataUrl(target.name),
          model: target.type === 'microsoft' ? 'slim' : 'classic',
          source: target.type === 'microsoft' ? 'microsoft' : 'offline-store'
        })
      },
      async servers(baseUrl) {
        if (!/^https?:\/\//.test(baseUrl)) return err('invalid-input', '地址需要以 http(s):// 开头', baseUrl)
        return ok([
          { serverName: '示例联合服', serverUrl: baseUrl + '/authdemo' },
          { serverName: '离线白名单服', serverUrl: baseUrl + '/whitelist' }
        ])
      }
    },

    download: {
      async jobs() {
        return ok([...jobs.values()].map(clone))
      },
      async cancel(jobId) {
        const job = jobs.get(jobId)
        if (!job) return err<boolean>('not-found', '任务不存在', jobId)
        job.status = 'cancelled'
        job.finishedAt = Date.now()
        emit(EVENTS.jobFinished, clone(job))
        jobs.delete(jobId)
        jobMeta.delete(jobId)
        stopTicker()
        return ok(true)
      },
      async retry(jobId) {
        const job = jobs.get(jobId)
        if (!job) return err<DownloadJob>('not-found', '任务不存在', jobId)
        job.status = 'running'
        job.error = undefined
        job.failed = 0
        const meta = jobMeta.get(jobId) ?? { speed: 2_400_000, failAfter: null }
        meta.failAfter = null
        jobMeta.set(jobId, meta)
        ensureTicker()
        pushProgress(job)
        return ok(clone(job))
      },
      async clear() {
        for (const [id, job] of jobs) {
          if (job.status !== 'running') {
            jobs.delete(id)
            jobMeta.delete(id)
          }
        }
        stopTicker()
        return ok(true)
      }
    },

    game: {
      async preview(instanceId): Promise<Result<LaunchPlan>> {
        const target = findInstance(instanceId)
        if (!target) return err<LaunchPlan>('not-found', '实例不存在', instanceId)
        const brokenState = instanceStates[instanceId]
        if (brokenState && !brokenState.clientJarOk) {
          return err<LaunchPlan>('not-found', '缺少客户端 jar，请先校验修复', target.versionId)
        }
        const major = target.java.major ?? seed.javaMajorFor(target.gameVersion)
        const runtime = runtimes.find((entry) => entry.major === major && !entry.broken)
        if (!runtime) return err<LaunchPlan>('java-missing', `缺少 Java ${major}`, target.gameVersion)
        const account = selectedAccount()
        const plan: LaunchPlan = {
          javaExecutable: runtime.executable,
          jvmArgs: ['-Xmx' + target.memoryMb + 'M', '-Xms1024M', settings.extraJvmArgs, '-Djava.library.path=${natives_dir}', '-cp'].filter(Boolean),
          gameArgs: ['--username', account?.name ?? 'Player', '--version', target.versionId, '--gameDir', gameDirOf(target), '--assetsDir', seed.PATHS.assetsDir, '--assetIndex', '17'],
          commandLine:
            `"${runtime.executable}" -Xmx${target.memoryMb}M ${settings.extraJvmArgs} -cp "libraries/*" net.minecraft.client.main.Main --username ${account?.name ?? 'Player'} --version ${target.versionId} --gameDir "${gameDirOf(target)}"`,
          classpath: ['D:\\Games\\Minecraft\\libraries\\*', `D:\\Games\\Minecraft\\versions\\${target.versionId}\\${target.versionId}.jar`],
          nativesDir: `${seed.PATHS.versionsDir}\\${target.versionId}\\natives`,
          gameDir: gameDirOf(target),
          versionName: target.versionId,
          javaMajor: major,
          notes: target.playCount > 10 ? ['已复用上次登录账户', '内存高于物理内存 50%，谨慎调高'] : ['首次启动会下载资产文件']
        }
        return ok(plan)
      },
      async launch(request) {
        const plan = await api.game.preview(request.instanceId)
        if (!plan.ok) return plan
        const existing = running.find((entry) => entry.instanceId === request.instanceId)
        if (existing) return err<GameProcessInfo>('busy', '该实例已经在运行', String(existing.pid))
        const processInfo: GameProcessInfo = {
          pid: 20_000 + Math.floor(Math.random() * 40_000),
          instanceId: request.instanceId,
          startedAt: Date.now(),
          commandLine: plan.data.commandLine,
          javaExecutable: plan.data.javaExecutable,
          gameDir: plan.data.gameDir
        }
        running.push(processInfo)
        const target = findInstance(request.instanceId)
        if (target) {
          target.lastPlayedAt = Date.now()
          target.playCount += 1
        }
        return ok(clone(processInfo))
      },
      async kill(instanceId) {
        const at = running.findIndex((entry) => entry.instanceId === instanceId)
        if (at === -1) return err<boolean>('not-found', '没有正在运行的进程', instanceId)
        const info = running[at]!
        running.splice(at, 1)
        const isBroken = instanceStates[instanceId]?.clientJarOk === false
        const exit: GameExitInfo = {
          instanceId,
          pid: info.pid,
          code: isBroken ? 1 : 0,
          signal: null,
          durationMs: Date.now() - info.startedAt
        }
        if (isBroken) exit.analysis = clone(seed.CRASH_SAMPLE)
        emit(EVENTS.gameExit, exit)
        return ok(true)
      },
      async running() {
        return ok(running.map(clone))
      },
      async logs(instanceId, lines = 200) {
        const tail: GameLogLine[] = empty ? [] : seed.LOG_TAIL.map((entry) => ({ ...entry, instanceId }))
        return ok(tail.slice(-lines))
      },
      async analyze(text) {
        if (!text || text.trim().length === 0) return err<CrashAnalysis>('invalid-input', '没有可分析的日志文本')
        const sample = clone(seed.CRASH_SAMPLE)
        if (/OutOfMemory/i.test(text)) {
          sample.title = 'Java 堆内存不足'
          sample.cause = 'Xmx 设置过小，或模组数量超过 100。'
          sample.suggestion = '把实例内存调到 6-8 GB，并关闭不必要的模组。'
          sample.tags = ['oom', 'memory']
          sample.severity = 'critical'
        } else if (/NoSuchMethod|Incompatible|version/i.test(text)) {
          sample.tags = ['mod-conflict', 'neoforge', 'setup-phase']
        } else {
          sample.title = '未能定位具体原因'
          sample.severity = 'warning'
          sample.cause = '日志里没有匹配的已知特征。'
          sample.suggestion = '把完整崩溃报告发给开发者，或查看控制台首行报错。'
        }
        return ok(sample)
      },
      async scanCrashReports(instanceId) {
        if (empty) return ok<CrashAnalysis[]>([])
        const first = clone(seed.CRASH_SAMPLE)
        const second = clone(seed.CRASH_SAMPLE)
        second.title = '资产文件缺失导致白屏'
        second.cause = `${seed.PATHS.assetsDir} 里缺少 1.20.2 的 index。`
        second.suggestion = '对该实例执行校验修复。'
        second.severity = 'warning'
        second.tags = ['assets', 'missing']
        second.reportPath = `D:\\Games\\Minecraft\\crash-reports\\crash-${instanceId}-08.txt`
        return ok([first, second])
      }
    },

    mod: {
      async search(query) {
        const needle = query.keyword.trim().toLowerCase()
        const filtered = projects.filter((item) => {
          if (query.kind && item.kind !== query.kind) return false
          if (query.provider && item.provider !== query.provider) return false
          if (query.loader && !item.loaders.includes(query.loader)) return false
          if (query.gameVersion && !item.gameVersions.includes(query.gameVersion)) return false
          if (!needle) return true
          return (
            item.title.toLowerCase().includes(needle) ||
            item.description.toLowerCase().includes(needle) ||
            item.slug.includes(needle)
          )
        })
        const offset = Math.max(0, query.offset)
        const limit = Math.max(1, query.limit)
        return ok({ items: filtered.slice(offset, offset + limit), total: filtered.length, offset })
      },
      async versions(provider, projectId) {
        const list = seed.PROJECT_VERSIONS[projectId]
        if (!list) return err<ProjectVersion[]>('not-found', '没有该项目的版本信息', `${provider}:${projectId}`)
        return ok(list.map(clone))
      },
      async install(request) {
        if (!findInstance(request.instanceId)) return err<DownloadJob>('not-found', '实例不存在', request.instanceId)
        const job = startJob(`安装 ${request.file.fileName}`, downloadKindFor(request.kind), request.file.size, 1)
        const list = (modsByInstance[request.instanceId] ??= [])
        list.unshift({
          fileName: request.file.fileName,
          modId: request.file.projectId,
          name: request.file.name,
          version: request.file.versionId,
          description: request.file.name,
          loader: request.file.loaders[0],
          gameVersions: request.file.gameVersions,
          size: request.file.size,
          disabled: false,
          updatedAt: Date.now(),
          projectId: request.file.projectId,
          provider: request.file.provider,
          versionId: request.file.versionId
        })
        modCounts[request.instanceId] = list.length
        return ok(clone(job))
      },
      async installed(instanceId) {
        return ok((modsByInstance[instanceId] ?? []).map(clone))
      },
      async toggle(instanceId, fileName, disabled) {
        const target = (modsByInstance[instanceId] ?? []).find((entry) => entry.fileName === fileName)
        if (!target) return err<InstalledMod>('not-found', '模组文件不存在', fileName)
        const renamed = disabled ? withDisabledSuffix(fileName) : withoutDisabledSuffix(fileName)
        target.fileName = renamed
        target.disabled = disabled
        target.updatedAt = Date.now()
        return ok(clone(target))
      },
      async remove(instanceId, fileName) {
        const list = modsByInstance[instanceId] ?? []
        const at = list.findIndex((entry) => entry.fileName === fileName)
        if (at === -1) return err<boolean>('not-found', '模组文件不存在', fileName)
        list.splice(at, 1)
        modCounts[instanceId] = list.length
        return ok(true)
      },
      async checkUpdates(instanceId) {
        const list = modsByInstance[instanceId] ?? []
        for (const entry of list) {
          const known = entry.projectId ? seed.PROJECT_VERSIONS[entry.projectId] : undefined
          if (known && known[0] && known[0].versionNumber !== entry.version) entry.updateAvailable = clone(known[0])
        }
        return ok(list.map(clone))
      },
      async localFile(instanceId, kind, source) {
        if (!findInstance(instanceId)) return err<InstalledMod>('not-found', '实例不存在', instanceId)
        const fileName = source.split(/[\\/]/).pop() ?? 'downloaded.jar'
        const made: InstalledMod = {
          fileName: kind === 'mod' ? fileName : fileName,
          modId: fileName.replace(/\.(jar|zip)$/i, ''),
          name: fileName.replace(/\.(jar|zip)$/i, ''),
          version: 'local',
          description: '从本地文件安装',
          size: 1_200_000,
          disabled: false,
          updatedAt: Date.now(),
          provider: 'local'
        }
        const list = (modsByInstance[instanceId] ??= [])
        list.unshift(made)
        modCounts[instanceId] = list.length
        return ok(clone(made))
      }
    },

    server: {
      async list(instanceId) {
        // Servers are per-instance in the real store; the preview shares one list.
        void instanceId
        return ok(servers.map(clone))
      },
      async save(instanceId, entry) {
        void instanceId
        if (!entry.address) return err('invalid-input', '服务器地址不能为空')
        const at = servers.findIndex((item) => item.id === entry.id)
        if (at === -1) servers.push({ ...entry, id: entry.id || nextId('srv') })
        else servers[at] = entry
        return ok(clone(entry))
      },
      async remove(instanceId, id) {
        void instanceId
        const at = servers.findIndex((item) => item.id === id)
        if (at === -1) return err<boolean>('not-found', '服务器不存在', id)
        servers.splice(at, 1)
        return ok(true)
      },
      async ping(address): Promise<Result<ServerPingResult>> {
        if (!address) return err<ServerPingResult>('invalid-input', '请输入地址')
        await delay(null, 220)
        if (address.includes('25566')) {
          return ok<ServerPingResult>({
            address,
            port: 25565,
            online: false,
            latencyMs: 0,
            motdPlain: '',
            error: new AppError('network', '服务器无响应', '连接被拒绝', true).toPayload()
          })
        }
        const latency = 20 + Math.floor(Math.random() * 160)
        return ok<ServerPingResult>({
          address,
          port: 25565,
          online: true,
          latencyMs: latency,
          motdPlain: '§a欢迎来到示例服务器 §7- 生存 · 无插件',
          motdJson: '{"text":"欢迎来到示例服务器"}',
          versionName: '1.21.1',
          protocol: 767,
          maxPlayers: 60,
          onlinePlayers: 12 + (latency % 20),
          samplePlayers: ['jiamou', 'MoucPlayer', 'Steve_233', 'klee'],
          iconPngBase64: undefined
        })
      },
      async lanScan() {
        if (lanTimer !== null) return ok(true)
        lanTimer = window.setInterval(() => {
          const game: LanGame = seed.LAN_GAMES[Math.floor(Math.random() * seed.LAN_GAMES.length)]!
          emit(EVENTS.lan, { ...game, seenAt: Date.now() })
        }, 3000)
        const first = seed.LAN_GAMES[0]
        if (first) emit(EVENTS.lan, first)
        return ok(true)
      },
      async lanStop() {
        if (lanTimer !== null) {
          window.clearInterval(lanTimer)
          lanTimer = null
        }
        return ok(true)
      },
      async join(instanceId, entry) {
        const launched = await api.game.launch({ instanceId, server: { address: entry.address, port: entry.port ?? 25565 } })
        return launched
      },
      async relayStatus() {
        return ok(clone(relay))
      },
      async relayHost(request: IpcRelayHostRequest) {
        const room = request.room ?? randomRoom()
        relay = { state: 'hosting', room, localPort: request.targetPort, endpoint: settings.relayServerUrl, peers: [], message: `房间 ${room} 已建立，等待玩家加入` }
        emit(EVENTS.relay, clone(relay))
        scheduleRelayProgress(room)
        return ok(clone(relay))
      },
      async relayJoin(room) {
        relay = { state: 'joining', room, localPort: 25_566, peers: [], message: `正在连接房间 ${room}` }
        emit(EVENTS.relay, clone(relay))
        scheduleRelayProgress(room)
        return ok(clone(relay))
      },
      async relayStop() {
        if (relayTimer !== null) window.clearTimeout(relayTimer)
        relayTimer = null
        relay = { state: 'idle', peers: [], message: '已断开' }
        emit(EVENTS.relay, clone(relay))
        return ok(clone(relay))
      }
    },

    loader: {
      async options(gameVersion) {
        if (!gameVersion) return err<LoaderOption[]>('invalid-input', '缺少游戏版本')
        const majors = seed.javaMajorFor(gameVersion)
        const options: LoaderOption[] = [
          {
            id: 'fabric',
            label: 'Fabric',
            versions: seed.LOADER_VERSIONS.fabric.slice(0, 3).map((version, index) => ({
              version,
              stable: true,
              recommended: index === 0,
              javaFix: `Java ${majors}`
            }))
          },
          {
            id: 'quilt',
            label: 'Quilt',
            versions: seed.LOADER_VERSIONS.quilt.slice(0, 2).map((version, index) => ({ version, stable: index > 0, recommended: index === 1 }))
          },
          {
            id: 'neoforge',
            label: 'NeoForge',
            versions: seed.LOADER_VERSIONS.neoforge.slice(0, 3).map((version, index) => ({ version, stable: index === 1, recommended: index === 1 }))
          },
          {
            id: 'legacy-fabric',
            label: 'Legacy Fabric',
            versions: seed.LOADER_VERSIONS['legacy-fabric'].map((version) => ({ version, stable: true }))
          }
        ]
        return ok(options)
      },
      async install(instanceId, loader, version) {
        const target = findInstance(instanceId)
        if (!target) return err<DownloadJob>('not-found', '实例不存在', instanceId)
        target.loader = loader as Instance['loader']
        target.loaderVersion = version
        target.versionId = `${target.gameVersion}+${loader}.${version}`
        target.updatedAt = Date.now()
        const state = instanceStates[instanceId]
        if (state) state.loaderOk = true
        return ok(clone(startJob(`安装 ${loader} ${version}`, loader as DownloadJob['kind'], 3_400_000, 14)))
      },
      async remove(instanceId) {
        const target = findInstance(instanceId)
        if (!target) return err<Instance>('not-found', '实例不存在', instanceId)
        target.loader = 'vanilla'
        target.loaderVersion = undefined
        target.versionId = target.gameVersion
        return ok(clone(target))
      }
    },

    win: {
      minimize() {
        console.info('[mock] minimize')
      },
      async toggleMaximize() {
        windowState = { ...windowState, maximized: !windowState.maximized }
        emit(EVENTS.windowState, clone(windowState))
        return ok(clone(windowState))
      },
      close() {
        console.info('[mock] close')
      },
      async state() {
        return ok(clone(windowState))
      },
      async setAlwaysOnTop(value) {
        windowState = { ...windowState, alwaysOnTop: value }
        emit(EVENTS.windowState, clone(windowState))
        return ok(clone(windowState))
      }
    },

    on(event, handler) {
      const set = listeners.get(event) ?? new Set<Handler>()
      set.add(handler)
      listeners.set(event, set)
      return () => {
        set.delete(handler)
      }
    }
  }

  function scheduleRelayProgress(room: string): void {
    if (relayTimer !== null) window.clearTimeout(relayTimer)
    relayTimer = window.setTimeout(() => {
      relay = {
        ...relay,
        state: 'connected',
        room,
        message: `已连接，房间 ${room}`,
        peers: [{ id: 'peer-1', name: 'MoucPlayer', latencyMs: 42, bytesForwarded: 1_200_000, connectedAt: Date.now() }]
      }
      emit(EVENTS.relay, clone(relay))
      relayTimer = null
    }, 1800)
  }

  return api
}

/* ------------------------------------------------------------------ helpers */

function clone<T>(value: T): T {
  return structuredClone(value)
}

function processlessNodeVersion(): string {
  return '22.20.0'
}

function downloadKindFor(kind: ProjectKind): DownloadKind {
  return kind === 'resourcepack' ? 'resource-pack' : kind
}

function gameDirOf(instanceItem: Instance): string {
  return instanceItem.isolated ? `${seed.PATHS.instancesDir}\\${instanceItem.id}` : seed.PATHS.gameRoot
}

function buildNewInstance(name: string, versionId: string, loader?: string, loaderVersion?: string): Instance {
  const id = nextId('inst')
  return {
    id,
    name,
    description: '',
    icon: loader ?? 'vanilla',
    versionId: loaderVersion ? `${versionId}+${loader}.${loaderVersion}` : versionId,
    loader: (loader ?? 'vanilla') as Instance['loader'],
    loaderVersion,
    gameVersion: versionId.split('+')[0] ?? versionId,
    isolated: true,
    java: { mode: 'auto' },
    memoryMb: 4096,
    jvmArgs: '',
    gameArgs: '',
    resolution: { width: 854, height: 480, fullscreen: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    playCount: 0,
    version: 1
  }
}

function loginStageMessage(stage: MicrosoftLoginProgress['stage']): string {
  switch (stage) {
    case 'waiting-user':
      return '等待你在浏览器里输入代码'
    case 'microsoft-ok':
      return '微软账户已通过'
    case 'xbox-ok':
      return 'Xbox Live 已通过'
    case 'live-ok':
      return 'XBL 令牌已获取'
    case 'minecraft-ok':
      return 'Minecraft 令牌已获取'
    case 'profile-ok':
      return '玩家档案已读取'
    case 'done':
      return '登录完成'
    default:
      return '登录失败'
  }
}

function withoutDisabledSuffix(fileName: string): string {
  return fileName.replace(/\.disabled$/i, '')
}

function withDisabledSuffix(fileName: string): string {
  return fileName.endsWith('.disabled') ? fileName : `${fileName}.disabled`
}

function randomRoom(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
}

/** 8x8 face PNG as a data URL — the real app returns a temp file path instead. */
function skinDataUrl(name: string): string {
  let hue = 0
  for (let i = 0; i < name.length; i += 1) hue = (hue * 31 + name.charCodeAt(i)) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue} 40% 45%)"/><rect x="8" y="8" width="48" height="48" fill="hsl(${hue} 30% 62%)"/><rect x="20" y="26" width="8" height="8" fill="#12151a"/><rect x="36" y="26" width="8" height="8" fill="#12151a"/><rect x="24" y="42" width="16" height="6" fill="#12151a"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

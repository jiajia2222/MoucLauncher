<script setup lang="ts">
/**
 * HomeView — ported from KAMUCL `src/renderer/src/views/HomeView.vue`.
 *
 * Layout, class names and scoped CSS come from upstream so the design system matches
 * KAMUCL exactly. The data layer is rewired to MoucLauncher's `window.mouc` contract
 * (see ../api/*). Dropped because there is no backing capability: launch-banner images
 * (the hero renders upstream's own `no-banner` state), the 3D skin viewer (no WebGL
 * dependency in this project — the real 2D skin texture from `account.skin` is shown
 * instead), the mascot, splash face, community/creator card, projections, recordings,
 * the home-layout editor and the multi-folder switcher.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { EVENTS } from '@shared/ipc'
import { navigate as setShellView, type ViewId } from '../../composables/useNav'
import type {
  Account,
  CrashAnalysis,
  DownloadJob,
  DownloadProgress,
  GameExitInfo,
  GameLogLine,
  GameProcessInfo,
  Instance,
  InstanceSummary,
  JavaRuntime,
  LaunchPlan,
  Settings,
  SkinInfo,
  VersionRef
} from '@shared/types'
import { api } from '../api/core'
import {
  deleteInstance,
  duplicateInstance,
  formatMemory,
  formatSize,
  instanceIconUrl,
  instanceSub,
  instanceTitle,
  javaRuntimes,
  lastPlayedText,
  listInstances,
  loaderBadge,
  needsAttention,
  openInstanceFolder,
  provisionJava,
  resolveInstanceJava,
  sortInstances,
  togglePinned,
  updateInstance
} from '../api/instances'
import { installVersion, installedVersionIds, latestRelease, listVersions, repairVersion } from '../api/versions'
import { cancelDownload, downloadJobs, isLiveJob, jobPercent, onJobFinished, onProgress } from '../api/download'
import {
  analyzeCrash,
  crashReports,
  gameLogs,
  killGame,
  launchGame,
  onGameExit,
  onGameLog,
  openPath,
  previewLaunch,
  runningGames
} from '../api/game'
import { accountSkin, listAccounts } from '../api/accounts'
import { getSettings } from '../api/settings'

const SELECTED_KEY = 'mouc.home.selectedInstance'
const VIEW_IDS: ViewId[] = ['home', 'instances', 'versions', 'mods', 'accounts', 'java', 'online', 'settings']

/** Navigation belongs to the shell: prefer the prop it passes, else its nav contract + hash. */
const props = defineProps<{ navigate?: (view: string) => void }>()

function goto(view: string): void {
  if (props.navigate) props.navigate(view)
  else if (VIEW_IDS.includes(view as ViewId)) setShellView(view as ViewId)
  if (window.location.hash !== `#view=${view}`) window.location.hash = `#view=${view}`
}

/** Non-critical read: keep the UI alive instead of rejecting (adapters already unwrap `Result`). */
async function soft<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch {
    return fallback
  }
}


/* ------------------------------------------------------------------ toast */
type ToastKind = 'info' | 'success' | 'error'
interface ToastItem {
  id: number
  text: string
  type: ToastKind
}

const toasts = ref<ToastItem[]>([])
let toastSeq = 0
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()

function dismissToast(id: number): void {
  const timer = toastTimers.get(id)
  if (timer) clearTimeout(timer)
  toastTimers.delete(id)
  toasts.value = toasts.value.filter((item) => item.id !== id)
}

function toast(text: string, type: ToastKind = 'info'): void {
  const previous = toasts.value.find((item) => item.text === text && item.type === type)
  if (previous) return
  const id = ++toastSeq
  toasts.value = [...toasts.value, { id, text, type }].slice(-3)
  toastTimers.set(id, setTimeout(() => dismissToast(id), type === 'error' ? 8000 : 3000))
}

function errText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') || '未知错误'
}

/* ------------------------------------------------------- 当前实例与展示数据 */
const instances = ref<InstanceSummary[]>([])
const loading = ref(true)
const loadError = ref('')
const selectedId = ref('')
const settings = ref<Settings | null>(null)
const accounts = ref<Account[]>([])

const sortedInstances = computed(() => sortInstances(instances.value))
const current = computed<InstanceSummary | null>(() => {
  const byId = instances.value.find((item) => item.instance.id === selectedId.value)
  return byId ?? sortedInstances.value[0] ?? null
})
const currentInstance = computed<Instance | null>(() => current.value?.instance ?? null)
const currentRunning = computed(
  () => !!currentInstance.value && games.value.some((entry) => entry.instanceId === currentInstance.value?.id)
)

const heroName = computed(() => (current.value ? instanceTitle(current.value) : '选择游戏实例'))
const heroVersion = computed(() => currentInstance.value?.gameVersion || '版本未知')
const heroKey = computed(() =>
  JSON.stringify([currentInstance.value?.id, heroName.value, heroVersion.value, loaderBadgeOf(currentInstance.value)])
)

function loaderBadgeOf(instance: Instance | null): string {
  return instance ? loaderBadge(instance) : '正式版'
}

function cardTooltip(summary: InstanceSummary): string {
  const { instance, state, modCount } = summary
  const flags = needsAttention(summary) ? ' · 需要校验修复' : ''
  return `${instance.description ? `${instance.description}\n` : ''}${instance.versionId}\n${formatSize(state.sizeBytes)} · ${modCount} 个模组 · 上次游玩 ${lastPlayedText(instance.lastPlayedAt)}${flags}`
}

async function loadInstances(): Promise<void> {
  instances.value = await listInstances()
}

async function loadAll(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [summaries, accountList, settingsValue, initialJobs] = await Promise.all([
      listInstances(),
      soft(listAccounts(), [] as Account[]),
      soft(getSettings(), null as Settings | null),
      soft(downloadJobs(), [] as DownloadJob[])
    ])
    instances.value = summaries
    accounts.value = accountList
    settings.value = settingsValue
    jobs.value = initialJobs.filter(isLiveJob)
    if (!selectedId.value || !summaries.some((item) => item.instance.id === selectedId.value)) {
      const saved = localStorage.getItem(SELECTED_KEY) ?? ''
      selectedId.value = summaries.some((item) => item.instance.id === saved) ? saved : (sortInstances(summaries)[0]?.instance.id ?? '')
    }
  } catch (error) {
    loadError.value = errText(error)
    toast('读取实例失败：' + loadError.value, 'error')
  } finally {
    loading.value = false
  }
}

watch(selectedId, (id) => {
  if (id) localStorage.setItem(SELECTED_KEY, id)
})

/* ---------------------------------------------------------------- 启动状态 */
type LaunchPhase = 'idle' | 'launching' | 'error'

const launchPhase = ref<LaunchPhase>('idle')
const launchBusy = ref(false)
const launchFailure = ref('')
const games = ref<GameProcessInfo[]>([])

const launching = computed(() => launchPhase.value === 'launching' || launchBusy.value)
const launchFailed = computed(() => launchPhase.value === 'error')

const launchText = computed(() => {
  if (launching.value) return progressText.value || '正在启动…'
  return currentRunning.value ? '再次启动' : launchFailed.value ? '重新启动' : '开始游戏'
})

const selectedAccount = computed<Account | null>(() => accounts.value.find((item) => item.selected) ?? accounts.value[0] ?? null)

async function startVersion(id: string): Promise<void> {
  if (!id) return
  selectedId.value = id
  if (launching.value) {
    toast('正在启动中，请稍候', 'info')
    return
  }
  if (!selectedAccount.value) {
    toast('请先在账户页选择或添加账号', 'error')
    goto('accounts')
    return
  }
  launchBusy.value = true
  launchPhase.value = 'launching'
  launchFailure.value = ''
  try {
    const info = await launchGame({ instanceId: id, accountId: selectedAccount.value.id })
    games.value = [...games.value.filter((entry) => entry.instanceId !== id), info]
    launchPhase.value = 'idle'
    toast(`游戏已启动 · PID ${info.pid}`, 'success')
    instances.value = await soft(listInstances(), instances.value)
  } catch (error) {
    launchPhase.value = 'error'
    launchFailure.value = errText(error)
    toast('启动失败：' + launchFailure.value, 'error')
  } finally {
    launchBusy.value = false
  }
}

function onLaunchClick(): void {
  if (!launching.value && currentInstance.value) void startVersion(currentInstance.value.id)
}

async function stopGame(instanceId: string): Promise<void> {
  cardMenu.id = ''
  try {
    await killGame(instanceId)
    games.value = games.value.filter((entry) => entry.instanceId !== instanceId)
    toast('已结束游戏进程', 'success')
  } catch (error) {
    toast('结束失败：' + errText(error), 'error')
  }
}

const heroStatus = computed<{ text: string; tone: string }>(() => {
  const summary = current.value
  if (!summary) return { text: loading.value ? '正在读取' : '等待选择', tone: 'idle' }
  if (currentRunning.value) return { text: '游戏运行中', tone: 'running' }
  if (launching.value) return { text: '正在准备', tone: 'running' }
  if (launchFailed.value || needsAttention(summary)) return { text: '需要检查', tone: 'error' }
  return { text: '就绪', tone: 'ready' }
})

/* ---------------------------------------------------------------- 下载进度 */
const jobs = ref<DownloadJob[]>([])
const progressByJob = ref<Record<string, DownloadProgress>>({})

const activeJob = computed<DownloadJob | null>(() => jobs.value.find(isLiveJob) ?? null)
const activeProgress = computed<DownloadProgress | null>(() => {
  const job = activeJob.value
  return job ? (progressByJob.value[job.id] ?? null) : null
})
const percent = computed(() => (activeJob.value ? jobPercent(activeJob.value, activeProgress.value ?? undefined) : 0))
const progressText = computed(() => activeProgress.value?.currentLabel ?? activeJob.value?.title ?? '')

const bytesText = computed(() => {
  const progress = activeProgress.value
  if (progress) return `${formatSize(progress.bytesDone)} / ${formatSize(progress.bytesTotal)}`
  const job = activeJob.value
  return job && job.bytesTotal > 0 ? `${formatSize(job.bytesDone)} / ${formatSize(job.bytesTotal)}` : ''
})
const speedText = computed(() => (activeProgress.value ? `${formatSize(activeProgress.value.speedBps)}/s` : ''))
const etaText = computed(() => {
  const seconds = activeProgress.value?.etaSeconds ?? 0
  if (!seconds || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return minutes > 0 ? `${minutes} 分 ${total % 60} 秒` : `${total} 秒`
})

async function cancelJob(job: DownloadJob): Promise<void> {
  try {
    await cancelDownload(job.id)
    jobs.value = jobs.value.filter((entry) => entry.id !== job.id)
    toast('已取消下载任务', 'info')
  } catch (error) {
    toast('取消失败：' + errText(error), 'error')
  }
}

/* ------------------------------------------------------------ 快捷行悬浮浮块 */
const runtimeHover = ref(-1)
const runtimeStrip = ref<HTMLElement | null>(null)
const runtimeBlob = reactive({ left: 0, width: 0 })

function updateRuntimeBlob(): void {
  const strip = runtimeStrip.value
  if (!strip || runtimeHover.value < 0) return
  const items = strip.querySelectorAll<HTMLElement>('.runtime-item')
  const target = items[runtimeHover.value]
  if (!target) return
  runtimeBlob.left = target.offsetLeft
  runtimeBlob.width = target.offsetWidth
}

watch(runtimeHover, () => nextTick(updateRuntimeBlob))

const runtimeBlobStyle = computed(() => ({ left: `${runtimeBlob.left}px`, width: `${runtimeBlob.width}px` }))

/* ----------------------------------------------------------- Java 与内存摘要 */
const javas = ref<JavaRuntime[]>([])
const javaChecked = ref(false)
const javaResolve = ref<{ runtime: JavaRuntime | null; major: number } | null>(null)

async function loadJavaSummary(): Promise<void> {
  javas.value = await soft(javaRuntimes(), [] as JavaRuntime[])
  javaChecked.value = true
}

const usableJava = computed(() => javas.value.filter((runtime) => !runtime.broken))

/** The instance stores the `javaw.exe` executable; the list is keyed by both paths. */
function runtimeMatches(instance: Instance, runtime: JavaRuntime): boolean {
  return !!instance.java.path && (runtime.executable === instance.java.path || runtime.path === instance.java.path)
}

const javaText = computed(() => {
  const instance = currentInstance.value
  if (!instance) return '—'
  if (instance.java.mode === 'auto') {
    const major = javaResolve.value?.major
    return major ? `自动选择 · Java ${major}` : '自动选择'
  }
  const match = usableJava.value.find((runtime) => runtimeMatches(instance, runtime))
  if (match) return `Java ${match.major} · ${match.vendor}`
  if (instance.java.path) return instance.java.path
  return javaResolve.value ? `Java ${javaResolve.value.major}` : '自动选择'
})

const javaMissing = computed(
  () => !!javaResolve.value && javaResolve.value.runtime === null && currentInstance.value?.java.mode === 'auto'
)

watch(
  currentInstance,
  async (instance) => {
    javaResolve.value = instance ? await soft(resolveInstanceJava(instance.id), null) : null
  },
  { immediate: true }
)

const memoryText = computed(() => {
  const instance = currentInstance.value
  const mb = instance?.memoryMb || settings.value?.defaultMemoryMb || 0
  return mb ? formatMemory(mb) : '—'
})

const javaPicker = ref<{ id: string; name: string; choice: string } | null>(null)
const javaSaving = ref(false)

async function openJavaPicker(): Promise<void> {
  const instance = currentInstance.value
  if (!instance) {
    goto('java')
    return
  }
  javaPicker.value = {
    id: instance.id,
    name: instance.name,
    choice: instance.java.mode === 'auto' ? '@auto' : instance.java.path ? `@path:${instance.java.path}` : '@global'
  }
  if (!javaChecked.value) await loadJavaSummary()
}

const globalJavaText = computed(() => {
  const options = settings.value
  if (!options) return '当前全局：自动选择'
  if (options.javaMode === 'custom' && options.customJavaPath) return `当前全局：${options.customJavaPath}`
  if (options.javaMode === 'adoptium') return '当前全局：Adoptium 自动下载'
  if (options.javaMode === 'mojang-component') return '当前全局：Mojang 官方组件'
  return '当前全局：自动选择'
})

function javaChoiceToPatch(choice: string): Partial<Instance> & { id: string } {
  const id = javaPicker.value?.id ?? ''
  if (choice === '@auto') return { id, java: { mode: 'auto' } }
  if (choice === '@global') {
    const custom = settings.value?.javaMode === 'custom' ? settings.value.customJavaPath : ''
    return { id, java: { mode: 'custom', path: custom || undefined } }
  }
  const path = choice.replace(/^@path:/, '')
  const match = usableJava.value.find((runtime) => runtime.executable === path || runtime.path === path)
  return { id, java: { mode: 'pinned', path, major: match?.major } }
}

async function saveJavaChoice(): Promise<void> {
  const target = javaPicker.value
  if (!target || javaSaving.value) return
  javaSaving.value = true
  try {
    await updateInstance(javaChoiceToPatch(target.choice))
    await refreshInstances()
    javaPicker.value = null
    toast('已更新此实例的 Java 选择', 'success')
  } catch (error) {
    toast('保存失败：' + errText(error), 'error')
  } finally {
    javaSaving.value = false
  }
}

const provisioning = ref(false)

async function fetchMissingJava(): Promise<void> {
  const major = javaResolve.value?.major
  if (!major || provisioning.value) return
  provisioning.value = true
  try {
    const result = await provisionJava(major)
    toast(`已准备 Java ${result.runtime.major}（${result.runtime.vendor}）`, 'success')
    await loadJavaSummary()
    if (currentInstance.value) javaResolve.value = await soft(resolveInstanceJava(currentInstance.value.id), javaResolve.value)
  } catch (error) {
    toast('下载 Java 失败：' + errText(error), 'error')
  } finally {
    provisioning.value = false
  }
}

const memoryEditor = ref<{ id: string; name: string; mb: number } | null>(null)
const memorySaving = ref(false)

function openMemoryEditor(): void {
  const instance = currentInstance.value
  if (!instance) {
    goto('settings')
    return
  }
  memoryEditor.value = { id: instance.id, name: instance.name, mb: instance.memoryMb || settings.value?.defaultMemoryMb || 4096 }
}

async function saveMemory(): Promise<void> {
  const target = memoryEditor.value
  if (!target || memorySaving.value) return
  memorySaving.value = true
  try {
    await updateInstance({ id: target.id, memoryMb: target.mb })
    await refreshInstances()
    memoryEditor.value = null
    toast('已更新此实例的内存分配', 'success')
  } catch (error) {
    toast('保存失败：' + errText(error), 'error')
  } finally {
    memorySaving.value = false
  }
}

/* ------------------------------------------------------------------ 日志窗 */
const logOpen = ref(false)
const logBody = ref<HTMLElement | null>(null)
const logs = ref<GameLogLine[]>([])
const logsBusy = ref(false)
const launchPlan = ref<LaunchPlan | null>(null)
const planError = ref('')
const reports = ref<CrashAnalysis[]>([])
const analyzing = ref(false)

async function openLogs(): Promise<void> {
  logOpen.value = true
  await refreshLogs()
}

async function refreshLogs(): Promise<void> {
  const instance = currentInstance.value
  if (!instance) return
  logsBusy.value = true
  logs.value = await soft(gameLogs(instance.id, 300), [] as GameLogLine[])
  launchPlan.value = await soft(previewLaunch(instance.id), null as LaunchPlan | null)
  planError.value = launchPlan.value ? '' : '无法生成启动参数：' + (launchFailure.value || '实例缺少文件，请先校验修复')
  reports.value = launchFailed.value ? await soft(crashReports(instance.id), [] as CrashAnalysis[]) : []
  logsBusy.value = false
  await scrollToBottom()
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (logBody.value) logBody.value.scrollTop = logBody.value.scrollHeight
}

watch(
  () => logs.value.length,
  async () => {
    if (!logOpen.value) return
    await scrollToBottom()
  }
)

async function analyseFailure(): Promise<void> {
  if (analyzing.value) return
  analyzing.value = true
  try {
    const analysis = await analyzeCrash(logs.value.map((line) => line.text).join('\n'))
    reports.value = [analysis, ...reports.value]
  } catch (error) {
    toast('分析失败：' + errText(error), 'error')
  } finally {
    analyzing.value = false
  }
}

async function revealReport(report: CrashAnalysis): Promise<void> {
  if (!report.reportPath) {
    toast('这条分析没有关联的报告文件', 'info')
    return
  }
  try {
    await openPath(report.reportPath)
  } catch (error) {
    toast('打开失败：' + errText(error), 'error')
  }
}

/* ------------------------------------------------------------ 最近游戏与菜单 */
const wideRecent = ref(window.innerWidth >= 1500)
const updateRecentWidth = (): void => {
  wideRecent.value = window.innerWidth >= 1500
}

const recent = computed(() => sortedInstances.value.slice(0, wideRecent.value ? 8 : 4))

const versionMenu = reactive({ open: false, top: 0, left: 0, width: 230 })
const versionMenuButton = ref<HTMLElement | null>(null)

function toggleVersionMenu(): void {
  if (!versionMenu.open && versionMenuButton.value) {
    const bounds = versionMenuButton.value.getBoundingClientRect()
    versionMenu.top = Math.min(window.innerHeight - 300, bounds.bottom + 8)
    versionMenu.left = Math.max(8, Math.min(window.innerWidth - 250, bounds.right - 230))
  }
  versionMenu.open = !versionMenu.open
}

function chooseVersion(id: string): void {
  selectedId.value = id
  versionMenu.open = false
}

const cardMenu = reactive({ id: '', top: 0, left: 0 })
const cardMenuSummary = computed(() => instances.value.find((item) => item.instance.id === cardMenu.id) ?? null)

function openCardMenu(event: MouseEvent, id: string): void {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  cardMenu.id = cardMenu.id === id ? '' : id
  cardMenu.top = Math.max(8, Math.min(window.innerHeight - 272, bounds.bottom + 6))
  cardMenu.left = Math.max(8, Math.min(window.innerWidth - 244, bounds.right - 232))
}

async function openVersionFolder(id: string): Promise<void> {
  cardMenu.id = ''
  try {
    await openInstanceFolder(id)
  } catch (error) {
    toast('打开文件夹失败：' + errText(error), 'error')
  }
}

const repairing = ref(false)

async function repairCurrent(summary: InstanceSummary): Promise<void> {
  cardMenu.id = ''
  if (repairing.value) return
  repairing.value = true
  try {
    const job = await repairVersion(summary.instance.versionId)
    jobs.value = [...jobs.value, job]
    toast(`正在校验修复 ${summary.instance.versionId}`, 'success')
  } catch (error) {
    toast('校验修复失败：' + errText(error), 'error')
  } finally {
    repairing.value = false
  }
}

async function duplicateCurrent(summary: InstanceSummary): Promise<void> {
  cardMenu.id = ''
  try {
    const copy = await duplicateInstance(summary.instance.id, `${summary.instance.name} 副本`)
    await refreshInstances()
    selectedId.value = copy.id
    toast(`已复制为 ${copy.name}`, 'success')
  } catch (error) {
    toast('复制失败：' + errText(error), 'error')
  }
}

async function refreshInstances(): Promise<void> {
  try {
    await loadInstances()
  } catch (error) {
    toast('刷新实例列表失败：' + errText(error), 'error')
  }
}

const removeModal = reactive({ open: false, target: null as InstanceSummary | null, busy: false })

function requestRemove(summary: InstanceSummary): void {
  cardMenu.id = ''
  removeModal.target = summary
  removeModal.open = true
}

async function confirmRemove(): Promise<void> {
  const summary = removeModal.target
  if (!summary || removeModal.busy) return
  removeModal.busy = true
  try {
    await deleteInstance(summary.instance.id, false)
    await loadInstances()
    removeModal.open = false
    toast(`已删除实例 ${instanceTitle(summary)}`, 'success')
  } catch (error) {
    toast('删除失败：' + errText(error), 'error')
  } finally {
    removeModal.busy = false
  }
}

async function togglePin(summary: InstanceSummary): Promise<void> {
  cardMenu.id = ''
  try {
    await togglePinned(summary.instance)
    await loadInstances()
  } catch (error) {
    toast('收藏失败：' + errText(error), 'error')
  }
}

/* -------------------------------------------------------- 空状态：安装版本 */
const installBusy = ref(false)
const installedCount = ref(0)

async function loadVersionFacts(): Promise<void> {
  installedCount.value = (await soft(installedVersionIds(), [] as string[])).length
}

async function installLatestRelease(): Promise<void> {
  if (installBusy.value) return
  installBusy.value = true
  try {
    const versions = await soft(listVersions(), [] as VersionRef[])
    const target = latestRelease(versions)
    if (!target) {
      toast('版本清单为空，请先在版本页刷新', 'error')
      goto('versions')
      return
    }
    const job = await installVersion({ id: target.id, createInstance: true, instanceName: `${target.id} 新实例` })
    jobs.value = [...jobs.value, job]
    toast(`开始下载 ${target.id}`, 'success')
  } catch (error) {
    toast('安装失败：' + errText(error), 'error')
  } finally {
    installBusy.value = false
  }
}

/* ------------------------------------------------------------- 账户与皮肤 */
const accountName = computed(() => selectedAccount.value?.name ?? '未登录')
const accountTypeLabel = computed(() => {
  const account = selectedAccount.value
  if (!account) return '添加账户后开始游戏'
  if (account.type === 'microsoft') return 'Microsoft 正版账户'
  if (account.type === 'yggdrasil') return '外置 Yggdrasil'
  if (account.type === 'authlib-injector') return account.server || 'authlib-injector'
  return '离线账户'
})
const accountStateClass = computed(() => {
  const account = selectedAccount.value
  if (!account) return 'offline-state'
  if (account.type === 'offline') return 'offline-state'
  return account.tokenState === 'valid' ? '' : 'stale-state'
})

const skin = ref<SkinInfo | null>(null)
const skinLoading = ref(false)
const skinError = ref('')
let skinRequestToken = 0

const skinModelText = computed(() => (skin.value ? (skin.value.model === 'slim' ? '纤细模型' : '经典模型') : '账户皮肤'))

/** `SkinInfo.previewPng` is a data url in the browser preview and a temp path in Electron. */
const skinSrc = computed(() => {
  const value = skin.value?.previewPng ?? ''
  if (!value) return ''
  return /^(data:|https?:|blob:|file:)/i.test(value) ? value : `file:///${value.replace(/\\/g, '/')}`
})

async function reloadSkin(): Promise<void> {
  const request = ++skinRequestToken
  skinError.value = ''
  const account = selectedAccount.value
  if (!account) {
    skin.value = null
    skinLoading.value = false
    return
  }
  skinLoading.value = true
  try {
    const info = await accountSkin(account.id)
    if (request === skinRequestToken) skin.value = info
  } catch (error) {
    if (request === skinRequestToken) skinError.value = errText(error)
  } finally {
    if (request === skinRequestToken) skinLoading.value = false
  }
}

watch(
  () => selectedAccount.value?.id,
  () => {
    skin.value = null
    void reloadSkin()
  }
)

/* ------------------------------------------------------------------- 生命周期 */
let unsubscribers: Array<() => void> = []

function subscribeAll(): void {
  unsubscribers = [
    onProgress((progress) => {
      progressByJob.value = { ...progressByJob.value, [progress.jobId]: progress }
      // A job can start from another page: adopt it so its progress stays visible here.
      if (!jobs.value.some((entry) => entry.id === progress.jobId)) {
        jobs.value = [
          ...jobs.value,
          {
            id: progress.jobId,
            title: progress.currentLabel.split(' · ')[0] ?? progress.currentLabel,
            kind: 'misc',
            status: progress.status,
            total: progress.total,
            done: progress.done,
            failed: progress.failed,
            skipped: 0,
            bytesTotal: progress.bytesTotal,
            bytesDone: progress.bytesDone,
            startedAt: Date.now()
          }
        ]
      } else {
        jobs.value = jobs.value.map((entry) =>
          entry.id === progress.jobId
            ? { ...entry, status: progress.status, done: progress.done, failed: progress.failed, bytesTotal: progress.bytesTotal, bytesDone: progress.bytesDone }
            : entry
        )
      }
    }),
    onJobFinished((job) => {
      jobs.value = jobs.value.filter((entry) => entry.id !== job.id)
      const rest = { ...progressByJob.value }
      delete rest[job.id]
      progressByJob.value = rest
      if (job.status === 'done') {
        toast(`${job.title} 已完成`, 'success')
        void refreshInstances()
        void loadVersionFacts()
      } else if (job.status === 'error') {
        toast(`${job.title} 失败：${job.error?.message ?? '未知错误'}`, 'error')
      }
    }),
    onGameLog((line) => {
      if (!currentInstance.value || line.instanceId !== currentInstance.value.id) return
      if (!logOpen.value) return
      logs.value = [...logs.value.slice(-499), line]
    }),
    onGameExit((exit: GameExitInfo) => {
      games.value = games.value.filter((entry) => entry.instanceId !== exit.instanceId)
      if (exit.code === 0) {
        toast('游戏已正常退出', 'info')
        return
      }
      launchPhase.value = 'error'
      launchFailure.value = exit.analysis
        ? `${exit.analysis.title}：${exit.analysis.cause}`
        : `异常退出（code ${exit.code ?? '未知'}）`
      toast('游戏异常退出：' + launchFailure.value, 'error')
    }),
    api().on(EVENTS.settings, (payload) => {
      settings.value = payload as Settings
    })
  ]
}

onMounted(async () => {
  subscribeAll()
  window.addEventListener('resize', updateRecentWidth)
  await Promise.all([loadAll(), loadJavaSummary(), loadVersionFacts()])
  games.value = await soft(runningGames(), [] as GameProcessInfo[])
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateRecentWidth)
  for (const off of unsubscribers) off()
  unsubscribers = []
  for (const timer of toastTimers.values()) clearTimeout(timer)
  toastTimers.clear()
  skinRequestToken++
})
</script>

<template>
  <div class="home-dashboard">
    <div class="home-main">
      <section class="hero-card no-banner">
        <div class="hero-content">
          <span class="hero-kicker">当前版本</span>
          <div class="hero-metadata-slot">
            <Transition name="instance-switch" mode="out-in">
              <div :key="heroKey" class="hero-metadata">
                <h1 :title="heroName" :class="{ 'long-name': heroName.length > 16 }">{{ heroName }}</h1>
                <div class="hero-edition">
                  <span
                    v-if="currentInstance && !heroName.includes(heroVersion)"
                    class="hero-game-version"
                    :title="`Minecraft ${heroVersion}`"
                    >{{ heroVersion }}</span
                  >
                  <span v-if="currentInstance" class="loader-badge">{{ loaderBadgeOf(currentInstance) }}</span>
                  <span v-else-if="loading" class="loader-badge">读取中…</span>
                  <span v-if="current && needsAttention(current)" class="loader-badge warn-badge">需要校验修复</span>
                </div>
              </div>
            </Transition>
          </div>

          <div class="hero-actions">
            <div class="hero-secondary-actions">
              <button class="hero-settings" :disabled="!currentInstance" @click="goto('instances')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1.4 1.68V21h-4v-.08A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 13.6H3v-4h.08A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10.4 3H14a1.7 1.7 0 0 0 1.4 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 21 10.4V14a1.7 1.7 0 0 0-1.6 1Z" /></svg>
                实例设置
              </button>
              <button
                class="hero-more"
                :disabled="!currentInstance"
                title="更多实例操作"
                @click="currentInstance && openCardMenu($event, currentInstance.id)"
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
              </button>
            </div>

            <div class="launch-combo">
              <button class="launch-main" :class="{ launching }" :disabled="launching || !currentInstance" @click="onLaunchClick">
                <span v-if="launching" class="launch-progress" :style="{ width: percent + '%' }"></span>
                <span class="launch-content">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
                  <span>{{ launchText }}</span>
                </span>
              </button>
              <button ref="versionMenuButton" class="launch-arrow" title="选择游戏实例" @click="toggleVersionMenu">
                <svg :class="{ open: versionMenu.open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      <div v-if="loadError" class="status-strip error" role="alert">
        <span>实例数据读取失败：{{ loadError }}</span>
        <button class="btn btn-ghost btn-sm" @click="loadAll()">重新读取</button>
      </div>

      <div v-else-if="activeJob" class="status-strip" role="status">
        <span class="strip-title u-truncate">{{ progressText }}</span>
        <span class="strip-bar" aria-hidden="true"><i :style="{ width: percent + '%' }"></i></span>
        <span class="mono">{{ percent }}%</span>
        <span v-if="bytesText" class="mono">{{ bytesText }}</span>
        <span v-if="speedText" class="mono strip-speed">{{ speedText }}</span>
        <span v-if="activeProgress" class="muted mono">剩余 {{ etaText }}</span>
        <button class="btn btn-ghost btn-sm" @click="cancelJob(activeJob)">取消</button>
      </div>

      <section ref="runtimeStrip" class="runtime-strip" @mouseleave="runtimeHover = -1">
        <span class="runtime-blob" :class="{ on: runtimeHover >= 0 }" :style="runtimeBlobStyle" aria-hidden="true"></span>
        <button class="runtime-item" @mouseenter="runtimeHover = 0" @click="openJavaPicker" title="选择此实例的 Java：自动或手动">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M7 8h10a4 4 0 0 1 4 4v0a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v0a4 4 0 0 1 4-4Z" /><path d="M8 13h8M9 17h6" /></svg>
          <span><small>运行环境</small><strong>{{ javaText }}</strong></span>
          <svg class="runtime-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <button class="runtime-item" @mouseenter="runtimeHover = 1" @click="openMemoryEditor" title="调整此实例的内存分配">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4M9 9h6v6H9Z" /></svg>
          <span><small>内存分配</small><strong>{{ memoryText }}</strong></span>
          <svg class="runtime-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        <button class="runtime-item runtime-state" :class="heroStatus.tone" @mouseenter="runtimeHover = 2" @click="openLogs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>
          <span><small>运行状态</small><strong><i></i>{{ heroStatus.text }}</strong></span>
          <svg class="runtime-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </section>

      <section class="instances-block">
        <div class="instances-head">
          <h2>最近游戏</h2>
          <button class="manage-instances" @click="goto('instances')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
            管理实例
          </button>
        </div>

        <div v-if="loading" class="content-skeleton" role="status" aria-busy="true">
          <span class="muted">正在读取实例…</span>
          <div v-for="row in 4" :key="row" class="skeleton-row" aria-hidden="true"><i /><span /><b /></div>
        </div>

        <div v-else-if="instances.length" class="instance-grid">
          <article
            v-for="summary in recent"
            :key="summary.instance.id"
            class="instance-card"
            tabindex="0"
            :class="{ selected: summary.instance.id === selectedId }"
            :title="cardTooltip(summary)"
            @click="chooseVersion(summary.instance.id)"
            @keydown.enter.self="chooseVersion(summary.instance.id)"
            @keydown.space.self.prevent="chooseVersion(summary.instance.id)"
            @contextmenu.prevent="openCardMenu($event, summary.instance.id)"
          >
            <img v-if="instanceIconUrl(summary.instance)" class="instance-icon image" :src="instanceIconUrl(summary.instance)" alt="" />
            <svg v-else class="instance-icon" viewBox="0 0 48 48" aria-hidden="true"><polygon points="24,5 43,14.5 24,24 5,14.5" fill="#79c144" /><polygon points="5,14.5 24,24 24,29.5 5,20" fill="#5da236" /><polygon points="24,24 43,14.5 43,20 24,29.5" fill="#4e8a2f" /><polygon points="5,20 24,29.5 24,43 5,33.5" fill="#8b5e34" /><polygon points="24,29.5 43,20 43,33.5 24,43" fill="#6f4a29" /></svg>
            <div class="instance-copy">
              <strong :title="instanceTitle(summary)">{{ instanceTitle(summary) }}</strong>
              <span :title="instanceSub(summary)">{{ instanceSub(summary) }}</span>
            </div>
            <button class="instance-more" title="更多" @click.stop="openCardMenu($event, summary.instance.id)">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
            <span v-if="games.some((entry) => entry.instanceId === summary.instance.id)" class="tag tag-success instance-last">运行中</span>
            <span v-else-if="needsAttention(summary)" class="tag tag-danger instance-last">需要校验修复</span>
            <span v-else-if="summary.instance.lastPlayedAt" class="instance-last">上次游玩：{{ lastPlayedText(summary.instance.lastPlayedAt) }}</span>
            <span v-else class="instance-last">尚未启动过</span>
            <button
              class="instance-play"
              :disabled="launching"
              :title="`启动 ${summary.instance.name}`"
              @click.stop="startVersion(summary.instance.id)"
            >
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z" /></svg>
            </button>
          </article>
        </div>

        <div v-else class="empty-instances">
          <strong>还没有游戏实例</strong>
          <span class="muted">
            {{ settings?.gameRoot || '当前游戏目录未设置' }}
            <template v-if="installedCount"> · 本地已安装 {{ installedCount }} 个版本</template>
            <template v-else> · 本地还没有已安装版本</template>
          </span>
          <div class="empty-actions">
            <button class="btn btn-gold" :disabled="installBusy" @click="installLatestRelease">
              {{ installBusy ? '准备中…' : '安装最新版本并创建实例' }}
            </button>
            <button class="btn btn-ghost" @click="goto('versions')">前往版本管理</button>
            <button class="btn btn-ghost" @click="goto('instances')">创建实例</button>
          </div>
        </div>
      </section>
    </div>

    <aside class="home-side">
      <section class="account-panel">
        <template v-if="selectedAccount">
          <div class="account-head">
            <div class="mc-avatar letter" :style="{ width: '54px', height: '54px', fontSize: '23px' }">
              {{ accountName.charAt(0).toUpperCase() }}
            </div>
            <div class="account-copy">
              <strong>{{ accountName }}</strong>
              <span :class="accountStateClass"><i></i>{{ selectedAccount.type === 'offline' ? '离线账号' : selectedAccount.tokenState === 'valid' ? '已登录' : '令牌需要刷新' }}</span>
            </div>
            <button class="account-more" title="账户管理" @click="goto('accounts')">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
            </button>
          </div>
          <button class="account-provider" @click="goto('accounts')">
            <span class="provider-mark" :class="selectedAccount.type"
              ><svg v-if="selectedAccount.type === 'microsoft'" viewBox="0 0 22 22" aria-label="Microsoft"><path fill="#f25022" d="M0 0h10v10H0z" /><path fill="#7fba00" d="M12 0h10v10H12z" /><path fill="#00a4ef" d="M0 12h10v10H0z" /><path fill="#ffb900" d="M12 12h10v10H12z" /></svg>
              <template v-else>{{ selectedAccount.type === 'yggdrasil' ? 'Y' : selectedAccount.type === 'authlib-injector' ? 'A' : 'O' }}</template></span
            >
            <span>{{ accountTypeLabel }}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </template>
        <template v-else>
          <div class="account-head">
            <div class="account-placeholder">?</div>
            <div class="account-copy"><strong>未登录</strong><span class="offline-state">请选择账户</span></div>
          </div>
          <button class="account-provider" @click="goto('accounts')">
            <span class="provider-mark offline">+</span><span>添加或选择账户</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </template>
      </section>

      <section class="skin-panel">
        <div class="skin-head">
          <div>
            <h3>皮肤预览</h3>
            <span>{{ skin ? skinModelText : '账户皮肤贴图' }}</span>
          </div>
          <button class="skin-refresh" :disabled="skinLoading || !selectedAccount" title="重新读取皮肤贴图" @click="reloadSkin">
            <svg :class="{ spinning: skinLoading }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18 6l2 1M4 17l2 1a7 7 0 0 0 11.9-3" /></svg>
          </button>
        </div>
        <div class="skin-stage">
          <img v-if="skinSrc" class="skin-texture" :src="skinSrc" alt="皮肤贴图" />
          <div v-if="skinLoading" class="skin-overlay"><span class="spin"></span><span>正在加载皮肤…</span></div>
          <button v-else-if="!selectedAccount" class="skin-overlay action" @click="goto('accounts')">登录后加载角色皮肤</button>
          <button v-else-if="skinError" class="skin-overlay action error" :title="skinError" @click="reloadSkin">皮肤加载失败，点击重试</button>
          <button v-else-if="skin && !skin.previewPng" class="skin-overlay action" @click="goto('accounts')">该账户还没有皮肤贴图</button>
        </div>
        <button class="skin-tip" @click="goto('accounts')">
          皮肤来自所选账户
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </section>
    </aside>

    <Teleport to="body">
      <div v-if="versionMenu.open" class="menu-overlay" @click="versionMenu.open = false"></div>
      <div
        v-if="versionMenu.open"
        class="float-menu"
        :style="{ top: versionMenu.top + 'px', left: versionMenu.left + 'px', width: versionMenu.width + 'px' }"
      >
        <button
          v-for="summary in sortedInstances"
          :key="summary.instance.id"
          class="menu-item"
          :class="{ active: summary.instance.id === selectedId }"
          @click="chooseVersion(summary.instance.id)"
          @contextmenu.prevent="openCardMenu($event, summary.instance.id)"
        >
          <svg v-if="summary.instance.quickAccess" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
          <span v-else class="menu-spacer"></span>
          {{ instanceTitle(summary) }}
        </button>
        <div v-if="!sortedInstances.length" class="menu-empty">暂无已安装实例</div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="cardMenu.id" class="menu-overlay" @click="cardMenu.id = ''"></div>
      <div v-if="cardMenu.id && cardMenuSummary" class="float-menu card-float-menu" :style="{ top: cardMenu.top + 'px', left: cardMenu.left + 'px' }">
        <button class="menu-item" @click="goto('instances'); cardMenu.id = ''">实例设置</button>
        <button class="menu-item" :disabled="launching" @click="startVersion(cardMenuSummary.instance.id); cardMenu.id = ''">启动实例</button>
        <button
          class="menu-item danger"
          :disabled="!games.some((entry) => entry.instanceId === cardMenuSummary?.instance.id)"
          @click="stopGame(cardMenuSummary.instance.id)"
        >
          结束游戏进程
        </button>
        <button class="menu-item" @click="togglePin(cardMenuSummary)">
          {{ cardMenuSummary.instance.quickAccess ? '取消收藏' : '收藏实例' }}
        </button>
        <button class="menu-item" @click="duplicateCurrent(cardMenuSummary)">复制实例</button>
        <button class="menu-item" @click="openVersionFolder(cardMenuSummary.instance.id)">打开文件夹</button>
        <button class="menu-item" :disabled="repairing || !needsAttention(cardMenuSummary)" @click="repairCurrent(cardMenuSummary)">校验修复文件</button>
        <button class="menu-item danger" @click="requestRemove(cardMenuSummary)">删除实例</button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="logOpen" class="log-mask" @pointerdown.self="logOpen = false">
        <section class="log-dialog" role="dialog" aria-modal="true" aria-label="游戏日志">
          <header>
            <div>
              <h3>启动日志</h3>
              <span>{{ logs.length }} 行 · {{ heroStatus.text }}<template v-if="current"> · {{ instanceTitle(current) }}</template></span>
            </div>
            <button class="log-close" title="关闭" @click="logOpen = false">×</button>
          </header>
          <div v-if="launchFailed" class="log-failure">
            <span>{{ launchFailure || '检测到启动失败或异常退出' }}</span>
            <button :disabled="analyzing" @click="analyseFailure">{{ analyzing ? '分析中…' : '分析日志' }}</button>
          </div>
          <div v-if="reports.length" class="log-reports">
            <div v-for="(report, index) in reports.slice(0, 2)" :key="index" class="log-report">
              <strong>{{ report.title }}</strong>
              <span>{{ report.cause }}</span>
              <em>{{ report.suggestion }}</em>
              <button v-if="report.reportPath" class="btn btn-ghost btn-sm" @click="revealReport(report)">打开报告</button>
            </div>
          </div>
          <div v-if="launchPlan" class="log-args">
            <div class="log-args-head">
              <strong>启动参数预览</strong>
              <span class="muted mono">Java {{ launchPlan.javaMajor }} · {{ launchPlan.classpath.length }} 个类路径 · {{ formatSize(current?.state.sizeBytes ?? 0) }}</span>
            </div>
            <code class="mono log-command">{{ launchPlan.commandLine }}</code>
            <ul v-if="launchPlan.notes.length" class="log-notes">
              <li v-for="note in launchPlan.notes" :key="note">{{ note }}</li>
            </ul>
          </div>
          <p v-else-if="planError" class="status-strip error log-plan-error" role="alert">{{ planError }}</p>
          <div ref="logBody" class="log-body">
            <p v-if="!logs.length" class="log-empty">{{ logsBusy ? '正在读取日志…' : '暂无启动日志' }}</p>
            <pre v-else><span v-for="(line, index) in logs" :key="index">{{ line.text }}</span></pre>
          </div>
          <footer>
            <button class="btn btn-ghost btn-sm" :disabled="!currentInstance" @click="refreshLogs">重新读取</button>
            <button class="btn btn-ghost btn-sm" :disabled="!logs.length" @click="logs = []">清空显示</button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="javaPicker" class="modal-mask" @pointerdown.self="!javaSaving && (javaPicker = null)">
        <section class="modal java-picker" role="dialog" aria-modal="true" aria-labelledby="java-picker-title">
          <h3 id="java-picker-title" class="modal-title">选择 Java 运行环境</h3>
          <p class="java-picker-description">{{ javaPicker.name }} · 仅修改此实例，不影响其他实例</p>
          <label class="java-option"><input v-model="javaPicker.choice" type="radio" value="@auto" name="home-java" /><span><strong>自动选择</strong><small>按游戏的真实版本要求匹配 Java，必要时自动下载{{ javaResolve ? `（本实例需要 Java ${javaResolve.major}）` : '' }}</small></span></label>
          <label class="java-option"><input v-model="javaPicker.choice" type="radio" value="@global" name="home-java" /><span><strong>跟随全局设置</strong><small>{{ globalJavaText }}</small></span></label>
          <div class="java-list">
            <label v-for="runtime in usableJava" :key="runtime.id" class="java-option">
              <input v-model="javaPicker.choice" type="radio" :value="`@path:${runtime.path}`" name="home-java" />
              <span><strong>Java {{ runtime.major }} · {{ runtime.arch || (runtime.executable ? '64-bit' : '未知') }} · {{ runtime.vendor }}</strong><small :title="runtime.path">{{ runtime.path }}</small></span>
            </label>
            <p v-if="!usableJava.length" class="java-picker-description">{{ javaChecked ? '未发现可用 Java，可使用自动选择，或在设置中添加。' : '正在扫描本地 Java…' }}</p>
          </div>
          <p v-if="javaMissing" class="status-strip">
            <span>本实例需要的 Java {{ javaResolve?.major }} 尚未下载。</span>
            <button class="btn btn-ghost btn-sm" :disabled="provisioning" @click="fetchMissingJava">{{ provisioning ? '下载中…' : `下载 Java ${javaResolve?.major}` }}</button>
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="javaSaving" @click="javaPicker = null; goto('java')">管理 Java</button>
            <button class="btn btn-ghost" :disabled="javaSaving" @click="javaPicker = null">取消</button>
            <button class="btn btn-gold" :disabled="javaSaving" @click="saveJavaChoice">{{ javaSaving ? '保存中…' : '保存选择' }}</button>
          </div>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="memoryEditor" class="modal-mask" @pointerdown.self="!memorySaving && (memoryEditor = null)">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="memory-title">
          <h3 id="memory-title" class="modal-title">内存分配</h3>
          <p class="java-picker-description">{{ memoryEditor.name }} · 仅修改此实例；全局默认 {{ formatMemory(settings?.defaultMemoryMb ?? 0) }}</p>
          <div class="memory-row">
            <input v-model.number="memoryEditor.mb" class="slider" type="range" min="1024" max="16384" step="512" />
            <strong class="mono memory-value">{{ formatMemory(memoryEditor.mb) }}</strong>
          </div>
          <input v-model.number="memoryEditor.mb" class="input" type="number" min="512" max="32768" step="512" />
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="memorySaving" @click="memoryEditor = null">取消</button>
            <button class="btn btn-gold" :disabled="memorySaving" @click="saveMemory">{{ memorySaving ? '保存中…' : '保存分配' }}</button>
          </div>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="removeModal.open" class="modal-mask" @pointerdown.self="!removeModal.busy && (removeModal.open = false)">
        <section class="modal" role="dialog" aria-modal="true" aria-label="删除实例">
          <h3 class="modal-title">删除实例</h3>
          <p class="confirm-text">
            确定要删除实例「{{ removeModal.target ? instanceTitle(removeModal.target) : '' }}」吗？实例配置会被移除，游戏文件与共享依赖保留。
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="removeModal.busy" @click="removeModal.open = false">取消</button>
            <button class="btn btn-danger" :disabled="removeModal.busy" @click="confirmRemove">{{ removeModal.busy ? '处理中…' : '确认删除' }}</button>
          </div>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <TransitionGroup name="toast" tag="div" class="toasts" aria-live="polite" aria-relevant="additions text">
        <div v-for="item in toasts" :key="item.id" class="toast" :class="`toast-${item.type}`">
          <span class="toast-dot"></span>
          <span class="toast-text">{{ item.text }}</span>
          <button class="icon-btn toast-close" aria-label="关闭通知" @click="dismissToast(item.id)">×</button>
        </div>
      </TransitionGroup>
    </Teleport>
  </div>
</template>

<style scoped>
.recent-grid, .instance-grid { grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr)) !important; }
.hero-content h1 { overflow-wrap:break-word; word-break:normal; }
.runtime-strip { background:var(--surface-content) !important; }
.home-side { align-self:start; }

.java-picker { width: min(580px, calc(100vw - 40px)); }
.java-picker .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
.java-picker-description { color: var(--text-dim); font-size: 12px; margin-bottom: 16px; overflow-wrap: anywhere; }
.java-list { max-height: 32vh; overflow: auto; margin-top: 10px; }
.java-option { display: flex; gap: 12px; align-items: center; padding: 13px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 12px; cursor: pointer; }
.java-option:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.java-option input { accent-color: var(--accent); flex: none; }
.java-option span { min-width: 0; }
.java-option strong, .java-option small { display: block; }
.java-option small { margin-top: 5px; font-size: 11px; color: var(--text-dim); overflow-wrap: anywhere; }
.memory-row { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.memory-row .slider { flex: 1; }
.memory-value { min-width: 74px; text-align: right; font-weight: 650; }
.home-dashboard {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
  gap: 14px;
  width: 100%;
  max-width: 1160px;
  margin: 0 auto;
  min-width: 0;
  min-height: calc(100vh - 132px);
}
.home-main {
  display: flex;
  min-width: 0;
  min-height: inherit;
  flex-direction: column;
  gap: 14px;
}
.hero-card {
  position: relative;
  height: var(--banner-h);
  min-height: 348px;
  flex: none;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 95%, white 4%);
  border-radius: 20px;
  background: #17231f;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.22);
}
.hero-card.no-banner { background: var(--surface-content); box-shadow: none; }
.no-banner .hero-content, .no-banner .hero-content h1, .no-banner .hero-game-version { color: var(--text); text-shadow: none; }
.no-banner .hero-kicker, .no-banner .hero-settings, .no-banner .hero-more { background: var(--card-2); color: var(--text); border-color: var(--border); backdrop-filter: none; }
.no-banner .loader-badge { color: var(--accent-2); background: var(--accent-soft); }
.hero-content { position: relative; z-index: 1; display: flex; height: 100%; padding: 48px 44px 32px 44px; flex-direction: column; align-items: flex-start; color: var(--bn-text); }
.hero-kicker { display: inline-flex; align-items: center; min-height: 34px; padding: 0 14px; border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 7px; background: rgba(9, 13, 14, 0.48); backdrop-filter: blur(12px); font-size: 13px; font-weight: 650; }
.hero-content h1 { max-width: 100%; margin-top: 18px; overflow: hidden; color: #fff; font-size: clamp(46px, 5.2vw, 64px); font-weight: 850; line-height: 1.15; letter-spacing: -1px; text-overflow: ellipsis; text-shadow: 0 4px 24px rgba(0, 0, 0, 0.32); white-space: nowrap; }
.hero-content h1.long-name { font-size: clamp(28px, 3.2vw, 42px); letter-spacing: -0.5px; }
.hero-metadata-slot { width: 100%; min-height: 130px; position: relative; }
.hero-metadata { width: 100%; }
.instance-switch-enter-active, .instance-switch-leave-active { transition: opacity 100ms ease, transform 100ms ease; }
.instance-switch-enter-from { opacity: 0; transform: translateY(2px); }
.instance-switch-leave-to { opacity: 0; transform: translateY(-2px); }
@media (prefers-reduced-motion: reduce) {
  .instance-switch-enter-active, .instance-switch-leave-active { transition: none; }
}
.hero-edition { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 16px; font-size: 17px; font-weight: 650; overflow-wrap: anywhere; }
.hero-game-version { color: #fff; }
.loader-badge { padding: 5px 11px; border: 1px solid color-mix(in srgb, var(--accent-2) 34%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--accent) 30%, rgba(20, 30, 24, 0.46)); color: #f6fff8; font-size: 11px; font-weight: 650; }
.loader-badge.warn-badge { border-color: var(--danger-border); background: var(--danger-soft); color: var(--danger); }
.hero-actions { display: flex; width: 100%; margin-top: auto; align-items: flex-end; justify-content: space-between; gap: 18px; }
.hero-secondary-actions, .launch-combo { display: flex; align-items: stretch; }
.hero-settings, .hero-more { height: 52px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(10, 16, 17, 0.58); color: #f4f7f5; backdrop-filter: blur(13px); cursor: pointer; }
.hero-settings { display: inline-flex; align-items: center; gap: 10px; min-width: 150px; padding: 0 18px; border-radius: 10px 0 0 10px; font-family: inherit; font-size: 14px; font-weight: 650; }
.hero-settings svg { width: 18px; height: 18px; }
.hero-more { width: 52px; border-left: 0; border-radius: 0 10px 10px 0; }
.hero-more svg { width: 19px; height: 19px; }
.hero-settings:hover:not(:disabled), .hero-more:hover:not(:disabled) { background: rgba(19, 29, 29, 0.76); }
.hero-settings:disabled, .hero-more:disabled { opacity: 0.45; cursor: default; }
.launch-combo {
  min-width: 310px; height: 76px; border-radius: 14px; overflow: hidden;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--accent) 38%, transparent), 0 2px 0 color-mix(in srgb, white 14%, transparent) inset;
  transition: transform var(--motion-normal) var(--ease-out), box-shadow 0.22s ease;
}
.launch-combo:hover { transform: translateY(-2px); box-shadow: 0 16px 40px color-mix(in srgb, var(--accent) 46%, transparent), 0 2px 0 color-mix(in srgb, white 16%, transparent) inset; }
.launch-combo:active { transform: translateY(0) scale(0.99); }
.launch-main, .launch-arrow { position: relative; overflow: hidden; border: 0; background: var(--accent-grad); color: var(--on-accent); cursor: pointer; }
.launch-main { flex: 1; min-width: 0; padding: 0 26px; font-family: inherit; font-size: 21px; font-weight: 800; letter-spacing: 0.5px; }
.launch-content { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 12px; }
.launch-content svg { width: 22px; height: 22px; flex: none; }
.launch-content span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.launch-progress { position: absolute; inset: 0 auto 0 0; background: rgba(255, 255, 255, 0.25); transition: width 0.25s ease; }
.launch-main:disabled { cursor: not-allowed; filter: saturate(0.75); }
.launch-arrow { width: 62px; border-left: 1px solid rgba(255, 255, 255, 0.22); }
.launch-arrow:hover, .launch-main:hover:not(:disabled) { filter: brightness(1.08); }
.launch-arrow svg { width: 22px; height: 22px; transition: transform 0.18s ease; }
.launch-arrow svg.open { transform: rotate(180deg); }

.runtime-strip { position: relative; display: grid; grid-template-columns: 1.12fr 0.95fr 0.92fr; min-height: 82px; flex: none; overflow: hidden; border: 1px solid var(--border); border-radius: 15px; background: color-mix(in srgb, var(--card) 80%, transparent); box-shadow: var(--shadow); backdrop-filter: blur(18px) saturate(130%); -webkit-backdrop-filter: blur(18px) saturate(130%); }
/* 悬浮浮块：跟随指针在三格间平滑滑动（浮起+落下+格间转移过渡） */
.runtime-blob {
  position: absolute; top: 0; bottom: 0; z-index: 0;
  border-radius: 12px; margin: var(--space-1) 0;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  opacity: 0; transform: scale(0.97);
  transition: left var(--motion-normal) var(--ease-out), width var(--motion-normal) var(--ease-out), opacity 0.18s ease, transform 0.2s ease;
  pointer-events: none;
}
.runtime-blob.on { opacity: 1; transform: scale(1); }
.runtime-item { position: relative; z-index: 1; display: grid; grid-template-columns: 34px minmax(0, 1fr) 15px; align-items: center; gap: 11px; min-width: 0; padding: 0 18px; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; transition: transform 0.18s cubic-bezier(0.22, 0.9, 0.32, 1.15); }
.runtime-item + .runtime-item { border-left: 1px solid var(--border); }
.runtime-item:hover { color: var(--accent-2); }
.runtime-item > svg:first-child { width: 27px; height: 27px; color: var(--text); }
.runtime-item > span { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.runtime-item small { color: var(--text-dim); font-size: 12px; }
.runtime-item strong { overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.runtime-chevron { width: 14px; height: 14px; color: var(--text-dim); opacity: 0.7; }
.runtime-state > svg:first-child { color: var(--accent-2); }
.runtime-state strong { display: flex; align-items: center; gap: 7px; color: var(--accent-2); }
.runtime-state i { width: 7px; height: 7px; flex: none; border-radius: 50%; background: #9ca3af; }
.runtime-state.ready i, .runtime-state.running i { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.runtime-state.error strong { color: var(--danger); }
.runtime-state.error i { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }

.instances-block { min-width: 0; margin-top: 14px; }
.instances-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 13px; }
.instances-head h2 { font-size: 17px; font-weight: 750; display: flex; align-items: center; gap: 9px; }
/* 区块标题前的主题色短竖线：视觉锚点 */
.instances-head h2::before { content: ''; width: 4px; height: 17px; border-radius: 2px; background: var(--accent-grad); flex: none; }
.manage-instances { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-2); color: var(--text-dim); font-family: inherit; font-size: 12px; font-weight: 550; cursor: pointer; }
.manage-instances:hover { color: var(--text); border-color: var(--border-strong); }
.manage-instances svg { width: 15px; height: 15px; }
.instance-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
/* Cards appear together so every action is available at the same time. */
.instance-card { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); grid-template-rows: 1fr auto; gap: 8px 8px; min-width: 0; height: 132px; min-height: 132px; padding: 17px 14px 13px; border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--card) 82%, transparent); cursor: pointer; transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease, box-shadow 0.22s ease; animation: card-in var(--motion-enter) var(--ease-out) backwards; }
@keyframes card-in { from { opacity: 0; } to { opacity: 1; } }
.instance-card:hover { border-color: var(--border-strong); background: var(--card-2); transform: translateY(-1px); box-shadow: var(--shadow); }
.instance-card.selected { border-color: var(--accent-2); box-shadow: inset 0 0 0 1px var(--accent); }
.instance-icon { align-self: center; width: 36px; height: 36px; }
.instance-icon.image { object-fit: contain; image-rendering: pixelated; }
.instance-copy { grid-column: 2; padding-right: 7px; align-self: center; display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.instance-copy strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 1.4; font-weight: 650; overflow-wrap: anywhere; word-break: break-all; }
.instance-copy span, .instance-last { overflow: hidden; color: var(--text-dim); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.instance-more { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border: 0; border-radius: 7px; background: transparent; color: var(--text-dim); cursor: pointer; }
.instance-more:hover { background: var(--hover); color: var(--text); }
.instance-more svg { width: 15px; height: 15px; }
.instance-last { grid-column: 1 / -1; grid-row: 2; padding-right: 42px; align-self: center; }
.instance-play { grid-column: 2; grid-row: 2; display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 32px; justify-self: end; border: 0; border-radius: 8px; background: color-mix(in srgb, var(--accent) 18%, var(--card-2)); color: var(--accent-2); cursor: pointer; }
.instance-play:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
.instance-play:disabled { opacity: 0.45; cursor: default; }
.instance-play svg { width: 15px; height: 15px; }
.empty-instances { width: 100%; min-height: 110px; border: 1px dashed var(--border-strong); border-radius: 13px; background: var(--card); color: var(--text-dim); cursor: pointer; }

.home-side { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.account-panel, .skin-panel { border: 1px solid var(--border); border-radius: 15px; background: var(--surface-content); box-shadow: var(--shadow); }
.account-panel { min-height: 146px; padding: 18px; }
.account-head { display: flex; align-items: center; gap: 13px; }
.mc-avatar { border-radius: var(--radius-md); image-rendering: pixelated; flex-shrink: 0; }
.mc-avatar.letter { display: flex; align-items: center; justify-content: center; font-weight: 800; color: var(--on-accent); background: var(--accent-grad); border-radius: 50%; box-shadow: 0 0 0 4px color-mix(in srgb, var(--text) 8%, transparent); }
.account-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; }
.account-copy strong { overflow: hidden; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
.account-copy span { display: flex; align-items: center; gap: 7px; color: var(--accent-2); font-size: 11px; }
.account-copy span i { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.account-copy .offline-state { color: var(--text-dim); }
.account-copy .offline-state i { background: var(--text-dim); box-shadow: none; }
.account-copy .stale-state { color: var(--danger); }
.account-copy .stale-state i { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.account-more, .skin-refresh { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--text-dim); cursor: pointer; }
.account-more:hover, .skin-refresh:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.account-more svg, .skin-refresh svg { width: 17px; height: 17px; }
.account-placeholder { display: flex; align-items: center; justify-content: center; width: 54px; height: 54px; border: 1px dashed var(--border-strong); border-radius: 12px; color: var(--text-dim); font-size: 20px; }
.account-provider { display: grid; grid-template-columns: 26px minmax(0, 1fr) 15px; align-items: center; gap: 10px; width: 100%; min-height: 44px; margin-top: 15px; padding: 0 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-2); color: var(--text); font-family: inherit; font-size: 12px; font-weight: 550; text-align: left; cursor: pointer; }
.provider-mark.microsoft { background: transparent; border-radius: 0; }
.provider-mark.microsoft svg { width: 22px; height: 22px; }
.account-provider:hover { border-color: var(--border-strong); }
.account-provider > svg { width: 15px; height: 15px; color: var(--text-dim); }
.provider-mark { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; background: linear-gradient(135deg, #f35325 0 48%, #81bc06 48% 100%); color: #fff; font-size: 10px; font-weight: 800; }
.provider-mark.yggdrasil { background: linear-gradient(135deg, #65bd78, #268e54); }
.provider-mark.authlib-injector { background: linear-gradient(135deg, #38bdf8, #2563eb); }
.provider-mark.offline { background: var(--card); color: var(--text-dim); }

.skin-panel { min-height: 400px; padding: 16px 15px 12px; }
.skin-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 0 2px 8px; }
.skin-head > div { display: flex; flex-direction: column; gap: 3px; }
.skin-head h3 { font-size: 14px; font-weight: 700; }
.skin-head span { color: var(--text-dim); font-size: 10px; }
.skin-refresh:disabled { opacity: 0.4; cursor: default; }
.skin-refresh .spinning { animation: spin 0.8s linear infinite; }
.skin-stage { position: relative; height: 300px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border) 78%, transparent); border-radius: 12px; background: radial-gradient(circle at 50% 82%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 38%), linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg) 18%, transparent)); display: flex; align-items: center; justify-content: center; }
.skin-texture { height: 84%; width: auto; image-rendering: pixelated; }
.skin-overlay { position: absolute; z-index: 2; right: 12px; bottom: 12px; left: 12px; display: flex; min-height: 34px; align-items: center; justify-content: center; gap: 9px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--card) 78%, transparent); color: var(--text-dim); font-family: inherit; font-size: 11px; font-weight: 550; backdrop-filter: blur(12px); }
.skin-overlay.action { cursor: pointer; }
.skin-overlay.action:hover { color: var(--text); }
.skin-overlay.error { color: var(--danger); }
.skin-tip { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; margin-top: 8px; border: 0; background: transparent; color: var(--text-dim); font-family: inherit; font-size: 10px; font-weight: 500; cursor: pointer; }
.skin-tip:hover { color: var(--accent-2); }
.skin-tip svg { width: 12px; height: 12px; }

.menu-overlay { position: fixed; inset: 0; z-index: 8000; }
.float-menu { position: fixed; z-index: 8001; max-height: 280px; overflow-y: auto; padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--card) 94%, transparent); box-shadow: var(--shadow-lg); backdrop-filter: blur(24px); }
.card-float-menu { width: 232px; max-height: 340px; background: var(--card-solid, #192225); }
.card-float-menu .menu-item { min-height: 40px; font-size: 13px; }
.menu-item:disabled { opacity: .45; cursor: not-allowed; }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font-family: inherit; font-size: 12px; font-weight: 500; text-align: left; cursor: pointer; }
.menu-item:hover, .menu-item.active { background: var(--accent-soft); color: var(--accent-2); }
.menu-item.danger { color: var(--danger); }
.menu-spacer { width: 12px; flex: none; }
.menu-empty { padding: 20px 8px; color: var(--text-dim); font-size: 12px; text-align: center; }

.log-mask { position: fixed; z-index: 9100; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--mask); backdrop-filter: blur(5px); }
.log-dialog { display: flex; width: min(760px, calc(100vw - 64px)); max-height: min(620px, calc(100vh - 80px)); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: color-mix(in srgb, var(--card) 94%, transparent); box-shadow: var(--shadow-lg); }
.log-dialog header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.log-dialog header div { display: flex; flex-direction: column; gap: 3px; }
.log-dialog h3 { font-size: 16px; }
.log-dialog header span { color: var(--text-dim); font-size: 11px; }
.log-close { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--text-dim); font-size: 20px; cursor: pointer; }
.log-close:hover { background: var(--hover); color: var(--text); }
.log-failure { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 18px; background: var(--danger-soft); color: var(--danger); font-size: 12px; }
.log-failure button { padding: 6px 10px; border: 1px solid var(--danger-border); border-radius: 7px; background: transparent; color: var(--danger); cursor: pointer; }
.log-reports { display: flex; flex-direction: column; gap: 8px; padding: 12px 18px; border-bottom: 1px solid var(--border); }
.log-report { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; align-items: center; font-size: 12px; }
.log-report strong { font-size: 13px; }
.log-report span, .log-report em { color: var(--text-dim); font-style: normal; overflow-wrap: anywhere; }
.log-report em { color: var(--accent-2); }
.log-args { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.log-args-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 12px; }
.log-command { display: block; max-height: 92px; overflow: auto; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--bg) 42%, transparent); color: var(--text-dim); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; user-select: text; }
.log-notes { margin: 8px 0 0; padding-left: 18px; color: var(--text-dim); font-size: 11px; line-height: 1.7; }
.log-plan-error { margin: 12px 18px 0; font-size: 12px; }
.log-body { min-height: 220px; flex: 1; overflow: auto; padding: 14px 18px; background: color-mix(in srgb, var(--bg) 42%, transparent); user-select: text; }
.log-body pre { display: flex; flex-direction: column; color: var(--text-dim); font: 11.5px/1.65 'Cascadia Code', Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
.log-empty { padding: 70px 0; color: var(--text-dim); text-align: center; }
.log-dialog footer { display: flex; justify-content: flex-end; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }

/* 下载进度行：复用共享 .status-strip，只补进度条本身 */
.strip-title { flex: 1 1 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.strip-bar { position: relative; flex: 2 1 120px; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--text) 12%, transparent); overflow: hidden; }
.strip-bar i { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--accent-grad); transition: width 0.25s ease; }
.strip-speed { color: var(--accent-2); }

/* 加载骨架（上游 ContentSkeleton 的标记与尺寸） */
.content-skeleton { display:grid; gap:12px; padding:16px 0; }
.skeleton-row { display:flex; align-items:center; gap:16px; height:48px; }
.skeleton-row i,.skeleton-row span,.skeleton-row b { background:color-mix(in srgb,var(--text) 9%,var(--card)); border-radius:var(--radius-sm); }
.skeleton-row i { width:36px; height:36px; }
.skeleton-row span { flex:1; height:18px; max-width:65%; }
.skeleton-row b { margin-left:auto; width:76px; height:32px; }

/* 通知栈（上游 Toasts.vue 的标记，内联到本视图以便独立渲染） */
.toasts { position: fixed; top: 76px; right: var(--space-5); z-index: 200; display: flex; flex-direction: column; gap: var(--space-2); pointer-events: none; }
.toast { display: flex; align-items: center; gap: var(--space-3); max-width: 360px; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius-md); background: var(--surface-raised); box-shadow: var(--shadow-lg); font-size: var(--text-sm); line-height: 1.5; user-select: text; }
.toast-close { pointer-events:auto; width:28px; height:28px; }
.toast-text { overflow-wrap:anywhere; }
.toast-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--accent); }
.toast-success { border-left-color: var(--ok); }
.toast-success .toast-dot { background: var(--ok); }
.toast-error { border-left-color: var(--danger); }
.toast-error .toast-dot { background: var(--danger); }
.toast-info { border-left-color: var(--accent); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.22s ease, transform 0.22s ease; }
.toast-enter-from { opacity: 0; transform: translateX(24px); }
.toast-leave-to { opacity: 0; transform: translateY(-8px); }
.toast-move { transition: transform 0.22s ease; }

@media (max-width: 1180px) {
  .home-dashboard { grid-template-columns: minmax(0, 1fr) 248px; gap: 12px; }
  .hero-content { padding: 38px 26px 25px; }
  .launch-combo { min-width: 242px; height: 62px; }
  .launch-main { padding: 0 16px; font-size: 17px; }
  .launch-arrow { width: 50px; }
  .hero-settings { min-width: 126px; padding: 0 13px; }
  .hero-more { width: 46px; }
  .runtime-item { grid-template-columns: 28px minmax(0, 1fr); padding: 0 12px; }
  .runtime-item > svg:first-child { width: 23px; height: 23px; }
  .runtime-chevron { display: none; }
  .instance-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 1010px) {
  .home-dashboard { grid-template-columns: minmax(0, 1fr) 226px; }
  .hero-card { min-height: 320px; }
  .hero-content h1 { font-size: 42px; }
  .hero-actions { gap: 10px; }
  .hero-settings { min-width: 112px; font-size: 12px; }
  .launch-combo { min-width: 210px; }
  .launch-main { font-size: 15px; }
  .runtime-item { padding: 0 9px; gap: 8px; }
  .runtime-item strong { font-size: 11px; }
  .skin-panel { padding-inline: 10px; }
}

@media (max-width: 1080px) {
  .hero-actions { flex-wrap: wrap; align-items: stretch; gap: 12px; }
  .hero-secondary-actions { width: 100%; }
  .hero-settings { height: 38px; flex: 1; }
  .hero-more { height: 38px; }
  .launch-combo { width: 100%; min-width: 0; height: 54px; }
  .hero-content { padding: 24px; }
  .hero-content h1, .hero-content h1.long-name { font-size: clamp(25px, 3.2vw, 36px); }
  .hero-metadata-slot { min-height: 110px; }
  .hero-edition { font-size: 14px; margin-top: 10px; }
}

@media (max-height: 760px) {
  .home-dashboard { min-height: 660px; }
  .hero-card { height: 340px; }
  .hero-content { padding-top: 30px; }
  .skin-stage { height: 230px; }
  .skin-panel { min-height: 322px; }
}

.home-dashboard{grid-template-columns:minmax(0,1fr) minmax(250px,290px);gap:16px}.hero-card{height:var(--banner-h);max-height:360px;min-height:320px}.hero-content{padding:24px;justify-content:space-between}.hero-metadata-slot{min-height:0}.hero-kicker{font-size:12px;align-self:flex-start;padding:5px 10px}.hero-content h1,.hero-content h1.long-name{font-size:clamp(24px,2.6vw,32px);line-height:1.25;max-width:100%;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.hero-edition{margin-top:8px;gap:10px}.hero-game-version{font-size:15px}.launch-main{min-height:56px;min-width:180px;font-size:21px;padding:0 24px}.launch-arrow{width:48px}.hero-actions{gap:12px;flex-wrap:wrap}.runtime-strip{min-height:68px;padding:8px}.runtime-item{padding:10px 12px}.instance-grid{display:flex!important;flex-direction:column;gap:0}.home-dashboard .instance-card{display:grid;grid-template-columns:36px minmax(0,1fr) auto 36px 40px;gap:12px;align-items:center;min-height:72px;height:auto;padding:12px;border:0;border-bottom:1px solid var(--border);border-radius:0;box-shadow:none;background:transparent}.instance-card.selected{background:var(--accent-soft)}.instance-card:hover{background:var(--hover)}.instance-card .instance-icon{width:36px;height:36px}.instance-card .instance-copy{min-width:0}.instance-copy strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:normal}.instance-copy span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.instance-more,.instance-last,.instance-play{position:static;margin:0;grid-row:1}.instance-last{grid-column:3;font-size:12px;white-space:nowrap}.instance-more{grid-column:4}.instance-play{grid-column:5;width:40px;height:34px}.instances-block{background:var(--surface-content);border-radius:var(--radius-lg);padding:16px}.instances-head{margin-bottom:8px}.account-panel{border-radius:var(--radius-lg) var(--radius-lg) 0 0;border-bottom:0;box-shadow:none;padding:16px}.skin-panel{border-radius:0 0 var(--radius-lg) var(--radius-lg);margin-top:-16px;border-top:0;box-shadow:none;padding:16px}.skin-stage{height:260px;min-height:220px}.account-head{gap:10px}.home-side{gap:16px}.hero-shade{background:linear-gradient(180deg,rgba(0,0,0,.16),rgba(0,0,0,.18) 30%,rgba(0,0,0,.68))}
@media(max-width:1100px){.home-dashboard{grid-template-columns:minmax(0,1fr)}.home-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}.account-panel{border-radius:var(--radius-lg)}.skin-panel{margin-top:0;border-radius:var(--radius-lg);grid-column:2;grid-row:1/3}.hero-card{max-height:360px}}@media(max-width:700px){.home-side{grid-template-columns:minmax(0,1fr)}.skin-panel{grid-column:1;grid-row:auto}.home-dashboard .instance-card{grid-template-columns:28px minmax(0,1fr) 32px 36px;gap:8px}.instance-last{grid-row:2;grid-column:2;font-size:12px}.instance-more{grid-column:3}.instance-play{grid-column:4}.hero-content{padding:16px}.launch-main{min-width:140px}.runtime-strip{flex-wrap:wrap}.runtime-item{min-width:140px}.hero-card{min-height:330px}}

.home-side{align-self:start}.skin-panel{flex:none;min-height:0}.home-side .skin-stage{height:230px;min-height:0}.skin-panel .skin-tip{margin-bottom:0}.account-panel{padding:16px}
.empty-instances{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:22px 18px;text-align:center;cursor:default}.empty-instances strong{color:var(--text);font-size:var(--text-md);font-weight:650}.empty-instances .muted{font-size:var(--text-xs);overflow-wrap:anywhere}.empty-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;margin-top:4px}
</style>

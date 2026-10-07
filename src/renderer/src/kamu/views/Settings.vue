<script setup lang="ts">
/**
 * 设置 —— ported from KAMUCL `src/renderer/src/views/SettingsView.vue` (MIT, upstream
 * contributions only; see /THIRD_PARTY_NOTICES.md).
 *
 * Kept from upstream: the section cards (`card group collapse` + `collapse-head` /
 * `collapse-arrow`), the sticky navigation block (search box, scope tabs, category tabs,
 * jump-to-setting with per-category scroll memory), the theme swatch picker, the
 * pointer-driven memory slider, the Java list rows, the directory row, the update row
 * vocabulary and the whole `--space/--text/--radius` type scale.
 *
 * Replaced: upstream's flat `api.ts` IPC (this port goes through `kamu/api/settings.ts`,
 * which unwraps `Result<T>`) and its global store (the record lives here, and every write
 * adopts the record the main process returns).
 *
 * Dropped because this launcher has no backend for it: background/launch-card image
 * import, home layout editor, mascot, splash, key bindings, plugin store, mod sync,
 * isolation migration, feature toggles, custom palette editor, update channel/rollback.
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { EVENTS } from '@shared/ipc'
import { ENDPOINTS } from '@shared/constants'
import type {
  CloseAction,
  GameDirStats,
  JavaRuntime,
  JavaSource,
  Language,
  PathInfo,
  Settings,
  ThemeMode,
  UpdateInfo
} from '@shared/types'
import { formatBytes } from '@shared/utils'
import { api } from '../api/core'
import {
  checkUpdate,
  getLauncherVersion,
  getPaths,
  getSettings,
  getStats,
  getSystemMemoryMb,
  openExternal,
  openPath,
  pickFolder,
  pickJavaFile,
  quit,
  relaunch,
  saveSettings,
  scanJava
} from '../api/settings'
import SettingsMirrors from '../components/SettingsMirrors.vue'
import SettingsSection from '../components/SettingsSection.vue'
import SettingsSkeleton from '../components/SettingsSkeleton.vue'
import SettingsToasts from '../components/SettingsToasts.vue'

/* ------------------------------------------------------------------ toasts */
interface ToastItem {
  id: number
  text: string
  type: 'success' | 'error' | 'info'
}

const toasts = ref<ToastItem[]>([])
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
let toastSeq = 0

function toast(text: string, type: ToastItem['type'] = 'info'): void {
  const id = ++toastSeq
  toasts.value = [...toasts.value, { id, text, type }].slice(-3)
  toastTimers.set(
    id,
    setTimeout(() => {
      toastTimers.delete(id)
      dismissToast(id)
    }, type === 'error' ? 6500 : 3200)
  )
}

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((item) => item.id !== id)
  const timer = toastTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    toastTimers.delete(id)
  }
}

/** ApiError already folds `detail` into `message`; this keeps the toast short. */
function errText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || '未知错误'
}

/* -------------------------------------------------------------- navigation */
type ScopeId = 'launcher' | 'game'
const scopes: ReadonlyArray<{ id: ScopeId; label: string }> = [
  { id: 'launcher', label: '启动器设置' },
  { id: 'game', label: '游戏设置' }
]

type CategoryId =
  | 'appearance'
  | 'general'
  | 'downloads'
  | 'online'
  | 'about'
  | 'runtime'
  | 'display'

const categories: ReadonlyArray<{ id: CategoryId; scope: ScopeId; label: string }> = [
  { id: 'appearance', scope: 'launcher', label: '外观' },
  { id: 'general', scope: 'launcher', label: '界面与行为' },
  { id: 'downloads', scope: 'launcher', label: '下载' },
  { id: 'online', scope: 'launcher', label: '联机与账号' },
  { id: 'about', scope: 'launcher', label: '关于与更新' },
  { id: 'runtime', scope: 'game', label: '运行环境' },
  { id: 'display', scope: 'game', label: '游戏窗口' }
]

/** Only sections that really exist in `Settings` are searchable. */
const catalog: ReadonlyArray<{ id: string; category: CategoryId; name: string; keywords: string }> = [
  { id: 'theme', category: 'appearance', name: '主题', keywords: '深色 浅色 外观 配色 夜间 白天 界面风格' },
  { id: 'interface', category: 'general', name: '界面语言与窗口行为', keywords: '语言 中文 英文 关闭 最小化 后台 退出 控制台 日志 隐藏 启动后' },
  { id: 'installation', category: 'downloads', name: '游戏根目录与存储占用', keywords: '游戏目录 路径 文件夹 安装位置 下载位置 占用 空间 versions libraries assets instances logs' },
  { id: 'downloads', category: 'downloads', name: '下载并发与校验', keywords: '线程 并发 断点续传 range 严格 失败 跳过 模组仓库 modrinth curseforge 密钥' },
  { id: 'mirror', category: 'downloads', name: '下载源规则', keywords: '镜像 域名 改写 官方源 优先级 bmclapi' },
  { id: 'relay', category: 'online', name: '联机中继与正版登录', keywords: '中继 房间 跨网 websocket 代理 proxy 微软 client id 账户 登录' },
  { id: 'update', category: 'about', name: '关于与更新', keywords: '版本 检查更新 自动 重启 退出 发布页 下载包' },
  { id: 'memory', category: 'runtime', name: '默认内存分配', keywords: '内存 ram gb xmx 性能 上限' },
  { id: 'java', category: 'runtime', name: 'Java 运行时', keywords: 'jdk jre 路径 扫描 目录 自动下载 adoptium mojang 本机' },
  { id: 'jvm', category: 'runtime', name: 'JVM 参数', keywords: '高级 垃圾回收 gc g1gc 启动参数' },
  { id: 'resolution', category: 'display', name: '游戏窗口分辨率', keywords: '宽 高 全屏 窗口化 分辨率' }
]

const CATEGORY_STORE = 'mouc.settings.category'

function scopeOf(id: CategoryId): ScopeId {
  return categories.find((item) => item.id === id)?.scope ?? 'launcher'
}

const page = ref<HTMLElement | null>(null)
const category = ref<CategoryId>(readStoredCategory())
const scope = computed<ScopeId>(() => scopeOf(category.value))
const visibleCategories = computed(() => categories.filter((item) => item.scope === scope.value))
const lastCategories: Record<ScopeId, CategoryId> = { launcher: 'appearance', game: 'runtime' }

function readStoredCategory(): CategoryId {
  try {
    const stored = sessionStorage.getItem(CATEGORY_STORE)
    return stored && categories.some((item) => item.id === stored) ? (stored as CategoryId) : 'appearance'
  } catch {
    return 'appearance'
  }
}

function body(): HTMLElement | null {
  return page.value?.querySelector<HTMLElement>('.settings-body') ?? null
}

const positions = new Map<CategoryId, number>()
let navigation = 0

async function selectCategory(id: CategoryId): Promise<void> {
  const ticket = ++navigation
  const scroll = body()
  positions.set(category.value, scroll?.scrollTop ?? 0)
  category.value = id
  lastCategories[scopeOf(id)] = id
  query.value = ''
  try {
    sessionStorage.setItem(CATEGORY_STORE, id)
  } catch {
    /* storage may be blocked; the on-screen choice still holds */
  }
  await nextTick()
  if (ticket === navigation && scroll) {
    scroll.scrollTop = Math.min(positions.get(id) ?? 0, Math.max(0, scroll.scrollHeight - scroll.clientHeight))
  }
}

function selectScope(id: ScopeId): void {
  void selectCategory(lastCategories[id])
}

async function jumpSetting(id: string): Promise<void> {
  const item = catalog.find((entry) => entry.id === id)
  if (!item) return
  await selectCategory(item.category)
  const target = page.value?.querySelector<HTMLElement>('[data-section="' + id + '"]')
  if (!target) return
  for (let parent: HTMLElement | null = target; parent && parent !== body(); parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
  }
  await nextTick()
  target.setAttribute('tabindex', '-1')
  const container = body()
  if (container) {
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
  }
  target.focus({ preventScroll: true })
}

const query = ref('')
const matches = computed(() => {
  const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return catalog.filter((item) => words.every((word) => `${item.name} ${item.keywords}`.toLocaleLowerCase().includes(word)))
})

/* ------------------------------------------------------------------ record */
const record = ref<Settings | null>(null)
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)

const paths = ref<PathInfo | null>(null)
const pathsError = ref('')
const stats = ref<GameDirStats | null>(null)
const statsError = ref('')
const storageBusy = ref(false)

function syncDrafts(source: Settings): void {
  for (const key of TEXT_KEYS) if (focused.value !== key) text[key] = source[key]
  if (focused.value !== 'threads') threads.value = String(source.maxConcurrentDownloads)
  if (focused.value !== 'width') width.value = String(source.defaultResolution.width)
  if (focused.value !== 'height') height.value = String(source.defaultResolution.height)
}

function adopt(next: Settings): void {
  record.value = next
  syncDrafts(next)
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    adopt(await getSettings())
  } catch (error) {
    loadError.value = '读取设置失败：' + errText(error)
  } finally {
    loading.value = false
  }
  memoryTotal.value = getSystemMemoryMb()
  void loadStorage()
  void rescanJava()
}

/** Every accepted write is broadcast by the main process; adopt it. */
let unsubscribe: (() => void) | null = null

/* -------------------------------------------------- debounced text drafts */
const TEXT_KEYS = [
  'extraJvmArgs',
  'modrinthBaseUrl',
  'curseForgeApiKey',
  'relayServerUrl',
  'proxyUrl',
  'microsoftClientId',
  'customJavaPath'
] as const
type TextKey = (typeof TEXT_KEYS)[number]

/** Debounced writes for free text: a keystroke must not reach the IPC layer. */
const TEXT_DELAY = 500
const text = reactive<Record<TextKey, string>>({
  extraJvmArgs: '',
  modrinthBaseUrl: '',
  curseForgeApiKey: '',
  relayServerUrl: '',
  proxyUrl: '',
  microsoftClientId: '',
  customJavaPath: ''
})
const threads = ref('8')
const width = ref('854')
const height = ref('480')
/** The field under the caret; its buffer is never overwritten mid-typing. */
const focused = ref('')
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function patchFor(key: TextKey, raw: string): Partial<Settings> {
  const value = raw.trim()
  switch (key) {
    case 'extraJvmArgs':
      return { extraJvmArgs: value }
    case 'modrinthBaseUrl':
      return { modrinthBaseUrl: value }
    case 'curseForgeApiKey':
      return { curseForgeApiKey: value }
    case 'relayServerUrl':
      return { relayServerUrl: value }
    case 'proxyUrl':
      return { proxyUrl: value }
    case 'microsoftClientId':
      return { microsoftClientId: value }
    case 'customJavaPath':
      return { customJavaPath: value }
    default:
      return {}
  }
}

function debounce(key: string, run: () => Promise<boolean>): void {
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void run()
    }, TEXT_DELAY)
  )
}

function flushDebounce(key: string): void {
  const pending = timers.get(key)
  if (pending) {
    clearTimeout(pending)
    timers.delete(key)
  }
}

function onTextField(key: TextKey, event: Event): void {
  const value = (event.target as HTMLInputElement).value
  text[key] = value
  debounce(key, () => write(patchFor(key, value)))
}

/** `@change` (blur / Enter) commits immediately instead of waiting out the debounce. */
function settleTextField(key: TextKey): void {
  flushDebounce(key)
  void write(patchFor(key, text[key]))
}

function onThreads(event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  threads.value = raw
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  debounce('threads', () => write({ maxConcurrentDownloads: Math.min(32, Math.max(1, Math.round(value))) }))
}

function settleThreads(): void {
  flushDebounce('threads')
  const value = Number(threads.value)
  if (!Number.isFinite(value)) {
    if (record.value) syncDrafts(record.value)
    return
  }
  void write({ maxConcurrentDownloads: Math.min(32, Math.max(1, Math.round(value))) })
}

/* ------------------------------------------------------------------- write */
async function write(patch: Partial<Settings>): Promise<boolean> {
  saving.value = true
  try {
    adopt(await saveSettings(patch))
    return true
  } catch (error) {
    toast('保存设置失败：' + errText(error), 'error')
    // Snap back to the record the process actually holds, then re-read it.
    if (record.value) syncDrafts(record.value)
    try {
      adopt(await getSettings())
    } catch (reloadError) {
      toast('重新读取设置失败：' + errText(reloadError), 'error')
    }
    return false
  } finally {
    saving.value = false
  }
}

type SwitchKey = 'resumeDownloads' | 'strictDownload' | 'showGameConsole' | 'hideOnLaunch' | 'autoCheckUpdate'

async function onSwitch(key: SwitchKey, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const value = input.checked
  const patch: Partial<Settings> = {}
  patch[key] = value
  const ok = await write(patch)
  // The DOM checkbox moved ahead of the record; restore it if the write failed.
  if (!ok && record.value) input.checked = record.value[key]
}

/* ------------------------------------------------------------------ theme */
/** Preview swatches copy the two palettes in `styles/tokens.css`; they are fixed per
 *  option on purpose, exactly like upstream's theme cards. */
const swatches: Record<ThemeMode, { bg: string; sidebar: string; card: string; border: string; accent: string }> = {
  dark: { bg: '#121519', sidebar: '#171b21', card: '#1e232a', border: '#22272e', accent: '#37a9de' },
  light: { bg: '#f2f3f6', sidebar: '#fafbfd', card: '#ffffff', border: '#e2e5ea', accent: '#0a6b9f' }
}

const themeOptions: ReadonlyArray<{ key: ThemeMode; label: string; description: string }> = [
  { key: 'dark', label: '深色', description: '默认配色，低光环境更舒适' },
  { key: 'light', label: '浅色', description: '高亮度配色，白天与投屏更清晰' }
]

function chooseTheme(mode: ThemeMode): void {
  void write({ theme: mode })
}

/* -------------------------------------------------------------- interface */
const languages: ReadonlyArray<{ value: Language; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' }
]

const closeActions: ReadonlyArray<{ value: CloseAction; label: string }> = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '隐藏到后台' },
  { value: 'exit', label: '直接退出' }
]

function onLanguage(event: Event): void {
  void write({ language: (event.target as HTMLSelectElement).value as Language })
}

function onCloseAction(event: Event): void {
  void write({ closeAction: (event.target as HTMLSelectElement).value as CloseAction })
}

/* --------------------------------------------------------------- storage */
const dirBusy = ref(false)
const dirError = ref('')

async function loadStorage(): Promise<void> {
  storageBusy.value = true
  pathsError.value = ''
  statsError.value = ''
  try {
    paths.value = await getPaths()
  } catch (error) {
    pathsError.value = '读取目录失败：' + errText(error)
  }
  try {
    stats.value = await getStats()
  } catch (error) {
    statsError.value = '统计占用失败：' + errText(error)
  } finally {
    storageBusy.value = false
  }
}

async function openLocation(target: string): Promise<void> {
  try {
    await openPath(target)
  } catch (error) {
    toast('打开目录失败：' + errText(error), 'error')
  }
}

async function chooseGameRoot(): Promise<void> {
  if (dirBusy.value) return
  dirBusy.value = true
  dirError.value = ''
  try {
    const picked = await pickFolder('选择游戏根目录', record.value?.gameRoot)
    if (!picked) return
    if (await write({ gameRoot: picked })) {
      toast('游戏根目录已更新，正在重新统计占用', 'success')
      await loadStorage()
    } else {
      dirError.value = '更改未生效，已恢复原目录。'
    }
  } catch (error) {
    dirError.value = '选择文件夹失败：' + errText(error)
  } finally {
    dirBusy.value = false
  }
}

const pathRows = computed<Array<{ label: string; value: string }>>(() => {
  const resolved = paths.value
  if (!resolved) return []
  return [
    { label: '游戏根目录', value: resolved.gameRoot },
    { label: '版本', value: resolved.versionsDir },
    { label: '库文件', value: resolved.librariesDir },
    { label: '游戏素材', value: resolved.assetsDir },
    { label: '实例', value: resolved.instancesDir },
    { label: '日志', value: resolved.logsDir },
    { label: 'Java 存储', value: resolved.javaStoreDir },
    { label: '启动器配置', value: resolved.configDir },
    { label: '账户与缓存', value: resolved.appData }
  ]
})

const statRows = computed<Array<{ label: string; value: string }>>(() => {
  const data = stats.value
  if (!data) return []
  return [
    { label: '占用空间', value: data.exists ? formatBytes(data.sizeBytes) : '—' },
    { label: '文件数', value: data.fileCount.toLocaleString('zh-CN') },
    { label: '已装版本', value: String(data.versions) },
    { label: '实例', value: String(data.instances) },
    { label: '模组', value: String(data.mods) },
    { label: '截图', value: String(data.screenshots) }
  ]
})

/* ----------------------------------------------------------- mirror rules */
/* ------------------------------------------------------------------ java */
const javaModes: ReadonlyArray<{ value: Settings['javaMode']; label: string }> = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'adoptium', label: '本机优先，缺失时下载 Adoptium' },
  { value: 'mojang-component', label: 'Mojang 官方运行时（该源目前不可达）' },
  { value: 'custom', label: '仅使用本机 Java' }
]

const runtimes = ref<JavaRuntime[]>([])
const javaLoading = ref(true)
const javaBusy = ref(false)
const javaError = ref('')
const newScanDir = ref('')

async function rescanJava(announce = false): Promise<void> {
  if (javaBusy.value) return
  javaBusy.value = true
  javaError.value = ''
  try {
    runtimes.value = await scanJava()
    if (announce) toast(`Java 扫描完成，共 ${runtimes.value.length} 个`, 'success')
  } catch (error) {
    javaError.value = 'Java 扫描失败：' + errText(error)
    if (announce) toast(javaError.value, 'error')
  } finally {
    javaBusy.value = false
    javaLoading.value = false
  }
}

function javaSourceLabel(source: JavaSource): string {
  return source === 'manual' ? '手动' : source === 'scan' ? '扫描' : '内置'
}

function useRuntime(runtime: JavaRuntime): void {
  text.customJavaPath = runtime.path
  void write({ customJavaPath: runtime.path, javaMode: 'custom' })
}

function onJavaMode(event: Event): void {
  void write({ javaMode: (event.target as HTMLSelectElement).value as Settings['javaMode'] })
}

async function chooseJavaPath(): Promise<void> {
  try {
    const picked = await pickJavaFile('选择 Java 可执行文件')
    if (!picked) return
    text.customJavaPath = picked
    await write({ customJavaPath: picked })
  } catch (error) {
    toast('选择文件失败：' + errText(error), 'error')
  }
}

async function addScanDir(): Promise<void> {
  const typed = newScanDir.value.trim()
  let target = typed
  if (!target) {
    try {
      target = (await pickFolder('添加 Java 扫描目录')) ?? ''
    } catch (error) {
      toast('选择目录失败：' + errText(error), 'error')
      return
    }
  }
  if (!target) return
  const current = record.value?.javaScanDirs ?? []
  if (current.includes(target)) {
    toast('该目录已在扫描列表中', 'info')
    return
  }
  if (await write({ javaScanDirs: [...current, target] })) newScanDir.value = ''
}

async function removeScanDir(dir: string): Promise<void> {
  const current = record.value?.javaScanDirs ?? []
  await write({ javaScanDirs: current.filter((item) => item !== dir) })
}

/* ---------------------------------------------------------------- memory */
const MEM_MIN = 1024
/** Slider step 512MB (0.5GB); the numeric input is the 0.25GB fine control. */
const MEM_STEP = 512
/** Reserve kept for the OS, matching upstream's manual ceiling rule. */
const SYS_RESERVE_MB = 1024
/** The main process clamps to this ceiling. */
const MEM_CEILING = 262_144

const memoryTotal = ref(0)
const memMax = computed(() =>
  memoryTotal.value > 0
    ? Math.max(MEM_MIN, Math.floor((memoryTotal.value - SYS_RESERVE_MB) / MEM_STEP) * MEM_STEP)
    : 8192
)

function fmtMem(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}MB（${(mb / 1024).toFixed(2)}G）`
}

const memoryValue = computed(() => record.value?.defaultMemoryMb ?? MEM_MIN)
const memoryText = computed(() => {
  if (memPreview.value !== null) return fmtMem(Math.round(memPreview.value / MEM_STEP) * MEM_STEP)
  return fmtMem(memoryValue.value)
})
const memoryOverMax = computed(() => memoryValue.value > memMax.value)
const memoryInfo = computed(() =>
  memoryTotal.value > 0
    ? `本机内存提示 ${fmtMem(memoryTotal.value)} · 建议上限 ${fmtMem(memMax.value)} · 手动可填至 ${fmtMem(MEM_CEILING)}`
    : `系统未提供内存信息，建议上限按 ${fmtMem(memMax.value)} 处理；手动可填至 ${fmtMem(MEM_CEILING)}`
)

const memTrack = ref<HTMLElement | null>(null)
const memDragging = ref(false)
const memPreview = ref<number | null>(null)
const memBaseline = ref<{ max: number; span: number } | null>(null)
const memScaleSpan = computed(() => memBaseline.value?.span ?? Math.max(memMax.value, MEM_MIN + MEM_STEP) - MEM_MIN)
const memFillPct = computed(() => {
  const mb = memPreview.value ?? memoryValue.value
  return Math.max(0, Math.min(100, ((mb - MEM_MIN) / memScaleSpan.value) * 100))
})

function memRawFromClientX(clientX: number): number {
  const track = memTrack.value
  if (!track) return memoryValue.value
  const rect = track.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return MEM_MIN + ratio * memScaleSpan.value
}

function onMemThumbDown(event: PointerEvent): void {
  event.preventDefault()
  event.stopPropagation()
  memDragging.value = true
  const max = memMax.value
  memBaseline.value = { max, span: Math.max(max, MEM_MIN + MEM_STEP) - MEM_MIN }
  memPreview.value = memoryValue.value
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}

function onMemPointerMove(event: PointerEvent): void {
  if (!memDragging.value) return
  memPreview.value = memRawFromClientX(event.clientX)
}

function onMemPointerUp(): void {
  if (!memDragging.value) return
  memDragging.value = false
  const raw = memPreview.value ?? memoryValue.value
  const frozenMax = memBaseline.value?.max ?? memMax.value
  memPreview.value = null
  memBaseline.value = null
  const value = Math.max(MEM_MIN, Math.min(Math.round(raw / MEM_STEP) * MEM_STEP, frozenMax))
  void write({ defaultMemoryMb: value })
}

const memoryEditing = ref(false)
const memoryInputGB = ref('')
const memoryInputError = ref('')

function startMemoryEdit(): void {
  memoryInputGB.value = String((memoryValue.value / 1024).toFixed(2)).replace(/\.?0+$/, '')
  memoryInputError.value = ''
  memoryEditing.value = true
}

function commitMemoryEdit(): void {
  const gb = Number(memoryInputGB.value)
  memoryEditing.value = false
  if (!Number.isFinite(gb) || gb <= 0) {
    memoryInputError.value = '请输入大于 0 的内存（GB）'
    return
  }
  const mb = Math.round(Math.max(0.5, Math.min(gb, MEM_CEILING / 1024)) * 1024)
  memoryInputError.value = ''
  void write({ defaultMemoryMb: mb })
}

/** The hint is a coarse browser value, so refreshing just re-reads it. */
function refreshMemoryInfo(): void {
  memoryTotal.value = getSystemMemoryMb()
  if (memoryTotal.value === 0) toast('系统未提供内存信息，已使用保守上限', 'info')
}

/* ------------------------------------------------------------ resolution */
const resolutionError = ref('')

function resolutionValues(): { width: number; height: number } | null {
  const w = Number(width.value)
  const h = Number(height.value)
  if (!Number.isInteger(w) || w < 854 || w > 7680) {
    resolutionError.value = '窗口宽度必须是 854–7680 之间的整数'
    return null
  }
  if (!Number.isInteger(h) || h < 480 || h > 4320) {
    resolutionError.value = '窗口高度必须是 480–4320 之间的整数'
    return null
  }
  resolutionError.value = ''
  return { width: w, height: h }
}

function saveResolution(): void {
  const size = resolutionValues()
  const current = record.value?.defaultResolution
  if (!size || !current) return
  void write({ defaultResolution: { ...current, ...size } })
}

async function onFullscreen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const current = record.value?.defaultResolution
  if (!current) return
  const ok = await write({ defaultResolution: { ...current, fullscreen: input.checked } })
  if (!ok && record.value) input.checked = record.value.defaultResolution.fullscreen
}

/* -------------------------------------------------------------- about */
const version = ref('')
const update = ref<UpdateInfo | null>(null)
const updateState = ref<'idle' | 'checking' | 'latest' | 'available' | 'failed'>('idle')
const updateError = ref('')
let lastManualCheck = 0

async function onCheckUpdate(): Promise<void> {
  const now = Date.now()
  if (now - lastManualCheck < 5 * 60_000 && updateState.value === 'latest') {
    toast('5 分钟内已检查过，已是最新', 'info')
    return
  }
  lastManualCheck = now
  updateState.value = 'checking'
  updateError.value = ''
  try {
    const info = await checkUpdate()
    update.value = info
    updateState.value = info.available ? 'available' : 'latest'
  } catch (error) {
    update.value = null
    updateState.value = 'failed'
    updateError.value = '检查失败：断网或更新源不可达。' + errText(error)
  }
}

const releasePage = computed(() => update.value?.url ?? `https://github.com/${ENDPOINTS.updateRepo}/releases`)

async function openReleasePage(): Promise<void> {
  try {
    await openExternal(releasePage.value)
  } catch (error) {
    toast('打开链接失败：' + errText(error), 'error')
  }
}

/** Destructive app actions need a second click, like upstream's plugin removal. */
const armedAction = ref('')
let armedTimer: ReturnType<typeof setTimeout> | null = null

function armAction(name: string, run: () => Promise<void>): void {
  if (armedAction.value !== name) {
    armedAction.value = name
    if (armedTimer) clearTimeout(armedTimer)
    armedTimer = setTimeout(() => {
      if (armedAction.value === name) armedAction.value = ''
    }, 4000)
    return
  }
  armedAction.value = ''
  void run()
}

async function onRelaunch(): Promise<void> {
  try {
    await relaunch()
  } catch (error) {
    toast('重启失败：' + errText(error), 'error')
  }
}

async function onQuit(): Promise<void> {
  try {
    await quit()
  } catch (error) {
    toast('退出失败：' + errText(error), 'error')
  }
}

/* ---------------------------------------------------------------- mount */
onMounted(() => {
  // The main process broadcasts the whole record after every write (including writes
  // from the shell), so the page always converges on what the process holds.
  try {
    unsubscribe = api().on(EVENTS.settings, (payload) => {
      const next = payload as Settings
      if (next && typeof next.settingsVersion === 'number') adopt(next)
    })
  } catch (error) {
    toast('无法订阅设置变更：' + errText(error), 'error')
  }
  void load()
  void getLauncherVersion()
    .then((value) => {
      version.value = value
    })
    .catch((error: unknown) => {
      toast('读取版本号失败：' + errText(error), 'error')
    })
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  for (const timer of toastTimers.values()) clearTimeout(timer)
  toastTimers.clear()
  if (armedTimer) clearTimeout(armedTimer)
})
</script>

<template>
  <div ref="page" class="page settings-page">
    <div class="page-head">
      <h1 class="page-title">设置</h1>
    </div>

    <div class="settings-navigation">
      <label class="settings-search">
        <input
          v-model="query"
          class="input"
          type="search"
          placeholder="搜索：内存、Java、镜像、中继…"
          aria-label="搜索设置"
          @keydown.esc="query = ''"
        />
      </label>
      <nav class="settings-scopes" aria-label="设置范围">
        <button
          v-for="item in scopes"
          :key="item.id"
          class="btn btn-ghost"
          :aria-current="scope === item.id ? 'page' : undefined"
          @click="selectScope(item.id)"
        >{{ item.label }}</button>
      </nav>
      <nav class="settings-categories" aria-label="设置分类">
        <button
          v-for="item in visibleCategories"
          :key="item.id"
          class="btn btn-ghost"
          :aria-current="category === item.id ? 'page' : undefined"
          @click="selectCategory(item.id)"
        >{{ item.label }}</button>
      </nav>
      <div v-if="query.trim()" class="settings-search-results" role="region" aria-label="设置搜索结果">
        <p v-if="!matches.length" class="muted">没有找到相关设置，试试“主题”“内存”或“下载”。</p>
        <button v-for="item in matches" :key="item.id" class="btn btn-ghost" @click="jumpSetting(item.id)">
          <strong>{{ item.name }}</strong>
          <span class="muted">{{ scopes.find((s) => s.id === scopeOf(item.category))?.label }} · {{ categories.find((c) => c.id === item.category)?.label }} →</span>
        </button>
      </div>
    </div>

    <div class="settings-body" tabindex="0" aria-label="设置内容">
      <SettingsSkeleton v-if="loading || ( !record && !loadError )" label="正在读取设置…" :rows="6" retry @retry="load" />

      <div v-else-if="!record" class="card empty">
        <p class="group-error">{{ loadError }}</p>
        <button class="btn btn-ghost btn-sm" @click="load">重试</button>
      </div>

      <template v-else>
        <!-- 外观 · 主题 -->
        <SettingsSection v-show="category === 'appearance'" title="主题" section="theme" open>
          <div class="theme-options">
            <button
              v-for="item in themeOptions"
              :key="item.key"
              class="theme-option"
              :class="{ active: record.theme === item.key }"
              :title="item.description"
              :disabled="saving"
              @click="chooseTheme(item.key)"
            >
              <span class="theme-preview" :style="{ background: swatches[item.key].bg }">
                <span
                  class="tp-side"
                  :style="{ background: swatches[item.key].sidebar, borderRight: '1px solid ' + swatches[item.key].border }"
                >
                  <span class="tp-dot" :style="{ background: swatches[item.key].accent }"></span>
                </span>
                <span class="tp-main">
                  <span
                    class="tp-top"
                    :style="{ background: swatches[item.key].card, borderBottom: '1px solid ' + swatches[item.key].border }"
                  ></span>
                  <span class="tp-body">
                    <span
                      class="tp-block"
                      :style="{ background: swatches[item.key].card, border: '1px solid ' + swatches[item.key].border }"
                    ></span>
                    <span class="tp-btn" :style="{ background: swatches[item.key].accent }"></span>
                  </span>
                </span>
                <svg
                  v-if="record.theme === item.key"
                  class="tp-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                ><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              <span class="theme-label">{{ item.label }}</span>
            </button>
          </div>
          <div class="theme-tools">
            <p class="muted group-hint">配色跟随启动器两套对比度标准；状态栏的主题开关与此处同步。</p>
          </div>
        </SettingsSection>

        <!-- 界面与行为 -->
        <SettingsSection v-show="category === 'general'" title="界面与窗口行为" section="interface" open>
          <label class="download-setting" data-field="language">
            <span>界面语言<small class="muted">（只改启动器文案，不影响游戏内语言）</small></span>
            <select class="select" :value="record.language" :disabled="saving" aria-label="界面语言" @change="onLanguage">
              <option v-for="item in languages" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label class="download-setting">
            <span>关闭主窗口时<small class="muted">（有游戏或下载进行中始终会先询问）</small></span>
            <select class="select" :value="record.closeAction" :disabled="saving" aria-label="关闭主窗口时" @change="onCloseAction">
              <option v-for="item in closeActions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <div class="feature-row">
            <span class="feature-name">显示游戏日志面板</span>
            <label class="switch">
              <input type="checkbox" aria-label="显示游戏日志面板" :checked="record.showGameConsole" :disabled="saving" @change="onSwitch('showGameConsole', $event)" />
              <span class="switch-ui"></span>
            </label>
          </div>
          <div class="feature-row">
            <span class="feature-name">启动游戏后隐藏启动器</span>
            <label class="switch">
              <input type="checkbox" aria-label="启动游戏后隐藏启动器" :checked="record.hideOnLaunch" :disabled="saving" @change="onSwitch('hideOnLaunch', $event)" />
              <span class="switch-ui"></span>
            </label>
          </div>
        </SettingsSection>

        <!-- 下载 · 游戏根目录与存储 -->
        <div v-show="category === 'downloads'" class="card group setting-target directory-setting" data-section="installation" tabindex="-1">
          <h3 class="group-title">游戏根目录</h3>
          <p class="muted group-hint">版本、整合包与共享资源（库文件、游戏素材、自动下载的 Java）都保存在这里。</p>
          <div class="dir-row">
            <input class="input mono" :value="record.gameRoot" readonly aria-label="游戏根目录" :title="record.gameRoot" />
            <button class="btn btn-gold dir-btn" :disabled="dirBusy" @click="chooseGameRoot">{{ dirBusy ? '处理中…' : '更改…' }}</button>
            <button class="btn btn-ghost dir-btn" :disabled="!record.gameRoot" @click="openLocation(record.gameRoot)">打开目录</button>
          </div>
          <p v-if="dirError" class="group-error" role="alert">{{ dirError }}</p>

          <div v-if="pathsError" class="group-error" role="alert">{{ pathsError }}</div>
          <div v-else-if="pathRows.length" class="path-list">
            <div v-for="row in pathRows" :key="row.label" class="path-row">
              <span class="muted path-label">{{ row.label }}</span>
              <span class="mono path-value" :title="row.value">{{ row.value }}</span>
              <button class="btn btn-ghost btn-sm path-open" :disabled="!row.value" @click="openLocation(row.value)">打开</button>
            </div>
          </div>

          <div class="storage-head">
            <h4 class="sub-title">存储占用</h4>
            <button class="btn btn-ghost btn-sm" :disabled="storageBusy" @click="loadStorage">
              <span v-if="storageBusy" class="spin"></span>
              {{ storageBusy ? '统计中' : '重新统计' }}
            </button>
          </div>
          <p v-if="statsError" class="group-error" role="alert">{{ statsError }}</p>
          <div v-else-if="stats && !stats.exists" class="muted group-hint">游戏根目录还不存在，首次下载版本时会自动创建。</div>
          <div v-else class="stat-grid">
            <div v-for="row in statRows" :key="row.label" class="stat">
              <span class="muted stat-label">{{ row.label }}</span>
              <strong class="stat-value">{{ row.value }}</strong>
            </div>
          </div>
        </div>

        <!-- 下载 · 并发 / 续传 / 校验 / 下载源 -->
        <SettingsSection v-show="category === 'downloads'" title="下载" section="downloads" open>
          <label class="download-setting">
            <span>最大并发数<small class="muted">（1–32）</small></span>
            <input
              class="input"
              type="number"
              min="1"
              max="32"
              step="1"
              :value="threads"
              aria-label="最大并发数"
              @input="onThreads"
              @change="settleThreads"
              @focus="focused = 'threads'"
              @blur="focused = ''"
            />
          </label>
          <div class="feature-row">
            <span class="feature-name">断点续传</span>
            <label class="switch">
              <input type="checkbox" aria-label="断点续传" :checked="record.resumeDownloads" :disabled="saving" @change="onSwitch('resumeDownloads', $event)" />
              <span class="switch-ui"></span>
            </label>
          </div>
          <div class="feature-row">
            <span class="feature-name">严格模式（单个文件失败即中止）</span>
            <label class="switch">
              <input type="checkbox" aria-label="严格模式" :checked="record.strictDownload" :disabled="saving" @change="onSwitch('strictDownload', $event)" />
              <span class="switch-ui"></span>
            </label>
          </div>
          <p class="muted group-hint">
            断点续传在服务器允许时用 Range 接着下载；关闭严格模式后，无法获取的文件会被跳过，任务继续完成其余文件。减少并发数后，已建立的连接会在结束时释放名额。
          </p>

          <details class="advanced-setting">
            <summary>高级 · 模组仓库与密钥</summary>
            <label class="download-setting download-setting-col">
              <span>Modrinth 接口地址<small class="muted">（模组搜索与下载的数据源）</small></span>
              <input
                class="input mono"
                :value="text.modrinthBaseUrl"
                placeholder="https://api.modrinth.com/v2"
                spellcheck="false"
                aria-label="Modrinth 接口地址"
                @input="onTextField('modrinthBaseUrl', $event)"
                @change="settleTextField('modrinthBaseUrl')"
                @focus="focused = 'modrinthBaseUrl'"
                @blur="focused = ''"
              />
            </label>
            <label class="download-setting download-setting-col">
              <span>CurseForge API Key<small class="muted">（选填，官方 api.curseforge.com 通道需要）</small></span>
              <input
                class="input mono"
                type="password"
                :value="text.curseForgeApiKey"
                placeholder="留空则不启用 CurseForge 官方通道"
                spellcheck="false"
                aria-label="CurseForge API Key"
                @input="onTextField('curseForgeApiKey', $event)"
                @change="settleTextField('curseForgeApiKey')"
                @focus="focused = 'curseForgeApiKey'"
                @blur="focused = ''"
              />
            </label>
            <p class="muted group-hint">
              CurseForge 官方接口需要免费注册申请：<a class="upd-link" href="https://console.curseforge.com/" target="_blank" rel="noreferrer">console.curseforge.com</a>（创建应用后把 Key 粘贴到上方）。
            </p>
          </details>

          <div class="download-mirror-group" data-section="mirror" tabindex="-1">
            <h4 class="sub-title">下载源规则</h4>
            <p class="muted group-hint">
              每条规则把官方域名换成自己的镜像；下载器按优先级从小到大依次尝试，官方地址始终保留为最后的兜底。公共 BMCLAPI 路由目前全部返回 404，因此不预置镜像。
            </p>
            <SettingsMirrors :rules="record.mirrors" :write="write" @notify="toast" />
          </div>
        </SettingsSection>

        <!-- 联机与账号 -->
        <SettingsSection v-show="category === 'online'" title="联机与正版登录" section="relay" open>
          <label class="download-setting download-setting-col">
            <span>联机中继地址<small class="muted">（跨网房间使用 ws:// 或 wss:// 地址，留空表示仅局域网）</small></span>
            <input
              class="input mono"
              :value="text.relayServerUrl"
              placeholder="wss://relay.example.com:25570"
              spellcheck="false"
              aria-label="联机中继地址"
              @input="onTextField('relayServerUrl', $event)"
              @change="settleTextField('relayServerUrl')"
              @focus="focused = 'relayServerUrl'"
              @blur="focused = ''"
            />
          </label>
          <label class="download-setting download-setting-col">
            <span>网络代理<small class="muted">（主进程所有请求走此地址，留空跟随系统）</small></span>
            <input
              class="input mono"
              :value="text.proxyUrl"
              placeholder="http://127.0.0.1:7890"
              spellcheck="false"
              aria-label="网络代理"
              @input="onTextField('proxyUrl', $event)"
              @change="settleTextField('proxyUrl')"
              @focus="focused = 'proxyUrl'"
              @blur="focused = ''"
            />
          </label>
          <label class="download-setting download-setting-col">
            <span>微软登录应用 ID<small class="muted">（正版登录使用的 OAuth 应用标识）</small></span>
            <input
              class="input mono"
              :value="text.microsoftClientId"
              placeholder="留空使用启动器内置应用"
              spellcheck="false"
              aria-label="微软登录应用 ID"
              @input="onTextField('microsoftClientId', $event)"
              @change="settleTextField('microsoftClientId')"
              @focus="focused = 'microsoftClientId'"
              @blur="focused = ''"
            />
          </label>
          <p class="muted group-hint">
            代理失败不会自动回退直连；正版登录与下载共用此设置。账户凭据保存在账户页，本页只配置连接参数。
          </p>
        </SettingsSection>

        <!-- 游戏 · 内存 / Java / JVM -->
        <div v-show="category === 'runtime'" class="runtime-grid">
          <SettingsSection title="内存分配" section="memory" open>
            <div class="memory-row">
              <div ref="memTrack" class="mem-slider" @pointermove="onMemPointerMove" @pointerup="onMemPointerUp" @pointercancel="onMemPointerUp">
                <div class="mem-slider-track"></div>
                <div class="mem-slider-fill" :style="{ width: memFillPct + '%' }"></div>
                <div
                  class="mem-slider-thumb"
                  :class="{ dragging: memDragging }"
                  :style="{ left: memFillPct + '%' }"
                  role="slider"
                  aria-label="新建实例的默认内存"
                  :aria-valuenow="memoryValue"
                  aria-valuemin="1024"
                  :aria-valuemax="memMax"
                  @pointerdown="onMemThumbDown"
                  @pointermove="onMemPointerMove"
                  @pointerup="onMemPointerUp"
                  @pointercancel="onMemPointerUp"
                ></div>
              </div>
              <input
                v-if="memoryEditing"
                v-model="memoryInputGB"
                class="input memory-input"
                type="number"
                min="0.5"
                :max="MEM_CEILING / 1024"
                step="0.25"
                aria-label="默认内存（GB）"
                @keydown.enter="commitMemoryEdit"
                @keydown.esc="memoryEditing = false"
                @blur="commitMemoryEdit"
              />
              <span v-else class="memory-value" title="点击精确输入（GB）" @click="startMemoryEdit">{{ memoryText }}</span>
            </div>
            <p class="muted group-hint">滑块按 0.5 GB 步进，上限随本机内存浮动并预留 1 G 给系统；需要 0.25 GB 精度时点右侧数值直接输入。</p>
            <p v-if="memoryOverMax" class="memory-warn">当前分配超过建议上限，游戏可能启动失败或让系统卡顿；请调低。</p>
            <p v-if="memoryInputError" class="group-error">{{ memoryInputError }}</p>
            <p class="muted memory-info">
              {{ memoryInfo }}
              <button class="memory-refresh" type="button" @click="refreshMemoryInfo">刷新</button>
            </p>
            <p class="muted group-hint">这是新建实例的默认值，单个实例可在实例设置里覆盖。</p>
          </SettingsSection>

          <SettingsSection title="Java 运行时" section="java" open>
            <div class="feature-row">
              <span class="feature-name">获取方式</span>
              <select class="select java-mode" :value="record.javaMode" aria-label="Java 获取方式" :disabled="saving" @change="onJavaMode">
                <option v-for="item in javaModes" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </div>
            <p class="muted group-hint">
              启动时先按游戏所需的大版本在本机与已下载的运行时里挑选；“仅使用本机 Java”不会自动下载，缺失时会直接报错并提示补充目录。
            </p>

            <label class="download-setting download-setting-col">
              <span>指定 Java 路径<small class="muted">（留空则自动挑选）</small></span>
              <div class="java-add-row">
                <input
                  class="input mono"
                  :value="text.customJavaPath"
                  placeholder="例如 C:\Program Files\Eclipse Adoptium\jdk-21\bin\javaw.exe"
                  spellcheck="false"
                  aria-label="指定 Java 路径"
                  @input="onTextField('customJavaPath', $event)"
                  @change="settleTextField('customJavaPath')"
                  @focus="focused = 'customJavaPath'"
                  @blur="focused = ''"
                />
                <button class="btn btn-ghost" @click="chooseJavaPath">选择…</button>
              </div>
            </label>

            <div class="java-scan-row">
              <div class="java-scan-status">
                <span class="muted">扫描注册表、PATH、启动器存储与下方目录</span>
                <span v-if="javaBusy" class="muted java-scan-text">正在扫描本机 Java…</span>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="javaBusy" @click="rescanJava(true)">
                <span v-if="javaBusy" class="spin"></span>
                {{ javaBusy ? '扫描中' : '重新扫描' }}
              </button>
            </div>

            <div class="scan-dirs">
              <div v-for="dir in record.javaScanDirs" :key="dir" class="scan-dir">
                <span class="mono path-value" :title="dir">{{ dir }}</span>
                <button class="java-item-hide" title="移出扫描列表" @click="removeScanDir(dir)">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>
              <div class="java-add-row">
                <input v-model="newScanDir" class="input mono" placeholder="粘贴 Java 目录，或留空点「添加」选择文件夹…" spellcheck="false" aria-label="新增 Java 扫描目录" @keyup.enter="addScanDir" />
                <button class="btn btn-ghost" @click="addScanDir">添加</button>
              </div>
            </div>

            <div v-if="javaLoading" class="java-loading">
              <span class="spin"></span>
              <span class="muted">正在检测本机 Java…</span>
            </div>
            <p v-else-if="javaError" class="group-error">{{ javaError }}</p>
            <p v-else-if="!runtimes.length" class="muted group-hint">未检测到本机 Java，启动时会按上面的获取方式自动准备。</p>
            <div v-else class="java-list">
              <div class="java-list-head">
                <span class="muted">已识别 {{ runtimes.length }} 个 Java</span>
              </div>
              <div v-for="item in runtimes" :key="item.id" class="java-item">
                <span class="tag" :class="item.source === 'manual' ? 'tag-accent' : ''">{{ javaSourceLabel(item.source) }}</span>
                <span class="java-item-ver">Java {{ item.major }}</span>
                <span class="muted java-item-path" :title="`${item.vendor} · ${item.arch} · ${item.path}`">
                  {{ item.vendor }} · {{ item.arch }} · {{ item.path }}
                </span>
                <button v-if="item.broken" class="tag tag-danger" title="该运行时无法使用">不可用</button>
                <button v-else class="btn btn-ghost btn-sm" @click="useRuntime(item)">选用</button>
              </div>
            </div>
          </SettingsSection>

          <div class="card group setting-target" data-section="jvm" tabindex="-1">
            <h3 class="group-title">高级 · JVM 参数</h3>
            <input
              class="input mono"
              :value="text.extraJvmArgs"
              placeholder="例如：-XX:+UseG1GC -XX:+ParallelRefProcEnabled"
              spellcheck="false"
              aria-label="附加 JVM 参数"
              @input="onTextField('extraJvmArgs', $event)"
              @change="settleTextField('extraJvmArgs')"
              @focus="focused = 'extraJvmArgs'"
              @blur="focused = ''"
            />
            <p class="muted group-hint">附加到每次启动的参数，留空则使用默认参数；内存上限由上方内存分配写入。</p>
          </div>
        </div>

        <!-- 游戏 · 窗口 -->
        <div v-show="category === 'display'" class="settings-grid">
          <div class="card group setting-target" data-section="resolution" tabindex="-1">
            <h3 class="group-title">游戏窗口分辨率</h3>
            <div class="resolution-row">
              <div class="res-field">
                <span class="muted res-label">宽</span>
                <input
                  v-model="width"
                  class="input"
                  type="number"
                  min="854"
                  max="7680"
                  aria-label="窗口宽度"
                  :disabled="record.defaultResolution.fullscreen"
                  @change="saveResolution"
                  @focus="focused = 'width'"
                  @blur="focused = ''"
                />
              </div>
              <span class="muted res-x">×</span>
              <div class="res-field">
                <span class="muted res-label">高</span>
                <input
                  v-model="height"
                  class="input"
                  type="number"
                  min="480"
                  max="4320"
                  aria-label="窗口高度"
                  :disabled="record.defaultResolution.fullscreen"
                  @change="saveResolution"
                  @focus="focused = 'height'"
                  @blur="focused = ''"
                />
              </div>
            </div>
            <div class="feature-row resolution-mode">
              <span class="feature-name">全屏启动</span>
              <label class="switch">
                <input type="checkbox" aria-label="全屏启动" :checked="record.defaultResolution.fullscreen" :disabled="saving" @change="onFullscreen($event)" />
                <span class="switch-ui"></span>
              </label>
            </div>
            <p v-if="resolutionError" class="group-error">{{ resolutionError }}</p>
            <p v-else class="muted group-hint">窗口化使用以上宽高；全屏不会修改显示器分辨率。以上都是新建实例的默认值，实例可单独覆盖。</p>
          </div>
        </div>

        <!-- 关于与更新 -->
        <SettingsSection v-show="category === 'about'" title="关于与更新" section="update" open>
          <div class="upd-row">
            <span class="upd-label">当前版本</span>
            <span class="upd-value">{{ version ? 'v' + version : '读取中…' }}</span>
            <button class="btn btn-ghost btn-sm" :disabled="updateState === 'checking'" @click="onCheckUpdate">
              <span v-if="updateState === 'checking'" class="spin"></span>
              {{ updateState === 'checking' ? '检查中' : '检查更新' }}
            </button>
            <span v-if="updateState === 'latest'" class="upd-latest">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              已是最新
            </span>
            <button v-if="updateState !== 'idle'" class="btn btn-ghost btn-sm" @click="openReleasePage">发布页</button>
          </div>

          <div v-if="updateState === 'available' && update" class="upd-row upd-pending-row">
            <span class="upd-pending-text">v{{ update?.latest }} 可更新（当前 v{{ update?.current }}）</span>
            <button class="btn btn-gold btn-sm" @click="openReleasePage">前往下载</button>
          </div>
          <p v-if="update?.notes" class="muted group-hint">{{ update.notes }}</p>

          <div v-if="updateState === 'failed'" class="upd-row upd-failed-row" role="alert">
            <span class="upd-failed-text">{{ updateError }}</span>
            <button class="btn btn-ghost btn-sm" @click="onCheckUpdate">重试</button>
          </div>

          <div class="upd-row">
            <span class="upd-label">启动时检查</span>
            <label class="switch">
              <input type="checkbox" aria-label="启动时检查更新" :checked="record.autoCheckUpdate" :disabled="saving" @change="onSwitch('autoCheckUpdate', $event)" />
              <span class="switch-ui"></span>
            </label>
            <span class="muted upd-auto-hint">关闭后只在本页手动检查，启动不再联网取版本列表。</span>
          </div>

          <details class="update-maintenance">
            <summary>维护</summary>
            <div class="upd-row upd-actions-row">
              <button class="btn btn-ghost btn-sm" :class="{ 'btn-danger': armedAction === 'relaunch' }" @click="armAction('relaunch', onRelaunch)">
                {{ armedAction === 'relaunch' ? '确认重启' : '重启启动器' }}
              </button>
              <button class="btn btn-ghost btn-sm" :class="{ 'btn-danger': armedAction === 'quit' }" @click="armAction('quit', onQuit)">
                {{ armedAction === 'quit' ? '确认退出' : '退出启动器' }}
              </button>
            </div>
            <p class="muted group-hint">设置改动即时写入配置文件；重启用于让界面语言与连接参数完全生效。</p>
          </details>
        </SettingsSection>
      </template>
    </div>

    <SettingsToasts :items="toasts" @dismiss="dismissToast" />
  </div>
</template>

<style scoped>
/* ---- page frame (upstream SettingsView scoped block) ---- */
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sec-gap);
  max-width: 760px;
  margin: 0 auto;
}
.settings-page {
  height: 100%;
  min-height: 0;
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 340px);
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 10px !important;
  padding: 0 !important;
  max-width: 1080px !important;
  position: relative;
}
.settings-page > .page-head {
  grid-row: 1;
  grid-column: 1;
  margin: 0 !important;
  align-self: center;
}
.settings-navigation {
  display: contents;
}
.settings-search {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}
.settings-search input {
  flex: 1;
  min-width: 0;
}
.settings-scopes {
  grid-column: 1 / -1;
  grid-row: 2;
  display: flex;
  gap: 6px;
}
.settings-scopes .btn {
  font-size: 15px;
  font-weight: 650;
  min-height: 38px;
  padding: 8px 18px;
  border-color: transparent;
}
.settings-scopes [aria-current] {
  background: var(--accent-soft);
  color: var(--accent-2);
}
.settings-categories {
  grid-column: 1 / -1;
  grid-row: 3;
  margin: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 0 8px;
  gap: 4px;
  display: flex;
  flex-wrap: wrap;
}
.settings-categories .btn {
  border: 0;
  border-radius: var(--radius-sm);
  min-height: 32px;
  padding: 6px 12px;
  font-size: 13px;
}
.settings-categories [aria-current] {
  background: var(--accent-soft);
  color: var(--accent);
}
.settings-body {
  grid-column: 1 / -1;
  grid-row: 4;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 8px 20px 0;
}
.settings-body > * {
  flex-shrink: 0;
}
.settings-search-results {
  position: absolute;
  right: 0;
  top: 48px;
  z-index: 20;
  width: min(480px, 100%);
  max-height: 60vh;
  overflow: auto;
  display: grid;
  gap: 8px;
  padding: 12px;
  background: var(--surface-solid);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
}
.settings-search-results button {
  justify-content: space-between;
  white-space: normal;
  text-align: left;
}
.settings-page [data-section] {
  scroll-margin-top: 12px;
}
.settings-page [data-section]:focus {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.settings-page .group {
  margin-bottom: 0;
}

/* ---- section cards ---- */
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px;
}
.group-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 8px;
  line-height: 1.5;
}
.sub-title {
  font-size: 13px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.group-hint {
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}
.group-error {
  font-size: var(--text-xs);
  margin: 0;
  color: var(--danger);
}
.settings-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.settings-grid > .card {
  min-width: 0;
}
.runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.runtime-grid [data-section='jvm'] {
  grid-column: 1 / -1;
}
.setting-target {
  scroll-margin-top: var(--space-5);
}
.setting-target:focus {
  outline: 2px solid var(--accent);
  outline-offset: var(--space-1);
}

/* ---- rows ---- */
.feature-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 40px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.feature-row:last-child {
  border-bottom: none;
}
.feature-name {
  font-size: var(--text-sm);
}
.download-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  min-height: 44px;
  font-size: var(--text-sm);
  font-weight: 600;
}
.download-setting .input,
.download-setting .select {
  width: 200px;
  font-weight: 400;
}
.download-setting-col {
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.download-setting-col .input {
  width: 100%;
}
.download-setting-col small {
  font-weight: 400;
}
.advanced-setting {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.advanced-setting > summary,
.update-maintenance > summary,
.java-detected > summary {
  color: var(--text-dim);
  font-size: 13px;
  padding: 6px 0;
}
.mono {
  font-size: var(--text-sm);
}

/* ---- directory / storage ---- */
.dir-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  align-items: center;
}
.dir-row .input {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
}
.dir-btn {
  flex-shrink: 0;
}
.path-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  overflow: hidden;
}
.path-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}
.path-row:first-child {
  border-top: none;
}
.path-label {
  width: 88px;
  flex-shrink: 0;
  font-size: var(--text-xs);
}
.path-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--text-xs);
}
.path-open {
  flex-shrink: 0;
}
.storage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2);
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.stat-label {
  font-size: var(--text-xs);
}
.stat-value {
  font-size: var(--text-md);
  font-variant-numeric: tabular-nums;
}

/* ---- mirror rules ---- */
.download-mirror-group {
  margin-top: 10px;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ---- java ---- */
.java-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}
.java-list {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-height: 200px;
}
.java-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  background: var(--card-2);
  font-size: var(--text-xs);
}
.java-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}
.java-item-ver {
  font-weight: 600;
  flex-shrink: 0;
}
.java-item-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--text-xs);
}
.java-item-hide {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
}
.java-item-hide:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.java-add-row {
  display: flex;
  gap: var(--space-2);
}
.java-add-row .input {
  flex: 1;
  min-width: 0;
}
.java-mode {
  width: 240px;
  flex-shrink: 0;
}
.java-scan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.java-scan-status {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.java-scan-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-dirs {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.scan-dir {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
}
.select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ---- memory ---- */
.memory-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.memory-value {
  flex: none;
  /* Fixed width: digit count must not squeeze the slider track mid-drag. */
  width: 172px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent-2);
  cursor: text;
  border-radius: var(--radius-sm);
  padding: 2px var(--space-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.memory-value:hover {
  background: var(--hover);
}
.memory-input {
  width: 88px;
  text-align: right;
}
.mem-slider {
  position: relative;
  flex: 1;
  height: 24px;
  touch-action: none;
}
.mem-slider-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 6px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: var(--card-2);
  pointer-events: none;
}
.mem-slider-fill {
  position: absolute;
  left: 0;
  top: 50%;
  height: 6px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent-2), var(--accent));
  pointer-events: none;
  transition: width 0.12s ease;
}
.mem-slider:has(.mem-slider-thumb.dragging) .mem-slider-fill {
  transition: none;
}
.mem-slider-thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--on-accent);
  box-shadow: 0 1px 6px color-mix(in srgb, var(--accent) 45%, transparent);
  cursor: grab;
  transition: transform 0.12s ease;
}
.mem-slider-thumb:hover {
  transform: translate(-50%, -50%) scale(1.12);
}
.mem-slider-thumb.dragging {
  cursor: grabbing;
  transform: translate(-50%, -50%) scale(1.18);
}
.memory-warn {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--danger);
}
.memory-info {
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.memory-refresh {
  border: none;
  background: transparent;
  color: var(--accent-2);
  font-size: var(--text-xs);
  cursor: pointer;
  padding: 0;
  flex: none;
  white-space: nowrap;
}
.memory-refresh:hover {
  text-decoration: underline;
}

/* ---- resolution ---- */
.resolution-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: 8px;
}
.res-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.res-label {
  font-size: var(--text-sm);
  flex-shrink: 0;
}
.res-x {
  flex-shrink: 0;
}
.resolution-mode {
  margin-top: 10px;
}

/* ---- theme picker ---- */
.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 8px;
}
.theme-option {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-height: 48px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: inherit;
  cursor: pointer;
}
.theme-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.theme-preview {
  position: relative;
  display: flex;
  width: 46px;
  height: 32px;
  flex: none;
  border-radius: 5px;
  border: 1.5px solid var(--border);
  overflow: hidden;
  transition: border-color 0.16s ease;
}
.theme-option.active .theme-preview {
  border-color: var(--accent);
}
.theme-label {
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
}
.theme-option.active .theme-label {
  color: var(--accent);
  font-weight: 600;
}
.tp-side {
  width: 9px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 4px;
}
.tp-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
}
.tp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tp-top {
  height: 6px;
  flex-shrink: 0;
}
.tp-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 3px;
}
.tp-block {
  flex: 1;
  border-radius: 4px;
}
.tp-btn {
  height: 4px;
  flex-shrink: 0;
  border-radius: 4px;
}
.tp-check {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  padding: 2px;
}
.theme-tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* ---- about & update ---- */
.upd-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 6px 0;
  min-height: 38px;
  margin: 0;
  flex-wrap: wrap;
}
.upd-label {
  width: 84px;
  flex-shrink: 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.upd-value {
  font-weight: 650;
}
.upd-latest {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent-2);
  font-size: var(--text-sm);
}
.upd-auto-hint {
  font-size: var(--text-xs);
}
.upd-pending-row {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.upd-pending-text {
  font-size: var(--text-sm);
  font-weight: 600;
}
.upd-failed-row {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent);
}
.upd-failed-text {
  font-size: var(--text-xs);
  color: var(--danger);
}
.upd-actions-row {
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.upd-link {
  color: var(--accent-2);
}
.update-maintenance {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.empty .group-error {
  margin-bottom: var(--space-3);
}

/* ---- narrow windows ---- */
@media (max-width: 1100px) {
  .runtime-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 800px) {
  .settings-page {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto auto minmax(0, 1fr);
  }
  .settings-search {
    grid-row: 2;
    grid-column: 1;
    align-items: stretch;
  }
  .settings-scopes {
    grid-row: 3;
  }
  .settings-categories {
    grid-row: 4;
  }
  .settings-body {
    grid-row: 5;
  }
  .settings-search-results {
    top: 92px;
  }
  .settings-page [data-section] {
    scroll-margin-top: 16px;
  }
}
</style>

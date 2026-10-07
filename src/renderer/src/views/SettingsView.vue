<script setup lang="ts">
/**
 * SettingsView — every row writes through `settings.set(patch)` and then renders the record
 * the process returned. Local drafts exist only for free-text fields (so a keystroke does not
 * hit IPC) and for sliders (so dragging does not spam writes); they are cleared the moment a
 * confirmed record arrives.
 *
 * Mirror rules are edited through a mapping-array draft and converted back into
 * `Record<string,string>` on save, because a record key is awkward to rename while typing.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GameDirStats, JavaRuntime, MirrorRule, Settings, UpdateInfo } from '@shared/types'
import { LANGUAGES, defineDict, setLocale, t } from '../i18n'
import { commitTheme } from '../theme'
import { formatBytes, formatCount } from '../composables/format'
import { useToast } from '../composables/useToast'
import { useModal } from '../composables/useModal'
import { activeMirrorMap, useSettings } from '../stores/useSettings'
import { useLauncher } from '../stores/useLauncher'
import type { SelectOption, TableColumn, TableRow } from '../components/ui/types'
import MButton from '../components/ui/MButton.vue'
import MCard from '../components/ui/MCard.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MIcon from '../components/icons/MIcon.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MInput from '../components/ui/MInput.vue'
import MProgress from '../components/ui/MProgress.vue'
import MRadio from '../components/ui/MRadio.vue'
import MRange from '../components/ui/MRange.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MSelect from '../components/ui/MSelect.vue'
import MSegmented from '../components/ui/MSegmented.vue'
import MSwitch from '../components/ui/MSwitch.vue'
import MTable from '../components/ui/MTable.vue'
import MTag from '../components/ui/MTag.vue'
import MTextarea from '../components/ui/MTextarea.vue'
import MTooltip from '../components/ui/MTooltip.vue'

const text = defineDict({
  browse: ['浏览…', 'Browse…'],
  gameRootHint: ['所有版本、库文件、资源与实例都写到这里。', 'Versions, libraries, assets and instances all land here.'],
  resolvedPaths: ['实际使用的目录', 'Resolved folders'],
  dirStats: ['目录统计', 'Folder stats'],
  notExist: ['目录不存在', 'Folder not found'],
  files: ['文件数', 'Files'],
  screenshots: ['截图', 'Screenshots'],
  downloadsHint: ['并发太高会挤占带宽；严格模式会在任一分片失败时终止任务。', 'High concurrency starves your bandwidth; strict mode aborts a job on any failed part.'],
  proxyHint: ['留空表示沿用系统代理。', 'Leave empty to follow the system proxy.'],
  currentJob: ['进行中的任务', 'Job in flight'],
  noJob: ['没有正在进行的下载任务。', 'No download in flight.'],
  mirrorRules: ['镜像规则', 'Mirror rules'],
  mirrorHint: ['每条规则把官方主机名重写成镜像主机（可以带路径前缀）。', 'Each rule rewrites an official host into a mirror host; a path prefix is allowed.'],
  noMirror: ['没有启用任何规则，全部走官方源。', 'No rule enabled — everything goes to the official hosts.'],
  addRule: ['新增下载源', 'Add a download source'],
  addHost: ['添加主机映射', 'Add a host mapping'],
  originalHost: ['官方主机', 'Official host'],
  priority: ['优先级', 'Priority'],
  mirrorHost: ['镜像主机', 'Mirror host'],
  hostRequired: ['主机映射两端都不能为空。', 'Both sides of a host mapping are required.'],
  applyMirrors: ['保存下载源', 'Save download sources'],
  discardMirrors: ['放弃修改', 'Discard'],
  activeHosts: ['生效映射 {n} 条', '{n} active rewrites'],
  dirtyRules: ['有未保存的改动', 'Unsaved changes'],
  javaHint: ['自动模式按版本 json 的 javaVersion 选择；下载的运行时写入启动器 java 目录。', 'Auto follows the version json; downloaded runtimes land in the launcher java folder.'],
  scanJava: ['扫描本机 Java', 'Scan this machine'],
  scanDone: ['发现 {n} 个运行时', 'Found {n} runtimes'],
  scanFailed: ['扫描失败', 'Scan failed'],
  scanDirs: ['扫描目录', 'Scan folders'],
  addScanDir: ['添加目录', 'Add folder'],
  noScanDir: ['没有额外扫描目录。', 'No extra scan folders.'],
  customJava: ['自定义 javaw.exe', 'Custom javaw.exe'],
  pickExe: ['选择 javaw.exe', 'Choose javaw.exe'],
  pickFailed: ['打开选择框失败', 'Could not open the picker'],
  majorCol: ['主版本', 'Major'],
  keysTitle: ['账户与密钥', 'Accounts & keys'],
  microsoftHint: ['Entra ID 应用注册里的客户端 ID，用于微软正版登录。', 'The client id from your Entra ID app registration, used for Microsoft sign-in.'],
  microsoftDoc: ['微软应用注册文档', 'Microsoft app registration docs'],
  curseHint: ['api.curseforge.com 没有 key 会返回 403。', 'api.curseforge.com answers 403 without a key.'],
  curseDoc: ['CurseForge 控制台', 'CurseForge console'],
  modrinthBaseUrl: ['模组仓库地址', 'Mod repository base'],
  relayHint: ['跨网联机房间使用的中转服务器（host:port）。', 'host:port of the relay used for cross-network rooms.'],
  appearance: ['界面', 'Interface'],
  language: ['语言', 'Language'],
  theme: ['主题', 'Theme'],
  autoUpdate: ['自动检查更新', 'Automatically check for updates'],
  defaults: ['新建实例默认值', 'Defaults for new instances'],
  defaultMemory: ['默认内存', 'Default memory'],
  defaultResolution: ['默认分辨率', 'Default resolution'],
  fullscreen: ['全屏', 'Fullscreen'],
  width: ['宽', 'Width'],
  height: ['高', 'Height'],
  about: ['关于', 'About'],
  checkUpdate: ['检查更新', 'Check for updates'],
  checkFailed: ['检查更新失败', 'Could not check for updates'],
  openRepo: ['打开仓库', 'Open repository'],
  openLogs: ['打开日志目录', 'Open log folder'],
  openRelease: ['打开发布页', 'Open release page'],
  updateAvailable: ['可更新到 {version}', 'Update to {version} available'],
  updateLatest: ['当前已是最新版本', 'This build is up to date'],
  buildInfo: ['运行环境', 'Build info'],
  resetAll: ['恢复默认设置', 'Restore defaults'],
  reload: ['重新读取', 'Reload']
})

const REPO_URL = 'https://github.com/jiajia2222/MoucLauncher'
const MS_DOCS_URL = 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app'
const CURSE_DOCS_URL = 'https://console.curseforge.com/'
const JAVA_MAJORS = ['8', '17', '21', '25']

const JAVA_MODES: { value: Settings['javaMode']; label: string }[] = [
  { value: 'auto', label: t('java.mode.auto') },
  { value: 'mojang-component', label: t('java.mode.mojang') },
  { value: 'adoptium', label: t('java.mode.adoptium') },
  { value: 'custom', label: t('java.mode.custom') }
]

const CLOSE_ACTIONS: SelectOption[] = [
  { value: 'minimize', label: t('settings.closeAction.minimize') },
  { value: 'exit', label: t('settings.closeAction.exit') },
  { value: 'ask', label: t('settings.closeAction.ask') }
]

const THEME_OPTIONS: SelectOption[] = [
  { value: 'dark', label: t('status.themeDark') },
  { value: 'light', label: t('status.themeLight') }
]

const LANGUAGE_OPTIONS: SelectOption[] = LANGUAGES.map((entry) => ({ value: entry.value, label: entry.label }))

const MAJOR_OPTIONS: SelectOption[] = JAVA_MAJORS.map((major) => ({ value: major, label: t('java.major', { major }) }))

const JAVA_COLUMNS: TableColumn[] = [
  { key: 'major', label: text.text('majorCol'), sortable: true, width: '96px' },
  { key: 'vendor', label: t('java.vendor'), width: '20%' },
  { key: 'arch', label: t('java.arch'), width: '88px' },
  { key: 'source', label: t('mod.provider'), width: '16%' },
  { key: 'path', label: t('java.path'), mono: true },
  { key: 'action', label: t('common.action'), align: 'end', width: '44px' }
]

const settings = useSettings()
const launcher = useLauncher()
const toast = useToast()
const modal = useModal()

const record = computed<Settings | null>(() => settings.record.value)

/* ------------------------------------------------------------ text drafts */
const drafts = ref<Record<string, string>>({})

function draft(key: keyof Settings): string {
  const local = drafts.value[key]
  if (local !== undefined) return local
  const value = record.value?.[key]
  return value === undefined || value === null ? '' : String(value)
}

function onDraft(key: keyof Settings, value: string): void {
  drafts.value[key] = value
}

async function commit(key: keyof Settings): Promise<boolean> {
  const local = drafts.value[key]
  if (local === undefined) return false
  if (local === String(record.value?.[key] ?? '')) {
    delete drafts.value[key]
    return false
  }
  const ok = await settings.save({ [key]: local } as Partial<Settings>)
  if (ok) delete drafts.value[key]
  return ok
}

async function set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await settings.save({ [key]: value } as Partial<Settings>)
}

/* --------------------------------------------------------------- sliders */
const concurrency = ref(8)
const defaultMemory = ref(4096)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => record.value?.maxConcurrentDownloads,
  (value) => {
    if (typeof value === 'number') concurrency.value = value
  },
  { immediate: true }
)

watch(
  () => record.value?.defaultMemoryMb,
  (value) => {
    if (typeof value === 'number') defaultMemory.value = value
  },
  { immediate: true }
)

function queue(key: 'maxConcurrentDownloads' | 'defaultMemoryMb', value: number): void {
  if (record.value?.[key] === value) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => void settings.save({ [key]: value } as Partial<Settings>), 400)
}

watch(concurrency, (value) => queue('maxConcurrentDownloads', value))
watch(defaultMemory, (value) => queue('defaultMemoryMb', value))

/* ---------------------------------------------------------- mirror rules */
interface RuleDraft {
  id: string
  label: string
  enabled: boolean
  priority: number
  mappings: { host: string; target: string }[]
}

const rules = ref<RuleDraft[]>([])

function toDrafts(source: MirrorRule[]): RuleDraft[] {
  // No structuredClone here: `source` is a reactive proxy and cloning one throws.
  // The map below already produces plain objects.
  return source.map((rule) => ({
    id: rule.id,
    label: rule.label,
    enabled: rule.enabled,
    priority: rule.priority,
    mappings: Object.entries(rule.hosts).map(([host, target]) => ({ host, target }))
  }))
}

function fromDrafts(drafts: RuleDraft[]): MirrorRule[] {
  return drafts.map((rule) => {
    const hosts: Record<string, string> = {}
    for (const mapping of rule.mappings) {
      const host = mapping.host.trim()
      const target = mapping.target.trim()
      if (host && target) hosts[host] = target
    }
    return { id: rule.id, label: rule.label.trim() || rule.id, enabled: rule.enabled, hosts, priority: rule.priority }
  })
}

/** True when the draft differs from the saved record (drives the "unsaved" chip). */
const rulesDirty = computed(() => JSON.stringify(fromDrafts(rules.value)) !== JSON.stringify(record.value?.mirrors ?? []))
const activeCount = computed(() => Object.keys(activeMirrorMap(record.value?.mirrors ?? [])).length)

function addRule(): void {
  rules.value = [
    ...rules.value,
    {
      id: `mirror-${Date.now().toString(36)}`,
      label: text.text('addRule'),
      enabled: true,
      priority: (rules.value.length + 1) * 10,
      mappings: [{ host: '', target: '' }]
    }
  ]
}

function removeRule(index: number): void {
  rules.value = rules.value.filter((_, position) => position !== index)
}

function addMapping(rule: RuleDraft): void {
  rule.mappings = [...rule.mappings, { host: '', target: '' }]
}

function removeMapping(rule: RuleDraft, index: number): void {
  rule.mappings = rule.mappings.filter((_, position) => position !== index)
}

function ruleError(rule: RuleDraft): string {
  const half = rule.mappings.some((mapping) => mapping.host.trim() !== '' && mapping.target.trim() === '')
  return half ? text.text('hostRequired') : ''
}

async function saveMirrors(): Promise<void> {
  const broken = rules.value.find((rule) => ruleError(rule))
  if (broken) {
    toast.push({ kind: 'warning', title: text.text('mirrorRules'), message: text.text('hostRequired') })
    return
  }
  await settings.saveMirrors(fromDrafts(rules.value))
}

function discardMirrors(): void {
  rules.value = toDrafts(record.value?.mirrors ?? [])
}

/* ------------------------------------------------------------------- java */
const runtimes = ref<JavaRuntime[]>([])
const scanning = ref(false)
const provisionMajor = ref('21')
const provisioning = ref(false)

const javaRows = computed<TableRow[]>(() =>
  runtimes.value.map((entry) => ({
    id: entry.id,
    major: entry.major,
    vendor: entry.vendor,
    arch: entry.arch,
    source: entry.source,
    path: entry.path,
    broken: entry.broken ?? ''
  }))
)

async function loadRuntimes(): Promise<void> {
  const res = await window.mouc.java.list()
  if (res.ok) runtimes.value = res.data
  else toast.push({ kind: 'danger', title: t('java.runtimes'), message: res.error.message })
}

async function scanJava(): Promise<void> {
  scanning.value = true
  const res = await window.mouc.java.scan()
  scanning.value = false
  if (!res.ok) {
    toast.push({ kind: 'danger', title: text.text('scanFailed'), message: res.error.message })
    return
  }
  runtimes.value = res.data
  toast.push({ kind: 'success', title: text.text('scanDone', { n: res.data.length }) })
}

async function removeRuntime(id: string): Promise<void> {
  const confirmed = await modal.confirm({
    title: t('java.remove'),
    text: id,
    confirmKey: 'common.delete',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  const res = await window.mouc.java.remove(id)
  if (!res.ok) {
    toast.push({ kind: 'danger', title: t('java.remove'), message: res.error.message })
    return
  }
  runtimes.value = runtimes.value.filter((entry) => entry.id !== id)
}

async function provisionJava(): Promise<void> {
  const major = Number.parseInt(provisionMajor.value, 10)
  provisioning.value = true
  const res = await window.mouc.java.provision({ major, imageType: 'jre' })
  provisioning.value = false
  if (!res.ok) {
    toast.push({ kind: 'danger', title: t('java.provision', { major }), message: res.error.message })
    return
  }
  runtimes.value = [...runtimes.value, res.data.runtime]
  toast.push({ kind: 'success', title: t('java.provision', { major: res.data.runtime.major }) })
}

async function addScanDir(): Promise<void> {
  const picked = await window.mouc.app.pickFolder(text.text('addScanDir'))
  if (!picked.ok) {
    toast.push({ kind: 'danger', title: text.text('pickFailed'), message: picked.error.message })
    return
  }
  const folder = picked.data
  if (!folder) return
  const current = record.value?.javaScanDirs ?? []
  if (current.includes(folder)) return
  await set('javaScanDirs', [...current, folder])
}

async function browseCustomJava(): Promise<void> {
  const picked = await window.mouc.app.pickFile(text.text('pickExe'), [{ name: 'javaw.exe', extensions: ['exe'] }])
  if (!picked.ok) {
    toast.push({ kind: 'danger', title: text.text('pickFailed'), message: picked.error.message })
    return
  }
  const file = picked.data
  if (!file) return
  onDraft('customJavaPath', file)
  await commit('customJavaPath')
}

/* ------------------------------------------------------------- game root */
async function browseGameRoot(): Promise<void> {
  const picked = await window.mouc.app.pickFolder(t('settings.gameRoot'), record.value?.gameRoot)
  if (!picked.ok) {
    toast.push({ kind: 'danger', title: text.text('pickFailed'), message: picked.error.message })
    return
  }
  const folder = picked.data
  if (!folder) return
  onDraft('gameRoot', folder)
  if (await commit('gameRoot')) await Promise.all([settings.loadPaths(), settings.loadStats()])
}

const pathRows = computed<[string, string][]>(() => {
  const info = settings.paths.value
  if (!info) return []
  return [
    [t('settings.gameRoot'), info.gameRoot],
    ['versions', info.versionsDir],
    ['libraries', info.librariesDir],
    ['assets', info.assetsDir],
    ['instances', info.instancesDir],
    ['logs', info.logsDir],
    ['java', info.javaStoreDir],
    ['config', info.configDir],
    ['appData', info.appData]
  ]
})

const stats = computed<GameDirStats | null>(() => settings.stats.value)
const activeJobs = computed(() => launcher.activeJobs.value)

/* ---------------------------------------------------------------- update */
const update = ref<UpdateInfo | null>(null)
const checking = ref(false)
const appVersion = ref('')
const build = ref<{ electron: string; node: string; platform: string; arch: string } | null>(null)

async function checkUpdate(): Promise<void> {
  checking.value = true
  const res = await window.mouc.app.checkUpdate()
  checking.value = false
  if (!res.ok) {
    toast.push({ kind: 'danger', title: text.text('checkFailed'), message: res.error.message })
    return
  }
  update.value = res.data
  toast.push({
    kind: res.data.available ? 'info' : 'success',
    title: res.data.available ? text.text('updateAvailable', { version: res.data.latest }) : text.text('updateLatest')
  })
}

async function openExternal(url: string): Promise<void> {
  const res = await window.mouc.app.openExternal(url)
  if (!res.ok) toast.push({ kind: 'danger', title: t('common.open'), message: res.error.message })
}

async function openLogs(): Promise<void> {
  const dir = settings.paths.value?.logsDir
  if (!dir) return
  const res = await window.mouc.app.openPath(dir)
  if (!res.ok) toast.push({ kind: 'danger', title: text.text('openLogs'), message: res.error.message })
}

/* --------------------------------------------------------------- locale */
async function changeTheme(value: string): Promise<void> {
  const mode = value === 'light' ? 'light' : 'dark'
  await commitTheme(mode)
  await set('theme', mode)
}

async function changeLanguage(value: string): Promise<void> {
  const language = value === 'en-US' ? 'en-US' : 'zh-CN'
  setLocale(language)
  await set('language', language)
}

async function resetAll(): Promise<void> {
  const confirmed = await modal.confirm({
    titleKey: 'settings.resetConfirm',
    confirmKey: 'common.reset',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  await settings.reset()
  await Promise.all([settings.loadPaths(), settings.loadStats()])
}

/* ------------------------------------------------------ resolution bridge */
const resWidth = computed({
  get: () => String(record.value?.defaultResolution.width ?? ''),
  set: (value: string) => {
    const current = record.value
    if (!current) return
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) void set('defaultResolution', { ...current.defaultResolution, width: parsed })
  }
})

const resHeight = computed({
  get: () => String(record.value?.defaultResolution.height ?? ''),
  set: (value: string) => {
    const current = record.value
    if (!current) return
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) void set('defaultResolution', { ...current.defaultResolution, height: parsed })
  }
})

const fullscreen = computed({
  get: () => record.value?.defaultResolution.fullscreen ?? false,
  set: (value: boolean) => {
    const current = record.value
    if (current) void set('defaultResolution', { ...current.defaultResolution, fullscreen: value })
  }
})

onMounted(async () => {
  await Promise.all([settings.load(), settings.loadPaths(), settings.loadStats(), launcher.refreshJobs()])
  rules.value = toDrafts(record.value?.mirrors ?? [])
  const [versionRes, statusRes] = await Promise.all([window.mouc.app.version(), window.mouc.app.status()])
  if (versionRes.ok) appVersion.value = versionRes.data
  else toast.push({ kind: 'danger', title: t('status.versionLabel'), message: versionRes.error.message })
  if (statusRes.ok) {
    build.value = {
      electron: statusRes.data.electron,
      node: statusRes.data.node,
      platform: statusRes.data.platform,
      arch: statusRes.data.arch
    }
  } else toast.push({ kind: 'danger', title: text.text('buildInfo'), message: statusRes.error.message })
  await loadRuntimes()
})

// A confirmed record always wins over an unsent draft.
watch(
  () => settings.record.value,
  () => {
    drafts.value = {}
    rules.value = toDrafts(record.value?.mirrors ?? [])
  }
)

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div class="settings">
    <header class="page-head">
      <div class="page-heading">
        <h1 class="page-title">{{ t('nav.settings') }}</h1>
        <p class="page-sub">v{{ appVersion || '--' }} · {{ t('app.tagline') }}</p>
      </div>
      <div class="page-actions">
        <MButton size="sm" icon="refresh" @click="settings.load()">{{ text.text('reload') }}</MButton>
        <MButton size="sm" variant="danger" icon="close-all" @click="resetAll">{{ text.text('resetAll') }}</MButton>
      </div>
    </header>

    <MCard v-if="settings.loading.value && !record" tone="flat">
      <MSkeleton :lines="7" height="32px" />
    </MCard>

    <MCard v-else-if="!record" tone="flat">
      <MEmpty icon="warning" :title="settings.error.value || t('common.empty')" compact>
        <MButton icon="refresh" @click="settings.load()">{{ t('common.retry') }}</MButton>
      </MEmpty>
    </MCard>

    <div v-else class="grid">
      <!-- ===================================================== game root -->
      <MCard id="root" :title="t('settings.gameRoot')" icon="folder" class="span-2">
        <MFieldRow :label="t('settings.gameRoot')" :hint="text.text('gameRootHint')">
          <div class="pair">
            <MInput
              :model-value="draft('gameRoot')"
              mono
              :placeholder="t('settings.gameRoot')"
              @update:model-value="onDraft('gameRoot', $event)"
              @blur="commit('gameRoot')"
              @enter="commit('gameRoot')"
            />
            <MButton icon="folder" @click="browseGameRoot">{{ text.text('browse') }}</MButton>
          </div>
        </MFieldRow>

        <div class="sub-head">
          <h3 class="sub-title">{{ text.text('resolvedPaths') }}</h3>
          <MButton size="sm" variant="ghost" icon="refresh" @click="settings.loadPaths()">
            {{ t('common.refresh') }}
          </MButton>
        </div>

        <dl v-if="pathRows.length" class="paths">
          <div v-for="[label, path] in pathRows" :key="label" class="path">
            <dt>{{ label }}</dt>
            <dd class="u-mono u-truncate" :title="path">{{ path || t('common.none') }}</dd>
          </div>
        </dl>
        <p v-else class="u-muted">{{ t('common.loading') }}</p>

        <div class="sub-head">
          <h3 class="sub-title">{{ text.text('dirStats') }}</h3>
          <MButton size="sm" variant="ghost" icon="refresh" @click="settings.loadStats()">
            {{ t('common.refresh') }}
          </MButton>
        </div>

        <div v-if="stats" class="stat-row">
          <MTag v-if="!stats.exists" tone="warning" icon="warning">{{ text.text('notExist') }}</MTag>
          <span class="stat"><i>{{ t('common.size') }}</i><b class="u-num">{{ formatBytes(stats.sizeBytes) }}</b></span>
          <span class="stat"><i>{{ text.text('files') }}</i><b class="u-num">{{ formatCount(stats.fileCount) }}</b></span>
          <span class="stat"><i>{{ t('nav.versions') }}</i><b class="u-num">{{ stats.versions }}</b></span>
          <span class="stat"><i>{{ t('nav.instances') }}</i><b class="u-num">{{ stats.instances }}</b></span>
          <span class="stat"><i>{{ t('nav.mods') }}</i><b class="u-num">{{ stats.mods }}</b></span>
          <span class="stat"><i>{{ text.text('screenshots') }}</i><b class="u-num">{{ stats.screenshots }}</b></span>
        </div>
        <p v-else class="u-muted">{{ t('common.loading') }}</p>
      </MCard>

      <!-- ======================================================= downloads -->
      <MCard id="downloads" :title="t('settings.downloads')" icon="download">
        <MFieldRow :label="t('settings.concurrent')" :hint="text.text('downloadsHint')">
          <MRange v-model="concurrency" :min="1" :max="16" show-value />
        </MFieldRow>

        <MFieldRow :label="t('settings.resume')">
          <MSwitch :model-value="record?.resumeDownloads ?? false" @update:model-value="set('resumeDownloads', $event)" />
        </MFieldRow>

        <MFieldRow :label="t('settings.strict')">
          <MSwitch :model-value="record?.strictDownload ?? false" @update:model-value="set('strictDownload', $event)" />
        </MFieldRow>

        <MFieldRow :label="t('settings.proxy')" :hint="text.text('proxyHint')">
          <MInput
            :model-value="draft('proxyUrl')"
            mono
            placeholder="http://127.0.0.1:7890"
            @update:model-value="onDraft('proxyUrl', $event)"
            @blur="commit('proxyUrl')"
            @enter="commit('proxyUrl')"
          />
        </MFieldRow>

        <div class="sub-head"><h3 class="sub-title">{{ text.text('currentJob') }}</h3></div>
        <p v-if="!activeJobs.length" class="u-muted jobs-empty">{{ text.text('noJob') }}</p>
        <div v-for="row in activeJobs" :key="row.job.id" class="job">
          <span class="job-title u-truncate" :title="row.job.title">{{ row.job.title }}</span>
          <MProgress
            class="job-bar"
            :percent="row.percent"
            size="sm"
            :speed="row.live?.speedBps ?? 0"
            :eta-seconds="row.live?.etaSeconds ?? 0"
            show-meta
          />
          <MButton size="sm" variant="ghost" icon="x" @click="launcher.cancelJob(row.job.id)">
            {{ t('common.cancel') }}
          </MButton>
        </div>
      </MCard>

      <!-- ========================================================= mirrors -->
      <MCard id="mirrors" :title="t('settings.mirrors')" :subtitle="text.text('mirrorHint')" icon="globe" class="span-2">
        <template #actions>
          <MTag size="sm" :tone="activeCount ? 'success' : 'neutral'">
            {{ text.text('activeHosts', { n: activeCount }) }}
          </MTag>
          <MTag v-if="rulesDirty" size="sm" tone="warning" dot>{{ text.text('dirtyRules') }}</MTag>
        </template>

        <p v-if="!rules.length" class="u-muted jobs-empty">{{ text.text('noMirror') }}</p>

        <section v-for="(rule, index) in rules" :key="rule.id" class="rule">
          <div class="rule-head">
            <MSwitch v-model="rule.enabled" size="sm" />
            <MInput :model-value="rule.label" size="sm" class="rule-label" @update:model-value="rule.label = $event" />
            <MInput
              :model-value="String(rule.priority)"
              class="rule-priority"
              type="number"
              size="sm"
              mono
              :placeholder="text.text('priority')"
              @update:model-value="rule.priority = Number.parseInt($event, 10) || 0"
            />
            <MIconButton icon="trash" :label="t('common.delete')" size="sm" tone="danger" @click="removeRule(index)" />
          </div>

          <p v-if="ruleError(rule)" class="inline-error">{{ ruleError(rule) }}</p>

          <ul v-if="rule.mappings.length" class="hosts">
            <li v-for="(mapping, position) in rule.mappings" :key="`${rule.id}-${position}`" class="host">
              <MInput
                :model-value="mapping.host"
                size="sm"
                mono
                :placeholder="text.text('originalHost')"
                @update:model-value="mapping.host = $event"
              />
              <MIcon name="chevron-right" :size="16" tone="muted" />
              <MInput
                :model-value="mapping.target"
                size="sm"
                mono
                :placeholder="text.text('mirrorHost')"
                @update:model-value="mapping.target = $event"
              />
              <MIconButton icon="x" :label="t('common.delete')" size="sm" @click="removeMapping(rule, position)" />
            </li>
          </ul>
          <p v-else class="u-muted jobs-empty">{{ text.text('addHost') }}</p>

          <MButton size="sm" variant="ghost" icon="plus" @click="addMapping(rule)">{{ text.text('addHost') }}</MButton>
        </section>

        <div class="rule-foot">
          <MButton size="sm" icon="plus" @click="addRule">{{ text.text('addRule') }}</MButton>
          <MButton size="sm" variant="ghost" @click="discardMirrors">{{ text.text('discardMirrors') }}</MButton>
          <MButton
            size="sm"
            variant="primary"
            icon="check"
            :disabled="!rulesDirty"
            :loading="settings.saving.value"
            @click="saveMirrors"
          >
            {{ text.text('applyMirrors') }}
          </MButton>
        </div>
      </MCard>

      <!-- ============================================================= java -->
      <MCard id="java" :title="t('nav.java')" icon="beaker" class="span-2">
        <MFieldRow :label="t('java.mode')" :hint="text.text('javaHint')">
          <div class="radio-row">
            <MRadio
              v-for="mode in JAVA_MODES"
              :key="mode.value"
              :model-value="record?.javaMode ?? 'auto'"
              :value="mode.value"
              :label="mode.label"
              @update:model-value="set('javaMode', $event as Settings['javaMode'])"
            />
          </div>
        </MFieldRow>

        <MFieldRow v-if="record?.javaMode === 'custom'" :label="text.text('customJava')">
          <div class="pair">
            <MInput
              :model-value="draft('customJavaPath')"
              mono
              placeholder="C:\\Java\\jdk-21\\bin\\javaw.exe"
              @update:model-value="onDraft('customJavaPath', $event)"
              @blur="commit('customJavaPath')"
            />
            <MButton icon="folder" @click="browseCustomJava">{{ text.text('browse') }}</MButton>
          </div>
        </MFieldRow>

        <MFieldRow :label="text.text('scanDirs')">
          <div class="pair pair-wrap">
            <span v-if="!(record?.javaScanDirs ?? []).length" class="u-muted">{{ text.text('noScanDir') }}</span>
            <MTag
              v-for="dir in (record?.javaScanDirs ?? [])"
              :key="dir"
              closable
              size="sm"
              @close="set('javaScanDirs', (record?.javaScanDirs ?? []).filter((entry) => entry !== dir))"
            >
              <span class="u-truncate" :title="dir">{{ dir }}</span>
            </MTag>
            <MButton size="sm" icon="plus" @click="addScanDir">{{ text.text('addScanDir') }}</MButton>
          </div>
        </MFieldRow>

        <div class="sub-head">
          <h3 class="sub-title">{{ t('java.runtimes') }}</h3>
          <div class="pair">
            <MSelect v-model="provisionMajor" class="major" size="sm" :options="MAJOR_OPTIONS" />
            <MButton size="sm" icon="download" :loading="provisioning" @click="provisionJava">
              {{ t('java.provision', { major: provisionMajor }) }}
            </MButton>
            <MButton size="sm" icon="search" :loading="scanning" @click="scanJava">{{ text.text('scanJava') }}</MButton>
          </div>
        </div>

        <MTable v-if="javaRows.length" :columns="JAVA_COLUMNS" :rows="javaRows" dense>
          <template #cell="{ row, column }">
            <template v-if="column.key === 'major'">
              <MTag size="sm" :tone="row.broken ? 'danger' : 'accent'">{{ t('java.major', { major: String(row.major) }) }}</MTag>
            </template>
            <template v-else-if="column.key === 'path'">
              <span class="u-truncate" :title="String(row.path)">{{ row.path }}</span>
              <p v-if="row.broken" class="broken">{{ t('java.broken', { reason: String(row.broken) }) }}</p>
            </template>
            <template v-else-if="column.key === 'action'">
              <MIconButton
                icon="trash"
                :label="t('java.remove')"
                size="sm"
                tone="danger"
                @click="removeRuntime(String(row.id))"
              />
            </template>
            <template v-else>{{ row[column.key] }}</template>
          </template>
        </MTable>

        <MEmpty v-else icon="beaker" :title="t('java.runtimes')" :description="text.text('scanJava')" compact>
          <MButton size="sm" icon="search" :loading="scanning" @click="scanJava">{{ text.text('scanJava') }}</MButton>
        </MEmpty>
      </MCard>

      <!-- ============================================================= keys -->
      <MCard id="keys" :title="text.text('keysTitle')" icon="key">
        <MFieldRow :label="t('account.addMicrosoft')" :hint="text.text('microsoftHint')">
          <div class="pair">
            <MInput
              :model-value="draft('microsoftClientId')"
              mono
              placeholder="00000000-0000-0000-0000-000000000000"
              @update:model-value="onDraft('microsoftClientId', $event)"
              @blur="commit('microsoftClientId')"
              @enter="commit('microsoftClientId')"
            />
            <MTooltip :content="text.text('microsoftDoc')">
              <MIconButton icon="external" :label="text.text('microsoftDoc')" @click="openExternal(MS_DOCS_URL)" />
            </MTooltip>
          </div>
        </MFieldRow>

        <MFieldRow label="CurseForge API Key" :hint="text.text('curseHint')">
          <div class="pair">
            <MInput
              :model-value="draft('curseForgeApiKey')"
              type="password"
              mono
              :placeholder="t('common.optional')"
              @update:model-value="onDraft('curseForgeApiKey', $event)"
              @blur="commit('curseForgeApiKey')"
              @enter="commit('curseForgeApiKey')"
            />
            <MTooltip :content="text.text('curseDoc')">
              <MIconButton icon="external" :label="text.text('curseDoc')" @click="openExternal(CURSE_DOCS_URL)" />
            </MTooltip>
          </div>
        </MFieldRow>

        <MFieldRow :label="text.text('modrinthBaseUrl')">
          <MInput
            :model-value="draft('modrinthBaseUrl')"
            mono
            @update:model-value="onDraft('modrinthBaseUrl', $event)"
            @blur="commit('modrinthBaseUrl')"
            @enter="commit('modrinthBaseUrl')"
          />
        </MFieldRow>
      </MCard>

      <!-- ============================================================ online -->
      <MCard id="online" :title="t('nav.online')" icon="radio">
        <MFieldRow :label="t('settings.relayServer')" :hint="text.text('relayHint')">
          <MInput
            :model-value="draft('relayServerUrl')"
            mono
            placeholder="relay.example.com:25570"
            @update:model-value="onDraft('relayServerUrl', $event)"
            @blur="commit('relayServerUrl')"
            @enter="commit('relayServerUrl')"
          />
        </MFieldRow>
      </MCard>

      <!-- ========================================================= appearance -->
      <MCard id="ui" :title="text.text('appearance')" icon="palette">
        <MFieldRow :label="text.text('language')">
          <MSelect :model-value="record?.language ?? 'zh-CN'" :options="LANGUAGE_OPTIONS" @update:model-value="changeLanguage" />
        </MFieldRow>

        <MFieldRow :label="text.text('theme')">
          <MSegmented :model-value="record?.theme ?? 'dark'" :options="THEME_OPTIONS" @update:model-value="changeTheme" />
        </MFieldRow>

        <MFieldRow :label="t('settings.closeAction')">
          <MSelect
            :model-value="record?.closeAction ?? 'ask'"
            :options="CLOSE_ACTIONS"
            @update:model-value="set('closeAction', $event as Settings['closeAction'])"
          />
        </MFieldRow>

        <MFieldRow :label="t('settings.console')">
          <MSwitch :model-value="record?.showGameConsole ?? false" @update:model-value="set('showGameConsole', $event)" />
        </MFieldRow>

        <MFieldRow :label="t('settings.hideOnLaunch')">
          <MSwitch :model-value="record?.hideOnLaunch ?? false" @update:model-value="set('hideOnLaunch', $event)" />
        </MFieldRow>

        <MFieldRow :label="text.text('autoUpdate')">
          <MSwitch :model-value="record?.autoCheckUpdate ?? false" @update:model-value="set('autoCheckUpdate', $event)" />
        </MFieldRow>
      </MCard>

      <!-- ========================================================= defaults -->
      <MCard id="defaults" :title="text.text('defaults')" icon="sort">
        <MFieldRow :label="text.text('defaultMemory')" :hint="`${defaultMemory} MB`">
          <MRange
            v-model="defaultMemory"
            :min="1024"
            :max="32768"
            :step="512"
            show-value
            :value-text="formatBytes(defaultMemory * 1024 * 1024, 0)"
          />
        </MFieldRow>

        <MFieldRow :label="text.text('defaultResolution')">
          <div class="pair">
            <MInput
              :model-value="resWidth"
              class="num"
              type="number"
              mono
              :placeholder="text.text('width')"
              @update:model-value="resWidth = $event"
            />
            <span class="u-muted">×</span>
            <MInput
              :model-value="resHeight"
              class="num"
              type="number"
              mono
              :placeholder="text.text('height')"
              @update:model-value="resHeight = $event"
            />
            <MSwitch v-model="fullscreen" size="sm" :label="text.text('fullscreen')" />
          </div>
        </MFieldRow>

        <MFieldRow :label="t('settings.jvmArgs')">
          <MTextarea
            :model-value="draft('extraJvmArgs')"
            :rows="2"
            resize="vertical"
            @update:model-value="onDraft('extraJvmArgs', $event)"
            @blur="commit('extraJvmArgs')"
          />
        </MFieldRow>
      </MCard>

      <!-- ============================================================ about -->
      <MCard id="about" :title="text.text('about')" icon="info">
        <div class="about-row">
          <span class="about-name">MoucLauncher</span>
          <MTag size="sm" tone="accent" class="u-mono">v{{ appVersion || '--' }}</MTag>
          <MTag v-if="update?.available" size="sm" tone="success" dot>
            {{ text.text('updateAvailable', { version: update.latest }) }}
          </MTag>
          <MTag v-else-if="update" size="sm" dot>{{ text.text('updateLatest') }}</MTag>
        </div>

        <dl v-if="build" class="build">
          <div><dt>Electron</dt><dd class="u-mono">{{ build.electron }}</dd></div>
          <div><dt>Node</dt><dd class="u-mono">{{ build.node }}</dd></div>
          <div><dt>Platform</dt><dd class="u-mono">{{ build.platform }} / {{ build.arch }}</dd></div>
          <div>
            <dt>{{ t('java.mode') }}</dt>
            <dd class="u-mono">{{ record?.javaMode }}</dd>
          </div>
        </dl>

        <p v-if="update?.notes" class="notes">{{ update.notes }}</p>

        <ul v-if="update?.assets.length" class="assets">
          <li v-for="asset in update.assets" :key="asset" class="u-mono">{{ asset }}</li>
        </ul>

        <div class="about-actions">
          <MButton icon="update" :loading="checking" @click="checkUpdate">{{ text.text('checkUpdate') }}</MButton>
          <MButton variant="ghost" icon="external" @click="openExternal(REPO_URL)">{{ text.text('openRepo') }}</MButton>
          <MButton v-if="update?.url" variant="ghost" icon="pack" @click="openExternal(update.url)">
            {{ text.text('openRelease') }}
          </MButton>
          <MButton variant="ghost" icon="terminal" @click="openLogs">{{ text.text('openLogs') }}</MButton>
        </div>
      </MCard>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-4);
  min-height: 100%;
  padding: var(--m-sp-5);
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--m-sp-4);
  flex-wrap: wrap;
}

.page-title {
  font-size: var(--m-fs-20);
  line-height: var(--m-lh-tight);
}

.page-sub {
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.page-actions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
  gap: var(--m-sp-4);
  align-items: start;
}

.span-2 {
  grid-column: 1 / -1;
}

.pair {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
  width: 100%;
}

.pair-wrap {
  flex-wrap: wrap;
}

.num {
  width: 96px;
  flex: none;
}

.major {
  width: 128px;
  flex: none;
}

.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--m-sp-2);
  padding-top: var(--m-sp-2);
  border-top: var(--m-line) solid var(--m-border-hairline);
}

.sub-title {
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.paths {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: var(--m-sp-1) var(--m-sp-4);
}

.path {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: baseline;
  gap: var(--m-sp-2);
  min-width: 0;
}

.path dt {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.path dd {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.stat-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--m-sp-2) var(--m-sp-4);
}

.stat {
  display: inline-flex;
  align-items: baseline;
  gap: var(--m-sp-1);
  font-size: var(--m-fs-12);
}

.stat i {
  font-style: normal;
  color: var(--m-text-muted);
}

.stat b {
  font-weight: 600;
  color: var(--m-text-primary);
}

.job {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.job-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.job-bar {
  flex: 2 1 auto;
  min-width: 0;
}

.jobs-empty {
  font-size: var(--m-fs-12);
}

/* -------------------------------------------------------------- mirrors */
.rule {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-md);
  background: var(--m-surface-raised);
}

.rule-head {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.rule-label {
  flex: 1 1 auto;
}

.rule-priority {
  width: 88px;
  flex: none;
}

.hosts {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.host {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1fr) 24px;
  align-items: center;
  gap: var(--m-sp-2);
}

.rule-foot {
  display: flex;
  gap: var(--m-sp-2);
}

.radio-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--m-sp-2) var(--m-sp-4);
}

.broken {
  font-size: var(--m-fs-12);
  color: var(--m-danger);
}

.inline-error {
  padding: var(--m-sp-2) var(--m-sp-3);
  border: var(--m-line) solid var(--m-danger);
  border-radius: var(--m-r-sm);
  background: var(--m-danger-soft);
  color: var(--m-danger);
  font-size: var(--m-fs-12);
  overflow-wrap: anywhere;
}

/* ---------------------------------------------------------------- about */
.about-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--m-sp-2);
}

.about-name {
  font-size: var(--m-fs-16);
  font-weight: 600;
}

.build {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--m-sp-1) var(--m-sp-4);
}

.build div {
  display: flex;
  align-items: baseline;
  gap: var(--m-sp-2);
  min-width: 0;
}

.build dt {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.build dd {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.notes {
  font-size: var(--m-fs-13);
  line-height: var(--m-lh-loose);
  color: var(--m-text-secondary);
}

.assets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--m-sp-1);
}

.assets li {
  padding: 0 var(--m-sp-2);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-xs);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--m-sp-2);
}
</style>

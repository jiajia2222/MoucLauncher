<script setup lang="ts">
/**
 * 模组 — port of KAMUCL's resource browser (`views/CommunityView.vue`) plus the per-instance
 * content manager.
 *
 * Two modes, like every other ported page: 「已安装」 reads one instance's `mods` folder through
 * `mouc.mod.installed()` (jar metadata, `.disabled` suffix, provenance-backed update badges),
 * 「浏览」 drives `mouc.mod.search()` with the upstream search card — kind capsules, keyword,
 * provider / game version / loader / sort filters, paginated project cards — and hands a chosen
 * project to the ported version sheet, which emits the file + instance this page installs.
 *
 * Rewired for this backend: results are `ModProject` (upstream had its own community record),
 * versions come from `mouc.mod.versions()`, installs go through `mouc.mod.install()` and report
 * on `mouc:progress`. CurseForge answers `unsupported` without an API key, so the browse tab
 * shows an inline key card that writes `settings.set` instead of firing a doomed request.
 *
 * Dropped because there is no backing capability: the favourites store, community login/session,
 * mcmod.cn lookups, machine translations, the jar-in-jar browser, the dependency-tree viewer and
 * the duplicate-mod cleaner. Required dependencies are still fetched — `withDependencies` is a
 * real flag on `mouc.mod.install()`.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type {
  DownloadJob,
  InstalledMod,
  InstanceSummary,
  LoaderId,
  ModFile,
  ModProject,
  ProjectKind,
  ProjectProvider,
  ProjectVersion,
  SearchQuery,
  Settings
} from '@shared/types'
import { navigate } from '../../composables/useNav'
import { useToast } from '../../composables/useToast'
import { defineDict, t } from '../../i18n'
import { loaderLabel } from '../api/instances'
import {
  KIND_LABELS,
  KIND_TABS,
  LOADER_TABS,
  PROVIDER_TABS,
  SORT_TABS,
  checkInstalledUpdates,
  curseForgeReady,
  errText,
  formatDate,
  formatDownloads,
  formatSize,
  installFromDisk,
  installProject,
  installedMods,
  installedVersionIds,
  isUnsupported,
  listInstances,
  openExternal,
  openInstanceDir,
  pickModFile,
  projectKey,
  projectSourceUrl,
  providerLabel as sourceLabel,
  readModSettings,
  removeInstalledMod,
  saveCurseForgeKey,
  searchProjects,
  setModDisabled,
  usesLoader
} from '../api/mods'
import CommunityVersionFilter from '../components/CommunityVersionFilter.vue'
import ModVersionModal from '../components/ModVersionModal.vue'
import ModsCurseKey from '../components/ModsCurseKey.vue'
import ModsInstalled from '../components/ModsInstalled.vue'
import ModsJobs from '../components/ModsJobs.vue'
import ModsSkeleton from '../components/ModsSkeleton.vue'

const copy = defineDict({
  subtitle: ['管理实例里的模组，或浏览 Modrinth 与 CurseForge。', 'Manage an instance, or browse Modrinth and CurseForge.'],
  modeInstalled: ['已安装', 'Installed'],
  modeBrowse: ['浏览', 'Browse'],
  instance: ['实例', 'Instance'],
  noInstance: ['没有可用实例', 'No instances'],
  vanilla: ['原版', 'vanilla'],
  instancesFailed: ['实例列表读取失败：{error}', 'Could not read the instances: {error}'],
  retry: ['重新读取', 'Reload'],
  browseSub: ['{provider} · {kind} · 共 {total} 个结果', '{provider} · {kind} · {total} results'],
  browseIdle: ['按下方条件搜索仓库；关键词留空可先看热门项目。', 'Search with the filters below; an empty keyword lists popular projects.'],
  keywordPlaceholder: ['输入{kind}名称，回车搜索…', 'Search {kind}…'],
  search: ['搜索', 'Search'],
  searching: ['正在搜索资源…', 'Searching the repositories…'],
  loadingInstances: ['正在读取实例…', 'Reading instances…'],
  reset: ['重置条件', 'Reset'],
  loader: ['加载器', 'Loader'],
  sort: ['排序', 'Sort'],
  useInstanceFilters: ['按当前实例筛选', 'Match this instance'],
  deps: ['下载文件时同时获取必要前置', 'Fetch required dependencies together'],
  depsHint: [
    '勾选后安装器会按当前实例的游戏版本与加载器解析前置，一并下载再写入。',
    'When ticked the installer resolves each required project for this instance before writing the file.'
  ],
  searchFailed: ['搜索失败：{error}', 'Search failed: {error}'],
  staleResults: ['条件已更新，暂时显示上次结果…', 'Filters changed — still showing the previous results.'],
  emptySearch: ['没有找到匹配的项目，换个关键词或放宽版本条件。', 'Nothing matched — try another keyword or widen the filters.'],
  emptyIdle: ['输入关键词或选择条件开始搜索。', 'Enter a keyword or pick a filter to start.'],
  downloads: ['下载量 {n}', '{n} downloads'],
  more: ['+{n}', '+{n}'],
  updated: ['更新于 {date}', 'updated {date}'],
  install: ['选择版本', 'Get versions'],
  sourcePage: ['打开 {site} 源页面', 'Open the {site} page'],
  page: ['共 {total} 项 · 第 {page} / {pages} 页', '{total} results · page {page} of {pages}'],
  prev: ['上一页', 'Previous'],
  next: ['下一页', 'Next'],
  queued: ['下载任务已开始：{title}', 'Download started: {title}'],
  installFailed: ['安装失败：{error}', 'Could not install: {error}'],
  noFile: ['这个版本没有可下载的文件', 'That version publishes no downloadable file'],
  noInstanceToast: ['内容按实例安装，请先创建一个实例', 'Content installs into an instance — create one first'],
  toggled: ['已{state} {name}', '{name} {state}'],
  stateEnabled: ['启用', 'enabled'],
  stateDisabled: ['停用', 'disabled'],
  toggleFailed: ['切换状态失败：{error}', 'Could not change the state: {error}'],
  removed: ['已删除 {name}', 'Deleted {name}'],
  removeFailed: ['删除失败：{error}', 'Could not delete: {error}'],
  removeTitle: ['删除文件', 'Delete file'],
  removeBody: [
    '将从 {instance} 的 mods 文件夹删除 {name}（{size}）。这会直接删除磁盘上的文件，无法撤销。',
    'Removes {name} ({size}) from the mods folder of {instance}. The file is deleted from disk.'
  ],
  removeConfirm: ['确认删除', 'Delete'],
  cancel: ['取消', 'Cancel'],
  updatesChecked: ['检查完成：{n} 个可更新', 'Done: {n} updatable'],
  updatesNone: ['检查完成，所有文件都是最新版', 'Everything is up to date'],
  updatesFailed: ['检查更新失败：{error}', 'Could not check for updates: {error}'],
  updatedAll: ['已开始 {n} 个更新任务', 'Started {n} update downloads'],
  diskPicked: ['已写入 {file}', 'Installed {file}'],
  diskFailed: ['从磁盘安装失败：{error}', 'Local install failed: {error}'],
  diskCancelled: ['已取消选择文件', 'File chooser cancelled'],
  folderFailed: ['无法打开实例文件夹', 'Could not open the instance folder'],
  keySaved: ['CurseForge API Key 已保存', 'CurseForge key saved'],
  keySaveFailed: ['保存失败：{error}', 'Could not save: {error}']
})

const toast = useToast()

/** Same page size the previous working browser used. */
const PAGE_SIZE = 12
const INSTANCE_KEY = 'mouc.mods.instance'

/* ------------------------------------------------------------------ instances */
const instances = ref<InstanceSummary[]>([])
const instanceId = ref('')
const instancesLoading = ref(true)
const instancesError = ref('')
const versionChoices = ref<string[]>([])

const current = computed<InstanceSummary | null>(
  () => instances.value.find((entry) => entry.instance.id === instanceId.value) ?? instances.value[0] ?? null
)

function instanceLabelOf(summary: InstanceSummary): string {
  const { instance } = summary
  const loader = instance.loader === 'vanilla' ? copy.text('vanilla') : loaderLabel(instance.loader, instance.loaderVersion)
  return `${instance.name} · ${instance.gameVersion || instance.versionId} · ${loader}`
}

const instanceText = computed(() => (current.value ? instanceLabelOf(current.value) : copy.text('noInstance')))

async function loadInstances(): Promise<void> {
  instancesLoading.value = true
  instancesError.value = ''
  try {
    instances.value = await listInstances()
    const saved = localStorage.getItem(INSTANCE_KEY) ?? ''
    const stillThere = instances.value.some((entry) => entry.instance.id === instanceId.value)
    if (!instanceId.value || !stillThere) {
      instanceId.value = instances.value.some((entry) => entry.instance.id === saved)
        ? saved
        : (instances.value[0]?.instance.id ?? '')
    }
  } catch (cause: unknown) {
    instancesError.value = errText(cause)
    toast.push({ kind: 'danger', title: copy.text('instancesFailed', { error: instancesError.value }) })
  } finally {
    instancesLoading.value = false
  }
}

async function loadVersionChoices(): Promise<void> {
  try {
    versionChoices.value = await installedVersionIds()
  } catch {
    // Non-critical: the version field still accepts a typed version.
    versionChoices.value = []
  }
}

/* ---------------------------------------------------------------------- modes */
type Mode = 'installed' | 'browse'
const mode = ref<Mode>('installed')

/* ------------------------------------------------------------------- installed */
const mods = ref<InstalledMod[]>([])
const modsLoading = ref(true)
const modsError = ref('')
const busyFile = ref('')
const checking = ref(false)
const updatingAll = ref(false)

async function loadMods(): Promise<void> {
  if (!instanceId.value) {
    mods.value = []
    modsError.value = ''
    modsLoading.value = false
    return
  }
  modsLoading.value = true
  modsError.value = ''
  try {
    mods.value = await installedMods(instanceId.value)
  } catch (cause: unknown) {
    modsError.value = errText(cause)
    toast.push({ kind: 'danger', title: modsError.value })
  } finally {
    modsLoading.value = false
  }
}

watch(instanceId, (id) => {
  if (id) localStorage.setItem(INSTANCE_KEY, id)
  void loadMods()
})

function replaceMod(fileName: string, next: InstalledMod): void {
  const index = mods.value.findIndex((entry) => entry.fileName === fileName)
  mods.value = index === -1 ? [...mods.value, next] : [...mods.value.slice(0, index), next, ...mods.value.slice(index + 1)]
}

async function onToggle(mod: InstalledMod, disabled: boolean): Promise<void> {
  if (busyFile.value) return
  busyFile.value = mod.fileName
  try {
    const next = await setModDisabled(instanceId.value, mod.fileName, disabled)
    replaceMod(mod.fileName, next)
    toast.push({
      kind: 'success',
      title: copy.text('toggled', {
        state: disabled ? copy.text('stateDisabled') : copy.text('stateEnabled'),
        name: next.name || next.modId || next.fileName
      })
    })
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: copy.text('toggleFailed', { error: errText(cause) }) })
    await loadMods()
  } finally {
    busyFile.value = ''
  }
}

const pendingRemove = ref<InstalledMod | null>(null)
const removing = ref(false)

function askRemove(mod: InstalledMod): void {
  pendingRemove.value = mod
}

async function confirmRemove(): Promise<void> {
  const target = pendingRemove.value
  if (!target || removing.value) return
  removing.value = true
  try {
    await removeInstalledMod(instanceId.value, target.fileName)
    mods.value = mods.value.filter((entry) => entry.fileName !== target.fileName)
    pendingRemove.value = null
    toast.push({ kind: 'success', title: copy.text('removed', { name: target.name || target.fileName }) })
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: copy.text('removeFailed', { error: errText(cause) }) })
    await loadMods()
  } finally {
    removing.value = false
  }
}

async function checkUpdates(): Promise<void> {
  if (checking.value || !instanceId.value) return
  checking.value = true
  try {
    mods.value = await checkInstalledUpdates(instanceId.value)
    const updatable = mods.value.filter((entry) => !!entry.updateAvailable).length
    toast.push({
      kind: updatable ? 'info' : 'success',
      title: updatable ? copy.text('updatesChecked', { n: updatable }) : copy.text('updatesNone')
    })
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: copy.text('updatesFailed', { error: errText(cause) }) })
  } finally {
    checking.value = false
  }
}

/** The file `install()` takes: the primary one, or the first the version publishes. */
function primaryFile(version: ProjectVersion | undefined): ModFile | null {
  if (!version) return null
  return version.files.find((entry) => entry.primary) ?? version.files[0] ?? null
}

async function installFile(file: ModFile, kind: ProjectKind, targetInstanceId: string): Promise<void> {
  try {
    const job = await installProject({ instanceId: targetInstanceId, kind, file, withDependencies: withDependencies.value })
    toast.push({ kind: 'success', title: copy.text('queued', { title: job.title }) })
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: copy.text('installFailed', { error: errText(cause) }) })
  }
}

async function onUpdate(mod: InstalledMod): Promise<void> {
  if (busyFile.value) return
  const file = primaryFile(mod.updateAvailable)
  if (!file) {
    toast.push({ kind: 'warning', title: copy.text('noFile') })
    return
  }
  busyFile.value = mod.fileName
  await installFile(file, 'mod', instanceId.value)
  busyFile.value = ''
}

async function onUpdateAll(): Promise<void> {
  if (updatingAll.value) return
  const targets = mods.value.filter((entry) => !!entry.updateAvailable)
  if (!targets.length) return
  updatingAll.value = true
  let started = 0
  for (const mod of targets) {
    const file = primaryFile(mod.updateAvailable)
    if (!file) continue
    busyFile.value = mod.fileName
    await installFile(file, 'mod', instanceId.value)
    started += 1
  }
  busyFile.value = ''
  updatingAll.value = false
  if (started) toast.push({ kind: 'info', title: copy.text('updatedAll', { n: started }) })
}

async function onInstallFromDisk(): Promise<void> {
  if (!instanceId.value) {
    toast.push({ kind: 'warning', title: copy.text('noInstanceToast') })
    return
  }
  const source = await pickModFile()
  if (!source) {
    toast.push({ kind: 'info', title: copy.text('diskCancelled') })
    return
  }
  busyFile.value = source
  try {
    const installed = await installFromDisk(instanceId.value, 'mod', source)
    toast.push({ kind: 'success', title: copy.text('diskPicked', { file: installed.fileName }) })
    await loadMods()
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: copy.text('diskFailed', { error: errText(cause) }) })
  } finally {
    busyFile.value = ''
  }
}

async function onOpenFolder(): Promise<void> {
  if (!instanceId.value) return
  const opened = await openInstanceDir(instanceId.value)
  if (!opened) toast.push({ kind: 'danger', title: copy.text('folderFailed') })
}

/** A finished install changes both the folder listing and the instance's mod count. */
function onJobChanged(job: DownloadJob): void {
  if (job.status !== 'done') return
  void loadMods()
  void loadInstances()
}

/* ---------------------------------------------------------------------- browse */
const provider = ref<ProjectProvider>('modrinth')
const kind = ref<ProjectKind>('mod')
const keyword = ref('')
const gameVersion = ref('')
const loader = ref<'' | LoaderId>('')
const sort = ref<NonNullable<SearchQuery['sort']>>('relevance')
const withDependencies = ref(true)

const results = ref<ModProject[]>([])
const total = ref(0)
const pageOffset = ref(0)
const searching = ref(false)
const searchError = ref('')
const searched = ref(false)
const brokenIcons = ref<Set<string>>(new Set())
let searchGeneration = 0

const settings = ref<Settings | null>(null)
const settingsKnown = ref(false)
const keySaving = ref(false)
const keyError = ref('')

const curseBlocked = computed(() => provider.value === 'curseforge' && settingsKnown.value && !curseForgeReady(settings.value))
const showKeyCard = computed(() => provider.value === 'curseforge' && (curseBlocked.value || keyError.value !== ''))
const apiKeyValue = computed(() => settings.value?.curseForgeApiKey ?? '')

const kindLabel = computed(() => KIND_LABELS[kind.value])
const providerName = computed(() => PROVIDER_TABS.find((entry) => entry.value === provider.value)?.label ?? 'Modrinth')
const currentPage = computed(() => Math.floor(pageOffset.value / PAGE_SIZE) + 1)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

function queryFor(offset: number): SearchQuery {
  return {
    provider: provider.value,
    kind: kind.value,
    keyword: keyword.value.trim(),
    ...(usesLoader(kind.value) && loader.value ? { loader: loader.value } : {}),
    ...(gameVersion.value.trim() ? { gameVersion: gameVersion.value.trim() } : {}),
    sort: sort.value,
    offset,
    limit: PAGE_SIZE
  }
}

async function searchAt(offset: number): Promise<void> {
  if (curseBlocked.value) {
    // No request can succeed: drop the spinner instead of leaving the list pending forever.
    searching.value = false
    return
  }
  const generation = ++searchGeneration
  searching.value = true
  searchError.value = ''
  try {
    const page = await searchProjects(queryFor(offset))
    if (generation !== searchGeneration) return
    results.value = page.items
    total.value = page.total
    pageOffset.value = page.offset
    searched.value = true
  } catch (cause: unknown) {
    if (generation !== searchGeneration) return
    const message = errText(cause)
    if (isUnsupported(cause) && provider.value === 'curseforge') keyError.value = message
    else {
      searchError.value = message
      toast.push({ kind: 'danger', title: copy.text('searchFailed', { error: message }) })
    }
  } finally {
    if (generation === searchGeneration) searching.value = false
  }
}

function doSearch(): Promise<void> {
  return searchAt(0)
}

function goPage(page: number): void {
  const target = Math.min(Math.max(1, page), totalPages.value)
  void searchAt((target - 1) * PAGE_SIZE)
}

/** Upstream's sliding page window: five numbers around the current page. */
const pageWindow = computed(() => {
  const pages = totalPages.value
  const from = Math.max(1, Math.min(currentPage.value - 2, pages - 4))
  const list: number[] = []
  for (let page = from; page <= Math.min(pages, from + 4); page += 1) list.push(page)
  return list
})

function resetFilters(): void {
  keyword.value = ''
  gameVersion.value = ''
  loader.value = ''
  sort.value = 'relevance'
  void doSearch()
}

/** Upstream 「使用当前实例」: filter the search by what the selected instance really runs. */
function useInstanceFilters(): void {
  const instance = current.value?.instance
  if (!instance) {
    toast.push({ kind: 'warning', title: copy.text('noInstanceToast') })
    return
  }
  gameVersion.value = instance.gameVersion || ''
  loader.value = instance.loader === 'vanilla' ? '' : instance.loader
  void doSearch()
}

async function loadSettings(): Promise<void> {
  try {
    settings.value = await readModSettings()
  } catch {
    // Unknown key state must not block the search; the backend answer is surfaced instead.
    settings.value = null
  } finally {
    settingsKnown.value = true
  }
}

async function onSaveKey(value: string): Promise<void> {
  if (keySaving.value) return
  keySaving.value = true
  keyError.value = ''
  try {
    settings.value = await saveCurseForgeKey(value)
    toast.push({ kind: 'success', title: copy.text('keySaved') })
    if (provider.value === 'curseforge') await doSearch()
  } catch (cause: unknown) {
    keyError.value = copy.text('keySaveFailed', { error: errText(cause) })
    toast.push({ kind: 'danger', title: keyError.value })
  } finally {
    keySaving.value = false
  }
}

function onIconError(project: ModProject): void {
  const key = projectKey(project)
  if (brokenIcons.value.has(key)) return
  brokenIcons.value = new Set([...brokenIcons.value, key])
}

function iconOf(project: ModProject): string {
  return project.iconUrl && !brokenIcons.value.has(projectKey(project)) ? project.iconUrl : ''
}

/** The three newest declared game versions; the rest collapse into a `+n` tag. */
function shownVersions(project: ModProject): string[] {
  return project.gameVersions.length > 3 ? project.gameVersions.slice(-3) : project.gameVersions
}

/* ------------------------------------------------------------- version sheet */
const sheet = ref<ModProject | null>(null)

function openSheet(project: ModProject): void {
  if (!instances.value.length) {
    toast.push({ kind: 'warning', title: copy.text('noInstanceToast') })
    return
  }
  sheet.value = project
}

async function onSheetInstall(payload: { instance: InstanceSummary; file: ModFile; kind: ProjectKind }): Promise<void> {
  sheet.value = null
  await installFile(payload.file, payload.kind, payload.instance.instance.id)
}

/* ------------------------------------------------------------------- watchers */
watch(mode, (next) => {
  if (next === 'browse' && !searched.value) void doSearch()
})

watch([provider, kind, gameVersion, loader, sort], () => {
  keyError.value = ''
  if (mode.value === 'browse') void doSearch()
})

watch(instanceId, () => {
  sheet.value = null
})

onMounted(async () => {
  await Promise.all([loadInstances(), loadSettings(), loadVersionChoices()])
  // `loadInstances()` fills `instanceId`, and that watcher is what reads the mods folder.
  if (!instanceId.value) modsLoading.value = false
  // The page can also land straight in the browser (restored mode, deep link).
  if (mode.value === 'browse') void doSearch()
})
</script>

<template>
  <section class="page mods-page">
    <header class="page-head">
      <div class="page-heading">
        <h1 class="page-title">{{ t('nav.mods') }}</h1>
        <p class="page-sub">
          <template v-if="instancesLoading">{{ copy.text('loadingInstances') }}</template>
          <template v-else-if="mode === 'browse'">
            <template v-if="searched">
              {{ copy.text('browseSub', { provider: providerName, kind: kindLabel, total }) }}
            </template>
            <template v-else>{{ copy.text('browseIdle') }}</template>
          </template>
          <template v-else>{{ copy.text('subtitle') }}</template>
        </p>
      </div>
      <div class="page-actions">
        <div class="mods-modes" role="tablist" aria-label="模组页模式">
          <button
            class="mods-mode"
            role="tab"
            :class="{ active: mode === 'installed' }"
            :aria-selected="mode === 'installed'"
            @click="mode = 'installed'"
          >
            {{ copy.text('modeInstalled') }}
            <span>{{ mods.length }}</span>
          </button>
          <button
            class="mods-mode"
            role="tab"
            :class="{ active: mode === 'browse' }"
            :aria-selected="mode === 'browse'"
            @click="mode = 'browse'"
          >
            {{ copy.text('modeBrowse') }}
          </button>
        </div>
        <label class="mods-instance">
          <span>{{ copy.text('instance') }}</span>
          <select v-model="instanceId" class="select" :disabled="instancesLoading || !instances.length" aria-label="选择实例">
            <option v-if="!instances.length && !instancesLoading" value="">{{ copy.text('noInstance') }}</option>
            <option v-for="entry in instances" :key="entry.instance.id" :value="entry.instance.id">
              {{ instanceLabelOf(entry) }}
            </option>
          </select>
        </label>
      </div>
    </header>

    <p v-if="instancesError" class="status-strip error" role="alert">
      {{ copy.text('instancesFailed', { error: instancesError }) }}
      <button class="btn btn-ghost btn-sm" @click="loadInstances">{{ copy.text('retry') }}</button>
    </p>

    <ModsJobs @changed="onJobChanged" />

    <!-- ======================================================== 已安装 -->
    <ModsInstalled
      v-if="mode === 'installed'"
      :mods="mods"
      :loading="modsLoading || instancesLoading"
      :error="modsError"
      :busy-file="busyFile"
      :checking="checking"
      :updating-all="updatingAll"
      :has-instance="!!instanceId"
      :instance-text="instanceText"
      kind="mod"
      @retry="loadMods"
      @toggle="onToggle"
      @remove="askRemove"
      @update="onUpdate"
      @update-all="onUpdateAll"
      @check-updates="checkUpdates"
      @from-disk="onInstallFromDisk"
      @browse="mode = 'browse'"
      @open-folder="onOpenFolder"
      @create-instance="navigate('instances')"
    />

    <!-- ========================================================== 浏览 -->
    <template v-else>
      <section class="card mods-search-card">
        <div class="mods-capsules" role="group" aria-label="资源类型">
          <button
            v-for="entry in KIND_TABS"
            :key="entry.value"
            class="capsule"
            :class="{ active: kind === entry.value }"
            :aria-pressed="kind === entry.value"
            @click="kind = entry.value"
          >
            {{ entry.label }}
          </button>
        </div>

        <div class="mods-search-row">
          <input
            v-model="keyword"
            class="input"
            :placeholder="copy.text('keywordPlaceholder', { kind: kindLabel })"
            type="search"
            aria-label="搜索资源"
            @keyup.enter="doSearch"
          />
          <button class="btn btn-gold" :disabled="searching" @click="doSearch">
            <span v-if="searching" class="spin" aria-hidden="true"></span>
            <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            {{ copy.text('search') }}
          </button>
          <button class="btn btn-ghost" :disabled="searching" @click="resetFilters">{{ copy.text('reset') }}</button>
        </div>

        <div class="mods-filter-row">
          <div class="mods-capsules" role="group" :aria-label="copy.text('loader')">
            <button
              v-for="entry in PROVIDER_TABS"
              :key="entry.value"
              class="capsule"
              :class="{ active: provider === entry.value }"
              :aria-pressed="provider === entry.value"
              @click="provider = entry.value"
            >
              {{ entry.label }}
            </button>
          </div>
          <CommunityVersionFilter v-model="gameVersion" :versions="versionChoices" />
          <select v-if="usesLoader(kind)" v-model="loader" class="select mods-filter-select" :aria-label="copy.text('loader')">
            <option v-for="entry in LOADER_TABS" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
          </select>
          <select v-model="sort" class="select mods-filter-select" :aria-label="copy.text('sort')">
            <option v-for="entry in SORT_TABS" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
          </select>
          <button class="btn btn-ghost btn-sm" @click="useInstanceFilters">{{ copy.text('useInstanceFilters') }}</button>
        </div>

        <label class="mods-deps">
          <input v-model="withDependencies" type="checkbox" />
          <span>
            <strong>{{ copy.text('deps') }}</strong>
            <small class="muted">{{ copy.text('depsHint') }}</small>
          </span>
        </label>
      </section>

      <ModsCurseKey v-if="showKeyCard" :current="apiKeyValue" :saving="keySaving" :error="keyError" @save="onSaveKey" @open-settings="navigate('settings')" />

      <section v-else class="card mods-results">
        <p v-if="searching && results.length" class="status-strip" role="status">{{ copy.text('staleResults') }}</p>

        <ModsSkeleton
          v-if="searching && !results.length"
          variant="cards"
          :rows="6"
          :label="copy.text('searching')"
          retry
          @retry="doSearch"
        />

        <div v-else-if="searchError && !results.length" class="empty">
          <span>{{ copy.text('searchFailed', { error: searchError }) }}</span>
          <button class="btn btn-ghost btn-sm" @click="doSearch">{{ copy.text('retry') }}</button>
        </div>

        <div v-else-if="!results.length" class="empty">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3a13.5 13.5 0 0 1 0 18" />
            <path d="M12 3a13.5 13.5 0 0 0 0 18" />
          </svg>
          <span>{{ searched ? copy.text('emptySearch') : copy.text('emptyIdle') }}</span>
        </div>

        <template v-else>
          <div class="mods-result-list" :inert="searching" :aria-busy="searching">
            <article v-for="project in results" :key="projectKey(project)" class="mods-result">
              <div class="mods-result-top">
                <span class="mods-result-icon">
                  <img v-if="iconOf(project)" :src="iconOf(project)" alt="" loading="lazy" @error="onIconError(project)" />
                  <span v-else class="mods-result-letter">{{ (project.title || '?').charAt(0).toUpperCase() }}</span>
                </span>
                <div class="mods-result-head">
                  <strong :title="project.title">{{ project.title }}</strong>
                  <span class="tag" :class="project.provider === 'modrinth' ? 'tag-success' : 'tag-cyan'">
                    {{ sourceLabel(project.provider) || project.provider }}
                  </span>
                  <span v-if="project.authors.length" class="muted mods-result-author">{{ project.authors.join(' · ') }}</span>
                </div>
              </div>

              <p class="mods-result-desc" :title="project.description">{{ project.description || copy.text('emptyIdle') }}</p>

              <div class="mods-result-meta muted">
                <span>{{ copy.text('downloads', { n: formatDownloads(project.downloads) }) }}</span>
                <span class="sep">·</span>
                <span>{{ copy.text('updated', { date: formatDate(project.dateModified) }) }}</span>
                <span class="sep">·</span>
                <span>{{ KIND_LABELS[project.kind] }}</span>
              </div>

              <div class="mods-result-tags">
                <span v-for="entry in project.loaders.slice(0, 3)" :key="entry" class="tag tag-accent">{{ entry }}</span>
                <span v-if="project.loaders.length > 3" class="tag">{{ copy.text('more', { n: project.loaders.length - 3 }) }}</span>
                <span v-for="entry in shownVersions(project)" :key="entry" class="tag">{{ entry }}</span>
                <span v-if="project.gameVersions.length > 3" class="tag">
                  {{ copy.text('more', { n: project.gameVersions.length - 3 }) }}
                </span>
              </div>

              <footer class="mods-result-foot">
                <button
                  class="icon-btn"
                  :title="copy.text('sourcePage', { site: providerName })"
                  :disabled="!projectSourceUrl(project, kind)"
                  @click="openExternal(projectSourceUrl(project, kind))"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                  </svg>
                </button>
                <button class="btn btn-gold btn-sm" @click="openSheet(project)">{{ copy.text('install') }}</button>
              </footer>
            </article>
          </div>

          <nav v-if="totalPages > 1" class="mods-pagination" aria-label="资源分页">
            <span class="muted">{{ copy.text('page', { total, page: currentPage, pages: totalPages }) }}</span>
            <button class="btn btn-ghost btn-sm" :disabled="searching || currentPage <= 1" @click="goPage(currentPage - 1)">
              {{ copy.text('prev') }}
            </button>
            <button
              v-for="page in pageWindow"
              :key="page"
              class="btn btn-sm"
              :class="page === currentPage ? 'btn-gold' : 'btn-ghost'"
              :aria-current="page === currentPage ? 'page' : undefined"
              :disabled="searching"
              @click="goPage(page)"
            >
              {{ page }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="searching || currentPage >= totalPages" @click="goPage(currentPage + 1)">
              {{ copy.text('next') }}
            </button>
          </nav>
        </template>
      </section>
    </template>

    <ModVersionModal
      v-if="sheet"
      :project="sheet"
      :kind="kind"
      :instances="instances"
      :current-instance-id="instanceId"
      :game-version="gameVersion"
      :loader="loader"
      :version-choices="versionChoices"
      @close="sheet = null"
      @install="onSheetInstall"
    />

    <Teleport to="body">
      <div v-if="pendingRemove" class="modal-mask" @pointerdown.self="!removing && (pendingRemove = null)">
        <section class="modal" role="dialog" aria-modal="true" aria-label="删除模组文件">
          <h3 class="modal-title">{{ copy.text('removeTitle') }}</h3>
          <p class="mods-confirm">
            {{
              copy.text('removeBody', {
                instance: instanceText,
                name: pendingRemove.name || pendingRemove.fileName,
                size: formatSize(pendingRemove.size)
              })
            }}
          </p>
          <p class="muted mods-confirm-file mono">{{ pendingRemove.fileName }}</p>
          <footer class="modal-actions">
            <button class="btn btn-ghost" :disabled="removing" @click="pendingRemove = null">{{ copy.text('cancel') }}</button>
            <button class="btn btn-danger" :disabled="removing" @click="confirmRemove">
              {{ removing ? copy.text('removeConfirm') + '…' : copy.text('removeConfirm') }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.mods-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  height: 100%;
  min-width: 0;
  overflow: auto;
}
.page-head {
  flex-direction: row;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.page-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.page-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

/* ---------------- 模式切换（upstream `.community-sections`） ---------------- */
.mods-modes {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.mods-mode {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--ctl-h);
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--motion-normal) ease, color var(--motion-normal) ease;
}
.mods-mode:hover {
  color: var(--text);
}
.mods-mode.active {
  background: var(--accent-soft);
  color: var(--accent-2);
  font-weight: 600;
}
.mods-mode span {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--card);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.mods-instance {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.mods-instance > span {
  flex: none;
  white-space: nowrap;
}
.mods-instance .select {
  min-width: 240px;
  max-width: 380px;
  text-overflow: ellipsis;
}

/* ---------------- 搜索卡片（upstream `.search-card`） ---------------- */
.mods-search-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}
.mods-capsules {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.capsule {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--ctl-h);
  padding: 0 var(--space-4);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  color: var(--text-dim);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
}
.capsule:hover {
  color: var(--text);
}
.capsule.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}
.mods-search-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.mods-search-row .input {
  flex: 1;
  min-width: 220px;
}
.mods-filter-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.mods-filter-select {
  width: auto;
  min-width: 140px;
}
.mods-filter-row :deep(.community-version-filter) {
  flex: 0 1 200px;
  min-width: 160px;
}
.mods-deps {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  font-size: var(--text-sm);
  cursor: pointer;
}
.mods-deps input {
  margin-top: 3px;
  flex: none;
  accent-color: var(--accent);
}
.mods-deps small {
  display: block;
  margin-top: 4px;
  font-size: var(--text-xs);
  line-height: 1.6;
}

/* ---------------- 结果卡片（upstream `.result-list` / `.result-card`） ---------------- */
.mods-results {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  min-width: 0;
}
.mods-result-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: var(--card-gap);
}
.mods-result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-content);
  transition: border-color var(--motion-fast) ease, box-shadow var(--motion-normal) ease;
  animation: mods-card-in var(--motion-enter) var(--ease-out) backwards;
}
@keyframes mods-card-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.mods-result:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  box-shadow: var(--shadow);
}
.mods-result-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.mods-result-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  flex: none;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.mods-result-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.mods-result-letter {
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--text-dim);
}
.mods-result-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
  min-width: 0;
}
.mods-result-head strong {
  flex: 1 1 100%;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--text-lg);
  line-height: 1.45;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.mods-result-head .tag {
  font-size: 11px;
}
.mods-result-author {
  font-size: var(--text-xs);
  min-width: 0;
}
.mods-result-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 3.2em;
  color: var(--text-dim);
  font-size: var(--text-xs);
  line-height: 1.6;
}
.mods-result-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  margin-top: auto;
  font-size: var(--text-xs);
}
.mods-result-meta .sep {
  opacity: 0.6;
}
.mods-result-tags {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}
.mods-result-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}
.mods-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding-top: var(--space-2);
  font-size: var(--text-xs);
}
.mods-confirm {
  line-height: 1.7;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.mods-confirm-file {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  .mods-page {
    padding: var(--space-4);
  }
  .mods-instance .select {
    min-width: 0;
    width: 100%;
  }
}
</style>

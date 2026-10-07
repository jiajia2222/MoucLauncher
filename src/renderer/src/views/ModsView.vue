<script setup lang="ts">
/**
 * ModsView — 「已安装」 and 「浏览」.
 *
 * All data comes from `window.mouc.mod.*`; the view owns only presentation state (which
 * tab, which row is busy, the modal-local install options). Job progress is folded into the
 * store from `mouc:progress` so a download keeps reporting after the tab changes.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { InstalledMod, LoaderId, ModFile, ProjectKind, ProjectVersion } from '@shared/types'
import { defineDict, t } from '../i18n'
import { useMods } from '../stores/useMods'
import { useModal } from '../composables/useModal'
import { navigate } from '../composables/useNav'
import { formatBytes, formatCount, formatRelative } from '../composables/format'
import MIcon from '../components/icons/MIcon.vue'
import MButton from '../components/ui/MButton.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MCard from '../components/ui/MCard.vue'
import MCheckbox from '../components/ui/MCheckbox.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MModal from '../components/ui/MModal.vue'
import MProgress from '../components/ui/MProgress.vue'
import MSegmented from '../components/ui/MSegmented.vue'
import MSearch from '../components/ui/MSearch.vue'
import MSelect from '../components/ui/MSelect.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MSwitch from '../components/ui/MSwitch.vue'
import MTag from '../components/ui/MTag.vue'
import MTooltip from '../components/ui/MTooltip.vue'
import type { SelectOption } from '../components/ui/types'

const copy = defineDict({
  subtitle: ['管理当前实例的模组与光影，或从 Modrinth / CurseForge 安装。', 'Manage the active instance, or browse Modrinth / CurseForge.'],
  tabInstalled: ['已安装', 'Installed'],
  tabBrowse: ['浏览', 'Browse'],
  pickInstance: ['选择实例', 'Pick an instance'],
  jobs: ['下载任务', 'Downloads'],
  fromDisk: ['从磁盘安装', 'Install from file'],
  updatesFound: ['{n} 个可更新', '{n} updatable'],
  updateAllCount: ['全部更新（{n}）', 'Update all ({n})'],
  versionCount: ['{n} 个文件', '{n} files'],
  summary: ['{n} 个文件 · 共 {size}', '{n} files · {size} total'],
  emptyTitle: ['这个实例还没有模组', 'No content in this instance'],
  emptyHint: ['从磁盘选择 .jar / .zip，或到「浏览」里搜索 Modrinth。', 'Pick a local .jar / .zip, or search Modrinth in the Browse tab.'],
  browseTitle: ['浏览内容仓库', 'Browse the repositories'],
  browseHint: ['设置筛选条件后自动搜索；结果为空时试试放宽游戏版本或加载器。', 'Search runs as you filter. Widen the game version or loader if nothing matches.'],
  curseTitle: ['CurseForge 需要 API Key', 'CurseForge needs an API key'],
  curseBody: [
    '设置里的 curseForgeApiKey 为空，CurseForge 接口会直接返回 unsupported（HTTP 403）。填入 Key 之前不会发起请求。',
    'settings.curseForgeApiKey is empty, so CurseForge answers unsupported (HTTP 403). No request is sent until a key is set.'
  ],
  curseTry: ['仍然尝试请求', 'Try the request anyway'],
  goSettings: ['打开设置', 'Open settings'],
  allVersions: ['全部游戏版本', 'Any game version'],
  allLoaders: ['全部加载器', 'Any loader'],
  filesLabel: ['文件', 'Files'],
  requiredDeps: ['必需依赖', 'Required dependencies'],
  withDeps: ['同时安装必需依赖', 'Install required dependencies too'],
  versionsOf: ['{name} 的版本', '{name} versions'],
  versionHint: ['选择与当前实例的游戏版本、加载器匹配的文件。', 'Pick a file matching the instance game version and loader.'],
  noVersions: ['没有拿到该项目的版本列表', 'No published versions were returned'],
  installKind: ['安装类型', 'Install as'],
  primaryFile: ['主文件', 'Primary file'],
  pager: ['第 {page} / {pages} 页', 'Page {page} of {pages}'],
  moreVersions: ['+{n}', '+{n}'],
  newerThan: ['最新 {version}', 'newest {version}'],
  noInstanceTitle: ['还没有实例', 'No instances yet'],
  noInstanceHint: ['模组安装在实例里，先创建一个实例。', 'Content is installed per instance — create an instance first.'],
  sortRelevance: ['按相关度', 'By relevance'],
  sortDownloads: ['按下载量', 'By downloads'],
  sortNewest: ['按最新发布', 'By newest'],
  sortUpdated: ['按更新时间', 'By updated'],
  localSource: ['本地文件', 'Local file']
})

const store = reactive(useMods())
const modal = useModal()

type Mode = 'installed' | 'browse'
const mode = ref<Mode>('installed')
const busyFile = ref('')
const withDependencies = ref(true)
const installKind = ref<ProjectKind>('mod')
const curseForced = ref(false)

const PAGE = 12

/* ------------------------------------------------------------------ options */
const modeOptions = computed(() => [
  { value: 'installed', label: copy.text('tabInstalled'), icon: 'package' as const },
  { value: 'browse', label: copy.text('tabBrowse'), icon: 'search' as const }
])

const providerOptions = computed(() => [
  { value: 'modrinth', label: 'Modrinth', icon: 'mod' as const },
  { value: 'curseforge', label: 'CurseForge', icon: 'pack' as const }
])

const kindOptions = computed<SelectOption[]>(() =>
  store.modableKinds.map((entry) => ({ value: entry, label: t(`mod.kind.${entry}`) }))
)

const versionOptions = computed<SelectOption[]>(() => [
  { value: '', label: copy.text('allVersions') },
  ...store.gameVersionOptions.map((entry) => ({ value: entry, label: entry }))
])

const loaderOptions = computed<SelectOption[]>(() => [
  { value: '', label: copy.text('allLoaders') },
  ...store.loaderOptions.map((entry) => ({ value: entry, label: entry }))
])

const sortOptions = computed<SelectOption[]>(() => [
  { value: 'relevance', label: copy.text('sortRelevance') },
  { value: 'downloads', label: copy.text('sortDownloads') },
  { value: 'newest', label: copy.text('sortNewest') },
  { value: 'updated', label: copy.text('sortUpdated') }
])

const diskKindOptions = kindOptions

/* ----------------------------------------------------------------- computed */
const jobs = computed(() => store.jobs.filter((entry) => entry.status !== 'cancelled'))
const summaryText = computed(() => copy.text('summary', { n: store.mods.length, size: formatBytes(store.modTotalBytes) }))
const curseBlocked = computed(() => store.provider === 'curseforge' && !store.curseForgeReady && !curseForced.value)
const totalPages = computed(() => Math.max(1, Math.ceil(store.total / PAGE)))
const currentPage = computed(() => Math.floor(store.offset / PAGE) + 1)
const showPager = computed(() => store.total > PAGE)

function nameOf(mod: InstalledMod): string {
  return mod.name ?? mod.modId ?? mod.fileName
}

function kindIcon(kind: ProjectKind): 'mod' | 'image' | 'shader' | 'pack' | 'world' {
  if (kind === 'resourcepack') return 'image'
  if (kind === 'shader') return 'shader'
  if (kind === 'modpack') return 'pack'
  if (kind === 'world') return 'world'
  return 'mod'
}

function providerLabel(value?: string): string {
  if (value === 'curseforge') return 'CurseForge'
  if (value === 'modrinth') return 'Modrinth'
  if (value === 'local') return copy.text('localSource')
  return ''
}

function dependenciesOf(version: ProjectVersion): string[] {
  return version.dependencies.filter((entry) => entry.kind === 'required').map((entry) => entry.projectId)
}

function updateHint(mod: InstalledMod): string {
  return mod.updateAvailable ? copy.text('newerThan', { version: mod.updateAvailable.versionNumber }) : ''
}

/* ------------------------------------------------------------------ actions */
async function onToggle(mod: InstalledMod, disabled: boolean): Promise<void> {
  busyFile.value = mod.fileName
  await store.toggleMod(mod, disabled)
  busyFile.value = ''
}

async function onRemove(mod: InstalledMod): Promise<void> {
  const confirmed = await modal.confirm({
    titleKey: 'mod.remove',
    text: nameOf(mod),
    confirmKey: 'common.delete',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  busyFile.value = mod.fileName
  await store.removeMod(mod)
  busyFile.value = ''
}

async function onUpdateAll(): Promise<void> {
  await store.updateAll(withDependencies.value)
}

async function onInstallFile(file: ModFile): Promise<void> {
  const okInstall = await store.installVersion(file, withDependencies.value, installKind.value)
  if (okInstall) store.closeVersions()
}

function forceCurseSearch(): void {
  curseForced.value = true
  void store.search(0)
}

function movePage(delta: number): void {
  const next = Math.min(Math.max(0, store.offset + delta * PAGE), (totalPages.value - 1) * PAGE)
  void store.search(next)
}

/* -------------------------------------------------------------------- setup */
watch(
  () => store.instanceId,
  () => {
    void store.loadMods()
  }
)

watch(
  () => store.provider,
  () => {
    curseForced.value = false
    if (mode.value === 'browse') void store.search(0)
  }
)

watch(mode, (next) => {
  if (next === 'browse' && !store.hasSearched) void store.search(0)
})

watch(
  () => [store.kind, store.versionFilter, store.loaderFilter, store.sort],
  () => {
    if (mode.value === 'browse') void store.search(0)
  }
)

onMounted(async () => {
  if (store.instances.length === 0) await store.loadInstances()
  if (!store.settings) await store.loadSettings()
  if (!store.instanceId) {
    store.versionFilter = store.currentInstance?.instance.gameVersion ?? ''
    store.loaderFilter = (store.currentInstance?.instance.loader ?? '') as LoaderId
  }
  if (store.mods.length === 0 && store.modsError === null) await store.loadMods()
  installKind.value = store.kind
})

watch(
  () => store.kind,
  (next) => {
    installKind.value = next
  }
)
</script>

<template>
  <div class="page">
    <!-- ============================================================ header -->
    <header class="head">
      <div class="head-text">
        <h1 class="title">{{ t('nav.mods') }}</h1>
        <p class="sub">{{ copy.text('subtitle') }}</p>
      </div>
      <div class="head-tools">
        <MSelect
          v-model="store.instanceId"
          :options="store.instanceOptions"
          :icon="'cube'"
          :placeholder="copy.text('pickInstance')"
          searchable
          class="pick"
        />
        <MSegmented v-model="mode" :options="modeOptions" :equal="false" />
      </div>
    </header>

    <MCard v-if="store.instances.length === 0 && !store.instancesLoading" icon="cube" :title="copy.text('noInstanceTitle')">
      <p class="notice-body">{{ copy.text('noInstanceHint') }}</p>
      <div class="u-row">
        <MButton variant="outline" icon="refresh" :loading="store.instancesLoading" @click="store.loadInstances()">
          {{ t('common.refresh') }}
        </MButton>
      </div>
    </MCard>

    <!-- ========================================================= live jobs -->
    <MCard v-if="jobs.length" icon="download" :title="copy.text('jobs')" dense padded>
      <ul class="jobs">
        <li v-for="job in jobs" :key="job.id" class="job">
          <MProgress
            :percent="job.percent"
            :status="job.status === 'error' ? 'error' : job.status === 'done' ? 'success' : 'active'"
            :label="job.title"
            :bytes-done="job.bytesDone"
            :bytes-total="job.bytesTotal"
            :speed="job.speedBps"
            :eta-seconds="job.etaSeconds"
            show-bytes
            show-meta
            size="sm"
          />
          <MTag
            size="sm"
            :tone="job.status === 'error' ? 'danger' : job.status === 'done' ? 'success' : 'accent'"
            :dot="job.status === 'running'"
          >
            {{ job.status === 'error' ? t('status.jobFailed') : job.status === 'done' ? t('status.jobDone') : t('status.jobRunning') }}
          </MTag>
        </li>
      </ul>
    </MCard>

    <!-- ======================================================== installed -->
    <MCard
      v-if="mode === 'installed'"
      icon="package"
      :title="t('mod.installed')"
      :subtitle="summaryText"
      padded
      class="grow-card"
    >
      <template #actions>
        <div class="row-tools">
          <MSelect v-model="store.diskKind" :options="diskKindOptions" :icon="'download'" size="sm" block class="disk-kind" />
          <MButton size="sm" variant="outline" icon="folder" @click="store.installFromDisk()">
            {{ copy.text('fromDisk') }}
          </MButton>
          <MButton size="sm" variant="ghost" icon="refresh" :loading="store.checkingUpdates" @click="store.checkUpdates()">
            {{ t('mod.checkUpdates') }}
          </MButton>
          <MButton
            size="sm"
            variant="primary"
            icon="update"
            :loading="store.updating"
            :disabled="store.updatable.length === 0"
            @click="onUpdateAll"
          >
            {{ store.updatable.length ? copy.text('updateAllCount', { n: store.updatable.length }) : t('mod.updateAll') }}
          </MButton>
        </div>
      </template>

      <p v-if="store.updatable.length" class="hint warning">
        <MIcon name="update" :size="16" tone="warning" />
        {{ copy.text('updatesFound', { n: store.updatable.length }) }}
      </p>

      <ul v-if="store.modsLoading && store.mods.length === 0" class="mod-list" aria-busy="true">
        <li v-for="n in 5" :key="n" class="skeleton-row">
          <MSkeleton variant="rect" width="32px" height="32px" rounded="var(--m-r-sm)" />
          <div class="skeleton-lines">
            <MSkeleton variant="line" width="46%" height="14px" />
            <MSkeleton variant="line" width="72%" height="12px" />
          </div>
        </li>
      </ul>

      <div v-else-if="store.modsError" class="state-error" role="alert">
        <MIcon name="warning" :size="20" tone="danger" />
        <div class="u-grow">
          <p class="state-title">{{ store.modsError.message }}</p>
          <p v-if="store.modsError.detail" class="state-detail u-mono u-truncate">{{ store.modsError.detail }}</p>
        </div>
        <MButton size="sm" variant="outline" icon="refresh" @click="store.loadMods()">{{ t('common.retry') }}</MButton>
      </div>

      <MEmpty
        v-else-if="store.mods.length === 0"
        icon="mod"
        :title="copy.text('emptyTitle')"
        :description="copy.text('emptyHint')"
      >
        <div class="u-row u-wrap">
          <MButton variant="primary" icon="search" @click="mode = 'browse'">{{ t('mod.search') }}</MButton>
          <MButton variant="outline" icon="folder" @click="store.installFromDisk()">{{ copy.text('fromDisk') }}</MButton>
        </div>
      </MEmpty>

      <ul v-else class="mod-list">
        <li v-for="mod in store.mods" :key="mod.fileName" class="mod-row" :class="{ 'is-off': mod.disabled }">
          <span class="glyph"><MIcon :name="mod.provider === 'local' ? 'folder' : 'mod'" :size="20" tone="muted" /></span>

          <div class="mod-main">
            <div class="mod-line">
              <span class="mod-name u-truncate">{{ nameOf(mod) }}</span>
              <MTag v-if="mod.updateAvailable" size="sm" tone="warning" icon="update">{{ t('mod.update') }}</MTag>
              <MTag v-if="mod.loader" size="sm">{{ mod.loader }}</MTag>
              <MTag v-if="providerLabel(mod.provider)" size="sm" tone="neutral">{{ providerLabel(mod.provider) }}</MTag>
              <MTag v-if="mod.disabled" size="sm">{{ t('common.disabled') }}</MTag>
            </div>
            <div class="mod-meta u-num">
              <span>{{ mod.version ?? t('common.unknown') }}</span>
              <span class="sep">·</span>
              <span class="u-truncate mod-id">{{ mod.modId ?? mod.fileName }}</span>
              <span class="sep">·</span>
              <span>{{ formatBytes(mod.size) }}</span>
              <span class="sep">·</span>
              <span>{{ formatRelative(mod.updatedAt) }}</span>
              <span v-if="mod.updateAvailable" class="sep">·</span>
              <span v-if="mod.updateAvailable" class="upd">{{ updateHint(mod) }}</span>
            </div>
          </div>

          <div class="mod-tools">
            <MTooltip :content="mod.disabled ? t('mod.enable') : t('mod.disable')" placement="left">
              <MSwitch
                :model-value="!mod.disabled"
                :disabled="busyFile === mod.fileName"
                size="sm"
                @update:model-value="onToggle(mod, $event)"
              />
            </MTooltip>
            <MTooltip :content="t('mod.remove')" placement="left">
              <MIconButton
                icon="trash"
                tone="danger"
                size="sm"
                :label="t('mod.remove')"
                :disabled="busyFile === mod.fileName"
                @click="onRemove(mod)"
              />
            </MTooltip>
          </div>
        </li>
      </ul>
    </MCard>

    <!-- =========================================================== browse -->
    <template v-else>
      <MCard icon="search" :title="t('mod.search')" :subtitle="copy.text('browseHint')">
        <div class="filters">
          <MSearch
            v-model="store.keyword"
            class="grow-search"
            :placeholder="t('mod.search')"
            hotkey="Ctrl+F"
            :loading="store.searching"
            @search="store.search(0)"
          />
          <MSegmented v-model="store.provider" :options="providerOptions" :equal="false" />
        </div>
        <div class="filters filters-2">
          <MSelect v-model="store.kind" :options="kindOptions" :icon="'filter'" size="sm" class="f-item" />
          <MSelect v-model="store.versionFilter" :options="versionOptions" :icon="'layers'" size="sm" searchable class="f-item" />
          <MSelect v-model="store.loaderFilter" :options="loaderOptions" :icon="'beaker'" size="sm" class="f-item" />
          <MSelect v-model="store.sort" :options="sortOptions" size="sm" class="f-item" />
          <MButton size="sm" variant="ghost" icon="search" :loading="store.searching" @click="store.search(0)">
            {{ t('common.apply') }}
          </MButton>
        </div>
      </MCard>

      <MCard v-if="curseBlocked" tone="flat" icon="key" :title="copy.text('curseTitle')" class="notice">
        <p class="notice-body">{{ copy.text('curseBody') }}</p>
        <div class="u-row u-wrap">
          <MButton size="sm" variant="primary" icon="gear" @click="navigate('settings')">{{ copy.text('goSettings') }}</MButton>
          <MButton size="sm" variant="ghost" icon="external" @click="forceCurseSearch">{{ copy.text('curseTry') }}</MButton>
        </div>
      </MCard>

      <MCard v-else icon="pack" :title="copy.text('browseTitle')" :subtitle="t('common.total', { n: store.total })" padded class="grow-card">
        <ul v-if="store.searching && store.results.length === 0" class="grid" aria-busy="true">
          <li v-for="n in 6" :key="n" class="sk-card">
            <MSkeleton variant="rect" width="44px" height="44px" rounded="var(--m-r-sm)" />
            <div class="skeleton-lines">
              <MSkeleton variant="line" width="58%" height="14px" />
              <MSkeleton variant="line" :lines="2" height="12px" />
            </div>
          </li>
        </ul>

        <div v-else-if="store.searchError" class="state-error" role="alert">
          <MIcon name="warning" :size="20" tone="danger" />
          <div class="u-grow">
            <p class="state-title">{{ store.searchError.message }}</p>
            <p v-if="store.searchError.detail" class="state-detail u-mono u-truncate">{{ store.searchError.detail }}</p>
          </div>
          <MButton size="sm" variant="outline" icon="refresh" @click="store.search(store.offset)">{{ t('common.retry') }}</MButton>
        </div>

        <MEmpty v-else-if="store.results.length === 0" icon="search" :title="t('mod.noResult')" :description="copy.text('browseHint')" />

        <ul v-else class="grid">
          <li v-for="project in store.results" :key="`${project.provider}-${project.id}`" class="card">
            <div class="card-head">
              <span class="card-glyph">
                <img v-if="project.iconUrl" :src="project.iconUrl" :alt="project.title" />
                <MIcon v-else :name="kindIcon(project.kind)" :size="20" tone="muted" />
              </span>
              <div class="u-grow">
                <p class="card-title u-truncate">{{ project.title }}</p>
                <p class="card-authors u-truncate">{{ project.authors.join(' · ') }}</p>
              </div>
              <MTag size="sm" :tone="project.provider === 'curseforge' ? 'neutral' : 'accent'">
                {{ providerLabel(project.provider) }}
              </MTag>
            </div>

            <p class="card-desc u-clamp-2">{{ project.description }}</p>

            <div class="card-meta">
              <span class="u-num"><MIcon name="download" :size="16" tone="muted" />{{ t('mod.downloads', { n: formatCount(project.downloads) }) }}</span>
              <MTag size="sm">{{ t(`mod.kind.${project.kind}` as 'mod.kind.mod') }}</MTag>
              <MTag v-for="entry in project.loaders.slice(0, 2)" :key="entry" size="sm">{{ entry }}</MTag>
              <MTag v-if="project.loaders.length > 2" size="sm">{{ copy.text('moreVersions', { n: project.loaders.length - 2 }) }}</MTag>
            </div>

            <div class="card-versions">
              <span class="u-num muted">{{ project.gameVersions.slice(0, 3).join(', ') }}</span>
              <MTag v-if="project.gameVersions.length > 3" size="sm">
                {{ copy.text('moreVersions', { n: project.gameVersions.length - 3 }) }}
              </MTag>
            </div>

            <div class="card-foot">
              <span class="u-num muted">{{ formatRelative(Date.parse(project.dateModified)) }}</span>
              <MButton size="sm" variant="primary" icon="download" @click="store.openVersions(project)">
                {{ t('mod.install') }}
              </MButton>
            </div>
          </li>
        </ul>

        <div v-if="showPager" class="pager">
          <MButton size="sm" variant="ghost" icon="chevron-left" :disabled="store.offset === 0" @click="movePage(-1)">
            {{ t('common.back') }}
          </MButton>
          <span class="u-num muted">{{ copy.text('pager', { page: currentPage, pages: totalPages }) }}</span>
          <MButton size="sm" variant="ghost" trailing-icon="chevron-right" :disabled="currentPage >= totalPages" @click="movePage(1)">
            {{ t('common.next') }}
          </MButton>
        </div>
      </MCard>
    </template>

    <!-- ==================================================== version modal -->
    <MModal
      :open="store.versionProject !== null"
      :title="store.versionProject ? copy.text('versionsOf', { name: store.versionProject.title }) : ''"
      :description="copy.text('versionHint')"
      :width="620"
      @close="store.closeVersions()"
    >
      <div class="modal-tools">
        <MCheckbox v-model="withDependencies" :label="copy.text('withDeps')" />
        <MSelect v-model="installKind" :options="kindOptions" :icon="'filter'" size="sm" class="kind-select" />
      </div>

      <ul v-if="store.versionsLoading" class="ver-list" aria-busy="true">
        <li v-for="n in 3" :key="n">
          <MSkeleton variant="line" :lines="2" height="12px" />
        </li>
      </ul>

      <div v-else-if="store.versionsError" class="state-error" role="alert">
        <MIcon name="warning" :size="20" tone="danger" />
        <div class="u-grow">
          <p class="state-title">{{ store.versionsError.message }}</p>
          <p v-if="store.versionsError.detail" class="state-detail u-mono u-truncate">{{ store.versionsError.detail }}</p>
        </div>
        <MButton size="sm" variant="outline" icon="refresh" @click="store.openVersions(store.versionProject!)">
          {{ t('common.retry') }}
        </MButton>
      </div>

      <MEmpty v-else-if="store.versions.length === 0" icon="box" :title="copy.text('noVersions')" compact />

      <ul v-else class="ver-list">
        <li v-for="version in store.versions" :key="version.id" class="ver">
          <div class="u-grow">
            <p class="ver-name u-truncate">{{ version.name }}</p>
            <p class="ver-meta u-num">
              {{ version.versionNumber }} · {{ formatRelative(Date.parse(version.datePublished)) }} ·
              {{ copy.text('versionCount', { n: version.files.length }) }}
            </p>
            <div class="card-meta">
              <MTag v-for="entry in version.loaders" :key="entry" size="sm">{{ entry }}</MTag>
              <MTag v-for="entry in version.gameVersions.slice(0, 3)" :key="entry" size="sm" tone="neutral">{{ entry }}</MTag>
            </div>
            <p v-if="version.changelog" class="ver-note u-clamp-2">{{ version.changelog }}</p>
            <p v-if="dependenciesOf(version).length" class="ver-deps">
              {{ copy.text('requiredDeps') }}: <span class="u-mono">{{ dependenciesOf(version).join(', ') }}</span>
            </p>
          </div>
          <div class="ver-action">
            <MButton
              v-for="file in version.files.slice(0, 1)"
              :key="file.fileName"
              size="sm"
              variant="primary"
              icon="download"
              @click="onInstallFile(file)"
            >
              {{ t('mod.install') }}
            </MButton>
            <span class="u-num muted">{{ formatBytes(version.files[0]?.size ?? 0) }}</span>
          </div>
        </li>
      </ul>

      <template #footer>
        <MButton variant="ghost" @click="store.closeVersions()">{{ t('common.close') }}</MButton>
      </template>
    </MModal>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-4);
  min-height: 100%;
  padding: var(--m-sp-5) var(--m-sp-6) var(--m-sp-7);
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--m-sp-4);
  flex-wrap: wrap;
}

.title {
  font-size: var(--m-fs-20);
  line-height: var(--m-lh-tight);
}

.sub {
  max-width: 62ch;
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.head-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.pick {
  width: 240px;
}

.grow-card {
  flex: 1 1 auto;
}

.row-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
}

.disk-kind {
  width: 132px;
}

.count {
  margin-left: var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-accent-text);
}

.hint {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  margin-bottom: var(--m-sp-3);
  padding: var(--m-sp-2) var(--m-sp-3);
  border: var(--m-line) solid var(--m-warning);
  border-radius: var(--m-r-sm);
  background: var(--m-warning-soft);
  font-size: var(--m-fs-12);
  color: var(--m-text-primary);
}

.hint.warning {
  color: var(--m-text-primary);
}

/* --------------------------------------------------------------- mod list */
.mod-list {
  display: flex;
  flex-direction: column;
}

.mod-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3) var(--m-sp-2);
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.mod-row:last-child {
  border-bottom: 0;
}

.mod-row.is-off .mod-name,
.mod-row.is-off .glyph {
  color: var(--m-text-muted);
  opacity: 0.72;
}

.glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
  color: var(--m-text-muted);
}

.mod-main {
  flex: 1 1 auto;
  min-width: 0;
}

.mod-line {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
}

.mod-name {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.mod-meta {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
  min-width: 0;
}

.mod-id {
  max-width: 220px;
  font-family: var(--m-font-mono);
}

.sep {
  color: var(--m-border-strong);
}

.upd {
  color: var(--m-warning);
}

.mod-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  flex: none;
}

.skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3) var(--m-sp-2);
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.skeleton-lines {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  flex: 1 1 auto;
}

/* ---------------------------------------------------------------- states */
.state-error {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-danger);
  border-radius: var(--m-r-sm);
  background: var(--m-danger-soft);
}

.state-title {
  font-size: var(--m-fs-13);
  font-weight: 600;
}

.state-detail {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.notice {
  border-color: var(--m-warning);
}

.notice-body {
  margin-bottom: var(--m-sp-3);
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

/* ----------------------------------------------------------------- browse */
.filters {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
}

.filters-2 {
  margin-top: var(--m-sp-3);
}

.grow-search {
  flex: 1 1 260px;
}

.f-item {
  width: 168px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(288px, 1fr));
  gap: var(--m-sp-3);
}

.sk-card {
  display: flex;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-sm);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-raised);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.card-glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  overflow: hidden;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
}

.card-glyph img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card-title {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.card-authors {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.card-desc {
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
  min-height: calc(var(--m-fs-13) * var(--m-lh-ui) * 2);
}

.card-meta,
.card-versions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.card-meta > span {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-1);
}

.card-foot,
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--m-sp-2);
  margin-top: var(--m-sp-1);
  padding-top: var(--m-sp-2);
  border-top: var(--m-line) solid var(--m-border-hairline);
  font-size: var(--m-fs-12);
}

.pager {
  margin-top: var(--m-sp-4);
}

.muted {
  color: var(--m-text-muted);
}

/* ------------------------------------------------------------------ jobs */
.jobs {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
}

.job {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
}

.job :deep(.m-progress) {
  flex: 1 1 auto;
}

/* ----------------------------------------------------------------- modal */
.modal-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--m-sp-3);
  margin-bottom: var(--m-sp-3);
  flex-wrap: wrap;
}

.kind-select {
  width: 160px;
}

.ver-list {
  display: flex;
  flex-direction: column;
}

.ver {
  display: flex;
  align-items: flex-start;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3) 0;
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.ver:last-child {
  border-bottom: 0;
}

.ver-name {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.ver-meta,
.ver-note,
.ver-deps {
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.ver-meta {
  font-family: var(--m-font-mono);
}

.ver-action {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--m-sp-1);
  flex: none;
  font-size: var(--m-fs-12);
}
</style>

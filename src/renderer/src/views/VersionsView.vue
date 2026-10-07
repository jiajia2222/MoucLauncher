<script setup lang="ts">
/**
 * VersionsView — the Mojang manifest, what is on disk, and the jobs that move between
 * the two. The download-source banner is generated from `settings.mirrors`, never hardcoded,
 * so a user with no mirror enabled sees the official endpoints.
 */
import { computed, onMounted, ref } from 'vue'
import type { DownloadJob, VersionRef, VersionType } from '@shared/types'
import { navigate } from '../composables/useNav'
import { defineDict, t } from '../i18n'
import { formatBytes, formatDate } from '../composables/format'
import { activeMirrorMap, useSettings } from '../stores/useSettings'
import { typeLabel, useVersions } from '../stores/useVersions'
import { useLauncher } from '../stores/useLauncher'
import type { MenuItem, TableColumn, TableRow } from '../components/ui/types'
import MButton from '../components/ui/MButton.vue'
import MCard from '../components/ui/MCard.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MIcon from '../components/icons/MIcon.vue'
import MInput from '../components/ui/MInput.vue'
import MMenu from '../components/ui/MMenu.vue'
import MModal from '../components/ui/MModal.vue'
import MProgress from '../components/ui/MProgress.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MSearch from '../components/ui/MSearch.vue'
import MSegmented from '../components/ui/MSegmented.vue'
import MSwitch from '../components/ui/MSwitch.vue'
import MTable from '../components/ui/MTable.vue'
import MTag from '../components/ui/MTag.vue'
import MTooltip from '../components/ui/MTooltip.vue'

const text = defineDict({
  subtitle: ['来自 Mojang 版本清单', 'From the Mojang version manifest'],
  type: ['类型', 'Type'],
  action: ['操作', 'Actions'],
  released: ['发布时间', 'Released'],
  all: ['全部', 'All'],
  installedCount: ['已安装 {n} 个', '{n} installed'],
  sourceTitle: ['当前下载源', 'Active download source'],
  sourceOfficial: ['官方源（未启用任何镜像规则）', 'Official endpoints — no mirror rule enabled'],
  sourceVia: ['经由 {label}', 'via {label}'],
  rewriteCount: ['重写 {n} 个主机', 'rewrites {n} hosts'],
  editSource: ['编辑下载源', 'Edit download sources'],
  installAndCreate: ['安装并新建实例', 'Install and create an instance'],
  installCreateTitle: ['安装 {id} 并创建实例', 'Install {id} and create an instance'],
  createSwitch: ['创建一个实例', 'Create an instance'],
  instanceName: ['实例名称', 'Instance name'],
  uninstallTitle: ['卸载 {id}？', 'Uninstall {id}?'],
  uninstallBody: ['只删除 versions 目录里的 json 与 jar，库文件和资源保留。', 'Removes the json and jar under versions/; libraries and assets stay.'],
  installNote: ['会下载版本 json、客户端 jar、依赖库与资源索引；任务进度同时显示在状态栏。', 'Fetches the version json, client jar, libraries and the asset index; the job also shows in the status bar.'],
  refreshHint: ['重新拉取 version_manifest_v2', 'Re-fetch version_manifest_v2'],
  jobFor: ['{id} 的任务', 'Job for {id}'],
  emptyTitle: ['没有可用版本', 'No versions available'],
  emptyDesc: ['点击刷新，从 Mojang 拉取版本清单。', 'Hit refresh to pull the manifest from Mojang.'],
  noMatch: ['没有符合条件的版本', 'No version matches these filters'],
  installedLabel: ['已安装', 'Installed'],
  missingLabel: ['未安装', 'Not installed'],
  more: ['更多', 'More']
})

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: text.text('all') },
  { value: 'release', label: t('version.type.release') },
  { value: 'snapshot', label: t('version.type.snapshot') },
  { value: 'old_beta', label: t('version.type.old_beta') },
  { value: 'old_alpha', label: t('version.type.old_alpha') }
]

const columns: TableColumn[] = [
  { key: 'id', label: t('common.version'), sortable: true, width: '24%' },
  { key: 'type', label: text.text('type'), width: '14%' },
  { key: 'time', label: text.text('released'), sortable: true, width: '16%' },
  { key: 'status', label: t('common.status'), width: '22%' },
  { key: 'action', label: text.text('action'), align: 'end', width: '24%' }
]

const versions = useVersions()
const launcher = useLauncher()
const settings = useSettings()

const filter = ref<string>('all')
const query = ref('')
const sortKey = ref('')
const direction = ref<'asc' | 'desc' | null>(null)

/** Which job belongs to which version id — the API only hands back the job. */
const jobs = ref<Record<string, DownloadJob>>({})

const visible = computed<VersionRef[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const list = versions.manifest.value.filter((entry) => {
    if (filter.value !== 'all' && entry.type !== filter.value) return false
    if (!needle) return true
    return entry.id.toLowerCase().includes(needle)
  })
  const factor = direction.value === 'desc' ? -1 : 1
  if (sortKey.value === 'id') return [...list].sort((a, b) => a.id.localeCompare(b.id) * factor)
  if (sortKey.value === 'time') return [...list].sort((a, b) => (Date.parse(a.time) - Date.parse(b.time)) * factor)
  return list
})

const rows = computed<TableRow[]>(() =>
  visible.value.map((entry) => ({
    id: entry.id,
    type: entry.type,
    time: formatDate(Date.parse(entry.time)),
    status: versions.isInstalled(entry.id) ? 1 : 0
  }))
)

const segmentOptions = computed(() =>
  TYPE_FILTERS.map((entry) => ({
    value: entry.value,
    label:
      entry.value === 'all'
        ? `${text.text('all')} ${versions.manifest.value.length}`
        : `${typeLabel(entry.value as VersionType)} ${versions.counts.value[entry.value as VersionType] ?? 0}`
  }))
)

const mirrorSummary = computed(() => {
  const rules = settings.record.value?.mirrors ?? []
  const enabled = rules.filter((rule) => rule.enabled && Object.keys(rule.hosts).length > 0)
  return { enabled, active: activeMirrorMap(rules) }
})

function jobOf(id: string): DownloadJob | null {
  return jobs.value[id] ?? null
}

function percentOf(job: DownloadJob): number {
  const live = launcher.progressOf(job.id)
  if (live) return live.percent
  return job.bytesTotal > 0 ? Math.round((job.bytesDone / job.bytesTotal) * 1000) / 10 : 0
}

async function install(target: VersionRef): Promise<void> {
  const job = await versions.install({ id: target.id })
  if (job) jobs.value = { ...jobs.value, [target.id]: job }
}

async function repair(target: VersionRef): Promise<void> {
  const job = await versions.repair(target.id)
  if (job) jobs.value = { ...jobs.value, [target.id]: job }
}

/* ------------------------------------------------------------- install+instance */
const createOpen = ref(false)
const createTarget = ref<VersionRef | null>(null)
const createName = ref('')
const createWithInstance = ref(true)
const createBusy = ref(false)

function openInstallModal(target: VersionRef): void {
  createTarget.value = target
  createName.value = target.id
  createWithInstance.value = true
  createOpen.value = true
}

async function runInstallModal(): Promise<void> {
  const target = createTarget.value
  if (!target || createBusy.value) return
  createBusy.value = true
  const job = await versions.install({
    id: target.id,
    createInstance: createWithInstance.value,
    instanceName: createName.value.trim() || target.id
  })
  createBusy.value = false
  if (job) {
    jobs.value = { ...jobs.value, [target.id]: job }
    createOpen.value = false
  }
}

/* ------------------------------------------------------------------ uninstall */
const uninstallTarget = ref<VersionRef | null>(null)
const uninstallBusy = ref(false)

function askUninstall(target: VersionRef): void {
  uninstallTarget.value = target
}

async function runUninstall(): Promise<void> {
  const target = uninstallTarget.value
  if (!target || uninstallBusy.value) return
  uninstallBusy.value = true
  const ok = await versions.uninstall(target.id)
  uninstallBusy.value = false
  if (ok) {
    const next = { ...jobs.value }
    delete next[target.id]
    jobs.value = next
    uninstallTarget.value = null
  }
}

function onMenu(id: string, target: VersionRef): void {
  if (id === 'install-create') openInstallModal(target)
  else if (id === 'repair') void repair(target)
  else if (id === 'uninstall') askUninstall(target)
}

function menuFor(target: VersionRef): MenuItem[] {
  if (!versions.isInstalled(target.id)) {
    return [{ id: 'install-create', label: text.text('installAndCreate'), icon: 'cube' }]
  }
  return [
    { id: 'repair', label: t('version.repair'), icon: 'shield' },
    { id: 'uninstall', label: t('version.uninstall'), icon: 'trash', danger: true }
  ]
}

onMounted(() => {
  void versions.load()
  void settings.load()
  void launcher.refreshJobs()
})
</script>

<template>
  <div class="versions">
    <header class="page-head">
      <div class="page-heading">
        <h1 class="page-title">{{ t('nav.versions') }}</h1>
        <p class="page-sub">
          {{ text.text('subtitle') }} · {{ text.text('installedCount', { n: versions.installedIds.value.length }) }}
        </p>
      </div>
      <div class="page-actions">
        <MSearch v-model="query" class="search" size="sm" hotkey="Ctrl+F" :placeholder="t('common.searchPlaceholder')" />
        <MSegmented v-model="filter" :options="segmentOptions" size="sm" :equal="false" />
        <MTooltip :content="text.text('refreshHint')">
          <MButton size="sm" icon="refresh" :loading="versions.refreshing.value" @click="versions.refresh()">
            {{ t('version.refresh') }}
          </MButton>
        </MTooltip>
      </div>
    </header>

    <!-- download source -->
    <MCard :title="text.text('sourceTitle')" icon="globe" dense>
      <template #actions>
        <MButton size="sm" variant="ghost" icon="gear" @click="navigate('settings')">
          {{ text.text('editSource') }}
        </MButton>
      </template>
      <p v-if="!mirrorSummary.enabled.length" class="source-official">{{ text.text('sourceOfficial') }}</p>
      <ul v-else class="mirror-list">
        <li v-for="rule in mirrorSummary.enabled" :key="rule.id" class="mirror">
          <MTag size="sm" tone="success" dot>{{ rule.label }}</MTag>
          <span class="mirror-count u-num">{{ text.text('rewriteCount', { n: Object.keys(rule.hosts).length }) }}</span>
          <span class="mirror-hosts u-mono u-truncate" :title="Object.entries(rule.hosts).map(([host, target]) => `${host} → ${target}`).join('  ·  ')">
            {{ Object.entries(rule.hosts).map(([host, target]) => `${host} → ${target}`).join('  ·  ') }}
          </span>
        </li>
      </ul>
    </MCard>

    <div class="table-wrap">
      <!-- loading -->
      <MCard v-if="versions.loading.value && !versions.manifest.value.length" tone="flat">
        <MSkeleton :lines="8" height="16px" />
      </MCard>

      <!-- error -->
      <MCard v-else-if="versions.error.value" tone="flat">
        <MEmpty icon="warning" :title="versions.error.value" :description="text.text('emptyDesc')" compact>
          <MButton icon="refresh" :loading="versions.refreshing.value" @click="versions.refresh()">{{ t('common.retry') }}</MButton>
        </MEmpty>
      </MCard>

      <!-- empty manifest -->
      <MCard v-else-if="!versions.manifest.value.length" tone="flat">
        <MEmpty icon="layers" :title="text.text('emptyTitle')" :description="text.text('emptyDesc')">
          <MButton variant="primary" icon="refresh" :loading="versions.refreshing.value" @click="versions.refresh()">
            {{ t('version.refresh') }}
          </MButton>
        </MEmpty>
      </MCard>

      <!-- empty filter -->
      <MCard v-else-if="!visible.length" tone="flat">
        <MEmpty icon="search" :title="text.text('noMatch')" :description="t('common.noMatch')" compact>
          <MButton icon="x" @click="query = ''; filter = 'all'">{{ t('common.clear') }}</MButton>
        </MEmpty>
      </MCard>

      <MCard v-else :padded="false" tone="flat">
        <MTable
          :columns="columns"
          :rows="rows"
          :sort-key="sortKey"
          :direction="direction"
          dense
          @update:sort-key="sortKey = $event"
          @update:direction="direction = $event"
        >
          <template #cell="{ row, column }">
            <template v-if="column.key === 'id'">
              <span class="version-id u-truncate" :title="String(row.id)">{{ row.id }}</span>
            </template>

            <template v-else-if="column.key === 'type'">
              <MTag
                size="sm"
                :tone="row.type === 'release' ? 'success' : row.type === 'snapshot' ? 'accent' : 'neutral'"
              >
                {{ typeLabel(row.type as VersionType) }}
              </MTag>
            </template>

            <template v-else-if="column.key === 'status'">
              <span v-if="jobOf(String(row.id))" class="job-cell">
                <MProgress
                  :percent="percentOf(jobOf(String(row.id))!)"
                  size="sm"
                  :status="jobOf(String(row.id))!.status === 'error' ? 'error' : jobOf(String(row.id))!.status === 'done' ? 'success' : 'active'"
                />
                <span class="job-text u-num">
                  {{ formatBytes(jobOf(String(row.id))!.bytesTotal) }} · {{ jobOf(String(row.id))!.done }}/{{ jobOf(String(row.id))!.total }}
                </span>
              </span>
              <MTag v-else-if="row.status" size="sm" tone="success" icon="check">{{ text.text('installedLabel') }}</MTag>
              <span v-else class="u-muted">{{ text.text('missingLabel') }}</span>
            </template>

            <template v-else-if="column.key === 'action'">
              <span class="row-actions">
                <MButton
                  v-if="!row.status"
                  size="sm"
                  variant="primary"
                  icon="download"
                  @click="install(visible.find((entry) => entry.id === row.id)!)"
                >
                  {{ t('version.install') }}
                </MButton>
                <MButton
                  v-else
                  size="sm"
                  variant="outline"
                  icon="shield"
                  @click="repair(visible.find((entry) => entry.id === row.id)!)"
                >
                  {{ t('version.repair') }}
                </MButton>
                <MMenu
                  v-if="menuFor(visible.find((entry) => entry.id === row.id)!).length"
                  :items="menuFor(visible.find((entry) => entry.id === row.id)!)"
                  size="sm"
                  align="end"
                  @select="onMenu($event, visible.find((entry) => entry.id === row.id)!)"
                >
                  <template #trigger>
                    <MButton size="sm" variant="ghost" trailing-icon="chevron-down">{{ text.text('more') }}</MButton>
                  </template>
                </MMenu>
              </span>
            </template>

            <template v-else>{{ row[column.key] }}</template>
          </template>
        </MTable>
      </MCard>
    </div>

    <!-- install + create instance -->
    <MModal
      :open="createOpen"
      :title="createTarget ? text.text('installCreateTitle', { id: createTarget.id }) : ''"
      :width="460"
      :confirm-text="t('common.next')"
      :cancel-text="t('common.cancel')"
      @update:open="createOpen = $event"
      @close="createOpen = false"
      @confirm="runInstallModal"
    >
      <MFieldRow :label="text.text('createSwitch')">
        <MSwitch v-model="createWithInstance" />
      </MFieldRow>
      <MFieldRow v-if="createWithInstance" :label="text.text('instanceName')">
        <MInput v-model="createName" :maxlength="64" />
      </MFieldRow>
      <p class="modal-note">{{ text.text('installNote') }}</p>
    </MModal>

    <!-- uninstall -->
    <MModal
      :open="!!uninstallTarget"
      :title="uninstallTarget ? text.text('uninstallTitle', { id: uninstallTarget.id }) : ''"
      :description="text.text('uninstallBody')"
      :width="440"
      tone="danger"
      :confirm-text="t('common.delete')"
      :cancel-text="t('common.cancel')"
      @update:open="uninstallTarget = $event ? uninstallTarget : null"
      @close="uninstallTarget = null"
      @confirm="runUninstall"
    >
      <div class="confirm-row">
        <MIcon name="warning" :size="20" tone="warning" />
        <span class="u-mono">{{ uninstallTarget?.id }}</span>
      </div>
    </MModal>
  </div>
</template>

<style scoped>
.versions {
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

.page-heading {
  min-width: 0;
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
  flex-wrap: wrap;
}

.search {
  width: 200px;
}

.source-official {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.mirror-list {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
}

.mirror {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  min-width: 0;
}

.mirror-count {
  flex: none;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.mirror-hosts {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.table-wrap {
  min-width: 0;
}

.version-id {
  font-family: var(--m-font-mono);
  font-size: var(--m-fs-13);
}

.job-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.job-text {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.row-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-2);
  justify-content: flex-end;
}

.confirm-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  font-size: var(--m-fs-13);
}

.modal-note {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
  line-height: var(--m-lh-loose);
}
</style>

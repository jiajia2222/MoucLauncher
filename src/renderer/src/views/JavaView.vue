<script setup lang="ts">
/**
 * JavaView — the runtime inventory, the per-instance "which runtime will be used" answer,
 * provisioning with live progress, and the manual path override.
 *
 * `java.resolve` is the only call that knows the required major (it reads the resolved
 * version json in the main process), so this panel is driven by it: a `null` runtime means
 * the major is missing and the row offers the matching download.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import type { JavaRuntime, JavaSource, Settings } from '@shared/types'
import { defineDict, t } from '../i18n'
import { useJava, type ResolveEntry } from '../stores/useJava'
import { useModal } from '../composables/useModal'
import { formatBytes, truncateMiddle } from '../composables/format'
import MIcon from '../components/icons/MIcon.vue'
import MButton from '../components/ui/MButton.vue'
import MCard from '../components/ui/MCard.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MInput from '../components/ui/MInput.vue'
import MProgress from '../components/ui/MProgress.vue'
import MSelect from '../components/ui/MSelect.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MTable from '../components/ui/MTable.vue'
import MTag from '../components/ui/MTag.vue'
import MTooltip from '../components/ui/MTooltip.vue'
import type { TableColumn, SortDirection, TableRow } from '../components/ui/types'

const copy = defineDict({
  subtitle: [
    '启动器按版本 json 的要求挑选 Java 运行时；这里可以扫描本机、下载缺失的大版本，或指定一个自定义路径。',
    'The launcher picks a runtime from the version json. Scan this machine, download a missing major, or point at your own path.'
  ],
  runtimesTitle: ['已发现的运行时', 'Detected runtimes'],
  runtimesSubtitle: ['{n} 个记录 · {broken} 个异常', '{n} listed · {broken} broken'],
  inUseTitle: ['每个实例将使用的运行时', 'Runtime used per instance'],
  inUseSubtitle: ['{n} 个实例缺少对应大版本', '{n} instances are missing their major'],
  inUseOk: ['全部实例都能匹配到运行时', 'Every instance resolves to a runtime'],
  strategyTitle: ['选择策略', 'Strategy'],
  strategyHint: ['自动匹配按版本 json 的要求；自定义路径会覆盖所有实例。', 'Auto follows the version json; a custom path overrides every instance.'],
  customTitle: ['自定义 Java 路径', 'Custom Java path'],
  customHint: ['指向一个 javaw.exe。清空则回到上面的策略。', 'Points at a javaw.exe. Clear it to fall back to the strategy.'],
  scanDirsTitle: ['扫描目录', 'Scan directories'],
  scanDirsHint: ['来自 settings.javaScanDirs，扫描时逐个查找 bin\\javaw.exe。', 'From settings.javaScanDirs; each is searched for bin\\javaw.exe during a scan.'],
  scan: ['扫描本机 Java', 'Scan this machine'],
  pickPath: ['浏览…', 'Browse…'],
  removeRuntime: ['移除运行时', 'Remove runtime'],
  removeBody: ['移除 Java {major}（{vendor}）？依赖它的实例会退回缺失状态。', 'Remove Java {major} ({vendor})? Instances using it fall back to missing.'],
  sourceLabel: ['来源', 'Source'],
  javaLabel: ['大版本', 'Major'],
  headlessYes: ['支持无头模式', 'Headless capable'],
  headlessNo: ['不支持无头模式', 'Not headless capable'],
  archX86: ['32 位', '32-bit'],
  pinned: ['实例固定 {major}', 'Pinned {major}'],
  customMode: ['实例自定义路径', 'Instance override'],
  autoMode: ['自动匹配', 'Auto'],
  emptyTitle: ['没有发现任何 Java 运行时', 'No Java runtime found'],
  emptyHint: ['扫描本机，或直接下载一个 Minecraft 需要的大版本。', 'Scan this machine, or download a major Minecraft needs.'],
  jobs: ['下载任务', 'Downloads'],
  installed: ['已安装', 'Installed'],
  notInstalled: ['未安装', 'Not installed'],
  majorsHint: ['下拉里优先列出实例需要的大版本；{hint}。', 'The picker lists the majors instances need first; {hint}.'],
  sourceSystemPath: ['PATH 环境变量', 'PATH environment'],
  sourceScan: ['目录扫描', 'Directory scan'],
  sourceAdoptium: ['Adoptium', 'Adoptium'],
  sourceZulu: ['Azul Zulu', 'Azul Zulu'],
  sourceMojang: ['Mojang 组件', 'Mojang component'],
  sourceManual: ['手动添加', 'Added manually']
})

const SOURCE_KEYS: Record<JavaSource, 'sourceSystemPath' | 'sourceScan' | 'sourceAdoptium' | 'sourceZulu' | 'sourceMojang' | 'sourceManual'> = {
  'system-path': 'sourceSystemPath',
  scan: 'sourceScan',
  adoptium: 'sourceAdoptium',
  zulu: 'sourceZulu',
  mojang: 'sourceMojang',
  manual: 'sourceManual'
}

const store = reactive(useJava())
const modal = useModal()

const majorChoice = ref('21')
const sortKey = ref('major')
const direction = ref<SortDirection>('asc')

const selectedMajor = computed(() => Number(majorChoice.value) || store.majors[0] || 0)

/* ------------------------------------------------------------------ options */
const modeOptions = computed(() => {
  const labels: Record<Settings['javaMode'], string> = {
    auto: t('java.mode.auto'),
    'mojang-component': t('java.mode.mojang'),
    adoptium: t('java.mode.adoptium'),
    custom: t('java.mode.custom')
  }
  return (Object.keys(labels) as Settings['javaMode'][]).map((value) => ({ value, label: labels[value] }))
})

const majorOptions = computed(() =>
  store.majors.map((major) => ({
    value: String(major),
    label: t('java.major', { major }),
    hint: store.installedMajors.has(major) ? copy.text('installed') : copy.text('notInstalled')
  }))
)

const columns = computed<TableColumn[]>(() => [
  { key: 'major', label: copy.text('javaLabel'), sortable: true, width: '104px' },
  { key: 'vendor', labelKey: 'java.vendor', width: '160px', sortable: true },
  { key: 'arch', labelKey: 'java.arch', width: '92px' },
  { key: 'source', label: copy.text('sourceLabel'), width: '144px' },
  { key: 'path', labelKey: 'java.path', mono: true },
  { key: 'action', labelKey: 'common.action', width: '72px', align: 'end' }
])

const runtimeById = computed(() => new Map(store.runtimes.map((entry) => [entry.id, entry])))

const rows = computed<TableRow[]>(() => {
  const dir = direction.value === 'desc' ? -1 : 1
  const sorted = [...store.sortedRuntimes]
  const key = sortKey.value
  if (key === 'vendor') sorted.sort((a, b) => a.vendor.localeCompare(b.vendor) * dir)
  else if (key === 'arch') sorted.sort((a, b) => a.arch.localeCompare(b.arch) * dir)
  else if (key === 'source') sorted.sort((a, b) => a.source.localeCompare(b.source) * dir)
  else if (key === 'path') sorted.sort((a, b) => a.path.localeCompare(b.path) * dir)
  else sorted.sort((a, b) => (a.major - b.major) * dir)
  return sorted.map((entry) => ({
    id: entry.id,
    major: entry.major,
    vendor: entry.vendor,
    arch: entry.arch,
    source: entry.source,
    path: entry.path,
    broken: entry.broken ?? ''
  }))
})

function runtimeOf(row: TableRow): JavaRuntime | null {
  return runtimeById.value.get(String(row.id)) ?? null
}

function sourceLabel(row: TableRow): string {
  const runtime = runtimeOf(row)
  return runtime ? copy.text(SOURCE_KEYS[runtime.source]) : String(row.source)
}

function archLabel(row: TableRow): string {
  const runtime = runtimeOf(row)
  if (!runtime) return String(row.arch)
  return runtime.arch === 'x86' ? copy.text('archX86') : runtime.arch
}

function headlessLabel(row: TableRow): string {
  const runtime = runtimeOf(row)
  if (!runtime) return ''
  return runtime.canHeadless ? copy.text('headlessYes') : copy.text('headlessNo')
}

function pathTip(row: TableRow): string {
  const runtime = runtimeOf(row)
  return runtime ? `${runtime.rawVersion} · ${headlessLabel(row)}` : ''
}

async function onRemoveRow(row: TableRow): Promise<void> {
  const runtime = runtimeOf(row)
  if (!runtime) return
  const confirmed = await modal.confirm({
    title: copy.text('removeRuntime'),
    text: copy.text('removeBody', { major: runtime.major, vendor: runtime.vendor }),
    confirmKey: 'common.delete',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  await store.removeRuntime(runtime)
}

function resolveModeLabel(entry: ResolveEntry): string {
  if (entry.instance.java.mode === 'pinned') return copy.text('pinned', { major: entry.instance.java.major ?? entry.major })
  if (entry.instance.java.mode === 'custom') return copy.text('customMode')
  return copy.text('autoMode')
}

function usedPathOf(entry: ResolveEntry): string {
  return entry.runtime ? truncateMiddle(entry.runtime.executable, 72) : ''
}

const customPath = computed(() => store.settings?.customJavaPath ?? '')
const scanDirs = computed(() => (store.settings?.javaScanDirs ?? []).join(' · '))

/* ------------------------------------------------------------------ actions */
async function onModeChange(value: string): Promise<void> {
  await store.saveSettings({ javaMode: value as Settings['javaMode'] })
}

async function onClearPath(): Promise<void> {
  await store.saveSettings({ customJavaPath: '', javaMode: 'auto' })
}

function onSort(key: string, next: SortDirection): void {
  sortKey.value = key || 'major'
  direction.value = next
}

onMounted(async () => {
  await Promise.all([store.loadSettings(), store.loadRuntimes(), store.loadInstances()])
  const firstMissing = store.missingEntries[0]
  majorChoice.value = String(firstMissing?.major ?? store.majors[0] ?? 8)
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div class="head-text">
        <h1 class="title">{{ t('nav.java') }}</h1>
        <p class="sub">{{ copy.text('subtitle') }}</p>
      </div>
      <div class="head-tools">
        <MButton variant="outline" icon="refresh" :loading="store.scanning" @click="store.scan()">
          {{ copy.text('scan') }}
        </MButton>
        <div class="pick-group">
          <MSelect v-model="majorChoice" :options="majorOptions" :icon="'beaker'" class="major-pick" />
          <MButton
            variant="primary"
            icon="download"
            :disabled="selectedMajor === 0 || store.provisionRunning"
            @click="store.provision(selectedMajor)"
          >
            {{ t('java.provision', { major: selectedMajor }) }}
          </MButton>
        </div>
      </div>
    </header>

    <!-- ==================================================== provisioning -->
    <MCard v-if="store.jobs.length" icon="download" :title="copy.text('jobs')" dense>
      <ul class="jobs">
        <li v-for="job in store.jobs" :key="job.id" class="job">
          <MProgress
            :percent="job.percent"
            :indeterminate="job.status === 'running' && job.bytesTotal === 0"
            :status="job.status === 'error' ? 'error' : job.status === 'done' ? 'success' : 'active'"
            :label="job.title"
            :bytes-done="job.bytesDone"
            :bytes-total="job.bytesTotal"
            :speed="job.speedBps"
            :eta-seconds="job.etaSeconds"
            :show-bytes="job.bytesTotal > 0"
            :show-meta="job.bytesTotal > 0"
            size="sm"
          />
          <MTag
            size="sm"
            :tone="job.status === 'error' ? 'danger' : job.status === 'done' ? 'success' : 'accent'"
            :dot="job.status === 'running'"
          >
            {{ job.status === 'done' ? formatBytes(job.bytesTotal) : job.status === 'error' ? t('status.jobFailed') : t('status.jobRunning') }}
          </MTag>
        </li>
      </ul>
    </MCard>

    <!-- ==================================================== which runtime -->
    <MCard
      icon="cube"
      :title="copy.text('inUseTitle')"
      :subtitle="store.missingEntries.length ? copy.text('inUseSubtitle', { n: store.missingEntries.length }) : copy.text('inUseOk')"
    >
      <ul v-if="store.resolving && store.resolveList.length === 0" class="resolve-list" aria-busy="true">
        <li v-for="n in 4" :key="n" class="resolve-row">
          <MSkeleton variant="line" width="34%" height="14px" />
          <MSkeleton variant="line" width="52%" height="12px" />
        </li>
      </ul>

      <MEmpty
        v-else-if="store.resolveList.length === 0"
        icon="cube"
        :title="copy.text('emptyTitle')"
        :description="copy.text('emptyHint')"
      >
        <MButton variant="outline" icon="refresh" @click="store.loadInstances()">{{ t('common.refresh') }}</MButton>
      </MEmpty>

      <ul v-else class="resolve-list">
        <li v-for="entry in store.resolveList" :key="entry.instance.id" class="resolve-row">
          <div class="resolve-name">
            <p class="u-truncate">{{ entry.instance.name }}</p>
            <p class="resolve-sub u-num">
              <span>{{ entry.instance.gameVersion }}</span>
              <span class="sep">·</span>
              <span>{{ entry.instance.loader }}</span>
              <span class="sep">·</span>
              <span>{{ resolveModeLabel(entry) }}</span>
            </p>
          </div>

          <MTag size="sm" tone="accent">{{ t('java.major', { major: entry.major }) }}</MTag>

          <div class="resolve-runtime u-grow">
            <template v-if="entry.error">
              <MIcon name="warning" :size="16" tone="danger" />
              <span class="u-truncate danger">{{ entry.error.message }}</span>
            </template>
            <template v-else-if="entry.runtime">
              <MIcon name="check" :size="16" tone="success" />
              <span class="u-truncate">{{ entry.runtime.vendor }}</span>
              <span class="u-num muted u-truncate">{{ usedPathOf(entry) }}</span>
              <MTag v-if="entry.runtime.broken" size="sm" tone="danger">{{ entry.runtime.broken }}</MTag>
            </template>
            <template v-else>
              <MIcon name="warning" :size="16" tone="warning" />
              <span class="u-truncate warn">{{ t('java.missingHint', { major: entry.major }) }}</span>
            </template>
          </div>

          <div class="resolve-action">
            <MButton v-if="entry.error" size="sm" variant="ghost" icon="refresh" @click="store.resolveInstances()">
              {{ t('common.retry') }}
            </MButton>
            <MButton
              v-else-if="!entry.runtime"
              size="sm"
              variant="primary"
              icon="download"
              :disabled="store.provisionRunning"
              @click="store.provision(entry.major)"
            >
              {{ t('java.provision', { major: entry.major }) }}
            </MButton>
            <MTooltip v-else :content="entry.runtime.executable" :detail="entry.runtime.rawVersion" placement="left">
              <span class="u-num muted">{{ t('java.inUse') }}</span>
            </MTooltip>
          </div>
        </li>
      </ul>
    </MCard>

    <!-- ======================================================== inventory -->
    <MCard
      icon="beaker"
      :title="copy.text('runtimesTitle')"
      :subtitle="copy.text('runtimesSubtitle', { n: store.runtimes.length, broken: store.broken.length })"
    >
      <template #actions>
        <MButton size="sm" variant="ghost" icon="refresh" :loading="store.loading" @click="store.scan()">
          {{ t('common.refresh') }}
        </MButton>
      </template>

      <div v-if="store.error" class="state-error" role="alert">
        <MIcon name="warning" :size="20" tone="danger" />
        <div class="u-grow">
          <p class="state-title">{{ store.error.message }}</p>
          <p v-if="store.error.detail" class="state-detail u-mono u-truncate">{{ store.error.detail }}</p>
        </div>
        <MButton size="sm" variant="outline" icon="refresh" @click="store.scan()">{{ t('common.retry') }}</MButton>
      </div>

      <ul v-else-if="store.loading && store.runtimes.length === 0" class="sk-list" aria-busy="true">
        <li v-for="n in 4" :key="n"><MSkeleton variant="line" height="14px" /></li>
      </ul>

      <MEmpty v-else-if="store.runtimes.length === 0" icon="beaker" :title="copy.text('emptyTitle')" :description="copy.text('emptyHint')">
        <div class="u-row u-wrap">
          <MButton variant="primary" icon="search" :loading="store.scanning" @click="store.scan()">{{ copy.text('scan') }}</MButton>
          <MButton variant="outline" icon="download" @click="store.provision(selectedMajor)">
            {{ t('java.provision', { major: selectedMajor }) }}
          </MButton>
        </div>
      </MEmpty>

      <MTable
        v-else
        :columns="columns"
        :rows="rows"
        :sort-key="sortKey"
        :direction="direction"
        :empty-text="copy.text('emptyTitle')"
        dense
        @sort="onSort"
      >
        <template #cell="{ row, column }">
          <template v-if="column.key === 'major'">
            <MTag size="sm" :tone="row.broken ? 'danger' : 'neutral'">{{ t('java.major', { major: Number(row.major) }) }}</MTag>
          </template>
          <template v-else-if="column.key === 'arch'">
            <span :class="{ warn: runtimeOf(row)?.arch === 'x86' }">{{ archLabel(row) }}</span>
          </template>
          <template v-else-if="column.key === 'source'">
            <span class="u-muted">{{ sourceLabel(row) }}</span>
          </template>
          <template v-else-if="column.key === 'path'">
            <MTooltip :content="String(row.path)" :detail="pathTip(row)" placement="top">
              <span class="path u-truncate">{{ row.path }}</span>
            </MTooltip>
            <p v-if="row.broken" class="broken">
              <MIcon name="warning" :size="16" tone="danger" />
              {{ t('java.broken', { reason: String(row.broken) }) }}
            </p>
          </template>
          <template v-else-if="column.key === 'action'">
            <MIconButton
              icon="trash"
              tone="danger"
              size="sm"
              :label="copy.text('removeRuntime')"
              @click="onRemoveRow(row)"
            />
          </template>
          <template v-else>{{ row[column.key] }}</template>
        </template>
      </MTable>
    </MCard>

    <!-- ========================================================= strategy -->
    <MCard icon="gear" :title="copy.text('strategyTitle')" :subtitle="copy.text('strategyHint')">
      <div class="fields">
        <MFieldRow :label="t('java.mode')" :hint="copy.text('majorsHint', { hint: store.majorsHintText })" :inline="false">
          <MSelect
            :model-value="store.settings?.javaMode ?? 'auto'"
            :options="modeOptions"
            @update:model-value="onModeChange($event)"
          />
        </MFieldRow>

        <MFieldRow :label="copy.text('customTitle')" :hint="copy.text('customHint')" :inline="false">
          <div class="path-row">
            <MInput :model-value="customPath" readonly mono :placeholder="t('common.none')" class="grow" />
            <MButton variant="outline" icon="folder" @click="store.pickCustomJava()">{{ copy.text('pickPath') }}</MButton>
            <MIconButton
              icon="x"
              size="sm"
              :label="t('common.clear')"
              :disabled="customPath.length === 0"
              @click="onClearPath"
            />
          </div>
        </MFieldRow>

        <MFieldRow :label="copy.text('scanDirsTitle')" :hint="copy.text('scanDirsHint')" :inline="false">
          <p class="dirs u-mono">{{ scanDirs || t('common.none') }}</p>
        </MFieldRow>
      </div>
    </MCard>
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
  max-width: 74ch;
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.head-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
}

.pick-group {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.major-pick {
  width: 160px;
}

/* --------------------------------------------------------------- resolve */
.resolve-list {
  display: flex;
  flex-direction: column;
}

.resolve-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3) 0;
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.resolve-row:last-child {
  border-bottom: 0;
}

.resolve-name {
  flex: 0 0 204px;
  min-width: 0;
  font-size: var(--m-fs-14);
}

.resolve-sub {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.resolve-runtime {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
  font-size: var(--m-fs-13);
}

.resolve-action {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.sep {
  color: var(--m-border-strong);
}

.warn {
  color: var(--m-warning);
}

.danger {
  color: var(--m-danger);
}

.muted {
  color: var(--m-text-muted);
}

/* ------------------------------------------------------------- inventory */
.sk-list {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
}

.path {
  max-width: 100%;
  font-family: var(--m-font-mono);
  font-size: var(--m-fs-12);
}

.broken {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-danger);
}

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

/* ---------------------------------------------------------------- fields */
.fields {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
}

.path-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.grow {
  flex: 1 1 auto;
}

.dirs {
  padding: var(--m-sp-2) var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

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
</style>

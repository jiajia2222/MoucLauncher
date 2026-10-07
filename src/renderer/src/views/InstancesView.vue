<script setup lang="ts">
/**
 * InstancesView — the instance library.
 *
 * Grid and list are two renders of the same `InstanceSummary[]`; every mutation goes through
 * the instance store so HomeView's picker stays in sync. The settings drawer edits a private
 * clone of one instance and writes it back in a single `instance.update` patch, then adopts
 * whatever the process returns.
 */
import { computed, onMounted, ref, toRaw, watch } from 'vue'
import type { LoaderOption } from '@shared/ipc'
import type { Account, Instance, InstanceJavaMode, InstanceSummary, JavaRuntime, LoaderId } from '@shared/types'
import { navigate } from '../composables/useNav'
import { formatBytes, formatDateTime, formatRelative } from '../composables/format'
import { useToast } from '../composables/useToast'
import { defineDict, t } from '../i18n'
import { badgeFor, iconFor, loaderLabel, useInstances } from '../stores/useInstances'
import { useLauncher } from '../stores/useLauncher'
import { useSettings } from '../stores/useSettings'
import { useVersions } from '../stores/useVersions'
import type { MenuItem, SelectOption } from '../components/ui/types'
import MButton from '../components/ui/MButton.vue'
import MCard from '../components/ui/MCard.vue'
import MCheckbox from '../components/ui/MCheckbox.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MIcon from '../components/icons/MIcon.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MInput from '../components/ui/MInput.vue'
import MList from '../components/ui/MList.vue'
import MMenu from '../components/ui/MMenu.vue'
import MModal from '../components/ui/MModal.vue'
import MProgress from '../components/ui/MProgress.vue'
import MRadio from '../components/ui/MRadio.vue'
import MRange from '../components/ui/MRange.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MSearch from '../components/ui/MSearch.vue'
import MSelect from '../components/ui/MSelect.vue'
import MSegmented from '../components/ui/MSegmented.vue'
import MSwitch from '../components/ui/MSwitch.vue'
import MTag from '../components/ui/MTag.vue'
import MTextarea from '../components/ui/MTextarea.vue'

const text = defineDict({
  grid: ['网格', 'Grid'],
  list: ['列表', 'List'],
  actions: ['操作', 'Actions'],
  settings: ['实例设置', 'Instance settings'],
  emptyAll: ['还没有实例', 'No instances yet'],
  emptyFiltered: ['没有匹配的实例', 'No instance matches the search'],
  emptyHint: ['新建一个实例，或导入现成的整合包。', 'Create an instance, or import a modpack.'],
  nameRequired: ['请填写实例名称', 'Give the instance a name'],
  versionRequired: ['请选择游戏版本', 'Pick a game version'],
  loaderNone: ['不安装加载器', 'No loader'],
  loaderVersionsCount: ['{n} 个可用版本', '{n} versions available'],
  channelRecommended: ['推荐', 'recommended'],
  channelStable: ['稳定', 'stable'],
  channelBeta: ['测试', 'beta'],
  pickImport: ['选择整合包文件', 'Choose a modpack file'],
  pickExport: ['选择导出保存位置', 'Choose where to save the export'],
  pickFailed: ['文件选择失败', 'Could not open the file dialog'],
  exportMrpack: ['导出为 .mrpack', 'Export as .mrpack'],
  exportZip: ['导出为 .zip', 'Export as .zip'],
  importTitle: ['导入整合包', 'Import modpack'],
  importFile: ['文件', 'File'],
  importNameHint: ['留空则使用整合包自身的名称。', 'Leave empty to use the pack name.'],
  format: ['格式', 'Format'],
  formatMrpack: ['Modrinth (.mrpack)', 'Modrinth (.mrpack)'],
  formatMultimc: ['MultiMC / Prism (.zip)', 'MultiMC / Prism (.zip)'],
  formatCurse: ['CurseForge (.zip)', 'CurseForge (.zip)'],
  deleteWarning: ['实例目录会被保留在游戏根目录，除非勾选下方选项。', 'The instance folder stays in the game root unless you tick the option below.'],
  serverTarget: ['服务器目标', 'Server target'],
  javaPinned: ['指定运行时', 'Pinned runtime'],
  javaCustom: ['自定义路径', 'Custom path'],
  javaNoneFound: ['未找到可用运行时', 'No usable runtime found'],
  width: ['宽度', 'Width'],
  height: ['高度', 'Height'],
  fullscreen: ['启动为全屏', 'Start fullscreen'],
  isolatedHint: ['每个实例使用自己的存档、资源与模组目录。', 'Each instance keeps its own saves, assets and mods.'],
  apply: ['保存修改', 'Save changes'],
  closeDrawer: ['关闭面板', 'Close panel'],
  refreshState: ['重新校验', 'Re-check files'],
  launching: ['正在启动实例', 'Launching instance']
})

type ModpackFormat = 'mrpack' | 'zip-multimc' | 'curse-zip'

const LOADER_IDS: LoaderId[] = [
  'vanilla',
  'fabric',
  'legacy-fabric',
  'quilt',
  'forge',
  'neoforge',
  'optifine',
  'liteloader',
  'cleanroom'
]

function asLoaderId(value: string): LoaderId {
  return (LOADER_IDS as string[]).includes(value) ? (value as LoaderId) : 'vanilla'
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const instances = useInstances()
const launcher = useLauncher()
const settings = useSettings()
const versions = useVersions()
const toast = useToast()

const view = ref<'grid' | 'list'>('grid')
const sort = ref<'name' | 'recent' | 'created'>('recent')
const query = ref('')

const accounts = ref<Account[]>([])
const runtimes = ref<JavaRuntime[]>([])
const runtimeFailed = ref('')

/* --------------------------------------------------------------- filtering */
const filtered = computed<InstanceSummary[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const list = instances.summaries.value.filter((entry) => {
    if (!needle) return true
    const instance = entry.instance
    return (
      instance.name.toLowerCase().includes(needle) ||
      instance.gameVersion.toLowerCase().includes(needle) ||
      instance.description.toLowerCase().includes(needle) ||
      loaderLabel(instance.loader).toLowerCase().includes(needle)
    )
  })
  return [...list].sort((a, b) => {
    if (sort.value === 'name') return a.instance.name.localeCompare(b.instance.name, 'zh-Hans-CN')
    if (sort.value === 'created') return b.instance.createdAt - a.instance.createdAt
    return (b.instance.lastPlayedAt ?? 0) - (a.instance.lastPlayedAt ?? 0)
  })
})

const sortOptions: SelectOption[] = [
  { value: 'recent', label: t('instance.sort.recent') },
  { value: 'name', label: t('instance.sort.name') },
  { value: 'created', label: t('instance.sort.created') }
]

const viewOptions: SelectOption[] = [
  { value: 'grid', label: text.text('grid') },
  { value: 'list', label: text.text('list') }
]

function summaryById(id: string): InstanceSummary | null {
  return instances.summaries.value.find((entry) => entry.instance.id === id) ?? null
}

const listRows = computed(() =>
  filtered.value.map((entry) => ({
    id: entry.instance.id,
    label: entry.instance.name,
    hint: `${entry.instance.gameVersion} · ${loaderLabel(entry.instance.loader)} · ${t('instance.lastPlayed')} ${formatRelative(entry.instance.lastPlayedAt ?? 0)}`,
    icon: iconFor(entry.instance.icon),
    meta: formatBytes(entry.state.sizeBytes)
  }))
)

/* ---------------------------------------------------------------- accounts */
const accountOptions = computed<SelectOption[]>(() =>
  accounts.value.map((entry) => ({
    value: entry.id,
    label: entry.name,
    hint: entry.label,
    disabled: !entry.selected && entry.tokenState === 'invalid'
  }))
)

async function loadAccounts(): Promise<void> {
  const res = await window.mouc.account.list()
  if (!res.ok) {
    toast.push({ kind: 'danger', title: t('account.title'), message: res.error.message })
    return
  }
  accounts.value = res.data
}

/* -------------------------------------------------------------- create flow */
const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const loaderOptions = ref<LoaderOption[]>([])
const loaderError = ref('')
const createForm = ref({
  name: '',
  versionId: '',
  loaderId: 'vanilla',
  loaderVersion: '',
  isolated: true,
  memoryMb: 4096,
  accountId: ''
})

const versionOptions = computed<SelectOption[]>(() =>
  versions.manifest.value.map((entry) => ({ value: entry.id, label: entry.id, hint: entry.time.slice(0, 10) }))
)

const loaderSelectOptions = computed<SelectOption[]>(() => [
  { value: 'vanilla', label: text.text('loaderNone') },
  ...loaderOptions.value.map((option) => ({
    value: option.id,
    label: option.label,
    hint: text.text('loaderVersionsCount', { n: option.versions.length })
  }))
])

const loaderVersionOptions = computed<SelectOption[]>(() => {
  const option = loaderOptions.value.find((entry) => entry.id === createForm.value.loaderId)
  if (!option) return []
  return option.versions.map((entry) => ({
    value: entry.version,
    label: entry.version,
    hint: entry.recommended
      ? text.text('channelRecommended')
      : entry.stable
        ? text.text('channelStable')
        : text.text('channelBeta')
  }))
})

function openCreate(): void {
  createOpen.value = true
  createError.value = ''
  createForm.value = {
    name: '',
    versionId: versions.manifest.value[0]?.id ?? '',
    loaderId: 'vanilla',
    loaderVersion: '',
    isolated: true,
    memoryMb: settings.record.value?.defaultMemoryMb ?? 4096,
    accountId: accounts.value.find((entry) => entry.selected)?.id ?? ''
  }
  void loadLoaderOptions(createForm.value.versionId)
}

async function loadLoaderOptions(versionId: string): Promise<void> {
  loaderOptions.value = []
  loaderError.value = ''
  createForm.value.loaderVersion = ''
  if (!versionId) return
  const res = await window.mouc.loader.options(versionId)
  if (!res.ok) {
    loaderError.value = res.error.message
    return
  }
  loaderOptions.value = res.data
  createForm.value.loaderVersion = res.data[0]?.versions[0]?.version ?? ''
}

async function runCreate(): Promise<void> {
  const form = createForm.value
  if (!form.name.trim()) {
    createError.value = text.text('nameRequired')
    return
  }
  if (!form.versionId) {
    createError.value = text.text('versionRequired')
    return
  }
  creating.value = true
  const created = await instances.create({
    name: form.name.trim(),
    versionId: form.versionId,
    isolated: form.isolated,
    memoryMb: form.memoryMb,
    accountId: form.accountId || undefined,
    loader: form.loaderId === 'vanilla' ? undefined : { id: asLoaderId(form.loaderId), version: form.loaderVersion }
  })
  creating.value = false
  if (created) createOpen.value = false
}

/* ------------------------------------------------------- rename / copy / kill */
const renameTarget = ref<Instance | null>(null)
const renameValue = ref('')
const renameError = ref('')

const copyTarget = ref<Instance | null>(null)
const copyValue = ref('')

const deleteTarget = ref<Instance | null>(null)
const deleteFiles = ref(true)
const deleting = ref(false)

async function runRename(): Promise<void> {
  const target = renameTarget.value
  if (!target) return
  const name = renameValue.value.trim()
  if (!name) {
    renameError.value = text.text('nameRequired')
    return
  }
  if (await instances.patch({ id: target.id, name })) renameTarget.value = null
}

async function runDuplicate(): Promise<void> {
  const target = copyTarget.value
  if (!target) return
  if (await instances.duplicate(target.id, copyValue.value.trim())) copyTarget.value = null
}

async function runDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  const ok = await instances.remove(target.id, deleteFiles.value)
  deleting.value = false
  if (ok && drawerId.value === target.id) drawerId.value = null
  if (ok) deleteTarget.value = null
}

/* ------------------------------------------------------------- import/export */
const importOpen = ref(false)
const importing = ref(false)
const importError = ref('')
const importForm = ref({ file: '', name: '', format: 'mrpack' as ModpackFormat })

const formatOptions: SelectOption[] = [
  { value: 'mrpack', label: text.text('formatMrpack') },
  { value: 'zip-multimc', label: text.text('formatMultimc') },
  { value: 'curse-zip', label: text.text('formatCurse') }
]

async function importFlow(): Promise<void> {
  const picked = await window.mouc.app.pickFile(text.text('pickImport'), [
    { name: 'Modpack', extensions: ['mrpack', 'zip'] }
  ])
  if (!picked.ok) {
    toast.push({ kind: 'danger', title: text.text('pickFailed'), message: picked.error.message })
    return
  }
  const file = picked.data
  if (!file) return
  importForm.value = { file, name: '', format: /\.mrpack$/i.test(file) ? 'mrpack' : 'zip-multimc' }
  importError.value = ''
  importOpen.value = true
}

async function runImport(): Promise<void> {
  const form = importForm.value
  if (!form.file) {
    importError.value = text.text('emptyHint')
    return
  }
  importing.value = true
  const fallbackName = form.file.split(/[\\/]/).pop() ?? ''
  const ok = await instances.importModpack(form.file, form.format, form.name.trim() || fallbackName)
  importing.value = false
  if (ok) importOpen.value = false
}

async function exportPack(instance: Instance, format: 'mrpack' | 'zip'): Promise<void> {
  // `MoucApi` has no save dialog, so `pickFile` chooses the destination path.
  const picked = await window.mouc.app.pickFile(text.text('pickExport'), [
    { name: format, extensions: [format === 'mrpack' ? 'mrpack' : 'zip'] }
  ])
  if (!picked.ok) {
    toast.push({ kind: 'danger', title: text.text('pickFailed'), message: picked.error.message })
    return
  }
  const target = picked.data
  if (!target) return
  await instances.exportModpack(instance.id, target, format)
}

/* ------------------------------------------------------------- row menu */
const menuItems: MenuItem[] = [
  { id: 'settings', label: text.text('settings'), icon: 'gear' },
  { id: 'rename', label: t('instance.rename'), icon: 'kbd' },
  { id: 'duplicate', label: t('instance.duplicate'), icon: 'copy' },
  { id: 'open', label: t('instance.openDir'), icon: 'folder' },
  { id: 'recheck', label: text.text('refreshState'), icon: 'shield' },
  { id: 'export-mrpack', label: text.text('exportMrpack'), icon: 'pack' },
  { id: 'export-zip', label: text.text('exportZip'), icon: 'box' },
  { id: 'separator', separator: true },
  { id: 'delete', label: t('instance.remove'), icon: 'trash', danger: true }
]

async function onMenu(id: string, instanceId: string): Promise<void> {
  const entry = summaryById(instanceId)
  if (!entry) return
  const instance = entry.instance
  if (id === 'settings') openDrawer(instance.id)
  else if (id === 'rename') {
    renameTarget.value = instance
    renameValue.value = instance.name
    renameError.value = ''
  } else if (id === 'duplicate') {
    copyTarget.value = instance
    copyValue.value = `${instance.name} 2`
  } else if (id === 'open') await instances.openDir(instance.id)
  else if (id === 'recheck') await instances.refreshState(instance.id)
  else if (id === 'export-mrpack' || id === 'export-zip') await exportPack(instance, id === 'export-mrpack' ? 'mrpack' : 'zip')
  else if (id === 'delete') {
    deleteTarget.value = instance
    deleteFiles.value = true
  }
}

/* --------------------------------------------------------------- launch from grid */
async function quickLaunch(entry: InstanceSummary): Promise<void> {
  instances.setActive(entry.instance.id)
  await launcher.launch(
    { instanceId: entry.instance.id, accountId: entry.instance.accountId, server: entry.instance.server },
    entry.instance.name
  )
}

/* --------------------------------------------------------------- settings drawer */
const drawerId = ref<string | null>(null)
const draft = ref<Instance | null>(null)
const savingDraft = ref(false)
const draftError = ref('')

const drawerSummary = computed<InstanceSummary | null>(() =>
  drawerId.value ? summaryById(drawerId.value) : null
)

async function openDrawer(id: string): Promise<void> {
  const entry = summaryById(id)
  if (!entry) return
  drawerId.value = id
  draft.value = structuredClone(toRaw(entry.instance))
  draftError.value = ''
  await loadRuntimes()
}

async function loadRuntimes(): Promise<void> {
  runtimeFailed.value = ''
  const res = await window.mouc.java.list()
  if (!res.ok) {
    runtimeFailed.value = res.error.message
    toast.push({ kind: 'danger', title: t('java.runtimes'), message: res.error.message })
    return
  }
  runtimes.value = res.data
}

const runtimeOptions = computed<SelectOption[]>(() =>
  runtimes.value.map((entry) => ({
    value: entry.executable,
    label: `Java ${entry.major} · ${entry.vendor}`,
    hint: entry.broken ? entry.arch : `${t('java.arch')} ${entry.arch}`,
    disabled: !!entry.broken
  }))
)

const javaModes: { value: InstanceJavaMode; label: string }[] = [
  { value: 'auto', label: t('java.mode.auto') },
  { value: 'pinned', label: text.text('javaPinned') },
  { value: 'custom', label: text.text('javaCustom') }
]

function setJavaMode(mode: InstanceJavaMode): void {
  const target = draft.value
  if (!target) return
  target.java.mode = mode
  if (mode !== 'auto' && !target.java.path) target.java.path = runtimes.value[0]?.executable ?? ''
}

/* Numeric fields need a string bridge: MInput speaks strings, Instance speaks numbers. */
const resWidth = computed({
  get: () => String(draft.value?.resolution.width ?? ''),
  set: (value: string) => {
    const target = draft.value
    if (target) target.resolution.width = toInt(value, target.resolution.width)
  }
})

const resHeight = computed({
  get: () => String(draft.value?.resolution.height ?? ''),
  set: (value: string) => {
    const target = draft.value
    if (target) target.resolution.height = toInt(value, target.resolution.height)
  }
})

const javaPath = computed({
  get: () => draft.value?.java.path ?? '',
  set: (value: string) => {
    const target = draft.value
    if (target) target.java.path = value
  }
})

const serverAddress = computed({
  get: () => draft.value?.server?.address ?? '',
  set: (value: string) => {
    const target = draft.value
    if (!target) return
    target.server = { address: value.trim(), port: target.server?.port ?? 25565 }
  }
})

const serverPort = computed({
  get: () => String(draft.value?.server?.port ?? 25565),
  set: (value: string) => {
    const target = draft.value
    if (!target) return
    target.server = { address: target.server?.address ?? '', port: toInt(value, 25565) }
  }
})

async function saveDraft(): Promise<void> {
  const target = draft.value
  if (!target) return
  if (!target.name.trim()) {
    draftError.value = text.text('nameRequired')
    return
  }
  if (target.server && !target.server.address) {
    draftError.value = t('online.address')
    return
  }
  savingDraft.value = true
  const saved = await instances.patch({
    id: target.id,
    name: target.name.trim(),
    description: target.description,
    memoryMb: target.memoryMb,
    jvmArgs: target.jvmArgs,
    resolution: { ...target.resolution },
    java: { ...target.java },
    server: target.server
  })
  savingDraft.value = false
  if (saved) draft.value = structuredClone(toRaw(saved))
}

watch(
  () => instances.summaries.value.length,
  (count) => {
    if (count === 0) drawerId.value = null
  }
)

onMounted(async () => {
  await Promise.all([instances.load(), versions.load(), settings.load(), loadAccounts(), launcher.refreshJobs()])
})
</script>

<template>
  <div class="instances">
    <header class="page-head">
      <div class="page-heading">
        <h1 class="page-title">{{ t('nav.instances') }}</h1>
        <p class="page-sub">
          {{ t('common.total', { n: instances.summaries.value.length }) }}
          <span v-if="query"> · {{ filtered.length }}</span>
        </p>
      </div>
      <div class="page-actions">
        <MSearch v-model="query" class="search" size="sm" hotkey="Ctrl+F" :placeholder="t('common.searchPlaceholder')" />
        <MSelect v-model="sort" class="sort" size="sm" :options="sortOptions" :placeholder="t('instance.sortBy')" />
        <MSegmented v-model="view" :options="viewOptions" size="sm" :equal="false" />
        <MButton size="sm" icon="pack" @click="importFlow">{{ t('launch.importModpack') }}</MButton>
        <MButton size="sm" variant="primary" icon="plus" @click="openCreate">{{ t('instance.new') }}</MButton>
      </div>
    </header>

    <div class="body" :class="{ 'has-drawer': !!drawerSummary }">
      <div class="content">
        <!-- loading -->
        <div v-if="instances.loading.value && !instances.summaries.value.length" class="grid">
          <MCard v-for="n in 6" :key="n" class="skeleton-card">
            <div class="skeleton-top">
              <MSkeleton variant="rect" width="40px" height="40px" rounded="var(--m-r-md)" />
              <div class="u-col">
                <MSkeleton width="150px" height="14px" />
                <MSkeleton width="96px" height="12px" />
              </div>
            </div>
            <MSkeleton :lines="2" height="12px" />
          </MCard>
        </div>

        <!-- error -->
        <MCard v-else-if="instances.error.value" tone="flat">
          <MEmpty icon="warning" :title="instances.error.value" :description="text.text('emptyHint')" compact>
            <MButton icon="refresh" @click="instances.load()">{{ t('common.retry') }}</MButton>
          </MEmpty>
        </MCard>

        <!-- zero state -->
        <MCard v-else-if="!instances.summaries.value.length" tone="flat">
          <MEmpty icon="cube" :title="text.text('emptyAll')" :description="text.text('emptyHint')">
            <MButton variant="primary" icon="plus" @click="openCreate">{{ t('instance.new') }}</MButton>
            <MButton icon="pack" @click="importFlow">{{ t('launch.importModpack') }}</MButton>
          </MEmpty>
        </MCard>

        <!-- no match -->
        <MCard v-else-if="!filtered.length" tone="flat">
          <MEmpty icon="search" :title="text.text('emptyFiltered')" :description="t('common.noMatch')" compact>
            <MButton icon="x" @click="query = ''">{{ t('common.clear') }}</MButton>
          </MEmpty>
        </MCard>

        <!-- grid -->
        <div v-else-if="view === 'grid'" class="grid">
          <MCard
            v-for="entry in filtered"
            :key="entry.instance.id"
            hoverable
            class="card"
            :class="{ 'is-active': instances.activeId.value === entry.instance.id }"
          >
            <div class="card-top" @click="instances.setActive(entry.instance.id)">
              <span class="card-icon">
                <MIcon :name="iconFor(entry.instance.icon)" :size="20" :stroke-width="1.2" tone="accent" />
              </span>
              <span class="card-titles">
                <span class="card-name u-truncate" :title="entry.instance.name">{{ entry.instance.name }}</span>
                <span class="card-sub u-truncate">
                  {{ entry.instance.gameVersion }} · {{ loaderLabel(entry.instance.loader) }}
                  <template v-if="entry.instance.loaderVersion"> {{ entry.instance.loaderVersion }}</template>
                </span>
              </span>
              <MMenu :items="menuItems" size="sm" @select="onMenu($event, entry.instance.id)">
                <template #trigger>
                  <MIconButton icon="drag" :label="text.text('actions')" size="sm" />
                </template>
              </MMenu>
            </div>

            <div class="card-tags">
              <MTag size="sm" :tone="badgeFor(entry.state).tone" :icon="badgeFor(entry.state).icon">
                {{ badgeFor(entry.state).label }}
              </MTag>
              <MTag size="sm">{{ t('instance.modCount', { n: entry.modCount }) }}</MTag>
              <MTag size="sm" :tone="entry.instance.isolated ? 'neutral' : 'warning'">
                {{ entry.instance.isolated ? t('instance.isolated') : t('instance.sharedRoot') }}
              </MTag>
            </div>

            <dl class="card-meta">
              <div>
                <dt>{{ t('common.size') }}</dt>
                <dd class="u-num">{{ formatBytes(entry.state.sizeBytes) }}</dd>
              </div>
              <div>
                <dt>{{ t('instance.lastPlayed') }}</dt>
                <dd>{{ formatRelative(entry.instance.lastPlayedAt ?? 0) }}</dd>
              </div>
              <div>
                <dt>{{ t('instance.memory') }}</dt>
                <dd class="u-num">{{ formatBytes(entry.instance.memoryMb * 1024 * 1024, 0) }}</dd>
              </div>
            </dl>

            <p class="card-checked u-muted u-num">{{ formatDateTime(entry.state.lastCheckedAt) }}</p>

            <div class="card-foot">
              <MButton
                size="sm"
                variant="primary"
                icon="play"
                :loading="launcher.launchingId.value === entry.instance.id"
                @click="quickLaunch(entry)"
              >
                {{ t('launch.start') }}
              </MButton>
              <MButton size="sm" variant="ghost" icon="gear" @click="openDrawer(entry.instance.id)">
                {{ text.text('settings') }}
              </MButton>
            </div>
          </MCard>
        </div>

        <!-- list -->
        <MCard v-else :padded="false" tone="flat">
          <MList
            :rows="listRows"
            :model-value="instances.activeId.value"
            :divided="true"
            @update:model-value="instances.setActive($event)"
          >
            <template #trailing="{ row }">
              <span class="row-trailing">
                <MTag size="sm" :tone="badgeFor(summaryById(row.id)!.state).tone">
                  {{ badgeFor(summaryById(row.id)!.state).label }}
                </MTag>
                <MButton size="sm" variant="ghost" icon="gear" @click.stop="openDrawer(row.id)">
                  {{ text.text('settings') }}
                </MButton>
              </span>
            </template>
          </MList>
        </MCard>
      </div>

      <!-- =============================================== settings drawer -->
      <aside v-if="drawerSummary && draft" class="drawer">
        <MCard tone="raised" :padded="false" class="drawer-card">
          <template #header>
            <span class="drawer-head">
              <MIcon :name="iconFor(draft.icon)" :size="20" tone="accent" />
              <span class="drawer-name u-truncate" :title="draft.name">{{ draft.name }}</span>
            </span>
          </template>
          <template #actions>
            <MIconButton icon="x" :label="text.text('closeDrawer')" size="sm" @click="drawerId = null" />
          </template>

          <div class="drawer-body">
            <MFieldRow :label="t('common.name')">
              <MInput v-model="draft.name" size="sm" :maxlength="64" />
            </MFieldRow>

            <MFieldRow :label="t('common.details')">
              <MInput v-model="draft.description" size="sm" :placeholder="t('common.optional')" />
            </MFieldRow>

            <MFieldRow :label="t('instance.memory')" :hint="`${draft.memoryMb} MB`">
              <MRange
                v-model="draft.memoryMb"
                :min="1024"
                :max="32768"
                :step="512"
                show-value
                :value-text="formatBytes(draft.memoryMb * 1024 * 1024, 0)"
              />
            </MFieldRow>

            <MFieldRow :label="t('java.mode')" :error="runtimeFailed">
              <div class="radio-col">
                <MRadio
                  v-for="mode in javaModes"
                  :key="mode.value"
                  :model-value="draft.java.mode"
                  :value="mode.value"
                  :label="mode.label"
                  @update:model-value="setJavaMode($event as InstanceJavaMode)"
                />
              </div>
            </MFieldRow>

            <MFieldRow
              v-if="draft.java.mode !== 'auto'"
              :label="t('java.path')"
              :hint="runtimes.length ? '' : text.text('javaNoneFound')"
            >
              <MSelect v-model="javaPath" :options="runtimeOptions" searchable :placeholder="t('common.selectPlaceholder')" />
            </MFieldRow>

            <MFieldRow :label="t('instance.gameVersion')">
              <p class="mono-line u-mono" :title="draft.versionId">{{ draft.versionId }}</p>
            </MFieldRow>

            <div class="pair">
              <MFieldRow :label="text.text('width')" control-width="112px">
                <MInput v-model="resWidth" type="number" :min="320" size="sm" mono />
              </MFieldRow>
              <MFieldRow :label="text.text('height')" control-width="112px">
                <MInput v-model="resHeight" type="number" :min="240" size="sm" mono />
              </MFieldRow>
            </div>

            <MFieldRow :label="text.text('fullscreen')">
              <MSwitch v-model="draft.resolution.fullscreen" />
            </MFieldRow>

            <MFieldRow :label="t('settings.jvmArgs')">
              <MTextarea v-model="draft.jvmArgs" :rows="2" resize="vertical" />
            </MFieldRow>

            <MFieldRow :label="text.text('serverTarget')">
              <div class="pair">
                <MInput v-model="serverAddress" size="sm" :placeholder="t('online.address')" />
                <MInput v-model="serverPort" size="sm" class="port" type="number" :placeholder="t('online.port')" mono />
              </div>
            </MFieldRow>

            <p v-if="draftError" class="inline-error">{{ draftError }}</p>

            <div class="drawer-foot">
              <MButton variant="primary" icon="check" :loading="savingDraft" @click="saveDraft">{{ text.text('apply') }}</MButton>
              <MButton variant="ghost" icon="refresh" @click="instances.refreshState(drawerSummary.instance.id)">
                {{ text.text('refreshState') }}
              </MButton>
            </div>

            <section class="jobs">
              <p class="jobs-title">{{ t('status.jobRunning') }}</p>
              <p v-if="!launcher.activeJobs.value.length" class="jobs-empty">{{ t('status.noJob') }}</p>
              <div v-for="row in launcher.activeJobs.value" :key="row.job.id" class="job">
                <span class="job-title u-truncate" :title="row.job.title">{{ row.job.title }}</span>
                <MProgress :percent="row.percent" size="sm" :label="row.statusLabel" />
              </div>
            </section>

            <MButton variant="outline" icon="home" @click="navigate('home')">{{ t('nav.home') }}</MButton>
          </div>
        </MCard>
      </aside>
    </div>

    <!-- ==================================================== create modal -->
    <MModal
      :open="createOpen"
      :title="t('instance.new')"
      :width="560"
      :confirm-text="t('common.create')"
      :cancel-text="t('common.cancel')"
      @update:open="createOpen = $event"
      @close="createOpen = false"
      @confirm="runCreate"
    >
      <MFieldRow :label="t('common.name')" required :error="createError">
        <MInput v-model="createForm.name" :placeholder="t('instance.namePlaceholder')" autofocus :maxlength="64" />
      </MFieldRow>

      <MFieldRow :label="t('instance.gameVersion')" :hint="versions.error.value">
        <MSelect
          v-model="createForm.versionId"
          :options="versionOptions"
          searchable
          :placeholder="t('demo.selectVersion')"
          @update:model-value="loadLoaderOptions"
        />
      </MFieldRow>

      <div class="pair">
        <MFieldRow :label="t('instance.loader')" control-width="168px">
          <MSelect v-model="createForm.loaderId" :options="loaderSelectOptions" :placeholder="text.text('loaderNone')" />
        </MFieldRow>
        <MFieldRow :label="t('common.version')" control-width="168px">
          <MSelect
            v-model="createForm.loaderVersion"
            :options="loaderVersionOptions"
            :disabled="createForm.loaderId === 'vanilla'"
            :placeholder="t('common.selectPlaceholder')"
          />
        </MFieldRow>
      </div>
      <p v-if="loaderError" class="inline-error">{{ loaderError }}</p>

      <MFieldRow :label="t('instance.isolated')" :hint="text.text('isolatedHint')">
        <MSwitch v-model="createForm.isolated" />
      </MFieldRow>

      <MFieldRow :label="t('instance.memory')" :hint="`${createForm.memoryMb} MB`">
        <MRange
          v-model="createForm.memoryMb"
          :min="1024"
          :max="32768"
          :step="512"
          show-value
          :value-text="formatBytes(createForm.memoryMb * 1024 * 1024, 0)"
        />
      </MFieldRow>

      <MFieldRow :label="t('account.title')">
        <MSelect v-model="createForm.accountId" :options="accountOptions" :placeholder="t('account.select')" />
      </MFieldRow>
    </MModal>

    <!-- ==================================================== rename modal -->
    <MModal
      :open="!!renameTarget"
      :title="t('instance.rename')"
      :width="420"
      :confirm-text="t('common.save')"
      :cancel-text="t('common.cancel')"
      @update:open="renameTarget = $event ? renameTarget : null"
      @close="renameTarget = null"
      @confirm="runRename"
    >
      <MFieldRow :label="t('common.name')" required :error="renameError">
        <MInput v-model="renameValue" :maxlength="64" autofocus @enter="runRename" />
      </MFieldRow>
    </MModal>

    <!-- ================================================= duplicate modal -->
    <MModal
      :open="!!copyTarget"
      :title="t('instance.duplicate')"
      :width="420"
      :confirm-text="t('common.create')"
      :cancel-text="t('common.cancel')"
      @update:open="copyTarget = $event ? copyTarget : null"
      @close="copyTarget = null"
      @confirm="runDuplicate"
    >
      <MFieldRow :label="t('common.name')" required>
        <MInput v-model="copyValue" :maxlength="64" autofocus @enter="runDuplicate" />
      </MFieldRow>
    </MModal>

    <!-- =================================================== delete modal -->
    <MModal
      :open="!!deleteTarget"
      :title="t('instance.remove')"
      :description="deleteTarget ? t('instance.removeConfirm', { name: deleteTarget.name }) : ''"
      :width="440"
      tone="danger"
      :confirm-text="t('common.delete')"
      :cancel-text="t('common.cancel')"
      @update:open="deleteTarget = $event ? deleteTarget : null"
      @close="deleteTarget = null"
      @confirm="runDelete"
    >
      <p class="modal-note">{{ text.text('deleteWarning') }}</p>
      <MCheckbox v-model="deleteFiles" :label="t('instance.removeFiles')" />
      <p v-if="deleteTarget" class="modal-path u-mono">
        {{ deleteTarget.id }} · {{ deleteTarget.isolated ? t('instance.isolated') : t('instance.sharedRoot') }}
      </p>
    </MModal>

    <!-- =================================================== import modal -->
    <MModal
      :open="importOpen"
      :title="text.text('importTitle')"
      :width="520"
      :confirm-text="t('common.import')"
      :cancel-text="t('common.cancel')"
      @update:open="importOpen = $event"
      @close="importOpen = false"
      @confirm="runImport"
    >
      <MFieldRow :label="text.text('importFile')">
        <p class="modal-path u-mono">{{ importForm.file }}</p>
      </MFieldRow>
      <MFieldRow :label="t('common.name')" :hint="text.text('importNameHint')" :error="importError">
        <MInput v-model="importForm.name" :placeholder="t('instance.namePlaceholder')" :maxlength="64" />
      </MFieldRow>
      <MFieldRow :label="text.text('format')">
        <MSelect v-model="importForm.format" :options="formatOptions" />
      </MFieldRow>
      <p v-if="importing" class="modal-note">{{ text.text('launching') }}</p>
    </MModal>
  </div>
</template>

<style scoped>
.instances {
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
  width: 208px;
}

.sort {
  width: 152px;
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--m-sp-4);
  align-items: start;
}

.body.has-drawer {
  grid-template-columns: minmax(0, 1fr) 340px;
}

.content {
  min-width: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
  gap: var(--m-sp-3);
}

.skeleton-card {
  gap: var(--m-sp-3);
}

.skeleton-top {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
}

.card {
  gap: var(--m-sp-2);
}

.card.is-active {
  border-color: var(--m-accent-line);
}

.card-top {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  min-width: 0;
  cursor: pointer;
}

.card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: none;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
}

.card-titles {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.card-name {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.card-sub {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--m-sp-1);
}

.card-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--m-sp-1);
}

.card-meta div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.card-meta dt {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.card-meta dd {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.card-checked {
  font-size: var(--m-fs-12);
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--m-sp-2);
}

.row-trailing {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex: none;
}

/* ---------------------------------------------------------------- drawer */
.drawer {
  position: sticky;
  top: 0;
  min-width: 0;
}

.drawer-card {
  height: 100%;
}

.drawer-head {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
}

.drawer-name {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.drawer-body {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  max-height: 640px;
  padding: var(--m-sp-4);
  overflow: auto;
}

.radio-col {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
}

.pair {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
  width: 100%;
}

.port {
  width: 92px;
  flex: none;
}

.mono-line {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
  overflow-wrap: anywhere;
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

.drawer-foot {
  display: flex;
  gap: var(--m-sp-2);
}

.jobs {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  padding-top: var(--m-sp-3);
  border-top: var(--m-line) solid var(--m-border-hairline);
}

.jobs-title {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.jobs-empty {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.job {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.job-title {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

/* ---------------------------------------------------------------- modals */
.modal-note {
  font-size: var(--m-fs-13);
  line-height: var(--m-lh-loose);
  color: var(--m-text-secondary);
}

.modal-path {
  font-size: var(--m-fs-12);
  overflow-wrap: anywhere;
}
</style>

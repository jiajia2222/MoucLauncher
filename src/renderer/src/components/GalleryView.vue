<script setup lang="ts">
/**
 * 组件画廊 — the temporary, route-less gallery that proves every primitive exists, is
 * styled only by tokens, and is exercised at least once. Reachable with `#gallery`.
 *
 * It doubles as the visual test bench: the icon strip is rendered at its real 16px size,
 * every state (disabled / loading / error / empty / indeterminate) is on screen at once.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import MIcon from './icons/MIcon.vue'
import { ICON_NAMES } from './icons/paths'
import MButton from './ui/MButton.vue'
import MIconButton from './ui/MIconButton.vue'
import MInput from './ui/MInput.vue'
import MTextarea from './ui/MTextarea.vue'
import MSearch from './ui/MSearch.vue'
import MSelect from './ui/MSelect.vue'
import MMenu from './ui/MMenu.vue'
import MSwitch from './ui/MSwitch.vue'
import MCheckbox from './ui/MCheckbox.vue'
import MRadio from './ui/MRadio.vue'
import MRange from './ui/MRange.vue'
import MProgress from './ui/MProgress.vue'
import MCard from './ui/MCard.vue'
import MTag from './ui/MTag.vue'
import MBadge from './ui/MBadge.vue'
import MTooltip from './ui/MTooltip.vue'
import MModal from './ui/MModal.vue'
import MList from './ui/MList.vue'
import MEmpty from './ui/MEmpty.vue'
import MSkeleton from './ui/MSkeleton.vue'
import MKbd from './ui/MKbd.vue'
import MTable from './ui/MTable.vue'
import MSegmented from './ui/MSegmented.vue'
import MFieldRow from './ui/MFieldRow.vue'
import type { ListRow, MenuItem, SelectOption, SortDirection, TableColumn, TableRow } from './ui/types'
import { t } from '../i18n'
import { useToast } from '../composables/useToast'
import { useModal } from '../composables/useModal'
import { formatBytes, formatSpeed } from '../composables/format'

const toast = useToast()
const modal = useModal()

/* ------------------------------------------------------------------- inputs */
const text = ref('D:\\Games\\Minecraft')
const emptyText = ref('')
const password = ref('seeduser2026')
const clearable = ref('可清空的内容')
const note = ref('')
const readonlyValue = ref('1.21.1+fabric.0.16.14')
const search = ref('')
const searchBusy = ref(false)

const versions: SelectOption[] = [
  { value: '26.3', label: '26.3', hint: t('version.type.release'), icon: 'star' },
  { value: '26.4-snapshot-1', label: '26.4-snapshot-1', hint: t('version.type.snapshot'), icon: 'clock' },
  { value: '1.21.8', label: '1.21.8', hint: t('version.latestRelease') },
  { value: '1.21.1', label: '1.21.1', hint: 'Fabric 0.16.14' },
  { value: '1.12.2', label: '1.12.2', hint: t('java.missing', { major: 8 }), disabled: true }
]
const chosenVersion = ref('26.3')

const loaders: SelectOption[] = [
  { value: 'vanilla', label: 'Vanilla', icon: 'cube' },
  { value: 'fabric', label: 'Fabric', icon: 'layers', hint: '0.16.14' },
  { value: 'neoforge', label: 'NeoForge', icon: 'beaker', hint: '21.4.90-beta' },
  { value: 'quilt', label: 'Quilt', icon: 'box', hint: '0.27.0-beta.4' }
]
const chosenLoader = ref('fabric')

const menuItems: MenuItem[] = [
  { id: 'open', labelKey: 'gallery.menuOpenDir', icon: 'folder' },
  { id: 'copy', labelKey: 'gallery.menuCopy', icon: 'copy' },
  { id: 'pin', labelKey: 'instance.pin', icon: 'pin', checked: true },
  { id: 'sep', separator: true },
  { id: 'remove', labelKey: 'gallery.menuDelete', icon: 'trash', danger: true }
]
const lastMenuAction = ref('')

const switchOn = ref(true)
const strict = ref(false)
const checkbox = ref(true)
const indeterminate = ref(false)
const radio = ref('auto')
const range = ref(4096)
const segment = ref('list')

const fieldError = computed(() => (text.value.trim().length === 0 ? t('settings.gameRoot') : ''))

/* ------------------------------------------------------------------ surfaces */
const listRows = computed<ListRow[]>(() => [
  { id: 'a', label: t('demo.instanceFabric'), hint: '1.21.1 · Fabric 0.16.14', icon: 'cube', meta: '6 ' + t('nav.mods') },
  { id: 'b', label: t('demo.instanceBroken'), hint: t('instance.stateBroken'), icon: 'warning', meta: '137', disabled: false },
  { id: 'c', label: t('demo.serverName'), hint: 'mc.example.net:25565', icon: 'server', meta: '42 ms' }
])
const selectedRow = ref('a')

const columns: TableColumn[] = [
  { key: 'name', labelKey: 'demo.rowA', sortable: true },
  { key: 'version', labelKey: 'demo.rowB', width: '128px', mono: true },
  { key: 'loader', labelKey: 'instance.loader', width: '120px' },
  { key: 'state', labelKey: 'common.status', width: '120px', align: 'end' },
  { key: 'enabled', labelKey: 'common.enabled', width: '72px', align: 'end' }
]
const sortKey = ref('name')
const direction = ref<SortDirection>('asc')

const tableSource: TableRow[] = [
  { id: 't1', name: 'Sodium', version: '0.6.6', loader: 'fabric', state: t('instance.stateOk'), enabled: true },
  { id: 't2', name: 'Lithium', version: '0.14.7', loader: 'quilt', state: t('mod.disable'), enabled: false },
  { id: 't3', name: 'Create', version: '0.6.2', loader: 'neoforge', state: t('mod.update'), enabled: true },
  { id: 't4', name: t('demo.instanceBroken'), version: '—', loader: 'fabric', state: t('instance.stateBroken'), enabled: true }
]

const tableRows = computed<TableRow[]>(() => {
  const key = sortKey.value
  const dir = direction.value === 'desc' ? -1 : 1
  if (!key || !direction.value) return tableSource
  return [...tableSource].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir)
})

const toggled = reactive<Record<string, boolean>>({ t1: true, t2: false, t3: true, t4: true })

/* ------------------------------------------------------------------ feedback */
const ringPercent = ref(63)
const bytesDone = ref(38_400_000)
const bytesTotal = 184_000_000
const speed = ref(7_400_000)

const modalOpen = ref(false)
const keepFiles = ref(false)

const badges = reactive({ mods: 12, updates: 0, big: 240 })

function pushAll(): void {
  toast.push({ kind: 'info', titleKey: 'toast.demoInfo' })
  toast.push({ kind: 'success', titleKey: 'toast.demoSuccess' })
  toast.push({ kind: 'warning', titleKey: 'toast.demoWarning' })
  toast.push({ kind: 'danger', titleKey: 'toast.demoDanger', vars: { reason: t('status.offline') } })
}

async function askConfirm(): Promise<void> {
  const yes = await modal.confirm({
    titleKey: 'instance.remove',
    text: t('instance.removeConfirm', { name: t('demo.instanceFabric') }),
    tone: 'danger',
    confirmKey: 'common.delete',
    cancelKey: 'common.cancel'
  })
  if (yes) toast.push({ kind: 'success', titleKey: 'toast.demoSuccess' })
}

function startDemoJob(): void {
  bytesDone.value = 0
}

function confirmModal(): void {
  modalOpen.value = false
  toast.push({ kind: 'success', titleKey: 'toast.demoSuccess', message: keepFiles.value ? t('instance.removeFiles') : t('common.none') })
}

let heartbeat: number | null = null

onMounted(() => {
  heartbeat = window.setInterval(() => {
    if (bytesDone.value < bytesTotal) {
      bytesDone.value = Math.min(bytesTotal, bytesDone.value + speed.value * 0.4)
      ringPercent.value = Math.round((bytesDone.value / bytesTotal) * 100)
    }
  }, 400)
})

onBeforeUnmount(() => {
  if (heartbeat !== null) window.clearInterval(heartbeat)
  heartbeat = null
})

const iconFilter = ref('')
const visibleIcons = computed(() =>
  iconFilter.value ? ICON_NAMES.filter((name) => name.includes(iconFilter.value.toLowerCase())) : ICON_NAMES
)
</script>

<template>
  <div class="gallery">
    <header class="page-head">
      <div class="head-main">
        <h1 class="page-title">{{ t('gallery.title') }}</h1>
        <p class="page-sub">{{ t('gallery.subtitle') }}</p>
      </div>
      <div class="head-actions">
        <MKbd :keys="['Esc']" />
        <span class="muted">{{ t('gallery.hint') }}</span>
      </div>
    </header>

    <!-- ================================================== buttons & input -->
    <MCard class="block" :title="t('gallery.groupActions')" icon="play">
      <div class="line">
        <MButton variant="primary" :icon="'play'">{{ t('launch.start') }}</MButton>
        <MButton variant="outline" :icon="'download'">{{ t('version.install') }}</MButton>
        <MButton variant="ghost" :icon="'refresh'">{{ t('common.refresh') }}</MButton>
        <MButton variant="danger" :icon="'trash'">{{ t('common.delete') }}</MButton>
        <MButton variant="primary" loading>{{ t('launch.launching') }}</MButton>
        <MButton variant="outline" disabled>{{ t('common.retry') }}</MButton>
        <MButton variant="outline" trailing-icon="chevron-down">{{ t('common.sort') }}</MButton>
      </div>
      <div class="line">
        <MButton size="sm" variant="primary">{{ t('common.save') }}</MButton>
        <MButton size="md" variant="primary">{{ t('common.save') }}</MButton>
        <MButton size="lg" variant="primary">{{ t('common.save') }}</MButton>
        <span class="divider-v" />
        <MIconButton icon="search" :label="t('common.searchPlaceholder')" />
        <MIconButton icon="gear" :label="t('nav.settings')" active />
        <MIconButton icon="pin" :label="t('instance.pin')" variant="outline" />
        <MIconButton icon="trash" :label="t('common.delete')" tone="danger" />
        <MIconButton icon="refresh" :label="t('common.loading')" loading />
        <MIconButton icon="drag" :label="t('common.more')" size="sm" />
      </div>

      <div class="grid-2">
        <MFieldRow :label="t('demo.fieldLabel')" :hint="t('demo.fieldHint')" :error="fieldError" inline>
          <MInput v-model="text" icon="folder" clearable :error="fieldError" :placeholder="t('demo.fieldLabel')" />
        </MFieldRow>
        <MFieldRow :label="t('common.size')" :hint="t('demo.fieldHint2')" inline>
          <MInput v-model="emptyText" :placeholder="t('common.searchPlaceholder')" />
        </MFieldRow>
        <MFieldRow label="authlib-injector" inline>
          <MInput v-model="password" type="password" />
        </MFieldRow>
        <MFieldRow :label="t('instance.gameVersion')" inline>
          <MInput :model-value="readonlyValue" readonly />
        </MFieldRow>
        <MFieldRow :label="t('demo.fieldLabel2')" inline>
          <MRange v-model="range" :min="1024" :max="16384" :step="512" show-value :value-text="formatBytes(range * 1024 * 1024)" :marks="[1024, 8192, 16384]" />
        </MFieldRow>
        <MFieldRow :label="t('log.console')" inline>
          <MTextarea v-model="note" :rows="3" :placeholder="t('crash.evidence')" :maxlength="240" />
        </MFieldRow>
      </div>

      <div class="line">
        <MSearch v-model="search" :loading="searchBusy" class="search-wide" :hotkey="'Ctrl+F'" :placeholder="t('mod.search')" @search="searchBusy = false" />
        <MSearch v-model="clearable" :loading="true" class="search-narrow" :placeholder="t('online.address')" />
      </div>
    </MCard>

    <!-- ======================================================== selection -->
    <MCard class="block" :title="t('gallery.groupSelection')" icon="check">
      <div class="grid-2">
        <MFieldRow :label="t('demo.selectVersion')" inline>
          <MSelect v-model="chosenVersion" :options="versions" :placeholder="t('common.selectPlaceholder')" />
        </MFieldRow>
        <MFieldRow :label="t('demo.selectLoader')" inline>
          <MSelect v-model="chosenLoader" :options="loaders" searchable />
        </MFieldRow>
        <MFieldRow :label="t('java.mode')" inline>
          <div class="radio-col">
            <MRadio v-model="radio" value="auto" :label="t('java.mode.auto')" :hint="t('java.inUse')" />
            <MRadio v-model="radio" value="mojang" :label="t('java.mode.mojang')" />
            <MRadio v-model="radio" value="custom" :label="t('java.mode.custom')" disabled />
          </div>
        </MFieldRow>
        <MFieldRow :label="t('gallery.controlGroup')" inline>
          <div class="line">
            <MSwitch v-model="switchOn" :label="t('settings.resume')" />
            <MSwitch v-model="strict" size="sm" :label="t('settings.strict')" />
            <MCheckbox v-model="checkbox" :label="t('instance.removeFiles')" />
            <MCheckbox v-model="indeterminate" :indeterminate="true" :label="t('common.selectAll')" />
          </div>
        </MFieldRow>
      </div>

      <div class="line">
        <MMenu :items="menuItems" @select="((id) => (lastMenuAction = id))">
          <template #trigger>
            <MButton variant="outline" trailing-icon="chevron-down">{{ t('common.more') }}</MButton>
          </template>
        </MMenu>
        <MMenu :items="menuItems" align="start" trigger-icon="chevron-down" :trigger-label-key="'common.filter'" @select="((id) => (lastMenuAction = id))" />
        <span v-if="lastMenuAction" class="muted">{{ t('common.details') }}: {{ lastMenuAction }}</span>
        <span class="divider-v" />
        <MSegmented
          v-model="segment"
          :options="[
            { value: 'list', label: t('common.name'), icon: 'sort' },
            { value: 'grid', label: t('gallery.groupSurfaces'), icon: 'box' },
            { value: 'table', label: t('common.status'), icon: 'layers' }
          ]"
        />
        <MSegmented
          size="sm"
          v-model="segment"
          :options="[
            { value: 'list', icon: 'sort', labelKey: 'common.name' },
            { value: 'grid', icon: 'box', labelKey: 'gallery.groupSurfaces' }
          ]"
        />
      </div>
    </MCard>

    <!-- ========================================================= feedback -->
    <MCard class="block" :title="t('gallery.groupFeedback')" icon="download">
      <div class="progress-grid">
        <div class="u-col">
          <MProgress :percent="42" size="sm" :label="t('demo.progressTitle')" />
          <MProgress :percent="68" show-bytes show-meta :bytes-done="bytesDone" :bytes-total="bytesTotal" :speed="speed" :eta-seconds="38" label="Fabric 0.16.14" />
          <MProgress :indeterminate="true" :label="t('common.loading')" />
          <MProgress :percent="100" status="success" :label="t('status.jobDone')" />
          <MProgress :percent="31" status="error" :label="t('status.jobFailed')" />
          <MProgress :percent="12" status="paused" :label="t('status.jobPaused')" />
        </div>
        <div class="ring-row">
          <MProgress kind="ring" size="lg" :percent="ringPercent" :label="t('launch.checking')" />
          <MProgress kind="ring" size="md" :percent="24" status="warning" />
          <MProgress kind="ring" size="sm" :indeterminate="true" />
        </div>
      </div>

      <div class="line">
        <MTag>{{ t('common.unknown') }}</MTag>
        <MTag tone="accent" :icon="'layers'">Fabric</MTag>
        <MTag tone="success" dot>{{ t('instance.stateOk') }}</MTag>
        <MTag tone="warning" dot>{{ t('account.token.needsRefresh') }}</MTag>
        <MTag tone="danger" closable @close="() => {}">{{ t('crash.severity.critical') }}</MTag>
        <MTag size="sm">{{ t('version.type.snapshot') }}</MTag>
        <span class="divider-v" />
        <MBadge :value="badges.mods" tone="accent">
          <MButton variant="outline" :icon="'mod'">{{ t('nav.mods') }}</MButton>
        </MBadge>
        <MBadge :value="badges.updates" tone="danger" hide-when-zero>
          <MIconButton icon="update" :label="t('mod.update')" />
        </MBadge>
        <MBadge :value="badges.big" :max="99" tone="warning" />
        <MBadge dot tone="success" />
      </div>

      <div class="line">
        <MTooltip :content="t('demo.kbdHint', { keys: 'Alt+1' })" :detail="t('online.relayCopyHint')">
          <MButton variant="ghost">{{ t('common.details') }}</MButton>
        </MTooltip>
        <MTooltip placement="right" :content="t('status.theme')">
          <MIconButton icon="palette" :label="t('status.theme')" />
        </MTooltip>
        <MKbd :keys="['Ctrl', 'F']" />
        <MKbd :keys="'Alt+1'" size="md" />
      </div>

      <div class="line">
        <MButton size="sm" variant="outline" @click="pushAll">{{ t('gallery.pushToast') }}</MButton>
        <MButton size="sm" variant="outline" @click="modalOpen = true">{{ t('gallery.openModal') }}</MButton>
        <MButton size="sm" variant="danger" @click="askConfirm">{{ t('instance.remove') }}</MButton>
        <MButton size="sm" variant="ghost" @click="startDemoJob">{{ t('demo.progressTitle') }}</MButton>
      </div>

      <div class="skeleton-row">
        <MSkeleton variant="circle" width="40px" height="40px" />
        <div class="u-col grow">
          <MSkeleton :lines="2" />
          <MSkeleton variant="text" width="40%" />
        </div>
        <MSkeleton variant="rect" width="64px" height="24px" />
      </div>
    </MCard>

    <!-- ======================================================== surfaces -->
    <div class="card-pair">
      <MCard class="block" :title="t('gallery.groupSurfaces')" icon="box" tone="raised">
        <template #actions>
          <MIconButton icon="plus" :label="t('instance.new')" size="sm" />
          <MIconButton icon="filter" :label="t('common.filter')" size="sm" />
        </template>
        <MList v-model="selectedRow" :rows="listRows" :marker="true">
          <template #trailing="{ row }">
            <MTag v-if="row.id === 'b'" tone="danger" size="sm">{{ t('instance.stateBroken') }}</MTag>
          </template>
        </MList>
        <MTable v-model:sort-key="sortKey" v-model:direction="direction" :columns="columns" :rows="tableRows" dense>
          <template #cell="{ row, column }">
            <MTag v-if="column.key === 'state' && row.state" size="sm" :tone="row.state === t('instance.stateOk') ? 'success' : row.state === t('instance.stateBroken') ? 'danger' : 'warning'">
              {{ row.state }}
            </MTag>
            <MSwitch v-else-if="column.key === 'enabled'" v-model="toggled[String(row.id)]" size="sm" />
            <span v-else-if="column.mono" class="u-mono">{{ row[column.key] }}</span>
            <span v-else>{{ row[column.key] }}</span>
          </template>
        </MTable>
      </MCard>

      <MCard class="block" :title="t('gallery.rangeLow') + ' / ' + t('gallery.rangeHigh')" icon="info">
        <MEmpty :title="t('demo.emptyTitle')" :description="t('demo.emptyDesc')">
          <MButton variant="primary" :icon="'plus'" @click="() => {}">{{ t('launch.createFirst') }}</MButton>
          <MButton variant="outline" :icon="'pack'" @click="() => {}">{{ t('launch.importModpack') }}</MButton>
        </MEmpty>
        <div class="line">
          <MTag tone="accent" dot>{{ formatBytes(bytesTotal) }}</MTag>
          <MTag tone="neutral">{{ formatSpeed(speed) }}</MTag>
        </div>
      </MCard>
    </div>

    <!-- ============================================================ icons -->
    <MCard class="block" :title="t('gallery.groupIcons')" icon="star">
      <template #actions>
        <MSearch v-model="iconFilter" class="icon-filter" :placeholder="t('common.searchPlaceholder')" :debounce="0" />
      </template>
      <div class="icon-strip">
        <span v-for="name in visibleIcons" :key="name" class="icon-cell">
          <MIcon :name="name" :size="16" />
        </span>
      </div>
      <div class="icon-strip">
        <span v-for="name in visibleIcons" :key="'lg-' + name" class="icon-cell wide">
          <MIcon :name="name" :size="20" />
          <span class="icon-name">{{ name }}</span>
        </span>
      </div>
    </MCard>

    <!-- ==================== declarative modal (focus trap + teleport live) -->
    <MModal
      v-model:open="modalOpen"
      :title="t('demo.modalTitle')"
      :description="t('demo.modalBody', { name: t('demo.instanceFabric') })"
      :confirm-text="t('common.confirm')"
      :cancel-text="t('common.cancel')"
      @confirm="confirmModal"
    >
      <MCheckbox v-model="keepFiles" :label="t('demo.modalKeepFiles')" />
      <MFieldRow :label="t('instance.namePlaceholder')" inline>
        <MInput v-model="text" clearable />
      </MFieldRow>
    </MModal>
  </div>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-4);
  padding: var(--m-sp-5);
  max-width: 1200px;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--m-sp-4);
}

.page-title {
  font-size: var(--m-fs-20);
  line-height: var(--m-lh-tight);
}

.page-sub {
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  white-space: nowrap;
}

.block {
  scroll-margin-top: var(--m-sp-4);
}

.line {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
}

.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--m-sp-3) var(--m-sp-5);
}

.radio-col {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
}

.divider-v {
  width: var(--m-line);
  height: 20px;
  background: var(--m-border-hairline);
}

.search-wide {
  max-width: 320px;
}

.search-narrow {
  width: 220px;
}

.progress-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--m-sp-5);
  align-items: center;
}

.ring-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-4);
}

.skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-md);
  background: var(--m-surface-base);
}

.grow {
  flex: 1 1 auto;
}

.card-pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--m-sp-4);
  align-items: start;
}

.icon-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--m-sp-2);
}

.icon-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-xs);
  background: var(--m-surface-base);
  color: var(--m-text-secondary);
}

.icon-cell.wide {
  width: 96px;
  height: 48px;
  flex-direction: column;
  gap: 2px;
}

.icon-name {
  font-family: var(--m-font-mono);
  font-size: 10px;
  color: var(--m-text-muted);
  white-space: nowrap;
}

.icon-filter {
  width: 180px;
}

.muted {
  color: var(--m-text-muted);
}
</style>

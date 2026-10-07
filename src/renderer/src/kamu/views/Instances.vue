<script setup lang="ts">
/**
 * Instances — port of KAMUCL's instance library + `InstanceCenter.vue` entry points.
 *
 * Row density, the ⋯ float menu and the confirmation sheet follow upstream's GameView
 * installed-list (`min-height:var(--row-h)`, `.installed-row`, `.instance-more`,
 * `.float-menu.instance-more-menu`). Every field comes from `mouc.instance.*`: the badges are
 * derived from the real `InstanceState`, the size from `state.sizeBytes`, the mod count from
 * `summary.modCount`.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Instance, InstanceSummary } from '@shared/types'
import { formatBytes, formatDateTime, formatRelative } from '../../composables/format'
import { useToast } from '../../composables/useToast'
import { navigate } from '../../composables/useNav'
import {
  deleteInstance,
  duplicateInstance,
  formatMemory,
  gameVersionOf,
  instanceHealth,
  listInstances,
  loaderLabel,
  openInstanceFolder,
  refreshInstanceState,
  validateInstanceName
} from '../api/instances'
import { installedVersionIds, repairVersion } from '../api/versions'
import InstanceCenterPanel from '../components/InstanceCenterPanel.vue'
import InstanceCenterProgress from '../components/InstanceCenterProgress.vue'
import InstancesCreateModal from '../components/InstancesCreateModal.vue'
import InstancesModpackModal from '../components/InstancesModpackModal.vue'

type HealthFilter = 'all' | 'complete' | 'attention'
type SortKey = 'played' | 'name' | 'size' | 'health'

const toast = useToast()

const summaries = ref<InstanceSummary[]>([])
const installed = ref<string[]>([])
const loading = ref(true)
const busyId = ref('')
const error = ref('')
const notice = ref('')
const query = ref('')
const healthFilter = ref<HealthFilter>('all')
const sort = ref<SortKey>('played')

const createOpen = ref(false)
const centerSummary = ref<InstanceSummary | null>(null)
const modpack = ref<{ mode: 'import' | 'export'; instance: Instance | null } | null>(null)
const pendingDelete = ref<InstanceSummary | null>(null)
const deleteFiles = ref(true)
const deleting = ref(false)

const menu = ref<{ id: string; top: number; left: number } | null>(null)
const menuTrigger = ref<HTMLElement | null>(null)

const healthFilters: Array<{ value: HealthFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'complete', label: '完整' },
  { value: 'attention', label: '需关注' }
]

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'played', label: '按最近游玩' },
  { value: 'name', label: '按名称' },
  { value: 'size', label: '按占用空间' },
  { value: 'health', label: '按状态' }
]

const instances = computed(() => summaries.value.map((summary) => summary.instance))

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const rows = summaries.value.filter((summary) => {
    const health = instanceHealth(summary.state)
    if (healthFilter.value === 'complete' && health.health !== 'complete') return false
    if (healthFilter.value === 'attention' && health.health === 'complete') return false
    if (!needle) return true
    return (
      summary.instance.name.toLowerCase().includes(needle) ||
      gameVersionOf(summary).toLowerCase().includes(needle) ||
      summary.instance.loader.toLowerCase().includes(needle) ||
      summary.instance.description.toLowerCase().includes(needle)
    )
  })
  const order: Record<string, number> = { repair: 0, uninstalled: 1, missing: 2, complete: 3 }
  return [...rows].sort((a, b) => {
    if (sort.value === 'name') return a.instance.name.localeCompare(b.instance.name, 'zh-CN')
    if (sort.value === 'size') return b.state.sizeBytes - a.state.sizeBytes
    if (sort.value === 'health') return order[instanceHealth(a.state).health] - order[instanceHealth(b.state).health]
    return (b.instance.lastPlayedAt ?? 0) - (a.instance.lastPlayedAt ?? 0)
  })
})

const totals = computed(() => {
  const complete = summaries.value.filter((summary) => instanceHealth(summary.state).health === 'complete').length
  const bytes = summaries.value.reduce((acc, summary) => acc + summary.state.sizeBytes, 0)
  return { complete, attention: summaries.value.length - complete, bytes }
})

function fail(cause: unknown, fallback: string): void {
  error.value = cause instanceof Error ? cause.message : fallback
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, installedIds] = await Promise.all([listInstances(), installedVersionIds()])
    summaries.value = list
    installed.value = installedIds
  } catch (cause: unknown) {
    fail(cause, '实例列表读取失败')
  } finally {
    loading.value = false
  }
}

async function rerun(): Promise<void> {
  notice.value = ''
  await load()
}

/** One-row reload so a state check does not disturb the whole list. */
async function checkState(summary: InstanceSummary): Promise<void> {
  busyId.value = summary.instance.id
  error.value = ''
  try {
    const fresh = await refreshInstanceState(summary.instance.id)
    const index = summaries.value.findIndex((entry) => entry.instance.id === fresh.instance.id)
    if (index >= 0) summaries.value = [...summaries.value.slice(0, index), fresh, ...summaries.value.slice(index + 1)]
    if (centerSummary.value?.instance.id === fresh.instance.id) centerSummary.value = fresh
    notice.value = `${fresh.instance.name}：${instanceHealth(fresh.state).label}`
  } catch (cause: unknown) {
    fail(cause, '状态校验失败')
  } finally {
    busyId.value = ''
  }
}

async function copy(summary: InstanceSummary): Promise<void> {
  busyId.value = summary.instance.id
  error.value = ''
  const suggestion = `${summary.instance.name}-副本`
  const taken = instances.value
  let candidate = suggestion
  let counter = 2
  while (validateInstanceName(candidate, taken, summary.instance.id)) {
    candidate = `${suggestion}${counter}`
    counter += 1
  }
  try {
    await duplicateInstance(summary.instance.id, candidate)
    toast.push({ kind: 'success', title: `已创建副本 ${candidate}` })
    await load()
  } catch (cause: unknown) {
    fail(cause, '复制实例失败')
  } finally {
    busyId.value = ''
  }
}

async function openFolder(summary: InstanceSummary): Promise<void> {
  error.value = ''
  try {
    await openInstanceFolder(summary.instance.id)
  } catch (cause: unknown) {
    fail(cause, '无法打开实例目录')
  }
}

async function repair(summary: InstanceSummary): Promise<void> {
  busyId.value = summary.instance.id
  error.value = ''
  try {
    const job = await repairVersion(summary.instance.versionId)
    toast.push({ kind: 'info', title: `修复任务已加入队列：${job.title}` })
  } catch (cause: unknown) {
    fail(cause, '修复任务创建失败')
  } finally {
    busyId.value = ''
  }
}

function askDelete(summary: InstanceSummary): void {
  pendingDelete.value = summary
  deleteFiles.value = true
  error.value = ''
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  if (!target) return
  deleting.value = true
  error.value = ''
  try {
    await deleteInstance(target.instance.id, deleteFiles.value)
    toast.push({
      kind: 'success',
      title: deleteFiles.value ? `已删除并清理 ${target.instance.name}` : `已从启动器移除 ${target.instance.name}`
    })
    pendingDelete.value = null
    if (centerSummary.value?.instance.id === target.instance.id) centerSummary.value = null
    await load()
  } catch (cause: unknown) {
    fail(cause, '删除实例失败')
  } finally {
    deleting.value = false
  }
}

/* ------------------------------------------------------------ float menu */

const MENU_WIDTH = 240
const MENU_HEIGHT = 300

function openMenu(event: MouseEvent, summary: InstanceSummary): void {
  const trigger = event.currentTarget as HTMLElement | null
  menuTrigger.value = trigger
  if (menu.value?.id === summary.instance.id) {
    closeMenu()
    return
  }
  const rect = trigger?.getBoundingClientRect()
  if (!rect) return
  menu.value = {
    id: summary.instance.id,
    top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - MENU_HEIGHT - 8)),
    left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
  }
}

function closeMenu(): void {
  menu.value = null
  menuTrigger.value?.focus()
}

function menuAction(action: (summary: InstanceSummary) => void): void {
  const summary = summaries.value.find((entry) => entry.instance.id === menu.value?.id)
  closeMenu()
  if (summary) action(summary)
}

function onGlobalPointer(event: PointerEvent): void {
  if (!menu.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.instance-more-menu')) return
  closeMenu()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && menu.value) closeMenu()
}

const menuSummary = computed(() => summaries.value.find((entry) => entry.instance.id === menu.value?.id) ?? null)

/* ----------------------------------------------------------------- panel */

function openCenter(summary: InstanceSummary): void {
  centerSummary.value = summary
}

/** Everything except the instance being managed — the rename check inside the panel. */
const centerSiblings = computed(() =>
  instances.value.filter((entry) => entry.id !== centerSummary.value?.instance.id)
)

function onPanelRefresh(): void {
  void load()
}

function onModpackDone(payload: { kind: 'import' | 'export'; manifest?: { name: string; files: number; gameVersion: string } }): void {
  modpack.value = null
  toast.push({
    kind: 'success',
    title: payload.kind === 'import' ? `正在导入 ${payload.manifest?.name ?? '整合包'}` : '导出任务已开始'
  })
  void load()
}

function onCreated(): void {
  createOpen.value = false
  toast.push({ kind: 'success', title: '实例已创建，首次启动前请确认运行文件已下载' })
  void load()
}

onMounted(() => {
  window.addEventListener('pointerdown', onGlobalPointer, true)
  window.addEventListener('keydown', onKeydown, true)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onGlobalPointer, true)
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <section class="page instances-page">
    <header class="page-head">
      <div class="page-heading">
        <h1 class="page-title">实例中心</h1>
        <p class="page-sub">
          <span v-if="loading">正在读取实例…</span>
          <span v-else>{{ summaries.length }} 个实例 · {{ totals.complete }} 个完整 · {{ totals.attention }} 个需关注 · 共 {{ formatBytes(totals.bytes) }}</span>
        </p>
      </div>
      <div class="page-actions">
        <div class="tool-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="query" aria-label="搜索实例" placeholder="搜索实例名称、版本、加载器…" />
        </div>
        <select v-model="sort" class="select instances-sort" aria-label="实例排序">
          <option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <button class="btn btn-ghost" @click="modpack = { mode: 'import', instance: null }">导入整合包</button>
        <button class="btn btn-gold" @click="createOpen = true">新建实例</button>
      </div>
    </header>

    <div class="instances-bar">
      <div class="filter-capsules" role="group" aria-label="实例状态筛选">
        <button
          v-for="entry in healthFilters"
          :key="entry.value"
          class="capsule"
          :class="{ active: healthFilter === entry.value }"
          :aria-pressed="healthFilter === entry.value"
          @click="healthFilter = entry.value"
        >
          {{ entry.label }}
          <span class="category-count">
            {{
              entry.value === 'all'
                ? summaries.length
                : entry.value === 'complete'
                  ? totals.complete
                  : totals.attention
            }}
          </span>
        </button>
      </div>
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="rerun">{{ loading ? '刷新中…' : '刷新列表' }}</button>
    </div>

    <InstanceCenterProgress label="实例相关任务" @changed="onPanelRefresh" />

    <p v-if="error" class="status-strip error" role="alert">
      {{ error }}
      <button class="btn btn-sm" :disabled="loading" @click="rerun">重新加载</button>
    </p>
    <p v-else-if="notice" class="status-strip" role="status">{{ notice }}</p>

    <div v-if="loading && !summaries.length" class="card list-card">
      <div class="empty"><span class="spin"></span><span>正在读取实例…</span></div>
    </div>

    <div v-else-if="!summaries.length" class="card list-card">
      <div class="empty">
        <span>还没有游戏实例。先安装一个版本，或直接导入整合包。</span>
        <div class="row-actions">
          <button class="btn btn-gold" @click="createOpen = true">新建实例</button>
          <button class="btn btn-ghost" @click="navigate('versions')">前往版本管理</button>
        </div>
      </div>
    </div>

    <div v-else-if="!filtered.length" class="card list-card">
      <div class="empty">
        <span>{{ query ? `没有匹配「${query}」的实例` : '当前筛选条件下没有实例' }}</span>
        <button class="btn btn-ghost btn-sm" @click="query = ''; healthFilter = 'all'">查看全部实例</button>
      </div>
    </div>

    <section v-else class="card list-card instances-list-card">
      <div class="instance-list">
        <article v-for="summary in filtered" :key="summary.instance.id" class="installed-row instance-row" :data-health="instanceHealth(summary.state).health">
          <span class="inst-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48">
              <polygon points="24,5 43,14.5 24,24 5,14.5" fill="#79c144" />
              <polygon points="5,14.5 24,24 24,29.5 5,20" fill="#5da236" />
              <polygon points="24,24 43,14.5 43,20 24,29.5" fill="#4e8a2f" />
              <polygon points="5,20 24,29.5 24,43 5,33.5" fill="#8b5e34" />
              <polygon points="24,29.5 43,20 43,33.5 24,43" fill="#6f4a29" />
            </svg>
          </span>
          <div class="inst-names">
            <button class="version-id instance-name" :title="summary.instance.name" @click="openCenter(summary)">{{ summary.instance.name }}</button>
            <div class="instance-meta">
              <span class="tag tag-accent">{{ loaderLabel(summary.instance.loader, summary.instance.loaderVersion) }}</span>
              <span class="tag" :class="instanceHealth(summary.state).tone">{{ instanceHealth(summary.state).label }}</span>
              <span>{{ gameVersionOf(summary) }}</span>
              <span>{{ summary.modCount }} 个模组</span>
              <span>{{ formatBytes(summary.state.sizeBytes) }}</span>
              <span>{{ summary.instance.isolated ? '独立目录' : '共享目录' }}</span>
              <span>{{ summary.instance.lastPlayedAt ? `最近游玩 ${formatRelative(summary.instance.lastPlayedAt)}` : '从未游玩' }}</span>
              <span class="muted" :title="`最近校验 ${formatDateTime(summary.state.lastCheckedAt)}`">校验于 {{ formatRelative(summary.state.lastCheckedAt) }}</span>
            </div>
            <p v-if="summary.instance.description" class="inst-sub muted">{{ summary.instance.description }}</p>
          </div>
          <div class="instance-commands">
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" :disabled="busyId === summary.instance.id" @click="openCenter(summary)">管理</button>
              <button class="btn btn-ghost btn-sm" :disabled="busyId === summary.instance.id" @click="checkState(summary)">
                {{ busyId === summary.instance.id ? '处理中…' : '校验' }}
              </button>
              <button
                class="btn btn-ghost btn-sm instance-more"
                :aria-label="summary.instance.name + '的更多操作'"
                :aria-expanded="menu?.id === summary.instance.id"
                @click="openMenu($event, summary)"
              >
                ⋯
              </button>
            </div>
            <span class="muted played-text">内存 {{ formatMemory(summary.instance.memoryMb) }}</span>
          </div>
        </article>
      </div>
    </section>

    <Teleport to="body">
      <template v-if="menu && menuSummary">
        <div class="menu-overlay" @pointerdown="closeMenu"></div>
        <div
          class="float-menu instance-more-menu"
          role="dialog"
          aria-modal="true"
          aria-label="实例更多操作"
          :style="{ top: menu.top + 'px', left: menu.left + 'px' }"
        >
          <button class="menu-item" @click="menuAction(openCenter)">实例管理中心</button>
          <button class="menu-item" @click="menuAction(checkState)">校验运行状态</button>
          <button class="menu-item" @click="menuAction(repair)">校验并修复运行文件</button>
          <button class="menu-item" @click="menuAction(openFolder)">打开实例文件夹</button>
          <button class="menu-item" @click="menuAction((summary) => (modpack = { mode: 'export', instance: summary.instance }))">导出整合包…</button>
          <button class="menu-item" @click="menuAction(copy)">复制实例</button>
          <button class="menu-item danger" @click="menuAction(askDelete)">删除实例…</button>
        </div>
      </template>
    </Teleport>

    <Teleport to="body">
      <div v-if="pendingDelete" class="modal-mask" @pointerdown.self="pendingDelete = null">
        <section class="modal" role="dialog" aria-modal="true" aria-label="删除实例确认">
          <header class="modal-head">
            <h3>删除实例</h3>
            <button class="icon-btn" aria-label="关闭删除确认" @click="pendingDelete = null">✕</button>
          </header>
          <p>将从启动器中移除「{{ pendingDelete.instance.name }}」（{{ gameVersionOf(pendingDelete) }} · {{ loaderLabel(pendingDelete.instance.loader) }}）。</p>
          <label class="check-option">
            <input v-model="deleteFiles" type="checkbox" />
            <span>
              <strong>同时删除游戏文件</strong>
              <small>会移除 {{ formatBytes(pendingDelete.state.sizeBytes) }} 的独立目录内容，包括模组与存档。此操作不可撤销。</small>
            </span>
          </label>
          <p v-if="!deleteFiles" class="muted modal-note">只解除登记：磁盘上的 {{ gameVersionOf(pendingDelete) }} 文件会保留，可稍后重新导入。</p>
          <p v-if="error" class="modal-note error-text" role="alert">{{ error }}</p>
          <footer class="modal-actions">
            <button class="btn btn-ghost" @click="pendingDelete = null">取消</button>
            <button class="btn btn-danger" :disabled="deleting" @click="confirmDelete">{{ deleting ? '正在删除…' : '确认删除' }}</button>
          </footer>
        </section>
      </div>
    </Teleport>

    <InstancesCreateModal v-if="createOpen" :instances="instances" :installed="installed" @close="createOpen = false" @created="onCreated" />

    <InstancesModpackModal
      v-if="modpack"
      :mode="modpack.mode"
      :instance="modpack.instance"
      :instances="instances"
      @close="modpack = null"
      @done="onModpackDone"
    />

    <InstanceCenterPanel
      v-if="centerSummary"
      :summary="centerSummary"
      :instances="centerSiblings"
      @close="centerSummary = null"
      @refresh="onPanelRefresh"
      @export="(entry) => (modpack = { mode: 'export', instance: entry })"
      @import="modpack = { mode: 'import', instance: null }"
    />
  </section>
</template>

<style scoped>
.instances-page {
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
.instances-sort {
  width: auto;
  min-width: 140px;
}
.tool-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 200px;
  height: var(--ctl-h);
  padding: 0 var(--space-3);
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text-dim);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.tool-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.tool-search svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.tool-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
}
.instances-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.filter-capsules {
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
  border-radius: 999px;
  border: 1px solid var(--border);
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
.category-count {
  opacity: 0.75;
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
}
.list-card {
  padding: var(--space-2);
  min-width: 0;
}
.instances-list-card {
  padding: var(--space-2) var(--space-4);
}
.instance-list {
  display: flex;
  flex-direction: column;
}
.installed-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 72px;
  padding: var(--space-3) var(--space-1);
  border-radius: var(--radius-md);
  border-bottom: 1px solid var(--border);
}
.installed-row:last-child {
  border-bottom: none;
}
.installed-row:hover {
  background: var(--hover);
}
.inst-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  color: var(--text-dim);
}
.inst-icon svg {
  width: 24px;
  height: 24px;
}
.inst-names {
  display: flex;
  flex: 1 1 calc(100% - 260px);
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  min-width: 0;
}
.instance-name {
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-weight: 700;
  font-size: var(--text-md);
  padding: 0;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.instance-name:hover {
  color: var(--accent);
}
.instance-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: var(--text-xs);
  color: var(--text-dim);
  min-width: 0;
}
.inst-sub {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}
.instance-commands {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.played-text {
  font-size: var(--text-xs);
}
.instance-more-menu {
  width: 240px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.modal-head h3 {
  font-size: 22px;
}
.modal p {
  line-height: 1.7;
  color: var(--text-dim);
}
.modal-note {
  font-size: var(--text-sm);
  line-height: 1.6;
  margin-top: 12px;
}
.error-text {
  color: var(--danger);
}
@media (max-width: 900px) {
  .instances-page {
    padding: var(--space-4);
  }
  .installed-row {
    flex-wrap: wrap;
  }
  .inst-names {
    flex-basis: calc(100% - 60px);
  }
  .instance-commands {
    align-items: flex-start;
    width: 100%;
  }
}
</style>

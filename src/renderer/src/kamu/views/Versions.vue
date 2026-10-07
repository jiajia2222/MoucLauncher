<script setup lang="ts">
/**
 * Versions — port of KAMUCL's version catalogue (`MinecraftVersionPicker.vue` filtering
 * model + the `GameView.vue` download tab).
 *
 * Rows, capsules, the latest-release card and the install sheet keep upstream's markup and
 * class names; the data is `mouc.version.*` + `mouc.loader.options`, and the live progress
 * block is the real `mouc.download.jobs()` feed driven by `mouc:progress` pushes.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onMounted, ref } from 'vue'
import type { LoaderId, VersionRef, VersionType } from '@shared/types'
import { formatDate, formatDateTime } from '../../composables/format'
import { useToast } from '../../composables/useToast'
import { api, maybe } from '../api/core'
import { asLoaderId, listInstances, loaderLabel, suggestedInstanceName, validateInstanceName } from '../api/instances'
import {
  installVersion,
  installedVersionIds,
  latestRelease as pickLatestRelease,
  listVersions,
  loaderOptions,
  refreshVersions,
  repairVersion,
  typeTagClass,
  typeText,
  uninstallVersion,
  versionCategories,
  versionCategory
} from '../api/versions'
import InstanceCenterProgress from '../components/InstanceCenterProgress.vue'

type TypeFilter = 'all' | 'release' | 'snapshot' | 'old'

const toast = useToast()

const versions = ref<VersionRef[]>([])
const installed = ref<string[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const checkedAt = ref(0)

const query = ref('')
const typeFilter = ref<TypeFilter>('release')
const onlyInstalled = ref(false)

const modal = ref<{ version: VersionRef } | null>(null)
const modalLoader = ref<LoaderId | null>(null)
const modalLoaderVersion = ref('')
const modalCreateInstance = ref(true)
const modalInstanceName = ref('')
const modalLoadingLoaders = ref(false)
const modalLoaderError = ref('')
const modalBusy = ref(false)
const modalError = ref('')
const modalNameError = ref('')
const pendingUninstall = ref<VersionRef | null>(null)
const uninstallBusy = ref(false)
const busyId = ref('')

const typeFilters: Array<{ value: TypeFilter; label: string }> = [
  { value: 'release', label: '正式版' },
  { value: 'snapshot', label: '快照' },
  { value: 'old', label: '旧版' },
  { value: 'all', label: '全部' }
]

const TYPE_BY_FILTER: Record<TypeFilter, VersionType[] | null> = {
  all: null,
  release: ['release'],
  snapshot: ['snapshot'],
  old: ['old_beta', 'old_alpha']
}

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const allowed = TYPE_BY_FILTER[typeFilter.value]
  return versions.value
    .filter((entry) => (allowed ? allowed.includes(entry.type) : true))
    .filter((entry) => entry.id.toLowerCase().includes(needle))
    .filter((entry) => !onlyInstalled.value || installed.value.includes(entry.id))
    .sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime))
})

const counts = computed(() => {
  const map: Record<TypeFilter, number> = { all: versions.value.length, release: 0, snapshot: 0, old: 0 }
  for (const entry of versions.value) {
    if (entry.type === 'release') map.release += 1
    else if (entry.type === 'snapshot') map.snapshot += 1
    else map.old += 1
  }
  return map
})

const latest = computed(() => pickLatestRelease(versions.value))
const installedSet = computed(() => new Set(installed.value))
const modalLoaderChoices = ref<{ id: LoaderId; label: string; versions: { version: string; stable: boolean; recommended?: boolean }[] }[]>([])

const modalVersions = computed(
  () => modalLoaderChoices.value.find((entry) => entry.id === modalLoader.value)?.versions ?? []
)

function fail(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

async function load(force = false): Promise<void> {
  loading.value = versions.value.length === 0
  error.value = ''
  try {
    const [list, onDisk] = await Promise.all([
      force ? refreshVersions() : listVersions(),
      maybe(api().version.installed(), [] as string[])
    ])
    versions.value = list
    installed.value = onDisk
    checkedAt.value = Date.now()
  } catch (cause: unknown) {
    error.value = fail(cause, '版本列表加载失败')
  } finally {
    loading.value = false
  }
}

async function reloadInstalled(): Promise<void> {
  installed.value = await installedVersionIds()
}

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    await load(true)
    toast.push({ kind: 'success', title: `版本清单已刷新 · ${versions.value.length} 个版本` })
  } finally {
    refreshing.value = false
  }
}

async function loadModalLoaders(): Promise<void> {
  const target = modal.value?.version.id
  modalLoaderChoices.value = []
  modalLoaderVersion.value = ''
  modalLoaderError.value = ''
  if (!target) return
  modalLoadingLoaders.value = true
  try {
    const options = await loaderOptions(target)
    const choices: { id: LoaderId; label: string; versions: { version: string; stable: boolean; recommended?: boolean }[] }[] = []
    for (const option of options) {
      const id = asLoaderId(option.id)
      if (!id) continue
      choices.push({
        id,
        label: option.label,
        versions: option.versions.map((entry) => ({
          version: entry.version,
          stable: entry.stable,
          ...(entry.recommended === undefined ? {} : { recommended: entry.recommended })
        }))
      })
    }
    modalLoaderChoices.value = choices
  } catch (cause: unknown) {
    modalLoaderError.value = fail(cause, '加载器列表获取失败')
  } finally {
    modalLoadingLoaders.value = false
  }
}

function openInstall(version: VersionRef): void {
  modal.value = { version }
  modalLoader.value = null
  modalLoaderVersion.value = ''
  modalCreateInstance.value = true
  modalInstanceName.value = suggestedInstanceName(version.id, null)
  modalError.value = ''
  modalNameError.value = ''
  void loadModalLoaders()
}

function closeModal(): void {
  modal.value = null
  modalBusy.value = false
}

function chooseLoader(id: LoaderId | null): void {
  modalLoader.value = id
  const first = modalVersions.value[0]
  modalLoaderVersion.value = id ? (modalVersions.value.find((entry) => entry.recommended)?.version ?? first?.version ?? '') : ''
  syncInstanceName()
}

function syncInstanceName(): void {
  const target = modal.value?.version.id
  if (!target) return
  const suggestion = suggestedInstanceName(target, modalLoader.value)
  // Only overwrite the auto-suggestion; a name the user typed stays put.
  const previous = suggestedInstanceName(target, null)
  if (!modalInstanceName.value.trim() || modalInstanceName.value === previous || modalInstanceName.value === suggestion) {
    modalInstanceName.value = suggestion
  }
}

const canInstall = computed(
  () => !!modal.value && !modalBusy.value && (!modalLoader.value || !!modalLoaderVersion.value)
)

const installTarget = computed(() => modal.value?.version ?? null)

async function confirmInstall(): Promise<void> {
  const version = modal.value?.version
  if (!version) return
  modalBusy.value = true
  modalError.value = ''
  modalNameError.value = ''
  try {
    const name = modalInstanceName.value.trim()
    if (modalCreateInstance.value && name) {
      const existing = await listInstances()
      modalNameError.value = validateInstanceName(name, existing.map((summary) => summary.instance))
      if (modalNameError.value) return
    }
    const job = await installVersion({
      id: version.id,
      createInstance: modalCreateInstance.value,
      instanceName: modalCreateInstance.value ? name || suggestedInstanceName(version.id, modalLoader.value) : undefined,
      loader: modalLoader.value && modalLoaderVersion.value ? { id: modalLoader.value, version: modalLoaderVersion.value } : undefined
    })
    toast.push({ kind: 'success', title: `已加入下载队列：${job.title}` })
    closeModal()
    await reloadInstalled()
  } catch (cause: unknown) {
    modalError.value = fail(cause, '安装任务创建失败')
  } finally {
    modalBusy.value = false
  }
}

async function repair(version: VersionRef): Promise<void> {
  busyId.value = version.id
  error.value = ''
  try {
    const job = await repairVersion(version.id)
    toast.push({ kind: 'info', title: `校验任务已加入队列：${job.title}` })
  } catch (cause: unknown) {
    error.value = fail(cause, '修复任务创建失败')
  } finally {
    busyId.value = ''
  }
}

async function confirmUninstall(): Promise<void> {
  const version = pendingUninstall.value
  if (!version) return
  uninstallBusy.value = true
  error.value = ''
  try {
    await uninstallVersion(version.id)
    toast.push({ kind: 'success', title: `已卸载 ${version.id}` })
    pendingUninstall.value = null
    await reloadInstalled()
  } catch (cause: unknown) {
    error.value = fail(cause, '卸载失败')
  } finally {
    uninstallBusy.value = false
  }
}

function categoryOf(version: VersionRef): string {
  return versionCategories.find((entry) => entry.value === versionCategory(version))?.label ?? '其他'
}

onMounted(() => {
  void load()
})

</script>

<template>
  <section class="page versions-page">
    <header class="page-head">
      <div class="page-heading">
        <h1 class="page-title">版本管理</h1>
        <p class="page-sub">
          <span v-if="loading">正在获取版本列表…</span>
          <span v-else>{{ versions.length }} 个版本 · {{ installed.length }} 个已安装</span>
          <span v-if="checkedAt && !loading" class="muted"> · 最近检查 {{ formatDateTime(checkedAt) }}</span>
        </p>
      </div>
      <div class="page-actions">
        <div class="tool-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="query" aria-label="搜索版本号" placeholder="搜索版本号，例如 1.21" />
        </div>
        <label class="versions-only">
          <input v-model="onlyInstalled" type="checkbox" />
          <span>仅看已安装</span>
        </label>
        <button class="btn btn-ghost tool-refresh" :disabled="loading || refreshing" @click="refresh">
          <span v-if="refreshing" class="spin" aria-hidden="true"></span>
          <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {{ refreshing ? '刷新中' : '刷新清单' }}
        </button>
      </div>
    </header>

    <div class="game-controls">
      <div class="filter-capsules" role="group" aria-label="版本分类筛选">
        <button
          v-for="entry in typeFilters"
          :key="entry.value"
          class="capsule"
          :class="{ active: typeFilter === entry.value }"
          :aria-pressed="typeFilter === entry.value"
          @click="typeFilter = entry.value"
        >
          {{ entry.label }}
          <span class="category-count">{{ counts[entry.value] }}</span>
        </button>
      </div>
      <span class="muted control-count">{{ filtered.length }} 个结果</span>
    </div>

    <InstanceCenterProgress label="安装与修复任务" @changed="reloadInstalled" />

    <p v-if="error" class="status-strip error" role="alert">
      {{ error }}
      <button class="btn btn-sm" :disabled="loading" @click="load(true)">重新加载</button>
    </p>
    <p v-else-if="refreshing" class="status-strip" role="status">正在向版本清单核对最新版本…</p>

    <div v-if="latest && !query && typeFilter === 'release'" class="card latest-release">
      <div>
        <span class="tag tag-gold">最新正式版</span>
        <strong>{{ latest.id }}</strong>
        <time :datetime="latest.releaseTime">发布于 {{ formatDate(latest.releaseTime) }}</time>
      </div>
      <button class="btn btn-gold" :disabled="busyId === latest.id" @click="openInstall(latest)">
        {{ installedSet.has(latest.id) ? '再次安装' : '安装' }}
      </button>
    </div>

    <div v-if="loading && !versions.length" class="card list-card">
      <div class="empty"><span class="spin"></span><span>正在获取版本列表…</span></div>
    </div>

    <div v-else-if="!versions.length" class="card list-card">
      <div class="empty">
        <span>拿不到版本清单：{{ error || '网络或镜像源不可用' }}</span>
        <button class="btn btn-ghost btn-sm" @click="load(true)">重试获取</button>
      </div>
    </div>

    <div v-else-if="!filtered.length" class="card list-card">
      <div class="empty">
        <span>{{ query || typeFilter !== 'all' ? '没有匹配的版本' : '版本列表为空' }}</span>
        <button v-if="typeFilter !== 'all' || query || onlyInstalled" class="btn btn-ghost btn-sm" @click="query = ''; typeFilter = 'all'; onlyInstalled = false">
          查看全部版本
        </button>
      </div>
    </div>

    <section v-else class="card list-card">
      <div class="version-list">
        <div v-for="entry in filtered" :key="entry.id" class="version-row">
          <div class="version-info">
            <span class="version-id">{{ entry.id }}</span>
            <span class="tag" :class="typeTagClass(entry.type)">{{ typeText[entry.type] }}</span>
            <span class="tag category-tag">{{ categoryOf(entry) }}</span>
            <time class="muted version-date" :datetime="entry.releaseTime" title="本地发布时间">{{ formatDate(entry.releaseTime) }}</time>
          </div>
          <div class="version-actions">
            <span v-if="installedSet.has(entry.id)" class="tag tag-success">已安装</span>
            <button class="btn btn-sm btn-ghost" :disabled="busyId === entry.id" @click="openInstall(entry)">
              {{ busyId === entry.id ? '处理中' : installedSet.has(entry.id) ? '再次安装' : '安装' }}
            </button>
            <button v-if="installedSet.has(entry.id)" class="btn btn-sm btn-ghost" :disabled="busyId === entry.id" @click="repair(entry)">修复</button>
            <button v-if="installedSet.has(entry.id)" class="btn btn-sm btn-danger" :disabled="busyId === entry.id" @click="pendingUninstall = entry">卸载</button>
          </div>
        </div>
      </div>
    </section>

    <Teleport to="body">
      <div v-if="modal && installTarget" class="modal-mask" @pointerdown.self="closeModal">
        <section class="modal game-install-modal" role="dialog" aria-modal="true" :aria-label="`安装 ${installTarget.id}`">
          <header class="install-header">
            <h3 class="modal-title">安装 {{ installTarget.id }}</h3>
            <button class="icon-btn" aria-label="关闭安装窗口" @click="closeModal">✕</button>
          </header>
          <p class="install-location muted">版本类型 {{ typeText[installTarget.type] }} · 发布 {{ formatDate(installTarget.releaseTime) }}</p>
          <div class="install-content">
            <p class="modal-label">选择模组加载器</p>
            <div v-if="modalLoadingLoaders" class="loaders-loading">
              <span class="spin"></span>
              <span class="muted">正在获取加载器版本列表…</span>
            </div>
            <template v-else>
              <div class="loader-options">
                <button class="loader-option" :class="{ active: modalLoader === null }" :aria-pressed="modalLoader === null" @click="chooseLoader(null)">原版</button>
                <button
                  v-for="option in modalLoaderChoices"
                  :key="option.id"
                  class="loader-option"
                  :class="{ active: modalLoader === option.id }"
                  :aria-pressed="modalLoader === option.id"
                  @click="chooseLoader(option.id)"
                >
                  {{ option.label }}
                </button>
              </div>
              <p v-if="modalLoaderError" class="loaders-error">{{ modalLoaderError }} <button class="btn btn-ghost btn-sm" @click="loadModalLoaders">重试</button></p>
              <p v-else-if="!modalLoaderChoices.length" class="muted inst-hint">该版本没有查询到可用加载器，将安装纯净原版。</p>
            </template>

            <template v-if="modalLoader">
              <p class="modal-label">加载器版本</p>
              <select v-if="modalVersions.length" v-model="modalLoaderVersion" class="select">
                <option v-for="item in modalVersions" :key="item.version" :value="item.version">
                  {{ item.version }}{{ item.recommended ? '（推荐）' : item.stable ? '（稳定）' : '（开发版）' }}
                </option>
              </select>
              <p v-else class="loaders-error">该版本下没有可用的 {{ loaderLabel(modalLoader) }} 构建。</p>
            </template>

            <label class="check-option">
              <input v-model="modalCreateInstance" type="checkbox" />
              <span>
                <strong>同时创建游戏实例</strong>
                <small>下载完成后登记为一个独立实例，可在实例中心里改名与调整。</small>
              </span>
            </label>

            <template v-if="modalCreateInstance">
              <p class="modal-label">实例名</p>
              <input v-model="modalInstanceName" class="input mono" maxlength="64" placeholder="留空则自动命名" spellcheck="false" />
              <p v-if="modalNameError" class="loaders-error">{{ modalNameError }}</p>
            </template>

            <p v-if="modalError" class="loaders-error" role="alert">{{ modalError }}</p>
            <p class="muted inst-hint">客户端 jar、依赖库与资源文件会按官方清单下载；进度显示在上方任务面板，可随时取消。</p>
          </div>
          <footer class="modal-actions install-footer">
            <button class="btn btn-ghost" @click="closeModal">取消</button>
            <button class="btn btn-gold" :disabled="!canInstall" @click="confirmInstall">{{ modalBusy ? '正在处理…' : '确认安装' }}</button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="pendingUninstall" class="modal-mask" @pointerdown.self="pendingUninstall = null">
        <section class="modal" role="dialog" aria-modal="true" aria-label="卸载版本确认">
          <header class="modal-head">
            <h3>卸载版本 {{ pendingUninstall.id }}</h3>
            <button class="icon-btn" aria-label="关闭卸载确认" @click="pendingUninstall = null">✕</button>
          </header>
          <p>会删除 <span class="mono">versions/{{ pendingUninstall.id }}</span> 下的版本 JSON 与客户端 jar。共享该版本的实例将无法启动，需要重新安装。</p>
          <footer class="modal-actions">
            <button class="btn btn-ghost" @click="pendingUninstall = null">取消</button>
            <button class="btn btn-danger" :disabled="uninstallBusy" @click="confirmUninstall">{{ uninstallBusy ? '正在删除…' : '确认卸载' }}</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.versions-page {
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
.versions-only {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-dim);
  cursor: pointer;
}
.game-controls {
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
.control-count {
  font-size: var(--text-xs);
}
.latest-release {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.latest-release strong {
  font-size: var(--text-lg);
  margin-left: var(--space-3);
  font-variant-numeric: tabular-nums;
}
.latest-release time {
  display: block;
  margin-left: 0;
  margin-top: 4px;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.list-card {
  padding: var(--space-2);
  min-width: 0;
}
.version-list {
  display: flex;
  flex-direction: column;
}
.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  transition: background 0.15s ease;
}
.version-row:hover {
  background: var(--card-2);
}
.version-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.version-id {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.category-tag {
  opacity: 0.8;
}
.version-date {
  font-size: var(--text-xs);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.version-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}
.version-row .btn-sm {
  min-width: 60px;
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
  overflow-wrap: anywhere;
}
.game-install-modal {
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 20px;
}
.install-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 8px;
  flex-shrink: 0;
}
.install-header .modal-title {
  font-size: 24px;
  margin: 0;
}
.install-location {
  margin: 0;
  padding: 4px 24px 10px;
  flex-shrink: 0;
  font-size: var(--text-sm);
}
.install-content {
  padding: 0 24px 20px;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.install-footer {
  padding: 16px 24px;
  margin: 0 !important;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.install-footer .btn {
  min-height: 42px;
  min-width: 116px;
  border-radius: 12px;
}
.modal-label {
  font-size: var(--text-md);
  font-weight: 600;
  margin: 14px 0 4px;
}
.loader-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.loader-option {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  border-radius: 14px;
  padding: 10px 6px;
  font-size: var(--text-sm);
  font-family: inherit;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text);
  cursor: pointer;
}
.loader-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 12%, transparent);
}
.loaders-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 12px 0;
}
.loaders-error {
  padding: 9px 12px;
  background: var(--danger-soft);
  border-radius: 9px;
  line-height: 1.5;
  color: var(--danger);
}
.inst-hint {
  font-size: var(--text-sm);
  line-height: 1.7;
}
@media (max-width: 900px) {
  .versions-page {
    padding: var(--space-4);
  }
  .version-row {
    flex-wrap: wrap;
  }
}
@media (max-width: 520px) {
  .install-header {
    padding: 16px;
  }
  .install-content {
    padding: 0 16px 16px;
  }
  .install-footer {
    padding: 12px 16px;
  }
  .loader-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

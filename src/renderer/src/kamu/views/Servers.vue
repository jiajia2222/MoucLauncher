<script setup lang="ts">
/**
 * 服务器页：服务器列表管理 + SLP 实时状态 + 一键进服 + 局域网与跨网房间
 *
 * Ported from KAMUCL `views/ServersView.vue` (MIT, (c) 2026 kamubaba-i) — see
 * /THIRD_PARTY_NOTICES.md and /licenses/KAMUCL-MIT.txt. The page-scoped CSS block at
 * the bottom is upstream's, kept verbatim so the ported components render with the
 * upstream rhythm; the additions below it are labelled.
 *
 * Rewired for this data layer: servers are per instance (`server.list(instanceId)`),
 * pings come from `server.ping`, joining is `server.join(instanceId, entry)`, LAN
 * worlds arrive on the `mouc:lan-game` push channel and the cross-network room talks
 * to `server.relay*`. Upstream's servers.dat merge, per-row instance binding,
 * favourites, address privacy and its FRP/VoxLink/Terracotta engines have no backend
 * here and are not ported.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { payloadOf } from '@shared/errors'
import type { InstanceSummary, LanGame, RelayStatus, ServerEntry, ServerPingResult } from '@shared/types'
import { useToast } from '../../composables/useToast'
import {
  copyText,
  errText,
  formatAddress,
  joinServer,
  listServers,
  pingServer,
  removeServer,
  resolvePort,
  saveServer,
  splitAddress
} from '../api/servers'
import {
  getRelayEndpoint,
  instanceLabel,
  isLanFresh,
  lanAddress,
  lanScan,
  lanStop,
  listInstances,
  onLanGame,
  onRelayStatus,
  plainMotd,
  relayHost,
  relayJoin,
  relayStatus,
  relayStop,
  saveRelayEndpoint
} from '../api/online'
import ServersDetails from '../components/ServersDetails.vue'
import ServersListItem from '../components/ServersListItem.vue'
import ServersLan from '../components/ServersLan.vue'
import ServersRoom from '../components/ServersRoom.vue'
import ServersSkeleton from '../components/ServersSkeleton.vue'

const toast = useToast()

// ---------------- 实例与列表 ----------------
const instances = ref<InstanceSummary[]>([])
const instanceId = ref('')
const instancesLoading = ref(true)
const instancesError = ref('')
const servers = ref<ServerEntry[]>([])
const pings = reactive<Record<string, ServerPingResult | 'loading'>>({})
const loading = ref(true)
const refreshing = ref(false)
const joining = ref(false)
const loadError = ref('')
const activeId = ref('')
const keyword = ref('')
const selectMode = ref(false)
const selected = ref<Set<string>>(new Set())
const pingEpoch = new Map<string, number>()

const activeInstance = computed(() => instances.value.find((item) => item.instance.id === instanceId.value) ?? null)
const instanceText = computed(() => (activeInstance.value ? instanceLabel(activeInstance.value) : ''))

async function loadInstances(): Promise<void> {
  instancesLoading.value = true
  instancesError.value = ''
  try {
    instances.value = await listInstances()
  } catch (e) {
    instancesError.value = errText(e)
    toast.push({ kind: 'danger', title: '读取实例列表失败：' + instancesError.value })
  } finally {
    instancesLoading.value = false
  }
  if (!instanceId.value) instanceId.value = instances.value[0]?.instance.id ?? ''
}

async function load(): Promise<void> {
  if (!instanceId.value) {
    servers.value = []
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    servers.value = await listServers(instanceId.value)
  } catch (e) {
    loadError.value = '读取服务器列表失败：' + errText(e)
    toast.push({ kind: 'danger', title: loadError.value })
  } finally {
    loading.value = false
  }
  void pingAll()
}

watch(instanceId, () => {
  activeId.value = ''
  selected.value = new Set()
  void load()
})

async function pingAll(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.allSettled(servers.value.map((entry) => pingOne(entry)))
  } finally {
    refreshing.value = false
  }
}

async function pingOne(entry: ServerEntry): Promise<void> {
  const epoch = (pingEpoch.get(entry.id) ?? 0) + 1
  pingEpoch.set(entry.id, epoch)
  pings[entry.id] = 'loading'
  const known = (): boolean => servers.value.some((item) => item.id === entry.id && item.address === entry.address)
  try {
    const result = await pingServer(entry.address, resolvePort(entry))
    if (pingEpoch.get(entry.id) === epoch && known()) pings[entry.id] = result
  } catch (e) {
    if (pingEpoch.get(entry.id) !== epoch || !known()) return
    pings[entry.id] = {
      address: entry.address,
      port: resolvePort(entry),
      online: false,
      latencyMs: 0,
      motdPlain: '',
      error: payloadOf(e)
    }
  }
}

// ---------------- 多选与批量删除 ----------------
const allChecked = computed(
  () => filteredServers.value.length > 0 && filteredServers.value.every((entry) => selected.value.has(entry.id))
)
const selectedCount = computed(() => selected.value.size)

function toggleSelectMode(): void {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.value = new Set()
}
function toggleSelect(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleAll(): void {
  selected.value = allChecked.value ? new Set() : new Set(filteredServers.value.map((entry) => entry.id))
}

// ---------------- 添加 / 编辑 ----------------
const addModal = reactive({ open: false, id: '', name: '', address: '', busy: false, error: '' })

function openAdd(entry?: ServerEntry): void {
  if (!instanceId.value) {
    toast.push({ kind: 'warning', title: '还没有实例，请先在实例页创建一个' })
    return
  }
  Object.assign(addModal, {
    open: true,
    id: entry?.id ?? '',
    name: entry?.name ?? '',
    address: entry ? formatAddress(entry) : '',
    error: ''
  })
}

async function onAdd(): Promise<void> {
  if (addModal.busy) return
  addModal.busy = true
  addModal.error = ''
  const editingId = addModal.id
  try {
    const previous = servers.value.find((entry) => entry.id === editingId)
    const draft: ServerEntry = {
      id: editingId,
      name: addModal.name.trim(),
      address: addModal.address.trim(),
      acceptTextures: previous?.acceptTextures,
      iconPngBase64: previous?.iconPngBase64
    }
    await saveServer(instanceId.value, draft)
    servers.value = await listServers(instanceId.value)
    addModal.open = false
    addModal.name = ''
    addModal.address = ''
    toast.push({ kind: 'success', title: editingId ? '服务器已更新' : '服务器已添加' })
    const just = editingId ? servers.value.find((entry) => entry.id === editingId) : servers.value.at(-1)
    if (just) {
      activeId.value = just.id
      void pingOne(just)
    }
  } catch (e) {
    addModal.error = errText(e)
  } finally {
    addModal.busy = false
  }
}

// ---------------- 删除（二次确认，支持单个/多选） ----------------
const delModal = reactive({ open: false, target: null as ServerEntry | null, batch: false, busy: false })

function requestDelete(entry: ServerEntry): void {
  Object.assign(delModal, { open: true, target: entry, batch: false })
}
function openBatchDelete(): void {
  if (!selectedCount.value) return
  delModal.target = null
  delModal.batch = true
  delModal.open = true
}

async function onDelete(): Promise<void> {
  if (delModal.busy) return
  delModal.busy = true
  const ids = delModal.batch ? [...selected.value] : [delModal.target?.id ?? '']
  let done = 0
  try {
    for (const id of ids) {
      if (!id) continue
      await removeServer(instanceId.value, id)
      delete pings[id]
      done += 1
    }
    servers.value = await listServers(instanceId.value)
    selected.value = new Set()
    delModal.open = false
    toast.push({ kind: 'success', title: done === 1 ? '已删除服务器' : `已删除 ${done} 个服务器` })
  } catch (e) {
    toast.push({ kind: 'danger', title: '删除失败：' + errText(e) })
  } finally {
    delModal.busy = false
  }
}

// ---------------- 一键进服 ----------------
async function onConnect(entry: ServerEntry): Promise<void> {
  if (joining.value) return
  if (!instanceId.value) {
    toast.push({ kind: 'danger', title: '还没有可选实例，请先在实例页创建一个' })
    return
  }
  joining.value = true
  if (entry.id) activeId.value = entry.id
  try {
    await joinServer(instanceId.value, entry)
    toast.push({ kind: 'info', title: `正在启动并进入 ${entry.name}…` })
    servers.value = await listServers(instanceId.value)
  } catch (e) {
    toast.push({ kind: 'danger', title: '启动失败：' + errText(e) })
  } finally {
    joining.value = false
  }
}

async function copyAddress(entry: ServerEntry): Promise<void> {
  const ok = await copyText(formatAddress(entry))
  toast.push({ kind: ok ? 'info' : 'danger', title: ok ? '服务器地址已复制' : '复制失败，请手动选择文本' })
}

// ---------------- 过滤与统计 ----------------
const pingOf = (entry: ServerEntry): ServerPingResult | null => {
  const value = pings[entry.id]
  return value && value !== 'loading' ? value : null
}

const term = computed(() => keyword.value.trim().toLowerCase())
const filteredServers = computed(() =>
  term.value
    ? servers.value.filter((entry) => {
        const ping = pingOf(entry)
        return (
          entry.name.toLowerCase().includes(term.value) ||
          entry.address.toLowerCase().includes(term.value) ||
          plainMotd(ping?.motdPlain ?? '').toLowerCase().includes(term.value)
        )
      })
    : servers.value
)
const activeServer = computed(() => filteredServers.value.find((entry) => entry.id === activeId.value) ?? filteredServers.value[0] ?? null)
const onlineCount = computed(() => servers.value.filter((entry) => pingOf(entry)?.online).length)

watch(servers, (list) => {
  selected.value = new Set([...selected.value].filter((id) => list.some((entry) => entry.id === id)))
})

// ---------------- 局域网世界 ----------------
const lanGames = ref<LanGame[]>([])
const lanScanning = ref(false)
const lanBusy = ref(false)
const lanError = ref('')
let lanOff: (() => void) | undefined
let sweepTimer: ReturnType<typeof setInterval> | undefined

function upsertLan(game: LanGame): void {
  const key = `${game.from}-${game.port}`
  const next = lanGames.value.filter((item) => `${item.from}-${item.port}` !== key)
  lanGames.value = [...next, game].slice(-12)
}

function sweepLan(): void {
  const now = Date.now()
  // A new array on every sweep also refreshes the "last seen / expires in" labels.
  lanGames.value = lanGames.value.filter((game) => isLanFresh(game, now))
}

async function onLanScan(): Promise<void> {
  if (lanBusy.value) return
  lanBusy.value = true
  lanError.value = ''
  try {
    await lanScan(instanceId.value || undefined)
    lanScanning.value = true
    toast.push({ kind: 'info', title: '正在监听局域网广播' })
  } catch (e) {
    lanError.value = '扫描失败：' + errText(e)
    toast.push({ kind: 'danger', title: lanError.value })
  } finally {
    lanBusy.value = false
  }
}

async function onLanStop(): Promise<void> {
  if (lanBusy.value) return
  lanBusy.value = true
  try {
    await lanStop()
    lanScanning.value = false
  } catch (e) {
    toast.push({ kind: 'danger', title: '停止扫描失败：' + errText(e) })
  } finally {
    lanBusy.value = false
  }
}

function onLanClear(): void {
  lanGames.value = []
  void onLanStop()
}

/** 广播转正式服务器：地址取 UDP 来源，名字取 MOTD 首行。 */
function lanDraft(game: LanGame): ServerEntry {
  const { host, port } = splitAddress(lanAddress(game))
  return {
    id: '',
    name: plainMotd(game.motd).split('\n')[0] || `${host} 局域网世界`,
    address: host,
    port: port ?? game.port
  }
}

async function onLanSave(game: LanGame): Promise<void> {
  if (lanBusy.value || !instanceId.value) return
  lanBusy.value = true
  try {
    await saveServer(instanceId.value, lanDraft(game))
    servers.value = await listServers(instanceId.value)
    toast.push({ kind: 'success', title: '已加入服务器列表' })
  } catch (e) {
    toast.push({ kind: 'danger', title: '加入列表失败：' + errText(e) })
  } finally {
    lanBusy.value = false
  }
}

async function onLanJoin(game: LanGame): Promise<void> {
  await onConnect(lanDraft(game))
}

// ---------------- 跨网房间 ----------------
const relay = ref<RelayStatus | null>(null)
const endpoint = ref('')
const endpointKnown = ref(false)
const relayBusy = ref(false)
const relayError = ref('')
let relayOff: (() => void) | undefined

async function loadEndpoint(): Promise<void> {
  relayError.value = ''
  try {
    endpoint.value = await getRelayEndpoint()
  } catch (e) {
    relayError.value = '读取中继设置失败：' + errText(e)
  } finally {
    endpointKnown.value = true
  }
}

async function onSaveEndpoint(url: string): Promise<void> {
  if (relayBusy.value) return
  relayBusy.value = true
  relayError.value = ''
  try {
    endpoint.value = await saveRelayEndpoint(url)
    toast.push({ kind: 'success', title: '中继服务器地址已保存' })
  } catch (e) {
    relayError.value = '保存失败：' + errText(e)
    toast.push({ kind: 'danger', title: relayError.value })
  } finally {
    relayBusy.value = false
  }
}

async function runRelay(action: () => Promise<RelayStatus>, pending: string, okMessage: string): Promise<void> {
  if (relayBusy.value) return
  relayBusy.value = true
  relayError.value = ''
  try {
    relay.value = await action()
    toast.push({ kind: 'success', title: okMessage })
  } catch (e) {
    relayError.value = `${pending}失败：` + errText(e)
    toast.push({ kind: 'danger', title: relayError.value })
  } finally {
    relayBusy.value = false
  }
}

function onRelayHost(payload: { targetPort: number; room: string; password: string }): void {
  void runRelay(
    () => relayHost(payload.targetPort, payload.room, payload.password),
    '创建房间',
    '房间已创建，把房间码发给好友'
  )
}

function onRelayJoin(payload: { room: string; password: string }): void {
  void runRelay(() => relayJoin(payload.room, payload.password), '加入房间', '正在加入房间')
}

function onRelayStop(): void {
  void runRelay(relayStop, '关闭房间', '房间已关闭')
}

function onRelayNotify(message: string): void {
  toast.push({ kind: 'info', title: message })
}

// ---------------- 生命周期 ----------------
onMounted(() => {
  lanOff = onLanGame(upsertLan)
  relayOff = onRelayStatus((status) => {
    relay.value = status
  })
  sweepTimer = setInterval(sweepLan, 5_000)
  void (async () => {
    await loadInstances()
    await load()
    await loadEndpoint()
    relay.value = await relayStatus().catch((e: unknown) => {
      relayError.value = '读取房间状态失败：' + errText(e)
      return null
    })
  })()
})

onBeforeUnmount(() => {
  lanOff?.()
  relayOff?.()
  if (sweepTimer) clearInterval(sweepTimer)
  if (lanScanning.value) void lanStop()
})
</script>

<template>
  <div class="connect-page servers-page">
    <header class="connection-header">
      <div>
        <h1>服务器 <small>{{ servers.length }} 个 · {{ onlineCount }} 个在线</small></h1>
      </div>
      <button class="btn btn-gold" :disabled="loading || !instanceId" @click="openAdd()"><span aria-hidden="true">＋</span> 添加服务器</button>
    </header>

    <div class="server-toolbar">
      <label class="server-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
        <input v-model="keyword" type="search" placeholder="搜索名称、地址或服务器介绍" aria-label="搜索服务器" />
      </label>
      <label class="server-instance">
        <span>实例</span>
        <select v-model="instanceId" class="select" :disabled="instancesLoading || !instances.length" aria-label="选择实例">
          <option v-if="!instances.length && !instancesLoading" value="">暂无实例</option>
          <option v-for="item in instances" :key="item.instance.id" :value="item.instance.id">{{ instanceLabel(item) }}</option>
        </select>
      </label>
      <div class="connection-actions">
        <button class="btn btn-ghost" :disabled="refreshing || loading || !servers.length" @click="pingAll">{{ refreshing ? '刷新中…' : '刷新状态' }}</button>
        <button class="btn btn-ghost" :disabled="!servers.length || loading" @click="toggleSelectMode">{{ selectMode ? '退出多选' : '批量管理' }}</button>
      </div>
    </div>

    <p v-if="instancesError" class="connection-error" role="alert">实例列表读取失败：{{ instancesError }} <button class="btn btn-ghost" @click="loadInstances">重试</button></p>
    <p v-if="loadError" class="connection-error" role="alert">{{ loadError }} <button class="btn btn-ghost" @click="load">重试</button></p>

    <div v-if="selectMode" class="server-batch">
      <label class="check-all"><input type="checkbox" :checked="allChecked" @change="toggleAll" /> 全选搜索结果</label>
      <span>已选 {{ selectedCount }} 项</span>
      <button class="btn btn-danger" :disabled="!selectedCount" @click="openBatchDelete">删除所选</button>
    </div>

    <ServersSkeleton v-if="loading && !servers.length" class="connection-panel" label="正在整理服务器列表…" />

    <div v-else-if="!instanceId && !instancesLoading" class="connection-panel connection-empty">
      <span class="connection-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 8h2m-2 10h2" /></svg>
      </span>
      <h3>还没有实例</h3>
      <p>服务器列表按实例保存。先到实例页创建一个实例，再回来添加服务器。</p>
    </div>

    <div v-else-if="!servers.length && !loadError" class="connection-panel connection-empty">
      <span class="connection-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="8" rx="2" /><rect x="3" y="13" width="18" height="8" rx="2" /><path d="M7 7h2m-2 10h2" /></svg>
      </span>
      <h3>下一站，去哪个世界？</h3>
      <p>添加好友的服务器地址，或扫描局域网里开放的世界。选中实例后即可一键进入。</p>
      <button class="btn btn-gold" @click="openAdd()">添加第一个服务器</button>
    </div>

    <div v-else-if="!filteredServers.length" class="connection-panel connection-empty">
      <h3>没有找到匹配的服务器</h3>
      <p>试试其他名称、地址或关键词。</p>
      <button class="btn btn-ghost" @click="keyword = ''">清除搜索</button>
    </div>

    <div v-else class="server-workspace" :inert="loading || !!loadError">
      <section class="server-list" aria-label="服务器列表">
        <ServersListItem
          v-for="entry in filteredServers"
          :key="entry.id"
          :server="entry"
          :ping="pingOf(entry)"
          :pending="pings[entry.id] === 'loading'"
          :active="activeServer?.id === entry.id"
          :select-mode="selectMode"
          :checked="selected.has(entry.id)"
          @select="activeId = entry.id"
          @toggle="toggleSelect(entry.id)"
          @connect="onConnect(entry)"
          @refresh="pingOne(entry)"
          @edit="openAdd(entry)"
          @remove="requestDelete(entry)"
          @copy="copyAddress(entry)"
        />
        <p class="connection-muted server-list-hint">选择查看详情 · 双击快速连接</p>
      </section>

      <ServersDetails
        v-if="activeServer"
        :server="activeServer"
        :ping="pingOf(activeServer)"
        :pending="pings[activeServer.id] === 'loading'"
        :busy="joining"
        :instance-text="instanceText"
        @connect="onConnect(activeServer)"
        @refresh="pingOne(activeServer)"
        @edit="openAdd(activeServer)"
        @remove="requestDelete(activeServer)"
        @copy="copyAddress(activeServer)"
      />
    </div>

    <div class="connection-columns online-columns">
      <ServersLan
        :games="lanGames"
        :scanning="lanScanning"
        :busy="lanBusy"
        :error="lanError"
        :can-join="!!instanceId && !joining"
        @scan="onLanScan"
        @stop="onLanStop"
        @clear="onLanClear"
        @save="onLanSave"
        @join="onLanJoin"
      />
      <ServersRoom
        :status="relay"
        :endpoint="endpoint"
        :endpoint-known="endpointKnown"
        :busy="relayBusy"
        :error="relayError"
        @host="onRelayHost"
        @join="onRelayJoin"
        @stop="onRelayStop"
        @save-endpoint="onSaveEndpoint"
        @notify="onRelayNotify"
      />
    </div>

    <Teleport to="body">
      <!-- 添加 / 编辑 -->
      <div v-if="addModal.open" class="modal-mask connection-modal" @pointerdown.self="!addModal.busy && (addModal.open = false)">
        <div class="modal" role="dialog" aria-modal="true" aria-label="服务器操作">
          <h3 class="modal-title">{{ addModal.id ? '编辑服务器' : '添加服务器' }}</h3>
          <p class="connection-muted">保存进当前实例（{{ instanceText || '未选择' }}）的服务器列表。</p>
          <p v-if="addModal.error" class="connection-error" role="alert">{{ addModal.error }}</p>
          <label for="server-edit-name" class="modal-label">服务器名称</label>
          <input id="server-edit-name" v-model="addModal.name" class="input" placeholder="例如：好友的生存服" maxlength="30" />
          <label for="server-edit-address" class="modal-label">服务器地址</label>
          <input
            id="server-edit-address"
            v-model="addModal.address"
            class="input mono"
            placeholder="例如：mc.example.com 或 1.2.3.4:25565"
            spellcheck="false"
            @keyup.enter="onAdd"
          />
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="addModal.busy" @click="addModal.open = false">取消</button>
            <button class="btn btn-gold" :disabled="addModal.busy || !addModal.name.trim() || !addModal.address.trim()" @click="onAdd">
              {{ addModal.busy ? '保存中…' : addModal.id ? '保存修改' : '添加服务器' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="delModal.open" class="modal-mask connection-modal" @pointerdown.self="!delModal.busy && (delModal.open = false)">
        <div class="modal">
          <h3 class="modal-title">删除服务器</h3>
          <p class="confirm-text">
            <template v-if="delModal.batch">确定要删除所选的 {{ selectedCount }} 个服务器吗？只影响当前实例的服务器列表。</template>
            <template v-else>确定要删除「{{ delModal.target?.name ?? '' }}」吗？只影响当前实例的服务器列表。</template>
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="delModal.busy" @click="delModal.open = false">取消</button>
            <button class="btn btn-danger" :disabled="delModal.busy" @click="onDelete">{{ delModal.busy ? '删除中…' : '确认删除' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* Server children share these page-scoped rules with the connection components.
   颜色一律 var/color-mix（禁止 hex/rgb 字面量）；字号/间距/圆角只用设计令牌。 */
.servers-page .server-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.servers-page .server-search { display: flex; flex: 1 1 250px; align-items: center; gap: var(--space-2); min-width: 0; height: var(--row-h); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0 var(--space-4); background: var(--card); }
.servers-page .server-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.servers-page .server-search svg { width: 18px; height: 18px; flex: none; color: var(--text-dim); }
.servers-page .server-search input { border: 0; outline: 0; background: transparent; color: var(--text); min-width: 0; width: 100%; font: inherit; font-size: var(--text-sm); }
.servers-page .server-search input::placeholder { color: var(--text-dim); }
.servers-page .server-collection-head, .servers-page .server-collection-head > div { display: flex; align-items: center; gap: var(--space-3); }
.servers-page .server-collection-head { justify-content: space-between; flex-wrap: wrap; }
.servers-page .server-collection-head strong { font-size: var(--text-md); font-weight: 700; }
.servers-page .server-collection-head strong > span { margin-left: var(--space-1); color: var(--text-dim); font-size: var(--text-xs); font-weight: 400; font-variant-numeric: tabular-nums; }
.servers-page .server-workspace { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.05fr); gap: var(--card-gap); align-items: start; }
.servers-page .server-list { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.servers-page .server-list-item { display: flex; align-items: center; min-width: 0; min-height: var(--row-h); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); transition: background 160ms ease, border-color 160ms ease, transform 0.18s ease, box-shadow 0.22s ease; overflow: hidden; animation: server-row-in 0.38s cubic-bezier(0.22, 0.9, 0.32, 1) backwards; }
@keyframes server-row-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.servers-page .server-list-item:hover { border-color: var(--border-strong); background: var(--card-2); transform: translateY(-2px); box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 10%, transparent); }
.servers-page .server-list-item:active { transform: translateY(0) scale(0.998); }
.servers-page .server-list-item.active, .servers-page .server-list-item.checked { border-color: var(--accent); background: linear-gradient(110deg, var(--accent-soft), transparent), var(--card); box-shadow: inset 3px 0 var(--accent); }
.servers-page .server-row-button { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-width: 0; padding: var(--space-3); border: 0; background: transparent; color: var(--text); text-align: left; font: inherit; cursor: pointer; }
.servers-page .server-row-button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: calc(var(--space-1) * -1); border-radius: var(--radius-sm); }
.servers-page .server-monogram { display: flex; align-items: center; justify-content: center; width: 36px; height: 40px; flex: none; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent-2); font-size: var(--text-lg); font-weight: 700; transition: transform 0.18s cubic-bezier(0.22, 0.9, 0.32, 1.2); }
.servers-page .server-list-item:hover .server-monogram { transform: scale(1.08); }
.servers-page .server-monogram.large { width: 48px; height: 52px; font-size: var(--text-xl); }
.servers-page .server-row-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: var(--space-1); }
.servers-page .server-row-copy strong { font-size: var(--text-sm); }
.servers-page .server-row-copy > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.servers-page .server-row-copy > span { color: var(--text-dim); font-size: var(--text-xs); }
.servers-page .server-row-copy small { color: var(--text-dim); font-size: var(--text-xs); }
.servers-page .server-row-state { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); flex: none; }
.servers-page .server-row-state small { color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap; }
.servers-page .server-list-hint { padding: var(--space-1) var(--space-2); }
.servers-page .server-detail { position: sticky; top: 0; }
.servers-page .server-detail-title { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.servers-page .server-detail-title > div { min-width: 0; }
.servers-page .server-detail-title h3 { font-size: var(--text-xl); font-weight: 700; line-height: 1.4; overflow-wrap: anywhere; }
.servers-page .server-detail-title p { color: var(--text-dim); font-size: var(--text-xs); line-height: 1.7; margin-top: var(--space-1); }
.servers-page .server-description { color: var(--text-dim); background: var(--card-2); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); font-size: var(--text-xs); line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.servers-page .server-facts { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.servers-page .server-facts > div { display: flex; flex-direction: column; gap: var(--space-1); }
.servers-page .server-facts span { color: var(--text-dim); font-size: var(--text-xs); }
.servers-page .server-facts strong { font-size: var(--text-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
.servers-page .server-connect { width: 100%; justify-content: space-between; min-height: var(--row-h); }
.servers-page .server-secondary { gap: var(--space-1); }
.servers-page .server-secondary .btn { flex: 1; padding: var(--space-1) var(--space-2); white-space: nowrap; }
.servers-page .server-delete { color: var(--danger); }
.servers-page .server-footnote { font-size: var(--text-xs); }
.servers-page .server-check { padding-left: var(--space-4); cursor: pointer; }
.servers-page input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
.servers-page .check-all, .servers-page .server-batch { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
.servers-page .server-batch { padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--accent-soft); flex-wrap: wrap; }
.servers-page .server-batch > .btn { margin-left: auto; }
@media (max-width: 1120px) { .servers-page .server-workspace { grid-template-columns: 1fr; } .servers-page .server-detail { position: static; } }
.servers-page{gap:16px}.servers-page .connection-header{margin:0;padding:0}.servers-page .connection-header h1 small{font-size:12px;font-weight:400;color:var(--text-dim);margin-left:12px}.server-toolbar{margin:0;gap:12px}.servers-page .server-list-item{border:0;border-bottom:1px solid var(--border);border-radius:0;min-height:80px;box-shadow:none;padding:0 8px;background:transparent}.servers-page .server-list-item.active{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}.servers-page .server-row-button{padding:12px;min-width:0}.servers-page .server-row-copy{min-width:0}.servers-page .server-row-copy strong{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.servers-page .server-row-state{min-width:76px}.servers-page .server-row-button{flex:1}.servers-page .server-detail-title h3{font-size:21px}.servers-page .server-detail{align-self:start}@media(max-width:800px){.server-toolbar{flex-wrap:wrap}.server-toolbar .server-search{flex-basis:100%}.servers-page .connection-header h1 small{display:block;margin:6px 0 0}}
.servers-page .server-list{gap:0;background:var(--surface-content);padding:0 12px;border:1px solid var(--border);border-radius:var(--radius-lg)}.servers-page .server-list-item{animation:none;overflow:visible}.servers-page .server-list-item:hover,.servers-page .server-list-item:active{transform:none;box-shadow:none}.servers-page .server-list-item:hover .server-monogram{transform:none}@media(min-width:1121px){.servers-page .server-workspace{grid-template-columns:minmax(360px,1.2fr) minmax(320px,1fr);min-height:0;flex:1}.servers-page .server-list,.servers-page .server-detail{max-height:calc(100vh - 270px);overflow:auto;scrollbar-gutter:stable}.content:has(.servers-page){overflow:hidden}.servers-page{height:100%;min-height:0}}

.servers-page .server-workspace { gap:16px; }
.servers-page .server-list { padding:8px; }
.servers-page .server-list-item { padding:0 4px; min-height:86px; }
.servers-page .server-list-item.active { border-bottom-color:var(--border);box-shadow:none;background:var(--accent-soft);border-radius:var(--radius-sm); }
.servers-page .server-list-item.active .server-row-copy strong { color:var(--accent-2); }
.servers-page .server-row-button { gap:12px;padding:12px 8px; }
.servers-page .server-monogram { width:36px;height:36px; }
.servers-page .server-row-state { min-width:66px; }
.servers-page .server-list > .connection-muted { padding:8px;font-size:12px; }
.servers-page .server-detail .connection-panel-body { gap:16px;padding:20px; }
.servers-page .server-detail-title h3 { margin:0;font-size:20px; }
.servers-page .server-facts { padding:12px 0;border-block:1px solid var(--border); }
.servers-page .server-facts strong { font-size:18px; }
.servers-page .server-description { padding:10px 12px;line-height:1.6; }
.servers-page .server-detail .connection-panel-head { padding:12px 20px; }
.servers-page .server-detail .connection-panel-head h2 { font-size:14px;color:var(--text-dim);font-weight:500; }
@media(min-width:1121px) { .servers-page { max-width:1480px;margin-inline:auto;width:100%; }.servers-page .server-detail { position:sticky;top:0; } }
@media(max-width:1120px) { .servers-page .server-workspace { grid-template-columns:minmax(0,1fr); }.servers-page .server-list{max-height:360px;overflow:auto}.servers-page .server-detail{position:static} }

/* ---- MoucLauncher additions (upstream had no per-row actions, no favicon, and no
   instance picker): these extend the rules above without touching them. ---- */
/* Upstream's ServersView is a full-height page whose list scrolls inside the workspace.
   This page also carries the LAN and room panels below it, so the workspace must keep
   its natural height and let the shell scroll the page — otherwise the flex box shrinks
   to zero and the panels below paint over the rows. */
@media (min-width: 1121px) {
  .content:has(.servers-page) { overflow: auto; }
  .servers-page { height: auto; min-height: 0; }
  .servers-page .server-workspace { flex: none; min-height: 0; }
  .servers-page .server-list, .servers-page .server-detail { max-height: none; overflow: visible; }
  .servers-page .server-detail { top: var(--space-4); }
}
.servers-page .server-instance { display: flex; align-items: center; gap: var(--space-2); flex: 0 1 320px; min-width: 0; font-size: var(--text-xs); color: var(--text-dim); }
.servers-page .server-instance > span { flex: none; }
.servers-page .server-instance .select { min-width: 0; text-overflow: ellipsis; }
.servers-page .server-icon { width: 36px; height: 36px; flex: none; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card-2); object-fit: contain; image-rendering: pixelated; }
/* The state column now carries three lines (status, latency bars, player count), so it
   needs more width than upstream's two-line pill; the action column never shrinks. */
.servers-page .server-row-state { min-width: 108px; gap: var(--space-2); }
.servers-page .server-row-actions { display: flex; align-items: center; gap: var(--space-1); flex: none; }
.servers-page .server-row-actions .icon-btn.is-danger:hover { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-border); }
.servers-page .online-columns { align-items: stretch; }
.servers-page .online-columns > * { min-width: 0; }
</style>

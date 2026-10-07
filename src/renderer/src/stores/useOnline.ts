/**
 * useOnline — shared state for OnlineView (servers / LAN / cross-network relay).
 *
 * Ping results, LAN arrivals and relay transitions are all transient main-process push
 * data, so they live in the store instead of the view: LAN broadcasts expire on their own
 * and the relay walks its state machine whether or not this view happens to be mounted.
 */
import { computed, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import { EVENTS, type RelayHostRequest } from '@shared/ipc'
import type {
  AppErrorPayload,
  InstanceSummary,
  LanGame,
  RelayStatus,
  ServerEntry,
  ServerPingResult,
  Settings
} from '@shared/types'
import { defineDict, t } from '../i18n'
import { useToast } from '../composables/useToast'

const copy = defineDict({
  serverSaved: ['服务器已保存', 'Server saved'],
  serverRemoved: ['服务器已删除', 'Server removed'],
  joined: ['正在进入服务器', 'Joining the server'],
  scanStarted: ['正在扫描局域网', 'Scanning the local network'],
  scanStopped: ['扫描已停止', 'Scan stopped'],
  relayHosted: ['房间已建立', 'Room opened'],
  relayStopped: ['已断开中继', 'Relay disconnected'],
  relayUrlSaved: ['中继地址已保存', 'Relay address saved']
})

/** Vanilla's default server port; only a fallback for entries without one. */
export const DEFAULT_PORT = 25565
/** A LAN broadcast nobody re-announced within this window is dropped. */
export const LAN_TTL_MS = 60_000

const instances: Ref<InstanceSummary[]> = ref([])
const instanceId: Ref<string> = ref('')
const instancesLoading: Ref<boolean> = ref(false)

const servers: Ref<ServerEntry[]> = ref([])
const serversLoading: Ref<boolean> = ref(false)
const serversError: Ref<AppErrorPayload | null> = ref(null)
const pings: Ref<Record<string, ServerPingResult>> = ref({})
const pinging: Ref<boolean> = ref(false)

const lanScanning: Ref<boolean> = ref(false)
const lanGames: Ref<LanGame[]> = ref([])
const lanError: Ref<AppErrorPayload | null> = ref(null)
const now: Ref<number> = ref(Date.now())

const relay: Ref<RelayStatus> = ref({ state: 'idle', peers: [], message: t('online.relay.state.idle') })
const relayError: Ref<AppErrorPayload | null> = ref(null)
const relayBusy: Ref<boolean> = ref(false)
const settings: Ref<Settings | null> = ref(null)

let attached = false
let tickTimer: number | null = null

function reportError(payload: AppErrorPayload): void {
  useToast().push({ kind: 'danger', title: payload.message, message: payload.detail, duration: 6000 })
}

function describeError(payload: AppErrorPayload): string {
  return payload.detail ? `${payload.message} — ${payload.detail}` : payload.message
}

function keyOf(address: string, port?: number): string {
  return `${address}:${port ?? DEFAULT_PORT}`
}

function startTicking(): void {
  if (tickTimer !== null) return
  now.value = Date.now()
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
    pruneLan()
  }, 1000)
}

function stopTicking(): void {
  if (tickTimer === null) return
  window.clearInterval(tickTimer)
  tickTimer = null
}

/** LAN announcements stop arriving once the host closes the world; drop stale rows. */
function pruneLan(): void {
  const cutoff = Date.now() - LAN_TTL_MS
  const kept = lanGames.value.filter((entry) => entry.seenAt > cutoff)
  if (kept.length !== lanGames.value.length) lanGames.value = kept
}

function onLanGame(payload: unknown): void {
  const game = payload as LanGame
  const seenAt = game.seenAt > 0 ? game.seenAt : Date.now()
  const rest = lanGames.value.filter((entry) => entry.from !== game.from)
  lanGames.value = [...rest, { ...game, seenAt }].sort((a, b) => b.seenAt - a.seenAt)
}

function attach(): void {
  if (attached) return
  attached = true
  const api = window.mouc
  api.on(EVENTS.lan, onLanGame)
  api.on(EVENTS.relay, (payload) => {
    const next = payload as RelayStatus
    relay.value = next
    if (next.error) reportError(next.error)
  })
  api.on(EVENTS.settings, (payload) => {
    settings.value = payload as Settings
  })
}

/* ------------------------------------------------------------------ selectors */
const currentInstance: ComputedRef<InstanceSummary | null> = computed(
  () => instances.value.find((entry) => entry.instance.id === instanceId.value) ?? null
)

const instanceOptions: ComputedRef<{ value: string; label: string; hint?: string }[]> = computed(() =>
  instances.value.map((entry) => ({
    value: entry.instance.id,
    label: entry.instance.name,
    hint: `${entry.instance.gameVersion} · ${entry.instance.loader}`
  }))
)

const liveLanGames: ComputedRef<LanGame[]> = computed(() => {
  const cutoff = now.value - LAN_TTL_MS
  return lanGames.value.filter((entry) => entry.seenAt > cutoff)
})

const relayConfigured: ComputedRef<boolean> = computed(() => (settings.value?.relayServerUrl ?? '').trim().length > 0)
const relayActive: ComputedRef<boolean> = computed(() => relay.value.state === 'hosting' || relay.value.state === 'joining' || relay.value.state === 'connected')
const relayBytes: ComputedRef<number> = computed(() => relay.value.peers.reduce((acc, peer) => acc + peer.bytesForwarded, 0))

/* -------------------------------------------------------------------- actions */
async function loadSettings(): Promise<void> {
  const res = await window.mouc.settings.get()
  if (res.ok) settings.value = res.data
  else reportError(res.error)
}

async function loadInstances(): Promise<void> {
  attach()
  instancesLoading.value = true
  const res = await window.mouc.instance.list()
  instancesLoading.value = false
  if (!res.ok) {
    reportError(res.error)
    return
  }
  instances.value = res.data
  if (!res.data.some((entry) => entry.instance.id === instanceId.value)) {
    instanceId.value = res.data[0]?.instance.id ?? ''
  }
}

async function loadServers(): Promise<void> {
  if (!instanceId.value) {
    servers.value = []
    return
  }
  serversLoading.value = true
  serversError.value = null
  const res = await window.mouc.server.list(instanceId.value)
  serversLoading.value = false
  if (res.ok) servers.value = res.data
  else serversError.value = res.error
}

async function pingOne(entry: ServerEntry): Promise<ServerPingResult | null> {
  const res = await window.mouc.server.ping(entry.address, entry.port ?? DEFAULT_PORT)
  if (!res.ok) {
    reportError(res.error)
    return null
  }
  pings.value = { ...pings.value, [keyOf(entry.address, entry.port)]: res.data }
  return res.data
}

async function pingAll(): Promise<number> {
  if (servers.value.length === 0) return 0
  pinging.value = true
  const next: Record<string, ServerPingResult> = { ...pings.value }
  let reachable = 0
  await Promise.all(
    servers.value.map(async (entry) => {
      const res = await window.mouc.server.ping(entry.address, entry.port ?? DEFAULT_PORT)
      if (res.ok) {
        next[keyOf(entry.address, entry.port)] = res.data
        if (res.data.online) reachable += 1
      } else {
        next[keyOf(entry.address, entry.port)] = {
          address: entry.address,
          port: entry.port ?? DEFAULT_PORT,
          online: false,
          latencyMs: 0,
          motdPlain: '',
          error: res.error
        }
      }
    })
  )
  pings.value = next
  pinging.value = false
  return reachable
}

async function saveEntry(entry: ServerEntry): Promise<ServerEntry | null> {
  if (!instanceId.value) {
    useToast().push({ kind: 'warning', titleKey: 'launch.noInstance' })
    return null
  }
  const res = await window.mouc.server.save(instanceId.value, toRaw(entry))
  if (!res.ok) {
    reportError(res.error)
    return null
  }
  // `save` may echo the entry without the id the store assigned, so an empty id means
  // "re-read the list" rather than "append this row".
  if (!res.data.id) {
    await loadServers()
    return res.data
  }
  const at = servers.value.findIndex((item) => item.id === res.data.id)
  if (at === -1) servers.value = [...servers.value, res.data]
  else servers.value.splice(at, 1, res.data)
  useToast().push({ kind: 'success', title: copy.text('serverSaved'), message: res.data.name })
  return res.data
}

async function removeEntry(entry: ServerEntry): Promise<boolean> {
  const res = await window.mouc.server.remove(instanceId.value, entry.id)
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  servers.value = servers.value.filter((item) => item.id !== entry.id)
  useToast().push({ kind: 'success', title: copy.text('serverRemoved'), message: entry.name })
  return true
}

/** Launches the instance and asks the client to connect on boot. */
async function joinServer(entry: ServerEntry): Promise<boolean> {
  if (!instanceId.value) {
    useToast().push({ kind: 'warning', titleKey: 'launch.noInstance' })
    return false
  }
  const res = await window.mouc.server.join(instanceId.value, entry)
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  useToast().push({ kind: 'success', title: copy.text('joined'), message: `${entry.name} · PID ${res.data.pid}` })
  return true
}

async function joinLanGame(game: LanGame): Promise<boolean> {
  return joinServer({ id: `lan-${game.from}`, name: game.motd, address: game.address, port: game.port })
}

async function startLan(): Promise<boolean> {
  attach()
  lanError.value = null
  const res = await window.mouc.server.lanScan(instanceId.value || undefined)
  if (!res.ok) {
    lanError.value = res.error
    reportError(res.error)
    return false
  }
  lanScanning.value = true
  startTicking()
  useToast().push({ kind: 'info', title: copy.text('scanStarted') })
  return true
}

async function stopLan(): Promise<boolean> {
  const res = await window.mouc.server.lanStop()
  lanScanning.value = false
  stopTicking()
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  useToast().push({ kind: 'info', title: copy.text('scanStopped') })
  return true
}

function clearLan(): void {
  lanGames.value = []
}

async function refreshRelay(): Promise<void> {
  attach()
  const res = await window.mouc.server.relayStatus()
  if (res.ok) relay.value = res.data
  else relayError.value = res.error
}

async function hostRelay(request: RelayHostRequest): Promise<boolean> {
  relayBusy.value = true
  relayError.value = null
  const res = await window.mouc.server.relayHost(request)
  relayBusy.value = false
  if (!res.ok) {
    relayError.value = res.error
    reportError(res.error)
    return false
  }
  relay.value = res.data
  useToast().push({ kind: 'info', title: copy.text('relayHosted'), message: res.data.room ?? '' })
  return true
}

async function joinRelay(room: string, password: string): Promise<boolean> {
  relayBusy.value = true
  relayError.value = null
  const res = await window.mouc.server.relayJoin(room, password || undefined)
  relayBusy.value = false
  if (!res.ok) {
    relayError.value = res.error
    reportError(res.error)
    return false
  }
  relay.value = res.data
  return true
}

async function stopRelay(): Promise<boolean> {
  relayBusy.value = true
  const res = await window.mouc.server.relayStop()
  relayBusy.value = false
  if (!res.ok) {
    relayError.value = res.error
    reportError(res.error)
    return false
  }
  relay.value = res.data
  useToast().push({ kind: 'info', title: copy.text('relayStopped') })
  return true
}

async function saveRelayUrl(url: string): Promise<boolean> {
  const res = await window.mouc.settings.set({ relayServerUrl: url.trim() })
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  settings.value = res.data
  useToast().push({ kind: 'success', title: copy.text('relayUrlSaved') })
  return true
}

export interface OnlineStore {
  instances: Ref<InstanceSummary[]>
  instancesLoading: Ref<boolean>
  instanceId: Ref<string>
  instanceOptions: ComputedRef<{ value: string; label: string; hint?: string }[]>
  currentInstance: ComputedRef<InstanceSummary | null>

  servers: Ref<ServerEntry[]>
  serversLoading: Ref<boolean>
  serversError: Ref<AppErrorPayload | null>
  pings: Ref<Record<string, ServerPingResult>>
  pinging: Ref<boolean>

  lanScanning: Ref<boolean>
  lanGames: Ref<LanGame[]>
  liveLanGames: ComputedRef<LanGame[]>
  lanError: Ref<AppErrorPayload | null>
  now: Ref<number>

  relay: Ref<RelayStatus>
  relayError: Ref<AppErrorPayload | null>
  relayBusy: Ref<boolean>
  relayConfigured: ComputedRef<boolean>
  relayActive: ComputedRef<boolean>
  relayBytes: ComputedRef<number>
  settings: Ref<Settings | null>

  keyOf: (address: string, port?: number) => string
  describeError: (payload: AppErrorPayload) => string
  loadSettings: () => Promise<void>
  loadInstances: () => Promise<void>
  loadServers: () => Promise<void>
  pingOne: (entry: ServerEntry) => Promise<ServerPingResult | null>
  pingAll: () => Promise<number>
  saveEntry: (entry: ServerEntry) => Promise<ServerEntry | null>
  removeEntry: (entry: ServerEntry) => Promise<boolean>
  joinServer: (entry: ServerEntry) => Promise<boolean>
  joinLanGame: (game: LanGame) => Promise<boolean>
  startLan: () => Promise<boolean>
  stopLan: () => Promise<boolean>
  clearLan: () => void
  refreshRelay: () => Promise<void>
  hostRelay: (request: RelayHostRequest) => Promise<boolean>
  joinRelay: (room: string, password: string) => Promise<boolean>
  stopRelay: () => Promise<boolean>
  saveRelayUrl: (url: string) => Promise<boolean>
}

export function useOnline(): OnlineStore {
  attach()
  return {
    instances,
    instancesLoading,
    instanceId,
    instanceOptions,
    currentInstance,
    servers,
    serversLoading,
    serversError,
    pings,
    pinging,
    lanScanning,
    lanGames,
    liveLanGames,
    lanError,
    now,
    relay,
    relayError,
    relayBusy,
    relayConfigured,
    relayActive,
    relayBytes,
    settings,
    keyOf,
    describeError,
    loadSettings,
    loadInstances,
    loadServers,
    pingOne,
    pingAll,
    saveEntry,
    removeEntry,
    joinServer,
    joinLanGame,
    startLan,
    stopLan,
    clearLan,
    refreshRelay,
    hostRelay,
    joinRelay,
    stopRelay,
    saveRelayUrl
  }
}

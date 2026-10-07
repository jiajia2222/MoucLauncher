<script setup lang="ts">
/**
 * OnlineView — server list, LAN discovery, cross-network relay rooms.
 *
 * Servers are per instance (`server.list(instanceId)`); ping results, LAN broadcasts and
 * relay transitions are transient push/state data kept in the store. LAN rows expire on
 * their own: a broadcast nobody re-announced within `LAN_TTL_MS` is dropped.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { LanGame, RelayState, ServerEntry } from '@shared/types'
import { defineDict, t, type I18nKey } from '../i18n'
import { DEFAULT_PORT, LAN_TTL_MS, useOnline } from '../stores/useOnline'
import { useModal } from '../composables/useModal'
import { useToast } from '../composables/useToast'
import { formatBytes, formatDuration, formatRelative } from '../composables/format'
import MIcon from '../components/icons/MIcon.vue'
import MButton from '../components/ui/MButton.vue'
import MCard from '../components/ui/MCard.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MInput from '../components/ui/MInput.vue'
import MMenu from '../components/ui/MMenu.vue'
import MModal from '../components/ui/MModal.vue'
import MProgress from '../components/ui/MProgress.vue'
import MSelect from '../components/ui/MSelect.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MSwitch from '../components/ui/MSwitch.vue'
import MTag from '../components/ui/MTag.vue'
import MTooltip from '../components/ui/MTooltip.vue'
import type { MenuItem } from '../components/ui/types'

const copy = defineDict({
  subtitle: ['管理实例的服务器列表、发现局域网世界，或通过中继服务器跨网联机。', 'Manage the instance server list, discover LAN worlds, or play across networks through a relay.'],
  serversTitle: ['服务器列表', 'Server list'],
  serversSubtitle: ['{n} 个服务器 · 可连接 {ok} 个', '{n} servers · {ok} reachable'],
  addServer: ['添加服务器', 'Add server'],
  editServer: ['编辑服务器', 'Edit server'],
  pingAll: ['Ping 全部', 'Ping all'],
  emptyServers: ['这个实例还没有服务器', 'This instance has no servers yet'],
  emptyServersHint: ['添加一个地址，或从局域网发现的世界保存为服务器。', 'Add an address, or save a world found on the LAN.'],
  join: ['进入服务器', 'Join server'],
  edit: ['编辑', 'Edit'],
  remove: ['删除', 'Delete'],
  removeBody: ['删除「{name}」？只删除列表条目，不影响存档。', 'Remove “{name}”? Only the list entry is deleted, worlds stay untouched.'],
  addressLabel: ['地址', 'Address'],
  portLabel: ['端口', 'Port'],
  nameLabel: ['显示名', 'Display name'],
  texturesLabel: ['接受皮肤', 'Accept player textures'],
  addressRequired: ['请输入服务器地址', 'A server address is required'],
  portInvalid: ['端口需在 1-65535 之间', 'Port must be between 1 and 65535'],
  playersLabel: ['玩家', 'Players'],
  versionLabel: ['版本', 'Version'],
  lastPing: ['最近 Ping {time}', 'Ping {time}'],
  neverPing: ['尚未 Ping', 'Not pinged yet'],
  pingFailed: ['Ping 失败', 'Ping failed'],
  barsOffline: ['不可达', 'Unreachable'],
  lanTitle: ['局域网世界', 'LAN worlds'],
  lanHint: ['游戏内「对局域网开放」后会自动出现在这里；广播 {time} 内无更新即移除。', 'Open to LAN from the game and it shows up here. A broadcast drops out after {time} of silence.'],
  lanStart: ['开始扫描', 'Start scan'],
  lanStop: ['停止扫描', 'Stop scan'],
  lanClear: ['清空结果', 'Clear results'],
  lanIdleTitle: ['尚未扫描局域网', 'No LAN scan running'],
  lanExpires: ['剩余 {time}', 'Expires in {time}'],
  lanMode: ['模式', 'Mode'],
  relayTitle: ['跨网联机（中继）', 'Cross-network play (relay)'],
  relayIntro: [
    '中继服务器把两端的 Minecraft 流量转发到同一个房间：房主把本地服务端端口暴露出来，其他人连自己的 127.0.0.1 端口即可。所有流量经过 relayServerUrl。',
    'A relay forwards both sides of a Minecraft connection into one room: the host exposes its local server port, everyone else connects to their own 127.0.0.1 port. All traffic goes through relayServerUrl.'
  ],
  relayDocs: ['协议与自建说明见', 'Protocol notes and self-hosting guide:'],
  relayUrlLabel: ['中继地址', 'Relay endpoint'],
  relayUrlHint: ['形如 relay.example.com:25570，保存后即可建立或加入房间。', 'Like relay.example.com:25570. Save it to host or join a room.'],
  relayEndpointTitle: ['尚未配置中继服务器', 'No relay endpoint configured'],
  relaySave: ['保存地址', 'Save endpoint'],
  relayHostTitle: ['建立房间', 'Host a room'],
  relayJoinTitle: ['加入房间', 'Join a room'],
  relayTargetPort: ['本地服务端端口', 'Local server port'],
  relayPortHint: ['游戏内「对局域网开放」显示的端口，默认 25565。', 'The port shown by Open to LAN; 25565 by default.'],
  relayRoom: ['房间码', 'Room code'],
  relayRoomAuto: ['留空由中继服务器分配', 'Leave empty to let the relay assign one'],
  relayPassword: ['房间密码', 'Room password'],
  relayStatusTitle: ['会话状态', 'Session'],
  relayLocal: ['本机连接地址', 'Connect locally on'],
  relayPeers: ['已连接玩家', 'Connected peers'],
  relayNoPeers: ['还没有玩家加入房间', 'Nobody in the room yet'],
  relayBytes: ['已转发 {size}', 'Forwarded {size}'],
  relayBytesLabel: ['已转发流量', 'Traffic forwarded'],
  lanShort: ['广播自动过期，无需刷新', 'Broadcasts expire on their own'],
  relayShort: ['未配置中继地址', 'No relay configured'],
  relaySince: ['{time} 起', 'since {time}'],
  copyEndpoint: ['复制', 'Copy'],
  copiedValue: ['已复制 {value}', 'Copied {value}'],
  copyFailed: ['复制失败', 'Copy failed'],
  relayHintHost: ['房主要先让世界「对局域网开放」，否则中继没有可转发的端口。', 'Open the world to LAN first, otherwise the relay has nothing to forward.'],
  roomLabel: ['房间码 {room}', 'Room {room}'],
  autoRoomNote: ['（未填写，自动分配）', '(empty — assigned automatically)']
})

const store = reactive(useOnline())
const modal = useModal()
const toast = useToast()

/* ------------------------------------------------------------------ servers */
const editorOpen = ref(false)
const editing = ref<ServerEntry | null>(null)
const formName = ref('')
const formAddress = ref('')
const formPort = ref(String(DEFAULT_PORT))
const formTextures = ref(true)
const formError = ref('')
const rowBusy = ref('')
/** The relay host form has its own error slot; sharing one with the server dialog leaks. */
const hostError = ref('')

/* --------------------------------------------------------------------- lan */
const lanTtlText = formatDuration(LAN_TTL_MS)

/* ------------------------------------------------------------------- relay */
const relayUrlDraft = ref('')
const hostPort = ref(String(DEFAULT_PORT))
const hostRoom = ref('')
const hostPassword = ref('')
const joinRoom = ref('')
const joinPassword = ref('')

/* ----------------------------------------------------------------- options */
const serverMenuItems: MenuItem[] = [
  { id: 'edit', labelKey: 'common.edit', icon: 'gear' },
  { id: 'remove', labelKey: 'common.delete', icon: 'trash', danger: true }
]

const relayStateKey: Record<RelayState, I18nKey> = {
  idle: 'online.relay.state.idle',
  hosting: 'online.relay.state.hosting',
  joining: 'online.relay.state.joining',
  connected: 'online.relay.state.connected',
  error: 'online.relay.state.error'
}

const relayTone: Record<RelayState, 'neutral' | 'accent' | 'success' | 'danger'> = {
  idle: 'neutral',
  hosting: 'accent',
  joining: 'accent',
  connected: 'success',
  error: 'danger'
}

const okCount = computed(() => store.servers.filter((entry) => store.pings[store.keyOf(entry.address, entry.port)]?.online).length)

function busy(entry: ServerEntry): boolean {
  return rowBusy.value !== "" && rowBusy.value === entry.id
}

function pingOf(entry: ServerEntry) {
  return store.pings[store.keyOf(entry.address, entry.port)] ?? null
}

function plainMotd(text: string): string {
  return text.replace(/§[0-9a-fk-orx]/gi, '')
}

/** 4 signal bars: the bracket the vanilla client uses for its own meter. */
function strengthOf(entry: ServerEntry): { bars: number; tone: 'success' | 'warning' | 'danger' | 'muted' } {
  const ping = pingOf(entry)
  if (!ping) return { bars: 0, tone: 'muted' }
  if (!ping.online) return { bars: 1, tone: 'danger' }
  if (ping.latencyMs <= 60) return { bars: 4, tone: 'success' }
  if (ping.latencyMs <= 120) return { bars: 3, tone: 'success' }
  if (ping.latencyMs <= 200) return { bars: 2, tone: 'warning' }
  return { bars: 1, tone: 'danger' }
}

function latencyText(entry: ServerEntry): string {
  const ping = pingOf(entry)
  if (!ping) return copy.text('neverPing')
  if (!ping.online) return ping.error?.message ?? copy.text('barsOffline')
  return t('online.latency', { n: ping.latencyMs })
}

function playersText(entry: ServerEntry): string {
  const ping = pingOf(entry)
  if (!ping?.online) return t('common.none')
  return t('online.players', { online: ping.onlinePlayers ?? 0, max: ping.maxPlayers ?? 0 })
}

function iconOf(entry: ServerEntry): string | null {
  const source = entry.iconPngBase64 ?? pingOf(entry)?.iconPngBase64
  if (!source) return null
  return source.startsWith('data:') ? source : `data:image/png;base64,${source}`
}

function lanSecondsLeft(game: LanGame): number {
  return Math.max(0, Math.ceil((game.seenAt + LAN_TTL_MS - store.now) / 1000))
}

/* ------------------------------------------------------------------ actions */
function openEditor(entry: ServerEntry | null): void {
  editing.value = entry
  formName.value = entry?.name ?? ''
  formAddress.value = entry?.address ?? ''
  formPort.value = String(entry?.port ?? DEFAULT_PORT)
  formTextures.value = entry?.acceptTextures !== 0
  formError.value = ''
  editorOpen.value = true
}

async function submitEditor(): Promise<void> {
  const address = formAddress.value.trim()
  if (!address) {
    formError.value = copy.text('addressRequired')
    return
  }
  const port = Number(formPort.value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    formError.value = copy.text('portInvalid')
    return
  }
  formError.value = ''
  const entry: ServerEntry = {
    id: editing.value?.id ?? '',
    name: formName.value.trim() || address,
    address,
    port,
    acceptTextures: formTextures.value ? 1 : 0,
    hidden: editing.value?.hidden,
    iconPngBase64: editing.value?.iconPngBase64
  }
  const saved = await store.saveEntry(entry)
  if (saved) editorOpen.value = false
}

async function onMenuSelect(id: string, entry: ServerEntry): Promise<void> {
  if (id === 'edit') {
    openEditor(entry)
    return
  }
  const confirmed = await modal.confirm({
    title: copy.text('remove'),
    text: copy.text('removeBody', { name: entry.name }),
    confirmKey: 'common.delete',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (confirmed) await store.removeEntry(entry)
}

async function onPing(entry: ServerEntry): Promise<void> {
  rowBusy.value = entry.id
  await store.pingOne(entry)
  rowBusy.value = ''
}

async function onJoin(entry: ServerEntry): Promise<void> {
  rowBusy.value = entry.id
  await store.joinServer(entry)
  rowBusy.value = ''
}

async function onLanToggle(): Promise<void> {
  if (store.lanScanning) await store.stopLan()
  else await store.startLan()
}

async function onCopy(value: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
  } catch (reason) {
    toast.push({ kind: 'danger', title: copy.text('copyFailed'), message: String(reason) })
    return
  }
  toast.push({ kind: 'success', title: copy.text('copiedValue', { value }) })
}

async function onSaveRelayUrl(): Promise<void> {
  await store.saveRelayUrl(relayUrlDraft.value)
}

async function onHost(): Promise<void> {
  const port = Number(hostPort.value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    hostError.value = copy.text('portInvalid')
    return
  }
  hostError.value = ''
  await store.hostRelay({
    targetPort: port,
    room: hostRoom.value.trim() || undefined,
    password: hostPassword.value || undefined
  })
}

async function onJoinRoom(): Promise<void> {
  await store.joinRelay(joinRoom.value.trim().toUpperCase(), joinPassword.value)
}

watch(
  () => store.instanceId,
  () => {
    void store.loadServers()
    store.pings = {}
  }
)

/** Keeps the setup field in sync when the endpoint changes from Settings. */
watch(
  () => store.settings?.relayServerUrl ?? '',
  (value) => {
    relayUrlDraft.value = value
  }
)

onMounted(async () => {
  if (store.instances.length === 0) await store.loadInstances()
  if (!store.settings) await store.loadSettings()
  await store.loadServers()
  await store.refreshRelay()
  relayUrlDraft.value = store.settings?.relayServerUrl ?? ''
})

onBeforeUnmount(() => {
  if (store.lanScanning) void store.stopLan()
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div class="head-text">
        <h1 class="title">{{ t('nav.online') }}</h1>
        <p class="sub">{{ copy.text('subtitle') }}</p>
      </div>
      <div class="head-tools">
        <MButton variant="ghost" icon="refresh" :loading="store.serversLoading" @click="store.loadServers()">
          {{ t('common.refresh') }}
        </MButton>
      </div>
    </header>

    <div class="cols">
      <!-- ======================================================= servers -->
      <MCard
        class="col-main"
        icon="server"
        :title="copy.text('serversTitle')"
        :subtitle="copy.text('serversSubtitle', { n: store.servers.length, ok: okCount })"
      >
        <template #actions>
          <div class="row-tools">
            <MSelect v-model="store.instanceId" :options="store.instanceOptions" :icon="'cube'" size="sm" class="pick" />
            <MButton size="sm" variant="ghost" icon="refresh" :loading="store.pinging" @click="store.pingAll()">
              {{ copy.text('pingAll') }}
            </MButton>
            <MButton size="sm" variant="primary" icon="plus" :disabled="!store.instanceId" @click="openEditor(null)">
              {{ copy.text('addServer') }}
            </MButton>
          </div>
        </template>

        <ul v-if="store.serversLoading && store.servers.length === 0" class="srv-list" aria-busy="true">
          <li v-for="n in 3" :key="n" class="srv-row">
            <MSkeleton variant="rect" width="32px" height="32px" rounded="var(--m-r-sm)" />
            <div class="sk-lines">
              <MSkeleton variant="line" width="38%" height="14px" />
              <MSkeleton variant="line" width="62%" height="12px" />
            </div>
          </li>
        </ul>

        <div v-else-if="store.serversError" class="state-error" role="alert">
          <MIcon name="warning" :size="20" tone="danger" />
          <div class="u-grow">
            <p class="state-title">{{ store.serversError.message }}</p>
            <p v-if="store.serversError.detail" class="state-detail u-mono u-truncate">{{ store.serversError.detail }}</p>
          </div>
          <MButton size="sm" variant="outline" icon="refresh" @click="store.loadServers()">{{ t('common.retry') }}</MButton>
        </div>

        <MEmpty
          v-else-if="store.servers.length === 0"
          icon="server"
          :title="copy.text('emptyServers')"
          :description="copy.text('emptyServersHint')"
        >
          <MButton variant="primary" icon="plus" :disabled="!store.instanceId" @click="openEditor(null)">
            {{ copy.text('addServer') }}
          </MButton>
        </MEmpty>

        <ul v-else class="srv-list">
          <li v-for="entry in store.servers" :key="entry.id" class="srv-row">
            <span class="fav">
              <img v-if="iconOf(entry)" :src="iconOf(entry) ?? undefined" :alt="entry.name" />
              <MIcon v-else name="server" :size="20" tone="muted" />
            </span>

            <div class="srv-main">
              <div class="srv-line">
                <span class="srv-name u-truncate">{{ entry.name }}</span>
                <span class="srv-addr u-num u-truncate">{{ entry.address }}:{{ entry.port ?? DEFAULT_PORT }}</span>
                <MTag v-if="entry.hidden" size="sm">{{ t('common.disabled') }}</MTag>
              </div>
              <div class="srv-meta u-num">
                <span>{{ copy.text('playersLabel') }} {{ playersText(entry) }}</span>
                <span class="sep">·</span>
                <span>{{ pingOf(entry)?.versionName ?? t('common.unknown') }}</span>
                <span class="sep">·</span>
                <span>{{ entry.lastPingAt ? copy.text('lastPing', { time: formatRelative(entry.lastPingAt) }) : copy.text('neverPing') }}</span>
              </div>
              <p v-if="pingOf(entry)?.motdPlain" class="srv-motd u-truncate">
                {{ plainMotd(pingOf(entry)?.motdPlain ?? '') }}
              </p>
              <p v-if="pingOf(entry) && !pingOf(entry)?.online && pingOf(entry)?.error" class="srv-error">
                <MIcon name="warning" :size="16" tone="danger" />
                {{ pingOf(entry)?.error?.message }}
              </p>
            </div>

            <div class="srv-signal">
              <span class="bars" :class="`t-${strengthOf(entry).tone}`" :aria-label="latencyText(entry)">
                <i v-for="n in 4" :key="n" :class="{ on: n <= strengthOf(entry).bars }" />
              </span>
              <span class="lat u-num">{{ latencyText(entry) }}</span>
            </div>

            <div class="srv-actions">
              <MButton
                size="sm"
                variant="primary"
                icon="play"
                
                :disabled="!store.instanceId || busy(entry)"
                @click="onJoin(entry)"
              >
                {{ copy.text('join') }}
              </MButton>
              <MTooltip :content="t('online.ping')" placement="left">
                <MIconButton
                  icon="refresh"
                  size="sm"
                  :label="t('online.ping')"
                  :loading="busy(entry)"
                  @click="onPing(entry)"
                />
              </MTooltip>
              <MMenu :items="serverMenuItems" size="sm" :trigger-icon="'chevron-down'" @select="onMenuSelect($event, entry)" />
            </div>
          </li>
        </ul>
      </MCard>

      <div class="col-side">
        <!-- ========================================================== lan -->
        <MCard icon="lan" :title="copy.text('lanTitle')" :subtitle="copy.text('lanShort')">
          <template #actions>
            <div class="row-tools">
              <MButton size="sm" variant="ghost" icon="x" :disabled="store.lanGames.length === 0" @click="store.clearLan()">
                {{ copy.text('lanClear') }}
              </MButton>
              <MButton
                size="sm"
                :variant="store.lanScanning ? 'outline' : 'primary'"
                :icon="store.lanScanning ? 'stop' : 'search'"
                @click="onLanToggle"
              >
                {{ store.lanScanning ? t('online.lanStop') : t('online.lanScan') }}
              </MButton>
            </div>
          </template>

          <div v-if="store.lanError" class="state-error" role="alert">
            <MIcon name="warning" :size="20" tone="danger" />
            <div class="u-grow">
              <p class="state-title">{{ store.lanError.message }}</p>
              <p v-if="store.lanError.detail" class="state-detail u-mono u-truncate">{{ store.lanError.detail }}</p>
            </div>
            <MButton size="sm" variant="outline" icon="refresh" @click="store.startLan()">{{ t('common.retry') }}</MButton>
          </div>

          <ul v-else class="lan-list">
            <li v-for="game in store.liveLanGames" :key="game.from" class="lan-row">
              <div class="lan-main">
                <p class="lan-title u-truncate">{{ plainMotd(game.motd) }}</p>
                <p class="lan-meta u-num">
                  <span>{{ game.address }}:{{ game.port }}</span>
                  <span class="sep">·</span>
                  <span>{{ game.versionName }}</span>
                  <span class="sep">·</span>
                  <span>{{ copy.text('lanMode') }} {{ game.gameMode ?? t('common.unknown') }}</span>
                </p>
                <p class="lan-exp">
                  <MProgress
                    :percent="(lanSecondsLeft(game) / (LAN_TTL_MS / 1000)) * 100"
                    size="sm"
                    :status="lanSecondsLeft(game) < 15 ? 'warning' : 'paused'"
                  />
                  <span class="u-num">{{ copy.text('lanExpires', { time: formatDuration(lanSecondsLeft(game) * 1000) }) }}</span>
                </p>
              </div>
              <MButton size="sm" variant="outline" icon="play" :disabled="!store.instanceId" @click="store.joinLanGame(game)">
                {{ copy.text('join') }}
              </MButton>
            </li>
          </ul>

          <MEmpty
            v-if="!store.lanError && store.liveLanGames.length === 0"
            :icon="store.lanScanning ? 'search' : 'lan'"
            :title="store.lanScanning ? t('online.lanNone') : copy.text('lanIdleTitle')"
            :description="copy.text('lanHint', { time: lanTtlText })"
            compact
          />
        </MCard>

        <!-- ======================================================== relay -->
        <MCard icon="radio" :title="t('online.relay')" :subtitle="copy.text('relayShort')">
          <template #actions>
            <MTag size="sm" :tone="relayTone[store.relay.state]" :dot="store.relayActive">
              {{ t(relayStateKey[store.relay.state]) }}
            </MTag>
          </template>

          <!-- no endpoint configured: explain instead of spinning -->
          <div v-if="!store.relayConfigured" class="setup">
            <p class="setup-lead">
              <MIcon name="key" :size="16" tone="warning" />
              {{ copy.text('relayEndpointTitle') }}
            </p>
            <p class="setup-body">{{ copy.text('relayIntro') }}</p>
            <p class="setup-docs">
              {{ copy.text('relayDocs') }} <code class="u-mono">docs/relay-protocol.md</code>
            </p>
            <MFieldRow :label="copy.text('relayUrlLabel')" :hint="copy.text('relayUrlHint')" :inline="false">
              <div class="path-row">
                <MInput v-model="relayUrlDraft" mono clearable :placeholder="'relay.example.com:25570'" @enter="onSaveRelayUrl" />
                <MButton variant="primary" icon="check" :disabled="relayUrlDraft.trim().length === 0" @click="onSaveRelayUrl">
                  {{ copy.text('relaySave') }}
                </MButton>
              </div>
            </MFieldRow>
          </div>

          <template v-else>
            <div class="relay-forms">
              <section class="relay-form">
                <h3 class="form-title">{{ copy.text('relayHostTitle') }}</h3>
                <p class="form-note">{{ copy.text('relayHintHost') }}</p>
                <MFieldRow
                  :label="copy.text('relayTargetPort')"
                  :hint="copy.text('relayPortHint')"
                  :error="hostError"
                  :inline="false"
                >
                  <MInput v-model="hostPort" type="number" :mono="true" />
                </MFieldRow>
                <MFieldRow :label="copy.text('relayRoom')" :hint="copy.text('relayRoomAuto')" :inline="false">
                  <MInput v-model="hostRoom" mono :maxlength="12" :placeholder="'ABCDEFG'" />
                </MFieldRow>
                <MFieldRow :label="copy.text('relayPassword')" :inline="false">
                  <MInput v-model="hostPassword" type="password" :placeholder="t('common.optional')" />
                </MFieldRow>
                <div class="u-row">
                  <MButton size="sm" variant="primary" icon="radio" :loading="store.relayBusy" :disabled="store.relayActive" @click="onHost">
                    {{ t('online.relayHost') }}
                  </MButton>
                </div>
              </section>

              <section class="relay-form">
                <h3 class="form-title">{{ copy.text('relayJoinTitle') }}</h3>
                <MFieldRow :label="copy.text('relayRoom')" :inline="false">
                  <MInput v-model="joinRoom" mono :maxlength="12" :placeholder="'ABCDEFG'" @enter="onJoinRoom" />
                </MFieldRow>
                <MFieldRow :label="copy.text('relayPassword')" :inline="false">
                  <MInput v-model="joinPassword" type="password" :placeholder="t('common.optional')" @enter="onJoinRoom" />
                </MFieldRow>
                <div class="u-row">
                  <MButton
                    size="sm"
                    variant="outline"
                    icon="link"
                    :loading="store.relayBusy"
                    :disabled="store.relayActive || joinRoom.trim().length === 0"
                    @click="onJoinRoom"
                  >
                    {{ t('online.relayJoin') }}
                  </MButton>
                  <MButton v-if="store.relayActive" size="sm" variant="ghost" icon="stop" @click="store.stopRelay()">
                    {{ t('online.relayStop') }}
                  </MButton>
                </div>
              </section>
            </div>

            <section class="relay-state">
              <h3 class="form-title">{{ copy.text('relayStatusTitle') }}</h3>
              <p v-if="store.relayError" class="srv-error">
                <MIcon name="warning" :size="16" tone="danger" />
                {{ store.relayError.message }}
              </p>
              <p class="relay-msg">{{ store.relay.message }}</p>

              <dl class="kv">
                <div class="kv-row">
                  <dt>{{ copy.text('relayRoom') }}</dt>
                  <dd>
                    <span class="u-mono">{{ store.relay.room ?? t('common.none') }}</span>
                    <MIconButton
                      v-if="store.relay.room"
                      icon="copy"
                      size="sm"
                      :label="copy.text('copyEndpoint')"
                      @click="onCopy(store.relay.room ?? '')"
                    />
                  </dd>
                </div>
                <div v-if="store.relay.localPort" class="kv-row">
                  <dt>{{ copy.text('relayLocal') }}</dt>
                  <dd>
                    <span class="u-mono">127.0.0.1:{{ store.relay.localPort }}</span>
                    <MIconButton
                      icon="copy"
                      size="sm"
                      :label="copy.text('copyEndpoint')"
                      @click="onCopy(`127.0.0.1:${store.relay.localPort}`)"
                    />
                  </dd>
                </div>
                <div class="kv-row">
                  <dt>{{ t('settings.relayServer') }}</dt>
                  <dd class="u-mono u-truncate">{{ store.relay.endpoint ?? store.settings?.relayServerUrl ?? t('common.none') }}</dd>
                </div>
                <div class="kv-row">
                  <dt>{{ copy.text('relayBytesLabel') }}</dt>
                  <dd class="u-num">{{ copy.text('relayBytes', { size: formatBytes(store.relayBytes) }) }}</dd>
                </div>
              </dl>

              <h4 class="peers-title">{{ copy.text('relayPeers') }}</h4>
              <MEmpty v-if="store.relay.peers.length === 0" icon="users" :title="copy.text('relayNoPeers')" compact />
              <ul v-else class="peers">
                <li v-for="peer in store.relay.peers" :key="peer.id" class="peer">
                  <MIcon name="user" :size="16" tone="muted" />
                  <span class="u-grow u-truncate">{{ peer.name }}</span>
                  <span class="u-num muted">{{ peer.latencyMs ? t('online.latency', { n: peer.latencyMs }) : t('common.unknown') }}</span>
                  <span class="u-num muted">{{ formatBytes(peer.bytesForwarded) }}</span>
                  <span class="u-num muted">{{ copy.text('relaySince', { time: formatRelative(peer.connectedAt) }) }}</span>
                </li>
              </ul>
            </section>
          </template>
        </MCard>
      </div>
    </div>

    <!-- ===================================================== server dialog -->
    <MModal
      v-model:open="editorOpen"
      :title="editing ? copy.text('editServer') : copy.text('addServer')"
      :width="460"
      :confirm-text="t('common.save')"
      :cancel-text="t('common.cancel')"
      @confirm="submitEditor"
    >
      <div class="u-col">
        <MFieldRow :label="copy.text('nameLabel')" :inline="false">
          <MInput v-model="formName" :placeholder="formAddress || t('common.optional')" />
        </MFieldRow>
        <MFieldRow :label="copy.text('addressLabel')" :error="formError" :inline="false">
          <MInput v-model="formAddress" mono clearable :placeholder="'mc.example.net'" @enter="submitEditor" />
        </MFieldRow>
        <MFieldRow :label="copy.text('portLabel')" :inline="false">
          <MInput v-model="formPort" type="number" class="port" />
        </MFieldRow>
        <MFieldRow :label="copy.text('texturesLabel')" :inline="false">
          <MSwitch v-model="formTextures" :label="formTextures ? t('common.yes') : t('common.no')" />
        </MFieldRow>
      </div>
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
  max-width: 74ch;
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.head-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.cols {
  display: grid;
  grid-template-columns: minmax(0, 8fr) minmax(0, 5fr);
  gap: var(--m-sp-4);
  align-items: start;
}

.col-side {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-4);
  min-width: 0;
}

.col-main {
  min-width: 0;
}

.row-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
}

.pick {
  width: 176px;
}

/* ---------------------------------------------------------------- servers */
.srv-list {
  display: flex;
  flex-direction: column;
}

.srv-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3) 0;
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.srv-row:last-child {
  border-bottom: 0;
}

.fav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  overflow: hidden;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
}

.fav img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.srv-main {
  flex: 1 1 auto;
  min-width: 0;
}

.srv-line {
  display: flex;
  align-items: baseline;
  gap: var(--m-sp-2);
  min-width: 0;
}

.srv-name {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.srv-addr,
.srv-meta,
.lat {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.srv-meta {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  margin-top: 2px;
  min-width: 0;
}

.srv-motd {
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.srv-error {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-danger);
}

.sep {
  color: var(--m-border-strong);
}

.srv-signal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: none;
  width: 56px;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}

.bars i {
  width: 4px;
  border-radius: var(--m-r-xs);
  background: var(--m-border-strong);
}

.bars i:nth-child(1) {
  height: 5px;
}

.bars i:nth-child(2) {
  height: 8px;
}

.bars i:nth-child(3) {
  height: 11px;
}

.bars i:nth-child(4) {
  height: 14px;
}

.bars i.on {
  background: currentColor;
}

.bars.t-success {
  color: var(--m-success);
}

.bars.t-warning {
  color: var(--m-warning);
}

.bars.t-danger {
  color: var(--m-danger);
}

.bars.t-muted {
  color: var(--m-text-muted);
}

.srv-actions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  flex: none;
}

/* -------------------------------------------------------------------- lan */
.lan-list {
  display: flex;
  flex-direction: column;
}

.lan-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3) 0;
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.lan-main {
  flex: 1 1 auto;
  min-width: 0;
}

.lan-title {
  font-size: var(--m-fs-13);
  font-weight: 600;
}

.lan-meta {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
  flex-wrap: wrap;
}

.lan-meta span {
  white-space: nowrap;
}

.lan-exp {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.lan-exp :deep(.m-progress) {
  width: 96px;
}

/* ------------------------------------------------------------------ relay */
.relay-forms {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--m-sp-4);
}

.relay-form,
.relay-state {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
}

.form-title {
  font-size: var(--m-fs-13);
  font-weight: 600;
}

.form-note {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.relay-msg {
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.kv {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.kv-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  font-size: var(--m-fs-12);
}

.kv-row dt {
  flex: 0 0 132px;
  color: var(--m-text-muted);
}

.kv-row dd {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  min-width: 0;
  color: var(--m-text-primary);
}

.peers-title {
  font-size: var(--m-fs-12);
  font-weight: 600;
  color: var(--m-text-muted);
}

.peers {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.peer {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  font-size: var(--m-fs-12);
}

.muted {
  color: var(--m-text-muted);
}

/* ----------------------------------------------------------------- states */
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

.sk-lines {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  flex: 1 1 auto;
}

.setup {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-warning);
  border-radius: var(--m-r-sm);
  background: var(--m-warning-soft);
}

.setup-lead {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  font-size: var(--m-fs-13);
  font-weight: 600;
}

.setup-body,
.setup-docs {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
  line-height: var(--m-lh-loose);
}

.setup-docs code {
  padding: 2px var(--m-sp-2);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-xs);
  background: var(--m-surface-sunken);
}

.path-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.port {
  width: 120px;
}
</style>

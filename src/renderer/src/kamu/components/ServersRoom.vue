<script setup lang="ts">
/**
 * Cross-network room panel.
 *
 * Upstream offers three tunnel engines (FRP, VoxLink P2P, Terracotta) behind
 * `FriendConnectView`'s method picker. MoucX ships one: a relay server that
 * forwards a local game port for a room. The panel therefore takes upstream's room
 * affordances wholesale — `connect-tabs`, `connection-field`, `room-card`,
 * `join-guide`, `connection-details`, `network-metrics` — and drops the picker,
 * because there is only one way in.
 *
 * When no relay endpoint is configured the panel shows the setup card instead of a
 * spinner: a spinner would promise a connection that cannot be attempted.
 */
import { computed, ref } from 'vue'
import type { RelayStatus } from '@shared/types'
import { formatBytes, formatRelative } from '../../composables/format'
import { copyText } from '../api/servers'
import ServersPanel from './ServersPanel.vue'
import ServersStatus from './ServersStatus.vue'

const props = defineProps<{
  status: RelayStatus | null
  endpoint: string
  endpointKnown: boolean
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  host: [payload: { targetPort: number; room: string; password: string }]
  join: [payload: { room: string; password: string }]
  stop: []
  saveEndpoint: [url: string]
  notify: [message: string]
}>()

const tab = ref<'host' | 'join'>('host')
const hostPort = ref(25565)
const hostRoom = ref('')
const hostPassword = ref('')
const joinRoom = ref('')
const joinPassword = ref('')
const endpointDraft = ref('')

const active = computed(() => {
  const state = props.status?.state
  return state === 'hosting' || state === 'joining' || state === 'connected'
})

const stateText = computed(() => {
  switch (props.status?.state) {
    case 'hosting':
      return '房间已开启'
    case 'joining':
      return '正在加入房间'
    case 'connected':
      return '已连接'
    case 'error':
      return '上次连接失败'
    default:
      return '未联机'
  }
})

const stateTone = computed(() => (props.status?.state === 'connected' ? 'success' : active.value ? 'pending' : props.status?.state === 'error' ? 'danger' : 'neutral'))

const localAddress = computed(() => (props.status?.localPort ? `127.0.0.1:${props.status.localPort}` : ''))

async function copy(value: string): Promise<void> {
  emit('notify', (await copyText(value)) ? '已复制到剪贴板' : '复制失败，请手动选择文本')
}

function submitHost(): void {
  emit('host', { targetPort: hostPort.value || 25565, room: hostRoom.value.trim(), password: hostPassword.value })
}

function submitJoin(): void {
  if (!joinRoom.value.trim()) return
  emit('join', { room: joinRoom.value.trim(), password: joinPassword.value })
}

function submitEndpoint(): void {
  const url = endpointDraft.value.trim()
  if (!url) return
  emit('saveEndpoint', url)
}
</script>

<template>
  <ServersPanel title="跨网联机" subtitle="把本地游戏端口交给中继服务器转发，好友凭房间码加入，双方都不需要公网 IP。">
    <template #action>
      <ServersStatus v-if="endpointKnown" :tone="stateTone" :label="stateText" />
      <button v-if="active" class="btn btn-ghost btn-sm" :disabled="busy" @click="$emit('stop')">{{ busy ? '处理中…' : '关闭房间' }}</button>
    </template>

    <p v-if="error" class="connection-error" role="alert">{{ error }}</p>

    <!-- 中继设置还没读到：一句状态文字，不转加载圈 -->
    <template v-if="!endpointKnown">
      <div class="connection-result" aria-live="polite">
        <ServersStatus tone="pending" label="正在读取中继设置…" />
        <p class="connection-muted">读取完成后，这里会出现创建或加入房间的入口。</p>
      </div>
    </template>

    <!-- 尚未配置中继：说明 + 填写地址，绝不显示加载圈 -->
    <template v-else-if="!endpoint">
      <div class="connection-notice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.6v.9" />
        </svg>
        <div>
          <strong>跨网联机需要先填写一个中继服务器地址</strong>
          <p>中继服务器是一台公网可访问的小服务：房主与好友各自与它建立一条连接，它再把游戏端口原样转发，双方都不必开放端口。</p>
          <p>协议、自建方法与现成公共地址写在 <code>docs/relay-protocol.md</code> 里；填好后随时可以在设置页修改。</p>
        </div>
      </div>
      <label class="connection-field">
        中继服务器地址
        <input v-model="endpointDraft" class="input mono" placeholder="https://relay.example.com" spellcheck="false" @keyup.enter="submitEndpoint" />
        <small>填写地址后即可创建或加入房间。</small>
      </label>
      <div class="connection-actions">
        <button class="btn btn-gold" :disabled="!endpointDraft.trim()" @click="submitEndpoint">保存并继续</button>
      </div>
    </template>

    <template v-else>
      <div class="network-metrics room-metrics">
        <div><span>连接状态</span><strong>{{ stateText }}</strong></div>
        <div><span>房间码</span><strong class="mono">{{ status?.room || '—' }}</strong></div>
        <div><span>本地端口</span><strong class="mono">{{ status?.localPort || '—' }}</strong></div>
        <div><span>房间成员</span><strong>{{ status?.peers.length ?? 0 }}</strong></div>
      </div>

      <p v-if="status?.message" class="connection-muted" aria-live="polite">{{ status.message }}</p>

      <div v-if="status?.state === 'hosting' && status.room" class="room-card ok">
        <p class="room-label">房间码（发给好友）</p>
        <p class="room-code">
          <code>{{ status.room }}</code>
          <button class="btn btn-ghost copy-mini" @click="copy(status.room ?? '')">复制房间码</button>
        </p>
        <p class="connection-muted">好友在自己的启动器里粘贴房间码即可连上；房间关闭后地址失效。</p>
      </div>

      <div v-else-if="status?.state === 'connected' && localAddress" class="connection-result success" aria-live="polite">
        <ServersStatus tone="success" label="已连接 · 本地地址就绪" />
        <p class="mc-address">
          <code>{{ localAddress }}</code>
          <button class="btn btn-ghost copy-mini" @click="copy(localAddress)">复制地址</button>
        </p>
        <ol class="join-guide">
          <li>打开 Minecraft（与房主相同的实例与版本）</li>
          <li>进入「多人游戏」→「直接连接」</li>
          <li>粘贴上方地址并加入</li>
        </ol>
      </div>

      <div v-if="!active" class="room-work">
        <div class="connect-tabs" role="tablist" aria-label="跨网房间入口">
          <button class="connect-tab" :class="{ active: tab === 'host' }" role="tab" :aria-selected="tab === 'host'" @click="tab = 'host'">创建房间</button>
          <button class="connect-tab" :class="{ active: tab === 'join' }" role="tab" :aria-selected="tab === 'join'" @click="tab = 'join'">加入房间</button>
        </div>

        <div v-if="tab === 'host'" class="room-form">
          <label class="connection-field">
            本地游戏端口
            <input v-model.number="hostPort" class="input" type="number" min="1" max="65535" placeholder="25565" />
            <small>游戏内「对局域网开放」后聊天栏提示的端口；默认 25565。</small>
          </label>
          <label class="connection-field">
            房间码（可选）
            <input v-model="hostRoom" class="input mono" placeholder="留空由中继服务器分配" maxlength="32" />
          </label>
          <label class="connection-field">
            房间密码（可选）
            <input v-model="hostPassword" class="input" type="password" placeholder="仅房间成员可见" autocomplete="off" />
          </label>
          <div class="connection-actions">
            <button class="btn btn-gold main-btn" :disabled="busy" @click="submitHost">{{ busy ? '处理中…' : '创建房间' }}</button>
          </div>
        </div>

        <div v-else class="room-form">
          <label class="connection-field">
            房间码
            <input v-model="joinRoom" class="input mono" placeholder="好友发给你的房间码" @keyup.enter="submitJoin" />
            <small>房间码区分大小写，直接粘贴即可。</small>
          </label>
          <label class="connection-field">
            房间密码（可选）
            <input v-model="joinPassword" class="input" type="password" autocomplete="off" />
          </label>
          <div class="connection-actions">
            <button class="btn btn-gold main-btn" :disabled="busy || !joinRoom.trim()" @click="submitJoin">{{ busy ? '处理中…' : '加入房间' }}</button>
          </div>
          <p class="connection-muted">加入成功后，本地地址会出现在上方，游戏里用「直接连接」粘贴进去。</p>
        </div>
      </div>

      <details class="connection-details">
        <summary>房间成员 · {{ status?.peers.length ?? 0 }} 人</summary>
        <ul v-if="status?.peers.length" class="peer-list">
          <li v-for="peer in status.peers" :key="peer.id">
            <span class="peer-name">{{ peer.name }}</span>
            <small>{{ formatBytes(peer.bytesForwarded) }} · 连接于 {{ formatRelative(peer.connectedAt) }}{{ peer.latencyMs ? ` · ${peer.latencyMs} ms` : '' }}</small>
          </li>
        </ul>
        <p v-else class="connection-muted">还没有玩家连上这个房间。</p>
      </details>
    </template>
  </ServersPanel>
</template>

<style scoped>
.room-metrics {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--card-2);
}
.room-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--card-pad);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.room-card.ok { border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
.room-label { font-size: var(--text-xs); font-weight: 600; color: var(--text-dim); }
.room-code {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--text-lg);
  letter-spacing: 0.06em;
  min-height: var(--row-h);
}
.room-code code { font-weight: 700; overflow-wrap: anywhere; }
.copy-mini { padding: var(--space-1) var(--space-3); font-size: var(--text-xs); min-height: 28px; }
.mc-address { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-lg); min-height: var(--row-h); }
.mc-address code { font-weight: 700; overflow-wrap: anywhere; }
.join-guide {
  margin: 0;
  padding-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-dim);
  line-height: 1.8;
}
.room-work { display: flex; flex-direction: column; gap: var(--card-gap); min-width: 0; }
.room-form { display: flex; flex-direction: column; gap: var(--card-gap); min-width: 0; }
.main-btn { min-height: calc(var(--ctl-h) + var(--space-2)); font-weight: 700; }
.peer-list { list-style: none; display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); }
.peer-list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
}
.peer-name { font-size: var(--text-sm); font-weight: 600; }
.peer-list small { color: var(--text-dim); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.connection-notice code { font-size: var(--text-xs); }
</style>

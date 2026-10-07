<script setup lang="ts">
/**
 * Ported from KAMUCL `components/connection/ServerDetails.vue` (MIT, (c) 2026
 * kamubaba-i) — see /THIRD_PARTY_NOTICES.md.
 *
 * Same panel, same order (title → MOTD → facts → version → instance → connect →
 * secondary actions → footnote). Two upstream pieces are replaced because this data
 * layer differs: servers already belong to one instance, so the per-row instance
 * `<select>` becomes a read-only "launched with" line, and the facts grid gains the
 * latency bars + protocol the SLP ping actually returns.
 */
import { computed } from 'vue'
import type { ServerEntry, ServerPingResult } from '@shared/types'
import { formatAddress } from '../api/servers'
import { plainMotd } from '../api/online'
import ServersAddress from './ServersAddress.vue'
import ServersPanel from './ServersPanel.vue'
import ServersPingBars from './ServersPingBars.vue'
import ServersStatus from './ServersStatus.vue'

const props = defineProps<{
  server: ServerEntry
  ping: ServerPingResult | null
  pending: boolean
  busy: boolean
  instanceText: string
}>()

defineEmits<{ connect: []; refresh: []; edit: []; remove: []; copy: [] }>()

const iconSrc = computed(() => {
  const icon = props.ping?.iconPngBase64 || props.server.iconPngBase64
  return icon ? `data:image/png;base64,${icon}` : ''
})

const monogram = computed(() => props.server.name.trim().slice(0, 1).toUpperCase() || '#')
const displayAddress = computed(() => formatAddress(props.server))
const motd = computed(() => plainMotd(props.ping?.motdPlain ?? ''))
const players = computed(() => {
  const ping = props.ping
  if (!ping?.online || props.pending) return '—'
  return `${ping.onlinePlayers ?? 0}/${ping.maxPlayers ?? 0}`
})
const latency = computed(() => {
  const ping = props.ping
  if (!ping?.online || props.pending) return '—'
  return `${ping.latencyMs} ms`
})
const versionText = computed(() => {
  const ping = props.ping
  if (!ping?.online || props.pending) return ''
  return [`服务器版本：${ping.versionName ?? '未知'}`, ping.protocol ? `协议 ${ping.protocol}` : ''].filter(Boolean).join(' · ')
})
const tone = computed(() => (props.pending ? 'pending' : props.ping?.online ? 'success' : 'neutral'))
const stateLabel = computed(() => (props.pending ? '检测中' : props.ping?.online ? '在线' : props.ping ? '未连通' : '未检测'))
const connectLabel = computed(() => (props.busy ? '正在启动…' : '启动并连接'))
</script>

<template>
  <ServersPanel title="连接详情" class="server-detail">
    <template #action>
      <button class="btn btn-ghost btn-sm" :disabled="pending" @click="$emit('refresh')">{{ pending ? '检测中…' : '刷新' }}</button>
      <ServersStatus :tone="tone" :label="stateLabel" />
    </template>

    <div class="server-detail-title">
      <img v-if="iconSrc" class="server-icon large" :src="iconSrc" alt="" aria-hidden="true" />
      <span v-else class="server-monogram large" aria-hidden="true">{{ monogram }}</span>
      <div>
        <h3>{{ server.name }}</h3>
        <ServersAddress :address="displayAddress" copyable @copy="$emit('copy')" />
      </div>
    </div>

    <div v-if="pending" class="server-description" aria-live="polite">正在读取服务器状态…</div>
    <div v-else-if="motd" class="server-description" aria-live="polite">{{ motd }}</div>
    <div v-else-if="ping && !ping.online" class="server-description" aria-live="polite">
      {{ ping.error?.message || '无法连接（服务器离线或地址错误）' }}
    </div>

    <div class="server-facts">
      <div><span>在线玩家</span><strong>{{ players }}</strong></div>
      <div>
        <span>网络延迟</span>
        <strong class="server-latency">
          <ServersPingBars :online="!!ping?.online && !pending" :latency-ms="ping?.latencyMs ?? 0" :pending="pending" />
          {{ latency }}
        </strong>
      </div>
    </div>

    <p v-if="versionText" class="connection-muted">{{ versionText }}</p>

    <details v-if="ping?.online && ping.samplePlayers?.length" class="connection-details">
      <summary>正在游玩（{{ ping.samplePlayers.length }}）</summary>
      <ul class="player-list">
        <li v-for="player in ping.samplePlayers" :key="player">{{ player }}</li>
      </ul>
    </details>

    <label class="connection-field">
      启动所用实例
      <span class="server-instance-value">{{ instanceText || '尚未选择实例' }}</span>
      <small>服务器列表按实例保存；在页面顶部切换实例即可换一份列表。</small>
    </label>

    <button class="btn btn-gold server-connect" :disabled="busy || !instanceText" @click="$emit('connect')">
      {{ connectLabel }}<span aria-hidden="true">↗</span>
    </button>

    <div class="connection-actions server-secondary">
      <button class="btn btn-ghost" :disabled="busy" @click="$emit('edit')">编辑服务器</button>
      <details class="server-more" @keydown.esc="($event.currentTarget as HTMLDetailsElement).open = false">
        <summary class="btn btn-ghost">更多</summary>
        <div><button class="btn btn-danger" :disabled="busy" @click="$emit('remove')">删除服务器</button></div>
      </details>
    </div>

    <p v-if="ping && !ping.online && !pending" class="connection-muted server-footnote">
      状态检测失败不一定代表无法进入游戏，仍可尝试连接。
    </p>
  </ServersPanel>
</template>

<style scoped>
/* Upstream's own overrides for these cells. */
.server-more { position: relative; }
.server-more summary { list-style: none; }
.server-more > div {
  position: absolute;
  right: 0;
  z-index: 4;
  background: var(--surface-solid);
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.server-connect { min-height: 44px; }
.server-secondary { justify-content: flex-end; }
.server-detail :deep(.connection-panel-head) { padding: 12px 20px; }
.server-detail-title { gap: 12px; }
.server-icon {
  width: 48px;
  height: 52px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  object-fit: contain;
  image-rendering: pixelated;
}
.server-latency { display: inline-flex; align-items: center; gap: var(--space-2); }
.player-list { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); margin-top: var(--space-2); }
.player-list li {
  padding: 2px var(--space-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.server-instance-value {
  min-height: var(--ctl-h);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  color: var(--text);
  font-size: var(--text-md);
  font-weight: 400;
  overflow-wrap: anywhere;
}
</style>

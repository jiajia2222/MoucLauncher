<script setup lang="ts">
/**
 * Ported from KAMUCL `components/connection/ServerListItem.vue` (MIT, (c) 2026
 * kamubaba-i) — see /THIRD_PARTY_NOTICES.md.
 *
 * Row anatomy kept from upstream (checkbox / monogram / copy column / state column and
 * the transparent full-row hit target), extended with what this data layer can report:
 * the SLP favicon, the MOTD, a five-bar latency meter, the player count and per-row
 * actions. Upstream's favourite star is dropped — `ServerEntry` has no favourite field,
 * so the list order is the stored order.
 */
import { computed } from 'vue'
import type { ServerEntry, ServerPingResult } from '@shared/types'
import { formatAddress } from '../api/servers'
import { plainMotd } from '../api/online'
import ServersAddress from './ServersAddress.vue'
import ServersPingBars from './ServersPingBars.vue'
import ServersStatus from './ServersStatus.vue'

const props = defineProps<{
  server: ServerEntry
  ping: ServerPingResult | null
  pending: boolean
  active: boolean
  selectMode: boolean
  checked: boolean
}>()

defineEmits<{ select: []; toggle: []; connect: []; refresh: []; edit: []; remove: []; copy: [] }>()

const iconSrc = computed(() => {
  const icon = props.ping?.iconPngBase64 || props.server.iconPngBase64
  return icon ? `data:image/png;base64,${icon}` : ''
})

const monogram = computed(() => props.server.name.trim().slice(0, 1).toUpperCase() || '#')

const displayAddress = computed(() => formatAddress(props.server))

const motd = computed(() => {
  if (props.pending) return '正在检测服务器状态…'
  if (!props.ping) return '尚未检测，点击右侧刷新按钮获取状态'
  if (!props.ping.online) return props.ping.error?.message || '无法连接（服务器离线或地址错误）'
  return plainMotd(props.ping.motdPlain) || '（该服务器没有留下介绍）'
})

const players = computed(() => {
  const ping = props.ping
  if (!ping?.online || props.pending) return '玩家 —'
  return `玩家 ${ping.onlinePlayers ?? 0}/${ping.maxPlayers ?? 0}`
})

const tone = computed(() => (props.pending ? 'pending' : props.ping?.online ? 'success' : 'neutral'))
const stateLabel = computed(() => (props.pending ? '检测中' : props.ping?.online ? '在线' : props.ping ? '未连通' : '未检测'))
</script>

<template>
  <div class="server-list-item" :class="{ active, checked }">
    <label v-if="selectMode" class="server-check">
      <input type="checkbox" :aria-label="`选择 ${server.name}`" :checked="checked" @change="$emit('toggle')" />
    </label>
    <div class="server-row-button">
      <button
        type="button"
        class="server-select-hit"
        :aria-label="`${selectMode ? '选择' : '查看'} ${server.name}`"
        :aria-pressed="selectMode ? checked : active"
        @click="selectMode ? $emit('toggle') : $emit('select')"
        @dblclick="!selectMode && $emit('connect')"
      />
      <img v-if="iconSrc" class="server-icon" :src="iconSrc" alt="" aria-hidden="true" />
      <span v-else class="server-monogram" aria-hidden="true">{{ monogram }}</span>
      <span class="server-row-copy">
        <strong :title="server.name">{{ server.name }}</strong>
        <ServersAddress :address="displayAddress" copyable @copy="$emit('copy')" />
        <small class="server-row-motd" :title="motd">{{ motd }}</small>
      </span>
      <span class="server-row-state">
        <ServersStatus :tone="tone" :label="stateLabel" />
        <span class="server-row-meter">
          <ServersPingBars :online="!!ping?.online && !pending" :latency-ms="ping?.latencyMs ?? 0" :pending="pending" />
          <small>{{ pending ? '—' : ping?.online ? `${ping.latencyMs} ms` : '—' }}</small>
        </span>
        <small class="server-row-players">{{ players }}</small>
      </span>
    </div>
    <span class="server-row-actions">
      <button type="button" class="icon-btn" :disabled="pending" aria-label="刷新服务器状态" title="刷新状态" @click.stop="$emit('refresh')">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6.4 4.6A6.6 6.6 0 0 1 16.6 8.4M16.6 15.4A6.6 6.6 0 0 1 3.4 11.6M16.6 4.4v4h-4M3.4 15.6v-4h4" />
        </svg>
      </button>
      <button type="button" class="icon-btn" aria-label="编辑服务器" title="编辑服务器" @click.stop="$emit('edit')">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13.6 3.4l3 3-9 9H4.6v-3zM11 6l3 3" />
        </svg>
      </button>
      <button type="button" class="icon-btn is-danger" aria-label="删除服务器" title="删除服务器" @click.stop="$emit('remove')">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.2 6.2h13.6M7.6 6.2V3.4h4.8v2.8M4.8 6.2l.8 10.4h8.8l.8-10.4M8.2 9.4v4.2M11.8 9.4v4.2" />
        </svg>
      </button>
    </span>
  </div>
</template>

<style scoped>
/* Upstream keeps the hit layer under the visible cells so the address copy button stays clickable. */
.server-row-button { position: relative; }
.server-row-button > .server-monogram,
.server-row-button > .server-icon,
.server-row-state,
.server-row-copy { pointer-events: none; }
.server-select-hit {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}
.server-select-hit:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.server-icon {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--card-2);
  object-fit: contain;
  image-rendering: pixelated;
}
.server-row-copy :deep(.server-address-line) { overflow: visible; white-space: normal; }
.server-row-meter { display: inline-flex; align-items: center; gap: var(--space-2); }
.server-row-meter small { color: var(--text-dim); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
</style>

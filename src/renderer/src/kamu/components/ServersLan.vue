<script setup lang="ts">
/**
 * LAN world panel for the ported servers page.
 *
 * Upstream has no equivalent card: KAMUCL folds LAN worlds into the same server list and
 * only tunnels them onward. MoucLauncher broadcasts them separately (`server.lanScan` +
 * the `mouc:lan-game` push), so they get their own panel built from the same upstream
 * vocabulary as the tunnel panels in `FriendConnectView` — `connection-panel`,
 * `connection-result`, `connection-empty` and `connection-actions`.
 */
import type { LanGame } from '@shared/types'
import { formatRelative } from '../../composables/format'
import { LAN_TTL_MS, lanAddress, plainMotd } from '../api/online'
import ServersPanel from './ServersPanel.vue'
import ServersStatus from './ServersStatus.vue'

defineProps<{
  games: LanGame[]
  scanning: boolean
  busy: boolean
  error: string
  canJoin: boolean
}>()

defineEmits<{ scan: []; stop: []; clear: []; save: [game: LanGame]; join: [game: LanGame] }>()

function title(game: LanGame): string {
  return plainMotd(game.motd).split('\n')[0] || '未命名世界'
}

function ttlLabel(game: LanGame): string {
  const left = Math.max(0, Math.round((LAN_TTL_MS - (Date.now() - game.seenAt)) / 1000))
  return `${left} 秒后过期`
}

function monogram(game: LanGame): string {
  return title(game).slice(0, 1).toUpperCase()
}
</script>

<template>
  <ServersPanel title="局域网世界" subtitle="发现同一局域网里已「对局域网开放」的世界，广播过期后自动移除。">
    <template #action>
      <ServersStatus :tone="scanning ? 'pending' : games.length ? 'success' : 'neutral'" :label="scanning ? '扫描中' : games.length ? `已发现 ${games.length} 个` : '未在扫描'" />
      <button v-if="games.length" class="btn btn-ghost btn-sm" :disabled="busy" @click="$emit('clear')">清空结果</button>
      <button class="btn btn-gold btn-sm" :disabled="busy" @click="scanning ? $emit('stop') : $emit('scan')">
        {{ busy ? '处理中…' : scanning ? '停止扫描' : '扫描局域网' }}
      </button>
    </template>

    <p v-if="error" class="connection-error" role="alert">{{ error }}</p>

    <div v-if="scanning && !games.length" class="connection-result" aria-live="polite">
      <ServersStatus tone="pending" label="正在监听广播…" />
      <p class="connection-muted">游戏内「对局域网开放」后，世界会在几秒内出现在这里；广播 60 秒内没有再次出现即自动移除。</p>
    </div>

    <div v-else-if="!games.length" class="connection-empty lan-empty">
      <span class="connection-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 12.6v8.2M9.4 20.8h5.2M9.6 8.4a3.4 3.4 0 0 1 4.8 0M6.6 5.4a7.6 7.6 0 0 1 10.8 0" />
          <circle cx="12" cy="11.2" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <h3>{{ scanning ? '正在等待广播' : '尚未扫描局域网' }}</h3>
      <p>游戏内「对局域网开放」后会自动出现在这里；也可以直接填写地址添加服务器。</p>
    </div>

    <ul v-else class="lan-list" aria-label="局域网世界列表">
      <li v-for="game in games" :key="`${game.from}-${game.port}`" class="lan-row">
        <span class="server-monogram" aria-hidden="true">{{ monogram(game) }}</span>
        <span class="lan-copy">
          <strong :title="title(game)">{{ title(game) }}</strong>
          <span class="mono">{{ lanAddress(game) }}</span>
          <small>{{ [game.versionName, game.gameMode].filter(Boolean).join(' · ') || '版本未知' }} · 最近广播 {{ formatRelative(game.seenAt) }} · {{ ttlLabel(game) }}</small>
        </span>
        <span class="lan-actions">
          <button class="btn btn-ghost btn-sm" :disabled="busy" title="存入当前实例的服务器列表" @click="$emit('save', game)">加入列表</button>
          <button class="btn btn-gold btn-sm" :disabled="busy || !canJoin" title="启动所选实例并直接进入" @click="$emit('join', game)">直接进入</button>
        </span>
      </li>
    </ul>
  </ServersPanel>
</template>

<style scoped>
.lan-empty { min-height: 180px; }
.lan-list { list-style: none; display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.lan-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  min-height: var(--row-h);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  transition: background var(--motion-fast) ease, border-color var(--motion-fast) ease;
}
.lan-row:hover { border-color: var(--border-strong); background: var(--card); }
.lan-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: var(--space-1); }
.lan-copy strong { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lan-copy span { color: var(--text-dim); font-size: var(--text-xs); overflow-wrap: anywhere; }
.lan-copy small { color: var(--text-dim); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lan-actions { display: flex; align-items: center; gap: var(--space-2); flex: none; }
@media (max-width: 820px) {
  .lan-row { flex-wrap: wrap; }
  .lan-actions { margin-left: auto; }
}
</style>

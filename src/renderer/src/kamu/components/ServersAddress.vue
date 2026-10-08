<script setup lang="ts">
/**
 * Ported from KAMUCL `components/connection/ServerAddress.vue` (MIT, (c) 2026
 * kamubaba-i) — see /THIRD_PARTY_NOTICES.md.
 *
 * Dropped from upstream: the address privacy mask. It is driven by KAMUCL's
 * `shared/serverPrivacy` module, which exists because upstream merges servers out of
 * shared `servers.dat` files where one row can belong to somebody else's folder.
 * MoucX's list is per instance and owned by this app, so there is nothing to
 * hide; the line keeps upstream's typography and its inline copy affordance.
 */
defineProps<{ address: string; copyable?: boolean }>()
defineEmits<{ copy: [] }>()
</script>

<template>
  <span class="server-address-line">
    <span class="server-address-value mono">{{ address }}</span>
    <button v-if="copyable" type="button" class="server-address-toggle" aria-label="复制服务器地址" title="复制服务器地址" @click.stop="$emit('copy')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7.4 7.4h8.4v8.4H7.4zM4 12.6V4h8.6" />
      </svg>
      <span>复制</span>
    </button>
  </span>
</template>

<style scoped>
.server-address-line {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  color: var(--text-dim);
  font-size: var(--text-xs);
  pointer-events: none;
}
.server-address-value { overflow-wrap: anywhere; min-width: 0; }
.server-address-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 28px;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  color: var(--text-dim);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
}
.server-address-toggle svg { width: 14px; height: 14px; }
.server-address-toggle:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-2); }
.server-address-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

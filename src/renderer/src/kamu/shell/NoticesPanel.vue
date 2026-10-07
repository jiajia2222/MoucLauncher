<script setup lang="ts">
/**
 * Notices panel (upstream 通知). Reads the shell notice feed and offers the same
 * mask/panel geometry as the top bar's changelog panel so the two stay in step.
 *
 * Ported shell layer — see /THIRD_PARTY_NOTICES.md.
 */
import { computed } from 'vue'
import { copy } from './copy'
import { clearNotices, notices } from './state'

const emit = defineEmits<{ close: [] }>()

const items = computed(() => notices.value)

function stamp(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toneClass(type: string): string {
  if (type === 'error') return 'tag-danger'
  if (type === 'success') return 'tag-success'
  return 'tag-accent'
}
</script>

<template>
  <div>
    <div class="notice-mask" @click="emit('close')"></div>
    <section class="notice-panel" :aria-label="copy.text('notices')">
      <header class="notice-head">
        <span class="notice-title">{{ copy.text('notices') }}</span>
        <button v-if="items.length > 0" class="btn btn-ghost btn-sm" type="button" @click="clearNotices">
          {{ copy.text('clearNotices') }}
        </button>
      </header>
      <div v-if="items.length === 0" class="notice-empty">{{ copy.text('noNotices') }}</div>
      <ul v-else class="notice-list">
        <li v-for="item in items" :key="item.id" class="notice-row">
          <span class="tag" :class="toneClass(item.type)">{{ item.type }}</span>
          <span class="notice-text">{{ item.text }}</span>
          <span class="notice-time mono">{{ stamp(item.time) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.notice-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--mask, rgba(0, 0, 0, 0.35));
}

.notice-panel {
  position: fixed;
  top: 52px;
  right: 18px;
  z-index: 41;
  width: min(420px, calc(100vw - 36px));
  max-height: min(60vh, 480px);
  overflow: auto;
  padding: var(--card-pad, 16px);
  border: 1px solid var(--border);
  border-radius: var(--radius, 14px);
  background: var(--card-solid, var(--card));
  box-shadow: var(--shadow-lg);
}

.notice-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  margin-bottom: var(--space-2, 8px);
}

.notice-title {
  font-size: var(--text-sm, 13px);
  font-weight: 700;
}

.notice-empty {
  padding: var(--space-4, 16px) 0;
  color: var(--text-dim);
  font-size: var(--text-xs, 12px);
  text-align: center;
}

.notice-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.notice-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2, 8px);
  min-height: var(--row-h, 34px);
  padding: var(--space-1, 4px) var(--space-2, 8px);
  border-radius: calc(var(--radius, 14px) / 2);
}

.notice-row:hover {
  background: var(--hover);
}

.notice-text {
  overflow: hidden;
  font-size: var(--text-md, 13px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notice-time {
  color: var(--text-dim);
  font-size: var(--text-xs, 12px);
}
</style>

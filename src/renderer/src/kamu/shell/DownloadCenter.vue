<script setup lang="ts">
/**
 * Download centre (upstream 下载中心): every queued/running/finished job with its live
 * progress, plus cancel / retry / remove.
 *
 * Ported shell layer — see /THIRD_PARTY_NOTICES.md.
 */
import { computed } from 'vue'
import { formatBytes, formatEta, formatSpeed } from '../../composables/format'
import { copy } from './copy'
import { closePanels } from './panels'
import { shell, dismissTask } from './state'
import { cancelJob, errorText, retryJob } from './bridge'
import { useToast } from '../../composables/useToast'

const toast = useToast()
const tasks = computed(() => shell.tasks.value)

function label(task: (typeof tasks.value)[number]): string {
  if (task.status === 'paused') return copy.text('pausedState', { text: task.currentLabel })
  if (task.status === 'cancelled') return copy.text('cancelledState')
  if (task.status === 'done') return copy.text('doneState')
  if (task.status === 'error') return copy.text('failedState', { stage: task.currentLabel || '—', error: task.error })
  if (task.indeterminate) return copy.text('computingTotal')
  return `${task.done} / ${task.total} · ${copy.text('totalProgress', { percent: task.percent })}`
}

function tone(status: string): string {
  if (status === 'error') return 'tag-danger'
  if (status === 'done') return 'tag-success'
  if (status === 'running') return 'tag-accent'
  return 'tag-cyan'
}

async function onCancel(id: string): Promise<void> {
  try {
    await cancelJob(id)
  } catch (error) {
    toast.push({ kind: 'danger', title: copy.text('cancelFailed', { error: errorText(error) }) })
  }
}

function onRetry(id: string): void {
  void retryJob(id).catch((error: unknown) => toast.push({ kind: 'danger', title: errorText(error) }))
}
</script>

<template>
  <div>
    <div class="notice-mask" @click="closePanels"></div>
    <section class="dl-panel" :aria-label="copy.text('downloadCenter')">
      <header class="notice-head">
        <span class="notice-title">{{ copy.text('downloadCenter') }}</span>
        <span class="muted">{{ tasks.length }}</span>
      </header>

      <div v-if="tasks.length === 0" class="notice-empty">
        {{ copy.text('noTasks') }}
        <button class="btn btn-ghost btn-sm" type="button" @click="closePanels">{{ copy.text('goVersions') }}</button>
      </div>

      <ul v-else class="dl-list">
        <li v-for="task in tasks" :key="task.id" class="dl-row">
          <div class="dl-line">
            <span class="tag" :class="tone(task.status)">{{ task.status }}</span>
            <span class="dl-title">{{ task.title }}</span>
            <span v-if="task.status === 'running'" class="dl-rate mono">
              {{ formatSpeed(task.speed) }} · {{ copy.text('eta') }} {{ formatEta(task.etaSeconds) }}
            </span>
          </div>
          <div class="dl-bar" :class="{ 'is-indeterminate': task.indeterminate }">
            <div class="dl-bar-fill" :style="{ width: `${task.percent}%` }"></div>
          </div>
          <div class="dl-line dl-meta muted mono">
            <span>{{ label(task) }}</span>
            <span v-if="task.bytesTotal > 0">{{ formatBytes(task.bytesDone) }} / {{ formatBytes(task.bytesTotal) }}</span>
            <span class="dl-actions">
              <button v-if="task.status === 'running'" class="btn btn-ghost btn-sm" type="button" @click="onCancel(task.id)">
                {{ copy.text('cancel') }}
              </button>
              <button v-else-if="task.status === 'error'" class="btn btn-ghost btn-sm" type="button" @click="onRetry(task.id)">
                {{ copy.text('retry') }}
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="dismissTask(task.id)">
                {{ copy.text('removeFromList') }}
              </button>
            </span>
          </div>
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

.dl-panel {
  position: fixed;
  top: 52px;
  right: 18px;
  z-index: 41;
  width: min(520px, calc(100vw - 36px));
  max-height: min(66vh, 560px);
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
  margin-bottom: var(--space-2, 8px);
}

.notice-title {
  font-size: var(--text-sm, 13px);
  font-weight: 700;
}

.notice-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2, 8px);
  padding: var(--space-4, 16px) 0;
  color: var(--text-dim);
  font-size: var(--text-xs, 12px);
}

.dl-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.dl-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
  padding: var(--space-2, 8px);
  border-radius: calc(var(--radius, 14px) / 2);
  background: var(--card-2, transparent);
}

.dl-line {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
}

.dl-title {
  overflow: hidden;
  font-size: var(--text-md, 13px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-rate {
  margin-left: auto;
  color: var(--accent);
  font-size: var(--text-xs, 12px);
  white-space: nowrap;
}

.dl-bar {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--hover);
}

.dl-bar-fill {
  height: 100%;
  background: var(--accent-grad, var(--accent));
  transition: width var(--dur-2, 200ms) var(--ease-out, ease-out);
}

.dl-bar.is-indeterminate .dl-bar-fill {
  width: 35% !important;
  animation: dl-slide 1.2s linear infinite;
}

@keyframes dl-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(320%);
  }
}

.dl-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  font-size: var(--text-xs, 12px);
}

.dl-actions {
  display: flex;
  gap: var(--space-1, 4px);
  margin-left: auto;
}
</style>

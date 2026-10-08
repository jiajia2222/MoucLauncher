<script setup lang="ts">
/**
 * ModsJobs — the live install panel of the 模组 page.
 *
 * Upstream (`CommunityView.vue` + `ModInstallDialog.vue`) folded the download into a global
 * store slot; MoucX pushes `DownloadProgress` on `mouc:progress` and the terminal
 * `DownloadJob` on `mouc:job-finished`, so this panel owns its own subscription: seed from
 * `mouc.download.jobs()`, follow the pushes, cancel or retry — the same markup and metrics
 * the versions / instance pages use, so a download looks identical everywhere.
 *
 * Only content jobs are listed (`mod` / `resource-pack` / `shader` / `world` / `modpack`);
 * version and Java downloads belong to the pages that started them.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DownloadJob, DownloadProgress } from '@shared/types'
import { formatBytes, formatEta, formatSpeed } from '../../composables/format'
import { defineDict } from '../../i18n'
import { useToast } from '../../composables/useToast'
import { cancelJob, downloadJobs, errText, isContentJob, jobPercent, onJobFinished, onJobProgress, retryJob } from '../api/mods'

const copy = defineDict({
  title: ['模组下载任务', 'Content downloads'],
  refresh: ['刷新任务', 'Refresh'],
  empty: ['当前没有正在进行的模组下载。', 'Nothing is downloading right now.'],
  readFailed: ['读取任务列表失败：{error}', 'Could not read the job list: {error}'],
  cancelDone: ['已请求取消 {title}', 'Cancellation requested for {title}'],
  stQueued: ['排队中', 'Queued'],
  stRunning: ['下载中', 'Downloading'],
  stPaused: ['已暂停', 'Paused'],
  stDone: ['已完成', 'Done'],
  stError: ['失败', 'Failed'],
  stCancelled: ['已取消', 'Cancelled'],
  cancel: ['取消', 'Cancel'],
  retry: ['重试', 'Retry'],
  eta: ['剩余 {time}', '{time} left'],
  files: ['{done} / {total} 个文件', '{done} / {total} files']
})

const emit = defineEmits<{ (e: 'changed', job: DownloadJob): void }>()

const toast = useToast()
const jobs = ref<DownloadJob[]>([])
const progress = ref<Record<string, DownloadProgress>>({})
const loading = ref(false)
const error = ref('')
let disposers: Array<() => void> = []

const shown = computed(() => jobs.value.filter(isContentJob))

function isActive(job: DownloadJob): boolean {
  return job.status === 'queued' || job.status === 'running' || job.status === 'paused'
}

function statusText(job: DownloadJob): string {
  switch (job.status) {
    case 'queued':
      return copy.text('stQueued')
    case 'running':
      return copy.text('stRunning')
    case 'paused':
      return copy.text('stPaused')
    case 'done':
      return copy.text('stDone')
    case 'cancelled':
      return copy.text('stCancelled')
    default:
      return copy.text('stError')
  }
}

function statusTone(job: DownloadJob): string {
  if (job.status === 'done') return 'tag-success'
  if (job.status === 'error' || job.status === 'cancelled') return 'tag-danger'
  if (job.status === 'running') return 'tag-accent'
  return 'tag-cyan'
}

function percentOf(job: DownloadJob): number {
  return jobPercent(job, progress.value[job.id])
}

/** `64% · 6.8 MB/s · 剩余 9s · 112.4 MB / 175.5 MB · 文件名` — everything one line can carry. */
function detailOf(job: DownloadJob): string {
  const live = progress.value[job.id]
  if (!live) {
    if (job.status === 'running') return copy.text('stRunning')
    if (job.bytesTotal > 0) return `${percentOf(job)}% · ${formatBytes(job.bytesDone)} / ${formatBytes(job.bytesTotal)}`
    return statusText(job)
  }
  const parts = [`${percentOf(job)}%`]
  if (live.speedBps > 0) parts.push(formatSpeed(live.speedBps))
  if (live.etaSeconds > 0) parts.push(copy.text('eta', { time: formatEta(live.etaSeconds) }))
  if (live.bytesTotal > 0) parts.push(`${formatBytes(live.bytesDone)} / ${formatBytes(live.bytesTotal)}`)
  if (live.total > 0) parts.push(copy.text('files', { done: live.done, total: live.total }))
  return parts.join(' · ')
}

async function seed(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    jobs.value = await downloadJobs()
  } catch (cause: unknown) {
    error.value = copy.text('readFailed', { error: errText(cause) })
  } finally {
    loading.value = false
  }
}

function onProgressEvent(payload: DownloadProgress): void {
  progress.value = { ...progress.value, [payload.jobId]: payload }
  const job = jobs.value.find((entry) => entry.id === payload.jobId)
  if (!job) {
    void seed()
    return
  }
  jobs.value = jobs.value.map((entry) =>
    entry.id === payload.jobId
      ? {
          ...entry,
          status: payload.status,
          total: payload.total,
          done: payload.done,
          failed: payload.failed,
          bytesTotal: payload.bytesTotal,
          bytesDone: payload.bytesDone
        }
      : entry
  )
}

function onFinished(job: DownloadJob): void {
  const index = jobs.value.findIndex((entry) => entry.id === job.id)
  jobs.value = index === -1 ? [job, ...jobs.value] : [...jobs.value.slice(0, index), job, ...jobs.value.slice(index + 1)]
  const rest = { ...progress.value }
  delete rest[job.id]
  progress.value = rest
  emit('changed', job)
  if (job.status === 'error') {
    toast.push({ kind: 'danger', title: job.error?.message ?? `${job.title} — ${copy.text('stError')}` })
  }
}

async function cancel(job: DownloadJob): Promise<void> {
  try {
    await cancelJob(job.id)
    toast.push({ kind: 'info', title: copy.text('cancelDone', { title: job.title }) })
    await seed()
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: errText(cause) })
  }
}

async function retry(job: DownloadJob): Promise<void> {
  try {
    const next = await retryJob(job.id)
    const index = jobs.value.findIndex((entry) => entry.id === job.id)
    jobs.value = index === -1 ? [next, ...jobs.value] : [...jobs.value.slice(0, index), next, ...jobs.value.slice(index + 1)]
    emit('changed', next)
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: errText(cause) })
  }
}

onMounted(async () => {
  disposers = [onJobProgress(onProgressEvent), onJobFinished(onFinished)]
  await seed()
})

onBeforeUnmount(() => {
  for (const off of disposers) off()
  disposers = []
})

defineExpose({ refresh: seed })
</script>

<template>
  <section v-if="shown.length || error || loading" class="card mods-jobs" aria-live="polite">
    <header class="mods-jobs-head">
      <h3>{{ copy.text('title') }}</h3>
      <span v-if="loading" class="spin" aria-hidden="true"></span>
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="seed">{{ copy.text('refresh') }}</button>
    </header>

    <p v-if="error" class="mods-jobs-error" role="alert">{{ error }}</p>
    <p v-else-if="!shown.length" class="mods-jobs-empty muted">{{ copy.text('empty') }}</p>

    <div v-for="job in shown" :key="job.id" class="mods-jobs-row">
      <div class="mods-jobs-names">
        <span class="mods-jobs-title" :title="job.title">{{ job.title }}</span>
        <span class="tag" :class="statusTone(job)">{{ statusText(job) }}</span>
      </div>
      <div
        class="row-bar"
        :class="{ 'is-indeterminate': job.status === 'running' && percentOf(job) === 0 }"
        role="progressbar"
        :aria-valuenow="percentOf(job)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="row-bar-fill" :style="{ width: percentOf(job) + '%' }"></div>
      </div>
      <span class="muted mono mods-jobs-detail">{{ detailOf(job) }}</span>
      <span class="mods-jobs-actions">
        <button v-if="isActive(job)" class="btn btn-ghost btn-sm" @click="cancel(job)">{{ copy.text('cancel') }}</button>
        <button v-else-if="job.status === 'error' || job.status === 'cancelled'" class="btn btn-ghost btn-sm" @click="retry(job)">
          {{ copy.text('retry') }}
        </button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.mods-jobs {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.mods-jobs-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.mods-jobs-head h3 {
  flex: 1;
  min-width: 0;
  font-size: var(--text-lg);
  font-weight: 700;
}
.mods-jobs-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border);
}
.mods-jobs-names {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.mods-jobs-title {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-bar {
  height: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
}
.row-bar-fill {
  height: 100%;
  background: var(--accent-grad);
  transition: width 0.25s ease;
}
.row-bar.is-indeterminate .row-bar-fill {
  width: 35%;
  animation: mods-job-slide 1.4s ease-in-out infinite;
}
@keyframes mods-job-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(290%);
  }
}
.mods-jobs-detail {
  overflow: hidden;
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.mods-jobs-actions {
  display: flex;
  gap: var(--space-2);
}
.mods-jobs-empty,
.mods-jobs-error {
  font-size: var(--text-sm);
  line-height: 1.6;
}
.mods-jobs-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  .mods-jobs-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .row-bar {
    grid-column: 1 / -1;
  }
}
</style>

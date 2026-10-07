<script setup lang="ts">
/**
 * InstanceCenterProgress — the live download panel both ported views share.
 *
 * Upstream keeps this state in a global store (`store.installProgress`) and shows it inside
 * the instance center as "进度及取消入口位于下载中心". MoucLauncher pushes the same data
 * through `mouc.on('mouc:progress')` / `mouc:job-finished`, so the panel owns its own
 * subscription: mount, seed from `download.jobs()`, follow the pushes, cancel or retry.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DownloadJob, DownloadProgress } from '@shared/types'
import { formatBytes, formatEta, formatSpeed } from '../../composables/format'
import { useToast } from '../../composables/useToast'
import {
  cancelDownload,
  downloadJobs,
  jobIsActive,
  jobPercent,
  jobStatusText,
  jobStatusTone,
  retryDownload,
  subscribeDownloads
} from '../api/versions'

const props = withDefaults(
  defineProps<{
    /** Heading text; the panel is hidden entirely when there is nothing to report. */
    label?: string
    /** Keep finished jobs in the list so the user can see what just landed. */
    keepFinished?: boolean
  }>(),
  { label: '下载与修复任务', keepFinished: true }
)

const emit = defineEmits<{ (e: 'changed', job: DownloadJob): void }>()

const toast = useToast()
const jobs = ref<DownloadJob[]>([])
const progress = ref<Record<string, DownloadProgress>>({})
const loading = ref(false)
const error = ref('')
let dispose: (() => void) | null = null

/** Finished jobs stay visible by default; the create/import dialogs opt out. */
const shown = computed(() => (props.keepFinished ? jobs.value : jobs.value.filter((job) => jobIsActive(job))))

async function seed(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    jobs.value = await downloadJobs()
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '无法读取任务列表'
  } finally {
    loading.value = false
  }
}

function onProgress(payload: DownloadProgress): void {
  progress.value = { ...progress.value, [payload.jobId]: payload }
  const job = jobs.value.find((entry) => entry.id === payload.jobId)
  if (job) {
    job.status = payload.status
    job.total = payload.total
    job.done = payload.done
    job.failed = payload.failed
    job.bytesTotal = payload.bytesTotal
    job.bytesDone = payload.bytesDone
  }
}

function onFinished(job: DownloadJob): void {
  const index = jobs.value.findIndex((entry) => entry.id === job.id)
  if (index === -1) jobs.value = [job, ...jobs.value]
  else jobs.value = [...jobs.value.slice(0, index), job, ...jobs.value.slice(index + 1)]
  delete progress.value[job.id]
  emit('changed', job)
  if (job.status === 'error') {
    toast.push({ kind: 'danger', title: job.error?.message ?? `任务失败：${job.title}` })
  }
}

async function cancel(job: DownloadJob): Promise<void> {
  try {
    await cancelDownload(job.id)
    toast.push({ kind: 'info', title: `已请求取消 ${job.title}` })
    await seed()
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: cause instanceof Error ? cause.message : '取消失败' })
  }
}

async function retry(job: DownloadJob): Promise<void> {
  try {
    const next = await retryDownload(job.id)
    const index = jobs.value.findIndex((entry) => entry.id === job.id)
    if (index >= 0) jobs.value = [...jobs.value.slice(0, index), next, ...jobs.value.slice(index + 1)]
    emit('changed', next)
  } catch (cause: unknown) {
    toast.push({ kind: 'danger', title: cause instanceof Error ? cause.message : '重试失败' })
  }
}

function percentOf(job: DownloadJob): number {
  return jobPercent(job, progress.value[job.id])
}

function textOf(job: DownloadJob): string {
  const live = progress.value[job.id]
  if (!live) return job.status === 'running' ? '正在下载…' : jobStatusText[job.status]
  const parts = [`${percentOf(job)}%`]
  if (live.speedBps > 0) parts.push(formatSpeed(live.speedBps))
  if (live.etaSeconds > 0) parts.push(`剩余 ${formatEta(live.etaSeconds)}`)
  if (live.bytesTotal > 0) parts.push(`${formatBytes(live.bytesDone)} / ${formatBytes(live.bytesTotal)}`)
  if (live.currentLabel) parts.push(live.currentLabel)
  return parts.join(' · ')
}

onMounted(async () => {
  dispose = subscribeDownloads({ onProgress, onJobFinished: onFinished })
  await seed()
})

onBeforeUnmount(() => {
  dispose?.()
  dispose = null
})

defineExpose({ refresh: seed })
</script>

<template>
  <section v-if="shown.length || loading || error" class="card ic-progress" data-ui="instance-center:progress" aria-live="polite">
    <header class="ic-progress-head">
      <h3>{{ label }}</h3>
      <span v-if="loading" class="spin" aria-hidden="true"></span>
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="seed">刷新任务</button>
    </header>
    <p v-if="error" class="ic-progress-error" role="alert">{{ error }}</p>
    <p v-else-if="!shown.length" class="ic-progress-empty muted">当前没有进行中的下载任务。</p>
    <div v-for="job in shown" :key="job.id" class="ic-progress-row">
      <div class="ic-progress-names">
        <span class="version-id">{{ job.title }}</span>
        <span class="tag" :class="jobStatusTone(job.status)">{{ jobStatusText[job.status] }}</span>
      </div>
      <div class="row-bar" :class="{ 'is-indeterminate': job.status === 'running' && percentOf(job) === 0 }" role="progressbar" :aria-valuenow="percentOf(job)" aria-valuemin="0" aria-valuemax="100">
        <div class="row-bar-fill" :style="{ width: percentOf(job) + '%' }"></div>
      </div>
      <span class="muted row-progress-text">{{ textOf(job) }}</span>
      <span class="ic-progress-actions">
        <button v-if="jobIsActive(job)" class="btn btn-ghost btn-sm" @click="cancel(job)">取消</button>
        <button v-else-if="job.status === 'error' || job.status === 'cancelled'" class="btn btn-ghost btn-sm" @click="retry(job)">重试</button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.ic-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.ic-progress-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.ic-progress-head h3 {
  flex: 1;
  min-width: 0;
  font-size: var(--text-lg);
  font-weight: 700;
}
.ic-progress-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border);
}
.ic-progress-names {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.ic-progress-names .version-id {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.row-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--card-2);
  border: 1px solid var(--border);
  overflow: hidden;
}
.row-bar-fill {
  height: 100%;
  background: var(--accent-grad);
  transition: width 0.25s ease;
}
.row-progress-text {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ic-progress-actions {
  display: flex;
  gap: var(--space-2);
}
.ic-progress-empty,
.ic-progress-error {
  font-size: var(--text-sm);
  line-height: 1.6;
}
.ic-progress-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  .ic-progress-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .row-bar {
    grid-column: 1 / -1;
  }
}
</style>

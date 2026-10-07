<script setup lang="ts">
/**
 * MProgress — one component for every "how far along is it" surface.
 *
 * bar  : status bar, cards, list rows
 * ring : launch/install centrepiece
 * Determinate progress may be driven by `percent` alone or by byte counters, in which
 * case the component also prints the transferred amount, the live speed and the ETA —
 * the three numbers a launcher has to show while it works.
 */
import { computed } from 'vue'
import { formatBytes, formatEta, formatSpeed, percent as toPercent } from '../../composables/format'
import { t } from '../../i18n'

const props = withDefaults(
  defineProps<{
    /** 0..100. Ignored when `bytesTotal` is set and `percent` is omitted. */
    percent?: number
    indeterminate?: boolean
    kind?: 'bar' | 'ring'
    size?: 'sm' | 'md' | 'lg'
    /** Colour of the filled portion. */
    status?: 'active' | 'success' | 'warning' | 'error' | 'paused'
    /** Title printed above the track. */
    label?: string
    bytesDone?: number
    bytesTotal?: number
    /** Bytes per second, from `DownloadProgress.speedBps`. */
    speed?: number
    etaSeconds?: number
    /** Show "12.3 MB / 512 MB". */
    showBytes?: boolean
    /** Show "12.3 MB/s · 剩余 1m 20s". */
    showMeta?: boolean
    /** Ring only: hides the percentage text. */
    showValue?: boolean
    id?: string
  }>(),
  {
    percent: 0,
    indeterminate: false,
    kind: 'bar',
    size: 'md',
    status: 'active',
    label: '',
    bytesDone: 0,
    bytesTotal: 0,
    speed: 0,
    etaSeconds: 0,
    showBytes: false,
    showMeta: false,
    showValue: true
  }
)

const RING_GEOMETRY: Record<'sm' | 'md' | 'lg', number> = { sm: 40, md: 64, lg: 88 }
const STROKE: Record<'sm' | 'md' | 'lg', number> = { sm: 4, md: 4, lg: 6 }

const diameter = computed(() => RING_GEOMETRY[props.size])
const stroke = computed(() => STROKE[props.size])
const radius = computed(() => (diameter.value - stroke.value) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)

const value = computed(() => {
  if (props.indeterminate) return 0
  if (props.bytesTotal > 0) return toPercent(props.bytesDone, props.bytesTotal)
  return Math.min(100, Math.max(0, props.percent))
})

const dashOffset = computed(() => circumference.value * (1 - value.value / 100))
const bytesText = computed(() => t('common.bytesOf', { done: formatBytes(props.bytesDone), total: formatBytes(props.bytesTotal) }))
const hasSpeed = computed(() => props.speed > 0)
const hasEta = computed(() => props.etaSeconds > 0)
</script>

<template>
  <div class="m-progress" :class="[`s-${size}`, `st-${status}`, `k-${kind}`, { 'is-busy': indeterminate }]" :id="id">
    <div v-if="label || (showBytes && bytesTotal > 0)" class="head">
      <span v-if="label" class="label u-truncate">{{ label }}</span>
      <span v-if="showBytes && bytesTotal > 0" class="bytes u-num">{{ bytesText }}</span>
    </div>

    <div v-if="kind === 'bar'" class="track" role="progressbar" :aria-valuenow="indeterminate ? undefined : Math.round(value)" aria-valuemin="0" aria-valuemax="100" :aria-label="label || undefined">
      <span class="fill" :style="indeterminate ? undefined : { width: `${value}%` }" />
    </div>

    <svg
      v-else
      class="ring"
      :width="diameter"
      :height="diameter"
      :viewBox="`0 0 ${diameter} ${diameter}`"
      role="progressbar"
      :aria-valuenow="indeterminate ? undefined : Math.round(value)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="label || undefined"
    >
      <circle class="ring-track" :cx="diameter / 2" :cy="diameter / 2" :r="radius" :stroke-width="stroke" />
      <circle
        class="ring-value"
        :cx="diameter / 2"
        :cy="diameter / 2"
        :r="radius"
        :stroke-width="stroke"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="indeterminate ? circumference * 0.75 : dashOffset"
      />
      <text v-if="showValue && !indeterminate" class="ring-text" :x="diameter / 2" :y="diameter / 2">
        {{ Math.round(value) }}%
      </text>
    </svg>

    <div v-if="showMeta && (hasSpeed || hasEta)" class="meta">
      <span v-if="hasSpeed" class="num">{{ formatSpeed(speed) }}</span>
      <span v-if="hasSpeed && hasEta" class="dot">·</span>
      <span v-if="hasEta" class="eta">{{ t('status.eta') }} {{ formatEta(etaSeconds) }}</span>
    </div>
  </div>
</template>

<style scoped>
.m-progress {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
  min-width: 0;
}

/* ---- head / meta ---- */
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--m-sp-2);
  min-width: 0;
}

.label {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.bytes {
  flex: none;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.num,
.eta {
  font-family: var(--m-font-mono);
  letter-spacing: 0;
}

.dot {
  opacity: 0.6;
}

/* ---- bar ---- */
.track {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: var(--m-r-full);
  background: var(--m-surface-active);
}

.s-sm .track {
  height: 4px;
}

.s-md .track {
  height: 8px;
}

.s-lg .track {
  height: 12px;
}

.fill {
  display: block;
  height: 100%;
  border-radius: var(--m-r-full);
  background: var(--m-accent);
  transition: width var(--m-dur-2) var(--m-ease-standard);
}

.st-success .fill {
  background: var(--m-success);
}

.st-warning .fill {
  background: var(--m-warning);
}

.st-error .fill {
  background: var(--m-danger);
}

.st-paused .fill {
  background: var(--m-text-muted);
}

.is-busy .fill {
  width: 34%;
  transition: none;
  animation: m-progress-slide var(--m-dur-spin) var(--m-ease-standard) infinite;
}

@keyframes m-progress-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

/* ---- ring ---- */
.ring {
  flex: none;
  transform: rotate(-90deg);
}

.is-busy .ring {
  animation: m-ring-turn var(--m-dur-spin) linear infinite;
}

@keyframes m-ring-turn {
  to {
    transform: rotate(270deg);
  }
}

.ring-track {
  fill: none;
  stroke: var(--m-surface-active);
}

.ring-value {
  fill: none;
  stroke: var(--m-accent);
  stroke-linecap: round;
  transition: stroke-dashoffset var(--m-dur-2) var(--m-ease-standard);
}

.st-success .ring-value {
  stroke: var(--m-success);
}

.st-warning .ring-value {
  stroke: var(--m-warning);
}

.st-error .ring-value {
  stroke: var(--m-danger);
}

.st-paused .ring-value {
  stroke: var(--m-text-muted);
}

.ring-text {
  fill: var(--m-text-primary);
  font-family: var(--m-font-mono);
  font-size: 13px;
  text-anchor: middle;
  dominant-baseline: central;
  /* counter the -90deg so the digits stay upright */
  transform: rotate(90deg);
  transform-origin: center;
}

.s-sm .ring-text {
  font-size: 11px;
}

.s-lg .ring-text {
  font-size: var(--m-fs-16);
}
</style>

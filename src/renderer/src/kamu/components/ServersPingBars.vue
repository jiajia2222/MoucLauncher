<script setup lang="ts">
/**
 * Minecraft's five-bar signal meter, drawn the way the game client draws it: bars grow
 * in height left to right, and the filled count plus their colour encode the latency
 * bucket. Colours come from the theme tokens only.
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ online: boolean; latencyMs?: number; pending?: boolean }>(), {
  latencyMs: 0,
  pending: false
})

const level = computed<number>(() => {
  if (props.pending || !props.online) return 0
  if (props.latencyMs < 60) return 5
  if (props.latencyMs < 120) return 4
  if (props.latencyMs < 220) return 3
  if (props.latencyMs < 400) return 2
  return 1
})

const quality = computed(() => (level.value >= 4 ? 'good' : level.value >= 2 ? 'mid' : 'poor'))

const label = computed(() => {
  if (props.pending) return '延迟检测中'
  if (!props.online) return '未连通'
  return `${props.latencyMs} ms`
})
</script>

<template>
  <span class="ping-bars" :class="[quality, { 'is-off': level === 0 }]" role="img" :aria-label="`网络延迟 ${label}`" :title="label">
    <i v-for="bar in 5" :key="bar" :class="{ on: bar <= level }" />
  </span>
</template>

<style scoped>
.ping-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  flex: none;
}
.ping-bars i {
  width: 3px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--text-dim) 30%, transparent);
  transition: background var(--motion-fast) ease;
}
.ping-bars i:nth-child(1) { height: 5px; }
.ping-bars i:nth-child(2) { height: 7px; }
.ping-bars i:nth-child(3) { height: 9px; }
.ping-bars i:nth-child(4) { height: 11px; }
.ping-bars i:nth-child(5) { height: 13px; }
.ping-bars.good i.on { background: var(--ok); }
.ping-bars.mid i.on { background: var(--accent); }
.ping-bars.poor i.on { background: var(--danger); }
.ping-bars.is-off i.on { background: var(--text-dim); }
</style>

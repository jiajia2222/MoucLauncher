<script setup lang="ts">
/**
 * MIcon — the only icon source in the app.
 * Geometry lives in ./paths.ts (20px grid, stroke 1.5, fill none).
 * Icons are decorative: interactive parents must provide the accessible name.
 */
import { computed } from 'vue'
import { ICON_PATHS, type IconName } from './paths'

const props = withDefaults(
  defineProps<{
    name: IconName
    /** CSS pixel size. The shell uses 16 (rail meta / status bar) and 20. */
    size?: number
    /** Optical weight; 1.5 is the brand default, 1.2 only for 24px+ marks. */
    strokeWidth?: number
    /** Continuous rotation, used by loading affordances. */
    spin?: boolean
    /** Overrides currentColor with a token colour. */
    tone?: 'current' | 'accent' | 'muted' | 'success' | 'warning' | 'danger'
  }>(),
  { size: 20, strokeWidth: 1.5, spin: false, tone: 'current' }
)

const d = computed(() => ICON_PATHS[props.name])
const dimension = computed(() => `${props.size}px`)
</script>

<template>
  <svg
    class="m-icon"
    :class="{ 'is-spin': spin }"
    :style="{ '--m-icon-size': dimension, '--m-icon-w': String(strokeWidth) }"
    :data-tone="tone"
    viewBox="0 0 20 20"
    width="20"
    height="20"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="d" />
  </svg>
</template>

<style scoped>
.m-icon {
  width: var(--m-icon-size);
  height: var(--m-icon-size);
  flex: none;
  color: currentColor;
}

.m-icon[data-tone='accent'] {
  color: var(--m-accent-text);
}

.m-icon[data-tone='muted'] {
  color: var(--m-text-muted);
}

.m-icon[data-tone='success'] {
  color: var(--m-success);
}

.m-icon[data-tone='warning'] {
  color: var(--m-warning);
}

.m-icon[data-tone='danger'] {
  color: var(--m-danger);
}

.m-icon path {
  fill: none;
  stroke: currentColor;
  stroke-width: var(--m-icon-w);
  stroke-linecap: round;
  stroke-linejoin: round;
}

.is-spin {
  animation: m-icon-spin var(--m-dur-spin) linear infinite;
  transform-origin: center;
}

@keyframes m-icon-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

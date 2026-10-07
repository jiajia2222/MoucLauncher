<script setup lang="ts">
/**
 * MIconButton — square icon-only action.
 * `label` is mandatory: an icon button without an accessible name is a bug, and the
 * tooltip is composed by the caller (`<MTooltip><MIconButton :label="…"/></MTooltip>`).
 */
import { computed } from 'vue'
import MIcon from '../icons/MIcon.vue'
import type { IconName } from '../icons/paths'

type Size = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    icon: IconName
    label: string
    size?: Size
    variant?: 'plain' | 'ghost' | 'outline'
    active?: boolean
    disabled?: boolean
    loading?: boolean
    /** Danger-tinted glyph, used for destructive row actions. */
    tone?: 'current' | 'accent' | 'danger'
  }>(),
  { size: 'md', variant: 'ghost', active: false, disabled: false, loading: false, tone: 'current' }
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

const iconSize = computed(() => (props.size === 'sm' ? 16 : 20))
</script>

<template>
  <button
    class="m-icon-button"
    :class="[`v-${variant}`, `s-${size}`, { 'is-active': active }]"
    type="button"
    :disabled="disabled || loading"
    :aria-label="label"
    :aria-pressed="active || undefined"
    @click="emit('click', $event)"
  >
    <MIcon :name="icon" :size="iconSize" :tone="tone === 'accent' ? 'accent' : tone === 'danger' ? 'danger' : 'current'" :spin="loading" />
  </button>
</template>

<style scoped>
.m-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: var(--m-line) solid transparent;
  border-radius: var(--m-r-sm);
  color: var(--m-text-secondary);
  -webkit-app-region: no-drag;
  transition:
    background-color var(--m-dur-1) var(--m-ease-standard),
    color var(--m-dur-1) var(--m-ease-standard),
    border-color var(--m-dur-1) var(--m-ease-standard);
}

.m-icon-button:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: var(--m-focus-offset);
}

.s-sm {
  width: 24px;
  height: 24px;
}

.s-md {
  width: 32px;
  height: 32px;
}

.s-lg {
  width: 40px;
  height: 40px;
}

.v-ghost:hover:not(:disabled) {
  background: var(--m-surface-hover);
  color: var(--m-text-primary);
}

.v-ghost:active:not(:disabled),
.is-active {
  background: var(--m-surface-active);
  color: var(--m-text-primary);
}

.v-outline {
  background: var(--m-surface-raised);
  border-color: var(--m-border-weak);
}

.v-outline:hover:not(:disabled) {
  background: var(--m-surface-hover);
  border-color: var(--m-border-strong);
}

.v-plain:hover:not(:disabled) {
  color: var(--m-text-primary);
}

.m-icon-button:disabled {
  opacity: 0.4;
}
</style>

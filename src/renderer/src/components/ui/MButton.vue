<script setup lang="ts">
/**
 * MButton — the only way to press something in MoucLauncher.
 * Four variants, three sizes, a built-in busy state that keeps the label width.
 */
import { computed } from 'vue'
import MIcon from '../icons/MIcon.vue'
import type { IconName } from '../icons/paths'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    /** Replaces the leading icon with a spinner and blocks interaction. */
    loading?: boolean
    disabled?: boolean
    icon?: IconName
    /** e.g. `chevron-down` for dropdown-ish triggers. */
    trailingIcon?: IconName
    /** Stretch to the container width. */
    block?: boolean
    type?: 'button' | 'submit' | 'reset'
    active?: boolean
  }>(),
  {
    variant: 'outline',
    size: 'md',
    loading: false,
    disabled: false,
    block: false,
    type: 'button',
    active: false
  }
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

const iconSize = computed(() => (props.size === 'sm' ? 16 : 20))
const inert = computed(() => props.disabled || props.loading)

function onClick(event: MouseEvent): void {
  if (inert.value) {
    event.preventDefault()
    return
  }
  emit('click', event)
}
</script>

<template>
  <button
    class="m-button"
    :class="[`v-${variant}`, `s-${size}`, { 'is-block': block, 'is-active': active }]"
    :type="type"
    :disabled="inert"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <MIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <span class="label"><slot /></span>
    <MIcon v-if="trailingIcon && !loading" :name="trailingIcon" :size="iconSize" class="trailing" />
  </button>
</template>

<style scoped>
.m-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--m-sp-2);
  border: var(--m-line) solid transparent;
  border-radius: var(--m-r-sm);
  font-family: var(--m-font-ui);
  font-size: var(--m-fs-13);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  -webkit-app-region: no-drag;
  transition:
    background-color var(--m-dur-1) var(--m-ease-standard),
    border-color var(--m-dur-1) var(--m-ease-standard),
    color var(--m-dur-1) var(--m-ease-standard),
    box-shadow var(--m-dur-1) var(--m-ease-standard);
}

.m-button:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: var(--m-focus-offset);
}

/* sizes: 24 / 32 / 40 — all on the 4px grid */
.s-sm {
  height: 24px;
  padding: 0 var(--m-sp-2);
  font-size: var(--m-fs-12);
}

.s-md {
  height: 32px;
  padding: 0 var(--m-sp-3);
}

.s-lg {
  height: 40px;
  padding: 0 var(--m-sp-4);
  font-size: var(--m-fs-14);
}

.is-block {
  width: 100%;
}

.label {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- variants ---- */
.v-primary {
  background: var(--m-accent);
  color: var(--m-accent-ink);
}

.v-primary:hover:not(:disabled) {
  background: var(--m-accent-hover);
}

.v-primary:active:not(:disabled) {
  background: var(--m-accent-pressed);
}

.v-outline {
  background: var(--m-surface-raised);
  border-color: var(--m-border-weak);
  color: var(--m-text-primary);
}

.v-outline:hover:not(:disabled) {
  background: var(--m-surface-hover);
  border-color: var(--m-border-strong);
}

.v-outline:active:not(:disabled),
.v-outline.is-active {
  background: var(--m-surface-active);
}

.v-ghost {
  background: transparent;
  color: var(--m-text-secondary);
}

.v-ghost:hover:not(:disabled) {
  background: var(--m-surface-hover);
  color: var(--m-text-primary);
}

.v-ghost:active:not(:disabled),
.v-ghost.is-active {
  background: var(--m-surface-active);
  color: var(--m-text-primary);
}

.v-danger {
  background: var(--m-danger-soft);
  border-color: var(--m-danger);
  color: var(--m-danger);
}

.v-danger:hover:not(:disabled) {
  background: var(--m-surface-active);
  border-color: var(--m-danger);
  color: var(--m-danger);
}

.m-button:disabled {
  opacity: 0.45;
}

.trailing {
  opacity: 0.7;
}

/* ---- busy ---- */
.spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border: 1.5px solid currentColor;
  border-bottom-color: transparent;
  border-radius: var(--m-r-full);
  animation: m-btn-spin var(--m-dur-spin) linear infinite;
}

@keyframes m-btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

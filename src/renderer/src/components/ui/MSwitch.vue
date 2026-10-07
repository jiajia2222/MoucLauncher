<script setup lang="ts">
/** MSwitch — boolean on/off with a track and a sliding knob. */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    disabled?: boolean
    size?: 'sm' | 'md'
    /** Inline caption to the right of the track. */
    label?: string
    id?: string
  }>(),
  { disabled: false, size: 'md', label: '' }
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <span class="m-switch" :class="[`s-${size}`, { 'is-on': modelValue, 'is-disabled': disabled }]">
    <button
      :id="id"
      class="track"
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="knob" />
    </button>
    <span v-if="label" class="caption" @click="toggle">{{ label }}</span>
    <slot />
  </span>
</template>

<style scoped>
.m-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-2);
  -webkit-app-region: no-drag;
}

.track {
  position: relative;
  flex: none;
  width: 32px;
  height: 16px;
  border: var(--m-line) solid var(--m-border-strong);
  border-radius: var(--m-r-full);
  background: var(--m-surface-active);
  transition:
    background-color var(--m-dur-2) var(--m-ease-standard),
    border-color var(--m-dur-2) var(--m-ease-standard);
}

.s-sm .track {
  width: 24px;
  height: 12px;
}

.knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 12px;
  height: 12px;
  border-radius: var(--m-r-full);
  background: var(--m-text-secondary);
  transition:
    transform var(--m-dur-2) var(--m-ease-out),
    background-color var(--m-dur-2) var(--m-ease-standard);
}

.s-sm .knob {
  width: 8px;
  height: 8px;
}

.is-on .track {
  background: var(--m-accent);
  border-color: var(--m-accent);
}

.is-on .knob {
  background: var(--m-accent-ink);
  transform: translateX(16px);
}

.s-sm.is-on .knob {
  transform: translateX(12px);
}

.track:hover:not(:disabled) {
  border-color: var(--m-accent-line);
}

.track:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: var(--m-focus-offset);
}

.is-disabled {
  opacity: 0.45;
}

.caption {
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
  cursor: pointer;
  user-select: none;
}
</style>

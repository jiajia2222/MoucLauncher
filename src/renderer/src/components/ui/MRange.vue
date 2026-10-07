<script setup lang="ts">
/**
 * MRange — value slider.
 * A transparent native `<input type=range>` sits on top of the painted track, so pointer
 * dragging, keyboard arrows and assistive-tech semantics come from the platform while the
 * visuals stay token-driven (no UA styling traps).
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: number
    min?: number
    max?: number
    step?: number
    disabled?: boolean
    /** Prints the current value at the right end. */
    showValue?: boolean
    /** Overrides the printed number (e.g. "4 GB"). */
    valueText?: string
    label?: string
    /** Tick marks drawn under the track. */
    marks?: number[]
    id?: string
  }>(),
  { min: 0, max: 100, step: 1, disabled: false, showValue: false, valueText: '', label: '' }
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const ratio = computed(() => {
  const span = props.max - props.min
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (props.modelValue - props.min) / span))
})

const printed = computed(() => props.valueText || String(props.modelValue))

function onInput(event: Event): void {
  emit('update:modelValue', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="m-range" :class="{ 'is-disabled': disabled }" :style="{ '--m-range-p': String(ratio) }">
    <div class="head">
      <span v-if="label" class="label">{{ label }}</span>
      <span v-if="showValue" class="value u-num">{{ printed }}</span>
    </div>
    <div class="rail">
      <span class="track" />
      <span class="fill" />
      <span class="thumb" aria-hidden="true" />
      <input
        :id="id"
        class="native"
        type="range"
        :value="modelValue"
        :min="min"
        :max="max"
        :step="step"
        :disabled="disabled"
        :aria-label="label || undefined"
        @input="onInput"
      />
    </div>
    <div v-if="marks && marks.length" class="ticks">
      <span v-for="mark in marks" :key="mark" class="tick" :style="{ '--m-tick-p': String((mark - min) / (max - min || 1)) }">
        {{ mark }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.m-range {
  width: 100%;
  -webkit-app-region: no-drag;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--m-sp-2);
  margin-bottom: var(--m-sp-1);
  min-height: 16px;
}

.label {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.value {
  font-size: var(--m-fs-12);
  color: var(--m-text-primary);
}

.rail {
  position: relative;
  height: 16px;
}

.track,
.fill {
  position: absolute;
  top: 6px;
  left: 6px;
  right: 6px;
  height: 4px;
  border-radius: var(--m-r-full);
}

.track {
  background: var(--m-surface-active);
}

.fill {
  right: auto;
  width: calc(var(--m-range-p) * (100% - 12px));
  background: var(--m-accent);
}

.thumb {
  position: absolute;
  top: 2px;
  left: calc(6px + var(--m-range-p) * (100% - 12px));
  width: 12px;
  height: 12px;
  transform: translateX(-6px);
  border-radius: var(--m-r-full);
  background: var(--m-accent);
  box-shadow: var(--m-shadow-sm);
  pointer-events: none;
}

.native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 16px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: none;
  cursor: pointer;
}

.native::-webkit-slider-runnable-track {
  height: 16px;
  background: none;
}

.native::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  border: 0;
  border-radius: var(--m-r-full);
  background: none;
}

.native:focus-visible {
  outline: none;
}

/* The ring belongs to the painted thumb, not the invisible input. */
.rail:has(.native:focus-visible) .thumb {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: 2px;
}

.ticks {
  position: relative;
  height: 14px;
  margin-top: var(--m-sp-1);
}

.tick {
  position: absolute;
  left: calc(6px + var(--m-tick-p) * (100% - 12px));
  transform: translateX(-50%);
  font-family: var(--m-font-mono);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.is-disabled {
  opacity: 0.45;
}

.is-disabled .native {
  cursor: not-allowed;
}
</style>

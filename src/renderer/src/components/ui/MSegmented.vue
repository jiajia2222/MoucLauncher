<script setup lang="ts">
/** MSegmented — mutually exclusive view/filter switch with a sliding indicator. */
import MIcon from "../icons/MIcon.vue";
import type { SegmentOption } from "./types";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SegmentOption[];
    size?: "sm" | "md";
    /** Equal-width cells; set false to size each cell to its label. */
    equal?: boolean;
    disabled?: boolean;
  }>(),
  { size: "md", equal: true, disabled: false }
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

function index(value: string): number {
  return props.options.findIndex((option) => option.value === value);
}
</script>

<template>
  <div
    class="m-segmented"
    :class="[`s-${size}`, { 'is-equal': equal, 'is-disabled': disabled }]"
    :style="{ '--m-seg-n': options.length, '--m-seg-i': Math.max(0, index(modelValue)) }"
    role="tablist"
  >
    <span class="indicator" aria-hidden="true" />
    <button
      v-for="option in options"
      :key="option.value"
      class="cell"
      type="button"
      role="tab"
      :aria-selected="modelValue === option.value"
      :aria-label="option.label ? undefined : option.labelKey || option.value"
      :disabled="disabled"
      @click="emit('update:modelValue', option.value)"
    >
      <MIcon v-if="option.icon" :name="option.icon" :size="16" />
      <span v-if="option.label" class="text u-truncate">{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.m-segmented {
  position: relative;
  display: grid;
  grid-auto-flow: column;
  gap: 0;
  padding: 2px;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-elevated);
  -webkit-app-region: no-drag;
}

.is-equal {
  grid-template-columns: repeat(var(--m-seg-n), minmax(0, 1fr));
}

.indicator {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc((100% - 4px) / var(--m-seg-n));
  height: calc(100% - 4px);
  border-radius: var(--m-r-xs);
  background: var(--m-accent-soft-strong);
  box-shadow: inset 0 0 0 1px var(--m-accent-line);
  transform: translateX(calc(var(--m-seg-i) * 100%));
  transition: transform var(--m-dur-2) var(--m-ease-out);
  pointer-events: none;
}

.cell {
  position: relative;
  z-index: var(--m-z-sticky);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--m-sp-1);
  min-width: 0;
  border: 0;
  border-radius: var(--m-r-xs);
  background: none;
  color: var(--m-text-secondary);
  font-size: var(--m-fs-13);
  transition:
    color var(--m-dur-1) var(--m-ease-standard),
    background-color var(--m-dur-1) var(--m-ease-standard);
}

.s-md .cell {
  height: 28px;
  padding: 0 var(--m-sp-2);
}

.s-sm .cell {
  height: 20px;
  padding: 0 var(--m-sp-2);
  font-size: var(--m-fs-12);
}

/* Icon-only segments stay square so a chip row keeps a rhythm. */
.cell {
  min-height: 28px;
}

.cell:hover:not(:disabled) {
  color: var(--m-text-primary);
}

.cell[aria-selected="true"] {
  color: var(--m-accent-text);
}

.cell:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: -2px;
}

.is-disabled {
  opacity: 0.45;
}

.text {
  white-space: nowrap;
}
</style>

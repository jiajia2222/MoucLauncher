<script setup lang="ts">
/**
 * MList — keyboard-driven vertical list (instances, servers, mods, LAN games).
 * Rows are props-driven so views do not re-implement selection, but a `row` slot can
 * replace the whole row body when a view needs a richer layout.
 */
import MIcon from "../icons/MIcon.vue";
import type { ListRow } from "./types";

const props = withDefaults(
  defineProps<{
    rows: ListRow[];
    modelValue?: string;
    selectable?: boolean;
    dense?: boolean;
    divided?: boolean;
    /** Shows a leading radio-style marker for the selected row. */
    marker?: boolean;
  }>(),
  { modelValue: "", selectable: true, dense: false, divided: true, marker: false }
);

const emit = defineEmits<{ "update:modelValue": [id: string]; select: [id: string] }>();

function choose(row: ListRow): void {
  if (row.disabled) return;
  emit("update:modelValue", row.id);
  emit("select", row.id);
}
</script>

<template>
  <ul class="m-list" :class="{ 'is-dense': dense }" role="listbox" :aria-multiselectable="false">
    <li v-if="!rows.length && $slots.empty" class="empty-slot" role="presentation"><slot name="empty" /></li>
    <template v-else>
      <li v-for="row in rows" :key="row.id" class="row-wrap" role="presentation">
      <component
        :is="selectable && !row.disabled ? 'button' : 'div'"
        class="row"
        :class="{ 'is-selected': modelValue === row.id, 'is-disabled': row.disabled, 'is-divided': divided }"
        :role="selectable && !row.disabled ? 'option' : 'listitem'"
        :aria-selected="selectable ? modelValue === row.id : undefined"
        :type="selectable && !row.disabled ? 'button' : undefined"
        :disabled="row.disabled"
        @click="choose(row)"
      >
        <template v-if="$slots.row">
          <slot name="row" :row="row" :selected="modelValue === row.id" />
        </template>
        <template v-else>
          <span v-if="marker" class="marker" aria-hidden="true">
            <MIcon v-if="modelValue === row.id" name="check" :size="16" />
          </span>
          <MIcon v-else-if="row.icon" :name="row.icon" :size="16" tone="muted" class="lead" />
          <span class="stack">
            <span class="label u-truncate">{{ row.label }}</span>
            <span v-if="row.hint" class="hint u-truncate">{{ row.hint }}</span>
          </span>
          <span v-if="row.meta" class="meta u-num">{{ row.meta }}</span>
          <slot name="trailing" :row="row" />
        </template>
      </component>
      </li>
    </template>
  </ul>
</template>

<style scoped>
.m-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.row-wrap {
  display: block;
}

.is-divided,
.row.is-divided {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  width: 100%;
  min-height: 44px;
  padding: var(--m-sp-2) var(--m-sp-3);
  border: 0;
  border-radius: var(--m-r-md);
  background: none;
  color: var(--m-text-primary);
  text-align: left;
  cursor: default;
  transition:
    background-color var(--m-dur-1) var(--m-ease-standard),
    box-shadow var(--m-dur-1) var(--m-ease-standard);
}

.is-dense .row {
  min-height: 32px;
  padding: var(--m-sp-1) var(--m-sp-2);
}

.row-wrap + .row-wrap .row.is-divided {
  box-shadow: inset 0 1px 0 var(--m-border-hairline);
  border-radius: 0 0 var(--m-r-md) var(--m-r-md);
}

.row-wrap + .row-wrap .row.is-divided::before {
  content: "";
  position: absolute;
  top: 0;
  left: var(--m-sp-3);
  right: var(--m-sp-3);
  height: 1px;
  background: var(--m-border-hairline);
}

button.row {
  cursor: pointer;
}

button.row:hover:not(:disabled) {
  background: var(--m-surface-hover);
}

.row.is-selected {
  background: var(--m-accent-soft);
}

.row.is-disabled {
  opacity: 0.45;
}

.row:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: -2px;
}

.marker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex: none;
  color: var(--m-accent-text);
}

.lead {
  flex: none;
}

.stack {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.label {
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
}

.hint {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.meta {
  flex: none;
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.empty-slot {
  padding: var(--m-sp-2) 0;
}
</style>

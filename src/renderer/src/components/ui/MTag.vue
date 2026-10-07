<script setup lang="ts">
/** MTag — short status/classification chip (loader, version type, category). */
import MIcon from "../icons/MIcon.vue";
import type { IconName } from "../icons/paths";
import { t } from "../../i18n";

withDefaults(
  defineProps<{
    tone?: "neutral" | "accent" | "success" | "warning" | "danger";
    size?: "sm" | "md";
    icon?: IconName;
    /** Leading 6px dot instead of an icon. */
    dot?: boolean;
    closable?: boolean;
    active?: boolean;
  }>(),
  { tone: "neutral", size: "md", closable: false, active: false, dot: false }
);

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <span class="m-tag" :class="['tone-' + tone, 'size-' + size, { 'is-active': active }]">
    <span v-if="dot" class="dot" aria-hidden="true" />
    <MIcon v-else-if="icon" :name="icon" :size="size === 'sm' ? 12 : 14" />
    <span class="text"><slot /></span>
    <button v-if="closable" class="close" type="button" :aria-label="t('common.close')" @click.stop="emit('close')">
      <MIcon name="x" :size="12" />
    </button>
  </span>
</template>

<style scoped>
.m-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  max-width: 100%;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-xs);
  background: var(--m-surface-raised);
  color: var(--m-text-secondary);
  font-size: var(--m-fs-12);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.size-sm {
  height: 18px;
  padding: 0 5px;
  font-size: var(--m-fs-12);
}

.size-md {
  height: 20px;
  padding: 0 var(--m-sp-2);
}

.text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tone-accent {
  border-color: var(--m-accent-line);
  background: var(--m-accent-soft);
  color: var(--m-accent-text);
}

.tone-success {
  border-color: var(--m-success);
  background: var(--m-success-soft);
  color: var(--m-success);
}

.tone-warning {
  border-color: var(--m-warning);
  background: var(--m-warning-soft);
  color: var(--m-warning);
}

.tone-danger {
  border-color: var(--m-danger);
  background: var(--m-danger-soft);
  color: var(--m-danger);
}

.is-active {
  border-color: var(--m-accent);
  color: var(--m-accent-text);
}

.dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--m-r-full);
  background: currentColor;
}

.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  margin-right: -2px;
  border-radius: var(--m-r-xs);
  color: inherit;
  opacity: 0.7;
}

.close:hover {
  opacity: 1;
  background: var(--m-surface-active);
}

.close:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: -1px;
}
</style>

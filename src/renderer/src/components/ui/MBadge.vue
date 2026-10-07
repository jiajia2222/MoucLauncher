<script setup lang="ts">
/** MBadge — count or state marker; anchored to a slot, or standalone as an inline pill. */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    value?: string | number;
    /** Counts above `max` render as `max+`. */
    max?: number;
    tone?: "neutral" | "accent" | "success" | "warning" | "danger";
    /** State dot only, no number. */
    dot?: boolean;
    /** Hide the pill when the count is zero. */
    hideWhenZero?: boolean;
    position?: "top-right" | "top-left" | "bottom-right";
  }>(),
  {
    value: "",
    tone: "accent",
    dot: false,
    hideWhenZero: false,
    position: "top-right",
    max: 99
  }
);

const visible = computed(() => !props.hideWhenZero || props.dot || Number(props.value) !== 0);
const shown = computed(() => {
  const numeric = Number(props.value);
  return Number.isFinite(numeric) && numeric > props.max ? props.max + "+" : String(props.value);
});
</script>

<template>
  <span class="m-badge" :class="{ 'has-anchor': !!$slots.default }">
    <slot />
    <span v-if="visible" class="pill" :class="['tone-' + tone, dot ? 'is-dot' : 'is-value', 'pos-' + position]">
      <template v-if="!dot">{{ shown }}</template>
    </span>
  </span>
</template>

<style scoped>
.m-badge {
  position: relative;
  display: inline-flex;
  -webkit-app-region: no-drag;
}

.has-anchor .pill {
  position: absolute;
  z-index: var(--m-z-sticky);
}

.pos-top-right {
  top: -6px;
  right: -6px;
}

.pos-top-left {
  top: -6px;
  left: -6px;
}

.pos-bottom-right {
  bottom: -6px;
  right: -6px;
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--m-r-full);
  font-family: var(--m-font-mono);
  font-size: var(--m-fs-12);
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0;
}

.is-dot {
  min-width: 8px;
  height: 8px;
  padding: 0;
}

.is-value {
  border: var(--m-line) solid var(--m-surface-elevated);
}

.tone-accent {
  background: var(--m-accent);
  color: var(--m-accent-ink);
}

.tone-neutral {
  background: var(--m-surface-active);
  color: var(--m-text-primary);
}

.tone-success {
  background: var(--m-success);
  color: var(--m-surface-base);
}

.tone-warning {
  background: var(--m-warning);
  color: var(--m-surface-base);
}

.tone-danger {
  background: var(--m-danger);
  color: var(--m-surface-base);
}
</style>

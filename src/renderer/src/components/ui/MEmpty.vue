<script setup lang="ts">
/** MEmpty — the "nothing here yet" state, sized so it never collapses into a caption. */
import MIcon from "../icons/MIcon.vue";
import type { IconName } from "../icons/paths";

withDefaults(
  defineProps<{
    icon?: IconName;
    title: string;
    description?: string;
    /** Denser variant for inside a card or a panel. */
    compact?: boolean;
  }>(),
  { icon: "box", description: "", compact: false }
);
</script>

<template>
  <div class="m-empty" :class="{ 'is-compact': compact }">
    <span class="mark"><MIcon :name="icon" :size="compact ? 20 : 28" :stroke-width="1.2" tone="muted" /></span>
    <p class="title">{{ title }}</p>
    <p v-if="description" class="desc">{{ description }}</p>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </div>
</template>

<style scoped>
.m-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--m-sp-2);
  padding: var(--m-sp-8) var(--m-sp-4);
  text-align: center;
}

.is-compact {
  padding: var(--m-sp-6) var(--m-sp-3);
}

.mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-lg);
  background: var(--m-surface-elevated);
  color: var(--m-text-muted);
}

.is-compact .mark {
  width: 36px;
  height: 36px;
  border-radius: var(--m-r-md);
}

.title {
  font-size: var(--m-fs-14);
  font-weight: 600;
  color: var(--m-text-primary);
}

.is-compact .title {
  font-size: var(--m-fs-13);
}

.desc {
  max-width: 360px;
  font-size: var(--m-fs-12);
  line-height: var(--m-lh-loose);
  color: var(--m-text-muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  margin-top: var(--m-sp-2);
}
</style>

<script setup lang="ts">
/** MCard — the container used for every panel, list section and dialog body. */
import MIcon from '../icons/MIcon.vue'
import type { IconName } from '../icons/paths'

withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    icon?: IconName
    /** Removes the inner padding so a table or list can bleed to the edges. */
    padded?: boolean
    /** Adds a hover lift; set on clickable cards only. */
    hoverable?: boolean
    /** `flat` sits on the page background, `raised` floats above it. */
    tone?: 'flat' | 'raised'
    /** Header description instead of the default title row. */
    dense?: boolean
    id?: string
  }>(),
  { title: '', subtitle: '', padded: true, hoverable: false, tone: 'flat', dense: false }
)
</script>

<template>
  <section class="m-card" :class="[`t-${tone}`, { 'is-padded': padded, 'is-hoverable': hoverable, 'is-dense': dense }]" :id="id">
    <header v-if="title || subtitle || icon || $slots.actions || $slots.header" class="head">
      <div class="heading">
        <MIcon v-if="icon" :name="icon" :size="20" tone="muted" />
        <span class="titles">
          <h3 v-if="title" class="title u-truncate">{{ title }}</h3>
          <p v-if="subtitle" class="subtitle u-truncate">{{ subtitle }}</p>
        </span>
        <slot name="header" />
      </div>
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </header>

    <div class="body"><slot /></div>

    <footer v-if="$slots.footer" class="foot"><slot name="footer" /></footer>
  </section>
</template>

<style scoped>
.m-card {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-lg);
  background: var(--m-surface-elevated);
  min-width: 0;
}

.t-raised {
  background: var(--m-surface-raised);
  box-shadow: var(--m-shadow-md);
}

.is-padded {
  padding: var(--m-sp-4);
}

.is-dense {
  gap: var(--m-sp-2);
}

.is-hoverable {
  transition:
    border-color var(--m-dur-2) var(--m-ease-standard),
    box-shadow var(--m-dur-2) var(--m-ease-standard),
    transform var(--m-dur-2) var(--m-ease-out);
}

.is-hoverable:hover {
  border-color: var(--m-border-weak);
  box-shadow: var(--m-shadow-md);
  transform: translateY(-1px);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--m-sp-3);
}

.is-padded .head {
  margin-bottom: 0;
}

/* Without card padding the header keeps its own inset. */
.m-card:not(.is-padded) .head,
.m-card:not(.is-padded) .foot {
  padding: var(--m-sp-3) var(--m-sp-4);
}

.m-card:not(.is-padded) .head {
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.m-card:not(.is-padded) .foot {
  border-top: var(--m-line) solid var(--m-border-hairline);
}

.heading {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
}

.titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-size: var(--m-fs-14);
  font-weight: 600;
  color: var(--m-text-primary);
}

.is-dense .title {
  font-size: var(--m-fs-13);
}

.subtitle {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex: none;
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  min-width: 0;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--m-sp-2);
}
</style>

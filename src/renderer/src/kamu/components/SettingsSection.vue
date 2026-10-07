<script setup lang="ts">
/**
 * One settings section card — the PCL-style collapsible card upstream uses
 * (`details.card.group.collapse` + `collapse-head` / `collapse-arrow` / `collapse-body`).
 * Markup and spacing are copied from KAMUCL SettingsView.vue; the colour tokens and the
 * base `.card` skin come from `kamu/styles/kamu.css`.
 *
 * `open` is passed through as a plain attribute by the caller, so a user collapsing a
 * section is never undone by a re-render.
 */
defineProps<{
  /** Card heading, shown in the collapsed title row. */
  title: string
  /** `data-section` anchor used by the category rail and the search jump. */
  section: string
}>()
</script>

<template>
  <details
    class="card group collapse setting-target"
    :data-section="section"
    tabindex="-1"
  >
    <summary class="collapse-head">
      <h3 class="group-title">{{ title }}</h3>
      <span class="collapse-arrow" aria-hidden="true"></span>
    </summary>
    <div class="collapse-body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
/* Effective values from upstream's SettingsView (base rules + the later
   `.settings-body .collapse*` overrides, which are what actually ships). */
.collapse {
  padding: 0;
  gap: 0;
}
.collapse-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 42px;
  padding: 10px 18px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.collapse-head::-webkit-details-marker {
  display: none;
}
.collapse-head:hover .group-title {
  color: var(--accent-2);
}
.collapse-arrow {
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--text-dim);
  border-bottom: 2px solid var(--text-dim);
  /* Collapsed: arrow points up (PCL card affordance). */
  transform: rotate(-45deg);
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.collapse[open] > .collapse-head .collapse-arrow {
  transform: rotate(45deg);
}
.collapse-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--border);
}
.group-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
  line-height: 1.5;
}
</style>

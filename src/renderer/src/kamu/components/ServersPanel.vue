<script setup lang="ts">
/**
 * Ported from KAMUCL `components/connection/ConnectionPanel.vue` (MIT, (c) 2026
 * kamubaba-i) — see /THIRD_PARTY_NOTICES.md. The panel chrome is themed entirely by
 * `kamu/styles/connection.css` (`.connection-panel*`), so every server/LAN/room card
 * on the page shares one head + body rhythm.
 */
defineProps<{ title: string; subtitle?: string; step?: string }>()
</script>

<template>
  <section class="connection-panel">
    <header class="connection-panel-head">
      <span v-if="step" class="connection-step" aria-hidden="true">{{ step }}</span>
      <div>
        <h2>{{ title }}</h2>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.action" class="connection-panel-action"><slot name="action" /></div>
    </header>
    <div class="connection-panel-body"><slot /></div>
  </section>
</template>

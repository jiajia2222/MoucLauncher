<script setup lang="ts">
/**
 * Ported from KAMUCL `components/connection/ConnectionStatus.vue` (MIT, (c) 2026
 * kamubaba-i) — see /THIRD_PARTY_NOTICES.md. `.connection-status` lives in
 * `kamu/styles/connection.css`; only the label wording is ours.
 */
withDefaults(defineProps<{ tone?: 'neutral' | 'success' | 'danger' | 'pending'; label: string }>(), {
  tone: 'neutral'
})
</script>

<template>
  <span class="connection-status" :class="tone"><i aria-hidden="true"></i>{{ label }}</span>
</template>

<script setup lang="ts">
/** MKbd — keyboard key chips. Single keys, or a sequence that is joined with `+`. */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    keys?: string | string[]
    size?: 'sm' | 'md'
  }>(),
  { size: 'sm' }
)

const list = computed(() => (Array.isArray(props.keys) ? props.keys : String(props.keys ?? '').split('+')))
</script>

<template>
  <span class="m-kbd" :class="`s-${size}`">
    <template v-for="(key, index) in list" :key="index">
      <span v-if="index > 0" class="join">+</span>
      <kbd class="cap">{{ key }}</kbd>
    </template>
  </span>
</template>

<style scoped>
.m-kbd {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  color: var(--m-text-muted);
  -webkit-app-region: no-drag;
}

.cap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 0 4px;
  border: var(--m-line) solid var(--m-border-weak);
  border-bottom-width: 2px;
  border-radius: var(--m-r-xs);
  background: var(--m-surface-raised);
  font-family: var(--m-font-mono);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
}

.s-md .cap {
  min-width: 20px;
  font-size: var(--m-fs-12);
}

.join {
  font-size: 11px;
  opacity: 0.7;
}
</style>

<script setup lang="ts">
/**
 * MSkeleton — loading placeholder.
 * A single soft sweep across a neutral block: this is the one place a moving fill is
 * functional (it says "content will land here"), not decorative.
 */
withDefaults(
  defineProps<{
    variant?: "text" | "rect" | "circle" | "line";
    /** Any CSS length; `lines` overrides it for multi-line text. */
    width?: string;
    height?: string;
    lines?: number;
    rounded?: string;
  }>(),
  { variant: "text", width: "", height: "", lines: 0, rounded: "" }
);
</script>

<template>
  <span class="m-skeleton" :class="['v-' + variant, { 'is-single': lines === 0 }]" :aria-hidden="true">
    <template v-if="lines > 0">
      <span
        v-for="line in lines"
        :key="line"
        class="bar"
        :style="{ width: line === lines ? '60%' : width || '100%', '--m-sk-h': height || '12px' }"
      />
    </template>
    <span v-else class="bar only" :style="{ width: width || undefined, height: height || undefined, borderRadius: rounded || undefined }" />
  </span>
</template>

<style scoped>
.m-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  min-width: 0;
}

.is-single {
  display: block;
}

.bar {
  position: relative;
  display: block;
  overflow: hidden;
  height: var(--m-sk-h, 12px);
  width: 100%;
  border-radius: var(--m-r-xs);
  background: var(--m-surface-active);
}

.v-rect .bar,
.v-rect.is-single .bar.only {
  border-radius: var(--m-r-md);
}

.v-circle .bar.only {
  border-radius: var(--m-r-full);
}

.v-text .bar {
  height: 12px;
}

.bar::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 40%;
  background: var(--m-surface-hover);
  transform: translateX(-120%);
  animation: m-sk-sweep 1600ms var(--m-ease-standard) infinite;
}

@keyframes m-sk-sweep {
  70%,
  100% {
    transform: translateX(320%);
  }
}
</style>

<script setup lang="ts">
/**
 * MTooltip — delayed, teleported hint.
 * Opens on hover/focus of the wrapped element, never traps the pointer, and is hidden
 * from AT when the wrapped control already has an equivalent aria-label.
 */
import { computed, onBeforeUnmount, ref, useId } from "vue";
import { useFloating } from "../../composables/useFloating";
import type { Placement } from "../../composables/useFloating";

const props = withDefaults(
  defineProps<{
    content: string;
    placement?: Placement;
    /** Second line, e.g. a path or a shortcut. */
    detail?: string;
    delay?: number;
    disabled?: boolean;
  }>(),
  { placement: "top", detail: "", delay: 300, disabled: false }
);

const anchor = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const shown = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
const tipId = useId();

const { style, update } = useFloating({ anchor, panel, open: shown, placement: props.placement, gap: 6 });

const visible = computed(() => shown.value && !props.disabled && props.content.length > 0);

function open(): void {
  if (props.disabled || !props.content) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    shown.value = true;
    requestAnimationFrame(update);
  }, props.delay);
}

function close(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  shown.value = false;
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (!next || !anchor.value?.contains(next)) close();
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <span ref="anchor" class="m-tooltip" @mouseenter="open" @mouseleave="close" @focusin="open" @focusout="onFocusOut">
    <slot />
    <Teleport to="body">
      <span v-if="visible" :id="tipId" ref="panel" class="panel" :style="style" role="tooltip">
        <span class="text">{{ content }}</span>
        <span v-if="detail" class="detail u-mono">{{ detail }}</span>
      </span>
    </Teleport>
  </span>
</template>

<style scoped>
.m-tooltip {
  display: inline-flex;
  position: relative;
}

.panel {
  z-index: var(--m-z-tooltip);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 260px;
  padding: 5px var(--m-sp-2);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-raised);
  box-shadow: var(--m-shadow-md);
  color: var(--m-text-primary);
  font-size: var(--m-fs-12);
  line-height: var(--m-lh-ui);
  pointer-events: none;
  white-space: normal;
  animation: m-tip-in var(--m-dur-1) var(--m-ease-out);
  -webkit-app-region: no-drag;
}

@keyframes m-tip-in {
  from {
    opacity: 0;
  }
}

.detail {
  color: var(--m-text-muted);
  overflow-wrap: anywhere;
}
</style>

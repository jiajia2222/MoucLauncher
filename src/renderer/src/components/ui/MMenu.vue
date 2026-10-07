<script setup lang="ts">
/**
 * MMenu — click-anchored action menu (row "more" menus, sort pickers).
 * Uses the same teleport/floating plumbing as MSelect, adds `role="menu"`, arrow-key
 * navigation over non-disabled entries, and separators.
 */
import { computed, nextTick, ref, useId } from 'vue'
import MIcon from '../icons/MIcon.vue'
import type { IconName } from '../icons/paths'
import MButton from './MButton.vue'
import { useDismiss, useFloating } from '../../composables/useFloating'
import { t, type I18nKey } from '../../i18n'
import type { MenuItem } from './types'

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    align?: 'start' | 'end'
    /** Fallback trigger when no `trigger` slot is given. */
    triggerLabel?: string
    triggerLabelKey?: I18nKey
    triggerIcon?: IconName
    size?: 'sm' | 'md'
    disabled?: boolean
  }>(),
  { align: 'end', triggerLabel: '', triggerIcon: 'chevron-down', size: 'md', disabled: false }
)

const emit = defineEmits<{ select: [id: string] }>()

const anchor = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const menuId = useId()

const { style: floatStyle, update } = useFloating({
  anchor,
  panel,
  open,
  placement: props.align === 'end' ? 'bottom-end' : 'bottom',
  gap: 4
})
useDismiss(open, [anchor, panel], close)

const entries = computed(() => props.items)

function labelOf(item: MenuItem): string {
  if (item.labelKey) return t(item.labelKey)
  return item.label ?? item.id
}

function toggle(): void {
  if (open.value) close()
  else openMenu()
}

function openMenu(): void {
  if (props.disabled) return
  open.value = true
  activeIndex.value = props.items.findIndex((item) => !item.separator && !item.disabled)
  void nextTick(() => {
    update()
    panel.value?.focus()
  })
}

function close(): void {
  if (!open.value) return
  open.value = false
}

function choose(item: MenuItem | undefined): void {
  if (!item || item.separator || item.disabled) return
  close()
  emit('select', item.id)
}

function move(delta: number): void {
  const count = entries.value.length
  if (count === 0) return
  let index = activeIndex.value
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count
    const candidate = entries.value[index]
    if (candidate && !candidate.separator && !candidate.disabled) break
  }
  activeIndex.value = index
  void nextTick(() => {
    panel.value?.querySelector<HTMLElement>('[data-active="true"]')?.focus({ preventScroll: true })
  })
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'End') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Tab') {
    close()
  }
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (panel.value && next && !panel.value.contains(next) && !anchor.value?.contains(next)) close()
}
</script>

<template>
  <span class="m-menu">
    <!-- A real button in the slot brings its own Enter/Space -> click, so only click
         is handled here; adding key handlers would toggle twice. -->
    <span ref="anchor" class="anchor" @click="toggle">
      <slot name="trigger">
        <MButton :size="size" variant="ghost" :trailing-icon="triggerIcon" :disabled="disabled">
          {{ triggerLabelKey ? t(triggerLabelKey) : triggerLabel }}
        </MButton>
      </slot>
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        :id="menuId"
        ref="panel"
        class="panel"
        :style="floatStyle"
        role="menu"
        tabindex="-1"
        @keydown="onPanelKeydown"
        @focusout="onFocusOut"
      >
        <template v-for="(item, index) in entries" :key="item.id + String(index)">
          <span v-if="item.separator" class="sep" role="separator" />
          <button
            v-else
            class="row"
            :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled, 'is-active': index === activeIndex }"
            type="button"
            role="menuitem"
            :data-active="index === activeIndex"
            :disabled="item.disabled"
            :aria-disabled="item.disabled || undefined"
            @mouseenter="activeIndex = index"
            @click="choose(item)"
          >
            <MIcon v-if="item.checked" name="check" :size="16" class="tick" />
            <MIcon v-else-if="item.icon" :name="item.icon" :size="16" tone="muted" class="row-icon" />
            <span class="row-label u-truncate">{{ labelOf(item) }}</span>
            <span v-if="item.hint" class="row-hint u-num">{{ item.hint }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.m-menu {
  position: relative;
  display: inline-flex;
  -webkit-app-region: no-drag;
}

.anchor {
  display: inline-flex;
}

.panel {
  z-index: var(--m-z-popover);
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 168px;
  max-height: 340px;
  padding: var(--m-sp-1);
  overflow: auto;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-md);
  background: var(--m-surface-raised);
  box-shadow: var(--m-shadow-lg);
  animation: m-menu-in var(--m-dur-2) var(--m-ease-out);
}

.panel:focus {
  outline: none;
}

@keyframes m-menu-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  width: 100%;
  height: 28px;
  padding: 0 var(--m-sp-2);
  border: 0;
  border-radius: var(--m-r-sm);
  background: none;
  color: var(--m-text-primary);
  font-size: var(--m-fs-13);
  text-align: left;
  cursor: pointer;
}

.row:hover:not(:disabled),
.row.is-active:not(:disabled) {
  background: var(--m-surface-hover);
}

.row:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: -2px;
}

.row:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.row.is-danger {
  color: var(--m-danger);
}

.row-label {
  flex: 1 1 auto;
  min-width: 0;
}

.row-hint {
  flex: none;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.row-icon,
.tick {
  flex: none;
}

.tick {
  color: var(--m-accent-text);
}

.sep {
  height: 1px;
  margin: var(--m-sp-1) var(--m-sp-2);
  background: var(--m-border-hairline);
}
</style>

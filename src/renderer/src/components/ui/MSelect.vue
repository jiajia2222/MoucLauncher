<script setup lang="ts">
/**
 * MSelect — own popover listbox.
 *
 * Never a native <select>: Chromium's popup cannot carry hints, icons or a filter row,
 * and styling it differs per platform. The panel is teleported and fixed-positioned so
 * it survives inside scrolling cards, and it is a real listbox for assistive tech.
 */
import { computed, nextTick, ref, useId } from 'vue'
import MIcon from '../icons/MIcon.vue'
import type { IconName } from '../icons/paths'
import { useDismiss, useFloating } from '../../composables/useFloating'
import { t } from '../../i18n'
import type { SelectOption } from './types'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: SelectOption[]
    placeholder?: string
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    readonly?: boolean
    icon?: IconName
    error?: string
    /** Type-to-filter row inside the panel. */
    searchable?: boolean
    emptyText?: string
    /** Stretch to the container width (default; set false for inline selects). */
    block?: boolean
  }>(),
  {
    placeholder: '',
    size: 'md',
    disabled: false,
    readonly: false,
    searchable: false,
    emptyText: '',
    block: true
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [option: SelectOption]
  open: []
  close: []
}>()

const anchor = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const filterInput = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)

const { style: floatStyle, update } = useFloating({
  anchor,
  panel,
  open,
  placement: 'bottom',
  gap: 4,
  matchWidth: true
})
useDismiss(open, [anchor, panel], close)

const selected = computed(() => props.options.find((option) => option.value === props.modelValue) ?? null)
const buttonLabel = computed(() => selected.value?.label ?? props.placeholder ?? t('common.selectPlaceholder'))
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return props.options
  return props.options.filter(
    (option) => option.label.toLowerCase().includes(needle) || (option.hint ?? '').toLowerCase().includes(needle)
  )
})
/** One stable id per mounted instance, so `aria-controls` never collides. */
const panelId = useId()

function openPanel(): void {
  if (props.disabled || props.readonly || open.value) return
  open.value = true
  query.value = ''
  const index = filtered.value.findIndex((option) => option.value === props.modelValue)
  activeIndex.value = index >= 0 ? index : 0
  emit('open')
  void nextTick(() => {
    update()
    if (props.searchable) filterInput.value?.focus()
    else scrollActiveIntoView()
  })
}

function closePanel(returnFocus = true): void {
  if (!open.value) return
  open.value = false
  emit('close')
  if (returnFocus) anchor.value?.focus()
}

function pick(option: SelectOption | undefined): void {
  if (!option || option.disabled) return
  if (option.value !== props.modelValue) {
    emit('update:modelValue', option.value)
    emit('change', option)
  }
  closePanel()
}

function move(delta: number): void {
  const list = filtered.value
  if (list.length === 0) return
  let next = activeIndex.value
  for (let step = 0; step < list.length; step += 1) {
    next = (next + delta + list.length) % list.length
    const candidate = list[next]
    if (candidate && !candidate.disabled) break
  }
  activeIndex.value = next
  scrollActiveIntoView()
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const node = panel.value?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (open.value) move(1)
    else openPanel()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (open.value) move(-1)
  } else if (event.key === 'Enter') {
    if (open.value) {
      event.preventDefault()
      pick(filtered.value[activeIndex.value])
    }
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    closePanel()
  } else if (event.key === 'Home' && open.value) {
    event.preventDefault()
    activeIndex.value = 0
    scrollActiveIntoView()
  } else if (event.key === 'End' && open.value) {
    event.preventDefault()
    activeIndex.value = Math.max(0, filtered.value.length - 1)
    scrollActiveIntoView()
  } else if (!open.value && (event.key === ' ' || event.key === 'Spacebar')) {
    event.preventDefault()
    openPanel()
  }
}

function onQueryInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  activeIndex.value = 0
}
</script>

<template>
  <div class="m-select" :class="[`s-${size}`, { 'is-block': block, 'is-error': !!error }]">
    <button
      ref="anchor"
      class="trigger"
      type="button"
      role="combobox"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="open ? panelId : undefined"
      :aria-invalid="error ? 'true' : undefined"
      @click="open ? closePanel() : openPanel()"
      @keydown="onKeydown"
    >
      <MIcon v-if="icon" :name="icon" :size="16" tone="muted" />
      <span class="value u-truncate" :class="{ 'is-placeholder': !selected }">{{ buttonLabel }}</span>
      <MIcon name="chevron-down" :size="16" class="caret" :class="{ 'is-open': open }" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="panelId"
        ref="panel"
        class="panel"
        :style="floatStyle"
        role="listbox"
        :aria-label="placeholder || undefined"
        @keydown="onKeydown"
      >
        <div v-if="searchable" class="filter">
          <MIcon name="search" :size="16" tone="muted" />
          <input
            ref="filterInput"
            class="filter-input"
            type="text"
            :value="query"
            :placeholder="t('common.searchPlaceholder')"
            @input="onQueryInput"
            @keydown="onKeydown"
          />
        </div>
        <ul v-if="filtered.length" class="list">
          <li
            v-for="(option, index) in filtered"
            :key="option.value"
            class="row"
            :class="{ 'is-selected': option.value === modelValue, 'is-active': index === activeIndex, 'is-disabled': option.disabled }"
            :data-active="index === activeIndex"
            role="option"
            :aria-selected="option.value === modelValue"
            @mouseenter="((activeIndex = index))"
            @click="pick(option)"
          >
            <MIcon v-if="option.icon" :name="option.icon" :size="16" tone="muted" class="row-icon" />
            <span class="row-main">
              <span class="row-label u-truncate">{{ option.label }}</span>
              <span v-if="option.hint" class="row-hint u-truncate">{{ option.hint }}</span>
            </span>
            <MIcon v-if="option.value === modelValue" name="check" :size="16" class="tick" />
          </li>
        </ul>
        <p v-else class="empty">{{ emptyText || t('common.noMatch') }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.m-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
}

.is-block {
  width: 100%;
}

.trigger {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  width: 100%;
  min-width: 0;
  padding: 0 var(--m-sp-2);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-raised);
  color: var(--m-text-primary);
  text-align: left;
  -webkit-app-region: no-drag;
  transition:
    border-color var(--m-dur-1) var(--m-ease-standard),
    box-shadow var(--m-dur-1) var(--m-ease-standard);
}

.s-sm .trigger {
  height: 24px;
  font-size: var(--m-fs-12);
}

.s-md .trigger {
  height: 32px;
  font-size: var(--m-fs-13);
}

.s-lg .trigger {
  height: 40px;
  font-size: var(--m-fs-14);
}

.trigger:hover:not(:disabled) {
  border-color: var(--m-border-strong);
}

.trigger:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: var(--m-focus-offset);
}

.trigger[aria-expanded='true'] {
  border-color: var(--m-accent);
}

.trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error .trigger {
  border-color: var(--m-danger);
}

.value {
  flex: 1 1 auto;
  min-width: 0;
}

.is-placeholder {
  color: var(--m-text-muted);
}

.caret {
  flex: none;
  color: var(--m-text-muted);
  transition: transform var(--m-dur-2) var(--m-ease-out);
}

.is-open {
  transform: rotate(180deg);
}

/* ---- teleported panel ---- */
.panel {
  z-index: var(--m-z-popover);
  max-height: 320px;
  overflow: auto;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-md);
  background: var(--m-surface-raised);
  box-shadow: var(--m-shadow-lg);
  padding: var(--m-sp-1);
  animation: m-select-in var(--m-dur-2) var(--m-ease-out);
  -webkit-app-region: no-drag;
}

@keyframes m-select-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.filter {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  padding: var(--m-sp-1) var(--m-sp-2);
  margin-bottom: var(--m-sp-1);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-elevated);
}

.filter-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--m-text-primary);
  font-size: var(--m-fs-13);
  outline: none;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  padding: var(--m-sp-1) var(--m-sp-2);
  border-radius: var(--m-r-sm);
  cursor: pointer;
  transition: background-color var(--m-dur-1) var(--m-ease-standard);
}

.row.is-active {
  background: var(--m-surface-hover);
}

.row.is-selected {
  background: var(--m-accent-soft);
}

.row.is-selected.is-active {
  background: var(--m-accent-soft-strong);
}

.row.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.row-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.row-label {
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
}

.row-hint {
  font-family: var(--m-font-mono);
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

.empty {
  padding: var(--m-sp-3);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
  text-align: center;
}

.s-sm .row-label {
  font-size: var(--m-fs-12);
}
</style>

<script setup lang="ts">
/**
 * CommunityVersionFilter — ported from KAMUCL `components/CommunityVersionFilter.vue`
 * (MIT, (c) 2026 kamubaba-i) — see /THIRD_PARTY_NOTICES.md.
 *
 * Same floating combobox: the field keeps free typing (a version that is not installed can
 * still be searched), the panel is teleported so no card clips it, and arrows / Home / End /
 * Enter / Escape drive the same keyboard path as upstream.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ modelValue: string; versions: string[]; loading?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; change: [] }>()

const input = ref<HTMLInputElement>()
const menu = ref<HTMLElement>()
const open = ref(false)
const active = ref(0)
const keyboardSelection = ref(false)
const text = ref(props.modelValue)
const position = ref<Record<string, string>>({})

const options = computed(() => [
  '',
  ...props.versions.filter((v) => v.toLowerCase().includes(text.value.trim().toLowerCase())).slice(0, 60)
])

function close(): void {
  open.value = false
  removeEventListener('pointerdown', outside, true)
  removeEventListener('scroll', onScroll, true)
  removeEventListener('resize', close)
}

function show(): void {
  const rect = input.value?.getBoundingClientRect()
  if (!rect) return
  const below = innerHeight - rect.bottom - 12
  const above = rect.top - 12
  const up = below < 180 && above > below
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`,
    width: `${Math.min(rect.width, innerWidth - 16)}px`,
    maxHeight: `${Math.min(280, Math.max(48, up ? above : below))}px`,
    ...(up ? { bottom: `${innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` })
  }
  active.value = Math.max(0, options.value.indexOf(props.modelValue))
  open.value = true
  addEventListener('pointerdown', outside, true)
  addEventListener('scroll', onScroll, true)
  addEventListener('resize', close)
}

function outside(event: PointerEvent): void {
  if (!input.value?.contains(event.target as Node) && !menu.value?.contains(event.target as Node)) close()
}

function onScroll(event: Event): void {
  if (!menu.value?.contains(event.target as Node)) close()
}

function choose(value: string): void {
  text.value = value
  emit('update:modelValue', value)
  emit('change')
  close()
  input.value?.focus({ preventScroll: true })
  close()
}

function typing(): void {
  keyboardSelection.value = false
  show()
}

function keyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    text.value = props.modelValue
    close()
    return
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    keyboardSelection.value = true
    if (!open.value) show()
    else {
      active.value =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.value.length - 1
            : Math.max(0, Math.min(options.value.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)))
    }
    void nextTick(() => menu.value?.querySelector<HTMLElement>('[data-focused="true"]')?.scrollIntoView({ block: 'nearest' }))
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose(open.value && keyboardSelection.value ? (options.value[active.value] ?? text.value.trim()) : text.value.trim())
  } else if (event.key === 'Tab') {
    if (text.value.trim() !== props.modelValue) {
      emit('update:modelValue', text.value.trim())
      emit('change')
    }
    close()
  }
}

// An instance filter or a reset can change the value while the field is mounted.
watch(
  () => props.modelValue,
  (value) => {
    text.value = value
  }
)

onBeforeUnmount(close)
</script>

<template>
  <div class="community-version-filter">
    <input
      ref="input"
      v-model="text"
      class="input"
      aria-label="Minecraft 版本"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="open"
      aria-controls="community-version-options"
      :aria-activedescendant="open && keyboardSelection ? 'community-version-option-' + active : undefined"
      :placeholder="loading ? '加载版本列表…' : '全部版本'"
      @focus="keyboardSelection = false; show()"
      @click="keyboardSelection = false; show()"
      @input="typing"
      @keydown="keyboard"
      @blur="close"
    />
    <Teleport to="body">
      <div
        v-if="open"
        id="community-version-options"
        ref="menu"
        class="community-version-popup"
        :style="position"
        role="listbox"
        @wheel.stop
      >
        <button
          v-for="(version, i) in options"
          :id="'community-version-option-' + i"
          :key="version || 'all'"
          type="button"
          role="option"
          :aria-selected="modelValue === version"
          :data-focused="active === i"
          :class="{ selected: modelValue === version }"
          @pointerdown.prevent
          @click="choose(version)"
        >
          {{ version || '全部版本' }}
        </button>
        <p v-if="options.length === 1 && text.trim()" class="muted">没有匹配项；按 Enter 使用输入版本</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.community-version-filter { flex: 1.4; min-width: 170px }
.community-version-filter .input { width: 100% }
</style>

<style>
/* The panel is teleported to `body`, so its styles cannot be scoped. */
.community-version-popup {
  position: fixed;
  z-index: 11000;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-solid, var(--card));
  box-shadow: var(--shadow);
}
.community-version-popup button {
  display: block;
  width: 100%;
  min-height: var(--row-h);
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: var(--text-sm);
}
.community-version-popup button:hover,
.community-version-popup button[data-focused='true'] { background: var(--hover) }
.community-version-popup button.selected { background: var(--accent-soft); color: var(--text); font-weight: 600 }
.community-version-popup p { padding: 8px; font-size: var(--text-xs) }
</style>

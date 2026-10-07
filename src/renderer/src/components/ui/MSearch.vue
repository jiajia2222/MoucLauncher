<script setup lang="ts">
/**
 * MSearch — search field with a built-in debounce, busy state and optional hotkey.
 * `search` fires after `debounce` ms of quiet, or immediately on Enter.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import MIcon from '../icons/MIcon.vue'
import MKbd from './MKbd.vue'
import { t } from '../../i18n'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    size?: 'sm' | 'md' | 'lg'
    debounce?: number
    loading?: boolean
    /** e.g. `Ctrl+F`; registered globally while the component is mounted. */
    hotkey?: string
    autofocus?: boolean
  }>(),
  { modelValue: '', placeholder: '', size: 'md', debounce: 240, loading: false }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  search: [value: string]
  clear: []
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const focused = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const canClear = computed(() => props.modelValue.length > 0)
const hotkeyKeys = computed(() => (props.hotkey ? props.hotkey.split('+').map((part) => part.trim().toLowerCase()) : []))

function onInput(value: string): void {
  emit('update:modelValue', value)
  if (timer) clearTimeout(timer)
  if (props.debounce <= 0) {
    emit('search', value)
    return
  }
  timer = setTimeout(() => emit('search', value), props.debounce)
}

function submitNow(): void {
  if (timer) clearTimeout(timer)
  emit('search', props.modelValue)
}

function clear(): void {
  emit('update:modelValue', '')
  emit('clear')
  emit('search', '')
  inputEl.value?.focus()
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (hotkeyKeys.value.length === 0) return
  const wantsCtrl = hotkeyKeys.value.includes('ctrl')
  const wantsShift = hotkeyKeys.value.includes('shift')
  const key = hotkeyKeys.value[hotkeyKeys.value.length - 1]
  if (!key) return
  const ctrlLike = wantsCtrl ? event.ctrlKey || event.metaKey : true
  if (!ctrlLike || event.altKey) return
  if (wantsShift !== event.shiftKey) return
  if (event.key.toLowerCase() !== key) return
  event.preventDefault()
  inputEl.value?.focus()
  inputEl.value?.select()
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  if (timer) clearTimeout(timer)
})

defineExpose({
  focus(): void {
    inputEl.value?.focus()
  }
})
</script>

<template>
  <div class="m-search" :class="[`s-${size}`, { 'is-focused': focused }]">
    <MIcon name="search" :size="16" tone="muted" />
    <input
      ref="inputEl"
      class="field"
      type="search"
      :value="modelValue"
      :placeholder="placeholder || t('common.searchPlaceholder')"
      :autofocus="autofocus"
      :aria-label="t('common.searchPlaceholder')"
      @input="onInput(($event.target as HTMLInputElement).value)"
      @keydown.enter="submitNow"
      @keydown.esc="clear"
      @blur="focused = false"
      @focus="focused = true"
    />
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <MKbd v-else-if="hotkey && !focused && !modelValue" :keys="hotkey.split('+')" class="hint" />
    <button v-if="canClear" class="clear" type="button" :aria-label="t('common.clear')" @click="clear">
      <MIcon name="x" :size="16" />
    </button>
  </div>
</template>

<style scoped>
.m-search {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  width: 100%;
  padding: 0 var(--m-sp-2);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-raised);
  -webkit-app-region: no-drag;
  transition:
    border-color var(--m-dur-1) var(--m-ease-standard),
    box-shadow var(--m-dur-1) var(--m-ease-standard);
}

.s-sm {
  height: 24px;
  font-size: var(--m-fs-12);
}

.s-md {
  height: 32px;
}

.s-lg {
  height: 40px;
}

.m-search:hover {
  border-color: var(--m-border-strong);
}

.is-focused {
  border-color: var(--m-accent);
  box-shadow: 0 0 0 1px var(--m-accent-soft-strong);
}

.field {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  color: var(--m-text-primary);
  outline: none;
}

/* `type=search` gives a UA clear button in Chromium; ours replaces it. */
.field::-webkit-search-cancel-button {
  appearance: none;
}

.field::placeholder {
  color: var(--m-text-muted);
}

.hint {
  flex: none;
}

.clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--m-r-xs);
  color: var(--m-text-muted);
}

.clear:hover {
  color: var(--m-text-primary);
  background: var(--m-surface-hover);
}

.clear:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: 1px;
}

.spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border: 1.5px solid var(--m-text-muted);
  border-bottom-color: transparent;
  border-radius: var(--m-r-full);
  animation: m-search-spin var(--m-dur-spin) linear infinite;
}

@keyframes m-search-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<script setup lang="ts">
/**
 * MInput — single-line text field.
 * Password reveals with eye/eye-off; `error` turns the border danger and is announced
 * through `aria-describedby` when the caller passes an `errorId`.
 */
import { computed, ref } from 'vue'
import MIcon from '../icons/MIcon.vue'
import type { IconName } from '../icons/paths'
import { t } from '../../i18n'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    type?: 'text' | 'password' | 'number' | 'search'
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    readonly?: boolean
    error?: string
    icon?: IconName
    clearable?: boolean
    autofocus?: boolean
    id?: string
    maxlength?: number
    step?: number
    min?: number
    max?: number
    mono?: boolean
  }>(),
  {
    modelValue: '',
    placeholder: '',
    type: 'text',
    size: 'md',
    disabled: false,
    readonly: false,
    clearable: false,
    autofocus: false,
    mono: false
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  enter: []
  clear: []
  blur: []
  focus: []
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const revealed = ref(false)
const focused = ref(false)

const effectiveType = computed(() => (props.type === 'password' && revealed.value ? 'text' : props.type))
const canClear = computed(() => props.clearable && !props.disabled && !props.readonly && props.modelValue.length > 0)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') emit('enter')
}

function clear(): void {
  emit('update:modelValue', '')
  emit('clear')
  inputEl.value?.focus()
}

defineExpose({
  focus(): void {
    inputEl.value?.focus()
  },
  select(): void {
    inputEl.value?.select()
  },
  inputEl
})
</script>

<template>
  <div
    class="m-input"
    :class="[`s-${size}`, { 'is-focused': focused, 'is-error': !!error, 'is-disabled': disabled, 'is-readonly': readonly }]"
  >
    <MIcon v-if="icon" :name="icon" :size="16" class="lead" tone="muted" />
    <input
      :id="id"
      ref="inputEl"
      class="field u-truncate"
      :class="{ mono }"
      :type="effectiveType"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :maxlength="maxlength"
      :step="step"
      :min="min"
      :max="max"
      :autofocus="autofocus"
      :aria-invalid="error ? 'true' : undefined"
      @input="onInput"
      @keydown="onKeydown"
      @blur="((focused = false), emit('blur'))"
      @focus="((focused = true), emit('focus'))"
    />
    <span v-if="$slots.trailing" class="trailing"><slot name="trailing" /></span>
    <button
      v-if="type === 'password'"
      class="reveal no-drag"
      type="button"
      :aria-label="revealed ? t('common.hidePassword') : t('common.showPassword')"
      @click="revealed = !revealed"
    >
      <MIcon :name="revealed ? 'eye-off' : 'eye'" :size="16" />
    </button>
    <button v-if="canClear" class="reveal no-drag" type="button" :aria-label="t('common.clear')" @click="clear">
      <MIcon name="x" :size="16" />
    </button>
  </div>
</template>

<style scoped>
.m-input {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  width: 100%;
  padding: 0 var(--m-sp-2);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-raised);
  color: var(--m-text-primary);
  -webkit-app-region: no-drag;
  transition:
    border-color var(--m-dur-1) var(--m-ease-standard),
    background-color var(--m-dur-1) var(--m-ease-standard),
    box-shadow var(--m-dur-1) var(--m-ease-standard);
}

.s-sm {
  height: 24px;
  font-size: var(--m-fs-12);
}

.s-md {
  height: 32px;
  font-size: var(--m-fs-13);
}

.s-lg {
  height: 40px;
  font-size: var(--m-fs-14);
}

.m-input:hover:not(.is-disabled):not(.is-readonly) {
  border-color: var(--m-border-strong);
}

.is-focused:not(.is-error) {
  border-color: var(--m-accent);
  box-shadow: 0 0 0 1px var(--m-accent-soft-strong);
}

.is-error {
  border-color: var(--m-danger);
}

.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.is-readonly {
  background: var(--m-surface-elevated);
  color: var(--m-text-secondary);
}

.field {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  color: inherit;
  outline: none;
}

.field::placeholder {
  color: var(--m-text-muted);
}

/* The wrapper owns focus, so the native ring would double up. */
.field:focus-visible {
  outline: none;
}

.mono {
  font-family: var(--m-font-mono);
  letter-spacing: 0;
}

.lead {
  flex: none;
}

.trailing {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-1);
  flex: none;
}

.reveal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--m-r-xs);
  color: var(--m-text-muted);
}

.reveal:hover {
  color: var(--m-text-primary);
  background: var(--m-surface-hover);
}

.reveal:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: 1px;
}
</style>

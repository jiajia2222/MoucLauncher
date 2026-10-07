<script setup lang="ts">
/** MTextarea — multi-line text, used for JVM args, crash text and log paste. */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    rows?: number
    disabled?: boolean
    readonly?: boolean
    error?: string
    mono?: boolean
    maxlength?: number
    id?: string
    resize?: 'none' | 'vertical' | 'both'
  }>(),
  {
    modelValue: '',
    placeholder: '',
    rows: 4,
    disabled: false,
    readonly: false,
    mono: true,
    resize: 'vertical'
  }
)

const emit = defineEmits<{ 'update:modelValue': [value: string]; blur: [] }>()

const areaEl = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)
const overflow = computed(() => props.maxlength !== undefined && props.modelValue.length >= props.maxlength)

defineExpose({
  focus(): void {
    areaEl.value?.focus()
  }
})
</script>

<template>
  <div class="m-textarea" :class="{ 'is-focused': focused, 'is-error': !!error, 'is-disabled': disabled }">
    <textarea
      :id="id"
      ref="areaEl"
      class="field"
      :class="{ mono }"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :maxlength="maxlength"
      :aria-invalid="error ? 'true' : undefined"
      :aria-label="placeholder || undefined"
      :style="{ resize }"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @blur="((focused = false), emit('blur'))"
      @focus="focused = true"
    />
    <div v-if="maxlength" class="counter u-num" :class="{ 'is-over': overflow }">
      {{ modelValue.length }}/{{ maxlength }}
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="$slots.hint" class="hint"><slot name="hint" /></p>
  </div>
</template>

<style scoped>
.m-textarea {
  position: relative;
  display: block;
  width: 100%;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-raised);
  -webkit-app-region: no-drag;
  transition:
    border-color var(--m-dur-1) var(--m-ease-standard),
    box-shadow var(--m-dur-1) var(--m-ease-standard);
}

.m-textarea:hover:not(.is-disabled) {
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
}

.field {
  display: block;
  width: 100%;
  padding: var(--m-sp-2) var(--m-sp-3);
  border: 0;
  background: none;
  color: var(--m-text-primary);
  font-size: var(--m-fs-13);
  line-height: var(--m-lh-loose);
  outline: none;
}

.field::placeholder {
  color: var(--m-text-muted);
}

.mono {
  font-family: var(--m-font-mono);
  letter-spacing: 0;
}

.counter {
  position: absolute;
  right: var(--m-sp-2);
  bottom: var(--m-sp-2);
  padding: 0 var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
  background: var(--m-surface-raised);
}

.is-over {
  color: var(--m-warning);
}

.error,
.hint {
  padding: var(--m-sp-1) var(--m-sp-3) var(--m-sp-2);
  font-size: var(--m-fs-12);
}

.error {
  color: var(--m-danger);
}

.hint {
  color: var(--m-text-muted);
}
</style>

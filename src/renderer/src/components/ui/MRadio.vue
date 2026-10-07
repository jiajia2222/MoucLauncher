<script setup lang="ts">
/** MRadio — a single choice inside a group; the group owns the shared `modelValue`. */
withDefaults(
  defineProps<{
    /** Value of this option. */
    value: string
    /** Current group value. */
    modelValue: string
    label?: string
    hint?: string
    disabled?: boolean
    name?: string
    id?: string
  }>(),
  { label: '', hint: '', disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <label class="m-radio" :class="{ 'is-checked': modelValue === value, 'is-disabled': disabled }">
    <span class="control">
      <input
        :id="id"
        class="native"
        type="radio"
        :name="name"
        :value="value"
        :checked="modelValue === value"
        :disabled="disabled"
        @change="emit('update:modelValue', value)"
      />
      <span class="ring" aria-hidden="true"><span class="dot" /></span>
    </span>
    <span class="stack">
      <span class="text"><slot>{{ label }}</slot></span>
      <span v-if="hint" class="hint">{{ hint }}</span>
    </span>
  </label>
</template>

<style scoped>
.m-radio {
  display: inline-flex;
  align-items: flex-start;
  gap: var(--m-sp-2);
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
  cursor: pointer;
  user-select: none;
  -webkit-app-region: no-drag;
}

.control {
  position: relative;
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 2px;
}

.native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.ring {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: var(--m-line) solid var(--m-border-strong);
  border-radius: var(--m-r-full);
  background: var(--m-surface-raised);
  transition:
    border-color var(--m-dur-1) var(--m-ease-standard),
    background-color var(--m-dur-1) var(--m-ease-standard);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--m-r-full);
  background: var(--m-accent-ink);
  transform: scale(0);
  transition: transform var(--m-dur-2) var(--m-ease-out);
}

.is-checked .ring {
  background: var(--m-accent);
  border-color: var(--m-accent);
}

.is-checked .dot {
  transform: scale(1);
}

.m-radio:hover .native:not(:disabled) ~ .ring {
  border-color: var(--m-accent-line);
}

.native:focus-visible ~ .ring {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: var(--m-focus-offset);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.hint {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>

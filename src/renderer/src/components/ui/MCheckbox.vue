<script setup lang="ts">
/** MCheckbox — 16px box with a drawn tick; supports the indeterminate state. */
withDefaults(
  defineProps<{
    modelValue: boolean
    indeterminate?: boolean
    disabled?: boolean
    label?: string
    id?: string
  }>(),
  { indeterminate: false, disabled: false, label: '' }
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <label class="m-checkbox" :class="{ 'is-checked': modelValue, 'is-disabled': disabled }" :for="id">
    <span class="control">
      <input
        :id="id"
        class="native"
        type="checkbox"
        :checked="modelValue"
        :disabled="disabled"
        :indeterminate.prop="indeterminate"
        :aria-checked="indeterminate ? 'mixed' : modelValue"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span class="box" aria-hidden="true">
        <svg v-if="!indeterminate" class="tick" viewBox="0 0 20 20" width="16" height="16">
          <path d="M4 10.6 7.8 14.4 16 5.6" />
        </svg>
        <span v-else class="dash" />
      </span>
    </span>
    <span class="text"><slot>{{ label }}</slot></span>
  </label>
</template>

<style scoped>
.m-checkbox {
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
  margin-top: 1px;
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

.box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: var(--m-line) solid var(--m-border-strong);
  border-radius: var(--m-r-xs);
  background: var(--m-surface-raised);
  color: var(--m-accent-ink);
  transition:
    background-color var(--m-dur-1) var(--m-ease-standard),
    border-color var(--m-dur-1) var(--m-ease-standard);
}

.m-checkbox:hover .native:not(:disabled) ~ .box {
  border-color: var(--m-accent-line);
}

.is-checked .box,
.box:has(.native:indeterminate) {
  background: var(--m-accent);
  border-color: var(--m-accent);
}

.native:focus-visible ~ .box {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: var(--m-focus-offset);
}

.tick {
  width: 14px;
  height: 14px;
}

.tick path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dash {
  width: 8px;
  height: 2px;
  border-radius: var(--m-r-full);
  background: currentColor;
}

.text {
  min-width: 0;
  line-height: var(--m-lh-ui);
}

.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>

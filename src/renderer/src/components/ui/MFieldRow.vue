<script setup lang="ts">
/**
 * MFieldRow — label + control + hint, the unit every settings/detail form is built from.
 * `inline` puts the label to the left (settings sheet); otherwise the label sits on top.
 */
withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    /** Error text wins over the hint and colours the label. */
    error?: string;
    /** `for` attribute of the label, so the control can be clicked through. */
    labelFor?: string;
    inline?: boolean;
    required?: boolean;
    /** Right-aligned control column width in inline mode. */
    controlWidth?: string;
  }>(),
  { hint: "", error: "", labelFor: "", inline: true, required: false, controlWidth: "" }
);
</script>

<template>
  <div class="m-field-row" :class="[inline ? 'is-inline' : 'is-stacked', { 'has-error': !!error }]" :style="controlWidth ? { '--m-field-control': controlWidth } : undefined">
    <div class="label-col">
      <label class="label" :for="labelFor || undefined">
        {{ label }}
        <span v-if="required" class="star" aria-hidden="true">*</span>
      </label>
      <p v-if="hint && !error" class="hint">{{ hint }}</p>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
    <div class="control">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.m-field-row {
  display: grid;
  gap: var(--m-sp-1);
  min-width: 0;
}

.is-inline {
  grid-template-columns: minmax(0, var(--m-field-label)) minmax(0, var(--m-field-control, 1fr));
  align-items: center;
  gap: var(--m-sp-4);
}

.is-stacked {
  grid-template-columns: minmax(0, 1fr);
}

.label-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.is-inline .label-col {
  padding-top: 0;
}

.label {
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
  cursor: default;
}

.is-inline .label {
  text-align: right;
}

.has-error .label {
  color: var(--m-danger);
}

.star {
  color: var(--m-danger);
}

.hint,
.error {
  font-size: var(--m-fs-12);
  line-height: var(--m-lh-ui);
  overflow-wrap: anywhere;
}

.is-inline .hint,
.is-inline .error {
  text-align: right;
}

.hint {
  color: var(--m-text-muted);
}

.error {
  color: var(--m-danger);
}

.control {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
}

.is-stacked .control {
  align-items: stretch;
}
</style>

<script setup lang="ts">
/**
 * MToast — the toast host. Mount once (App.vue); push from anywhere with `useToast()`.
 * Renders newest-at-the-bottom of a bounded stack, one icon per kind, its own dismiss
 * button, and it never overlaps the status bar.
 */
import MIcon from '../icons/MIcon.vue'
import { useToast, type ToastItem } from '../../composables/useToast'
import { t } from '../../i18n'
import type { IconName } from '../icons/paths'

const { toasts, dismiss } = useToast()

const ICONS: Record<ToastItem['kind'], IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'x'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="toasts.length" class="m-toast" role="region" :aria-label="t('common.more')">
      <TransitionGroup name="toast">
        <div v-for="item in toasts" :key="item.id" class="card" :class="'k-' + item.kind" role="status">
          <span class="mark"><MIcon :name="ICONS[item.kind]" :size="16" /></span>
          <span class="stack">
            <span class="title">{{ item.title }}</span>
            <span v-if="item.message" class="message">{{ item.message }}</span>
          </span>
          <button class="close" type="button" :aria-label="t('common.dismiss')" @click="dismiss(item.id)">
            <MIcon name="x" :size="16" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.m-toast {
  position: fixed;
  right: var(--m-sp-4);
  bottom: calc(var(--m-status-h) + var(--m-sp-4));
  z-index: var(--m-z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  width: 320px;
  -webkit-app-region: no-drag;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: var(--m-sp-2);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-md);
  background: var(--m-surface-raised);
  box-shadow: var(--m-shadow-lg);
}

.mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--m-r-xs);
}

.k-info .mark {
  color: var(--m-accent-text);
  background: var(--m-accent-soft);
}

.k-success .mark {
  color: var(--m-success);
  background: var(--m-success-soft);
}

.k-warning .mark {
  color: var(--m-warning);
  background: var(--m-warning-soft);
}

.k-danger .mark {
  color: var(--m-danger);
  background: var(--m-danger-soft);
}

.k-danger {
  border-color: var(--m-danger);
}

.stack {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-size: var(--m-fs-13);
  font-weight: 600;
  color: var(--m-text-primary);
}

.message {
  font-size: var(--m-fs-12);
  line-height: var(--m-lh-ui);
  color: var(--m-text-secondary);
  overflow-wrap: anywhere;
}

.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--m-r-xs);
  color: var(--m-text-muted);
}

.close:hover {
  color: var(--m-text-primary);
  background: var(--m-surface-hover);
}

.close:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: 0;
}

.toast-enter-active {
  transition:
    opacity var(--m-dur-2) var(--m-ease-standard),
    transform var(--m-dur-3) var(--m-ease-out);
}

.toast-leave-active {
  transition:
    opacity var(--m-dur-1) var(--m-ease-standard),
    transform var(--m-dur-2) var(--m-ease-in);
  position: absolute;
  right: 0;
  left: 0;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>

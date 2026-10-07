<script setup lang="ts">
/**
 * MModal — teleported, focus-trapped dialog.
 *
 * Behaviour: scrim + Esc + close button all route through one `close` emit so the caller
 * decides; focus moves into the panel on open and is restored to the invoker on close;
 * Tab and Shift+Tab cannot escape the panel. The scrim is a flat token colour, never a
 * blur or gradient.
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import MIcon from '../icons/MIcon.vue'
import MButton from './MButton.vue'
import { t } from '../../i18n'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    description?: string
    /** Max body width; the panel never exceeds the viewport. */
    width?: number
    tone?: 'neutral' | 'danger'
    closeOnEsc?: boolean
    closeOnScrim?: boolean
    showClose?: boolean
    /** Hides the cancel button (informational dialogs). */
    alert?: boolean
    confirmText?: string
    cancelText?: string
  }>(),
  {
    title: '',
    description: '',
    width: 480,
    tone: 'neutral',
    closeOnEsc: true,
    closeOnScrim: true,
    showClose: true,
    alert: false,
    confirmText: '',
    cancelText: ''
  }
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  close: []
  confirm: []
}>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const descId = useId()
let restoreTo: HTMLElement | null = null

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const hasFooter = computed(() => props.confirmText.length > 0 || props.cancelText.length > 0)

function close(): void {
  emit('update:open', false)
  emit('close')
}

function focusFirst(): void {
  const nodes = panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE)
  const first = nodes && nodes.length > 0 ? nodes[0] : panel.value
  first?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (!props.closeOnEsc) return
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab' || !panel.value) return
  const nodes = Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.offsetParent !== null)
  if (nodes.length === 0) {
    event.preventDefault()
    return
  }
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === panel.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreTo = (document.activeElement as HTMLElement | null) ?? null
      await nextTick()
      focusFirst()
    } else if (restoreTo) {
      restoreTo.focus()
      restoreTo = null
    }
  }
)

onBeforeUnmount(() => {
  restoreTo = null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="m-modal">
      <div
        v-if="open"
        class="scrim"
        :style="{ '--m-modal-width': width + 'px' }"
        @mousedown.self="closeOnScrim && close()"
      >
        <div
          ref="panel"
          class="panel"
          :class="'tone-' + tone"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          :aria-describedby="description ? descId : undefined"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <header class="head">
            <h2 v-if="title" :id="titleId" class="title">{{ title }}</h2>
            <slot name="title" />
            <button v-if="showClose" class="close" type="button" :aria-label="t('common.close')" @click="close">
              <MIcon name="x" :size="16" />
            </button>
          </header>

          <p v-if="description" :id="descId" class="desc">{{ description }}</p>

          <div class="body">
            <slot />
          </div>

          <footer v-if="$slots.footer || hasFooter" class="foot">
            <slot name="footer">
              <MButton v-if="!alert" variant="ghost" @click="close">{{ cancelText || t('common.cancel') }}</MButton>
              <MButton :variant="tone === 'danger' ? 'danger' : 'primary'" @click="emit('confirm')">
                {{ confirmText || t('common.confirm') }}
              </MButton>
            </slot>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: var(--m-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--m-sp-5);
  background: var(--m-scrim);
  -webkit-app-region: no-drag;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  width: 100%;
  max-width: var(--m-modal-width);
  max-height: calc(100vh - var(--m-sp-8));
  padding: var(--m-sp-4);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-lg);
  background: var(--m-surface-elevated);
  box-shadow: var(--m-shadow-overlay);
  overflow: auto;
}

.panel:focus {
  outline: none;
}

.tone-danger .head {
  color: var(--m-danger);
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--m-sp-2);
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--m-fs-16);
  font-weight: 600;
  color: var(--m-text-primary);
}

.tone-danger .title {
  color: var(--m-danger);
}

.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  margin: -2px -2px 0 0;
  border-radius: var(--m-r-sm);
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

.desc {
  font-size: var(--m-fs-13);
  line-height: var(--m-lh-loose);
  color: var(--m-text-secondary);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  min-width: 0;
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
}

.foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--m-sp-2);
  padding-top: var(--m-sp-1);
}

/* ---- transitions ---- */
.m-modal-enter-active,
.m-modal-leave-active {
  transition: opacity var(--m-dur-2) var(--m-ease-standard);
}

.m-modal-enter-active .panel,
.m-modal-leave-active .panel {
  transition:
    transform var(--m-dur-3) var(--m-ease-out),
    opacity var(--m-dur-2) var(--m-ease-standard);
}

.m-modal-enter-from,
.m-modal-leave-to {
  opacity: 0;
}

.m-modal-enter-from .panel,
.m-modal-leave-to .panel {
  opacity: 0;
  transform: translateY(8px) scale(0.99);
}
</style>

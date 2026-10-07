/**
 * Toast service — one module-level queue shared by the whole renderer, rendered by
 * the <MToast> host mounted once in App.vue.
 *
 * Stacking newest-last, per-kind colour, auto-dismiss; `duration: 0` keeps a toast
 * until it is dismissed manually. The stack is bounded so a burst of download events
 * cannot bury the window.
 */
import { ref, type Ref } from 'vue'
import { t, type I18nKey, type I18nVars } from '../i18n'

export type ToastKind = 'info' | 'success' | 'warning' | 'danger'

export interface ToastItem {
  id: number
  kind: ToastKind
  title: string
  message?: string
  duration: number
}

export interface ToastPushOptions {
  kind?: ToastKind
  /** Resolved through i18n before display; `vars` fills `{name}` placeholders. */
  titleKey?: I18nKey
  title?: string
  messageKey?: I18nKey
  message?: string
  vars?: I18nVars
  duration?: number
}

const MAX_VISIBLE = 4
const DEFAULT_DURATION = 4000
const ERROR_DURATION = 6000

const toasts: Ref<ToastItem[]> = ref([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let seq = 0

function dismiss(id: number): void {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  toasts.value = toasts.value.filter((item) => item.id !== id)
}

function clearAll(): void {
  for (const item of [...toasts.value]) dismiss(item.id)
}

export function push(options: ToastPushOptions): ToastItem {
  const kind = options.kind ?? 'info'
  const item: ToastItem = {
    id: (seq += 1),
    kind,
    title: options.titleKey ? t(options.titleKey, options.vars) : (options.title ?? ''),
    duration: options.duration ?? (kind === 'danger' ? ERROR_DURATION : DEFAULT_DURATION)
  }
  const message = options.messageKey ? t(options.messageKey, options.vars) : options.message
  if (message) item.message = message

  toasts.value = [...toasts.value, item]
  while (toasts.value.length > MAX_VISIBLE) {
    const oldest = toasts.value[0]
    if (!oldest) break
    dismiss(oldest.id)
  }

  if (item.duration > 0) {
    timers.set(
      item.id,
      setTimeout(() => dismiss(item.id), item.duration)
    )
  }
  return item
}

export interface UseToast {
  toasts: Ref<ToastItem[]>
  push: (options: ToastPushOptions) => ToastItem
  dismiss: (id: number) => void
  clearAll: () => void
  info: (titleKey: I18nKey, vars?: I18nVars) => ToastItem
  success: (titleKey: I18nKey, vars?: I18nVars) => ToastItem
  warning: (titleKey: I18nKey, vars?: I18nVars) => ToastItem
  danger: (titleKey: I18nKey, vars?: I18nVars) => ToastItem
}

export function useToast(): UseToast {
  return {
    toasts,
    push,
    dismiss,
    clearAll,
    info: (titleKey, vars) => push({ kind: 'info', titleKey, vars }),
    success: (titleKey, vars) => push({ kind: 'success', titleKey, vars }),
    warning: (titleKey, vars) => push({ kind: 'warning', titleKey, vars }),
    danger: (titleKey, vars) => push({ kind: 'danger', titleKey, vars })
  }
}

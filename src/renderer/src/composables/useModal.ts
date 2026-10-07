/**
 * Imperative modal controller.
 *
 * <MModal> is the declarative primitive (views own their dialogs). `useModal()` is the
 * escape hatch for "delete this?" confirmations that would otherwise need local state:
 * it drives one host <MModal> mounted in App.vue and resolves a promise.
 */
import { ref, type Ref } from 'vue'
import { t, type I18nKey, type I18nVars } from '../i18n'

export interface ModalRequest {
  titleKey?: I18nKey
  title?: string
  textKey?: I18nKey
  text?: string
  confirmKey?: I18nKey
  cancelKey?: I18nKey
  /** `danger` paints the primary action with the danger token. */
  tone?: 'neutral' | 'danger'
  vars?: I18nVars
}

const visible = ref(false)
const request: Ref<ModalRequest | null> = ref(null)
let resolver: ((confirmed: boolean) => void) | null = null

export function confirm(options: ModalRequest): Promise<boolean> {
  close(false)
  request.value = options
  visible.value = true
  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

export function close(result: boolean): void {
  if (resolver) {
    const pending = resolver
    resolver = null
    pending(result)
  }
  visible.value = false
  request.value = null
}

/** Resolves the pending promise with `true` (primary action). */
export function accept(): void {
  close(true)
}

export function modalTitle(options: ModalRequest | null): string {
  if (!options) return ''
  return options.titleKey ? t(options.titleKey, options.vars) : (options.title ?? '')
}

export function modalText(options: ModalRequest | null): string {
  if (!options) return ''
  return options.textKey ? t(options.textKey, options.vars) : (options.text ?? '')
}

export interface UseModal {
  visible: Ref<boolean>
  request: Ref<ModalRequest | null>
  confirm: (options: ModalRequest) => Promise<boolean>
  accept: () => void
  close: (result: boolean) => void
}

export function useModal(): UseModal {
  return { visible, request, confirm, accept, close }
}

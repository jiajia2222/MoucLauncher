/**
 * Anchored-popover plumbing shared by MSelect, MMenu and MTooltip.
 *
 * Panels are teleported to <body> and positioned with `position: fixed`, which is what
 * keeps them out of the shell's overflow containers (a select inside a scrolling card
 * must not clip). Vertical flips, horizontal viewport clamping, width matching and
 * reposition on scroll/resize are handled here so no component reimplements geometry.
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'bottom-end' | 'top-end'

export interface FloatingPosition {
  position: 'fixed'
  top: string
  left: string
  minWidth?: string
}

const VIEWPORT_PAD = 8

/** Places `panel` next to `anchor`, flipping vertically when it would overflow. */
export function computePosition(
  anchor: DOMRect,
  panel: { width: number; height: number },
  placement: Placement,
  gap: number
): { top: number; left: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = 0
  let left = 0

  switch (placement) {
    case 'left':
      top = anchor.top + anchor.height / 2 - panel.height / 2
      left = anchor.left - panel.width - gap
      break
    case 'right':
      top = anchor.top + anchor.height / 2 - panel.height / 2
      left = anchor.right + gap
      break
    case 'top':
    case 'top-end':
      top = anchor.top - panel.height - gap
      left = placement === 'top-end' ? anchor.right - panel.width : anchor.left + anchor.width / 2 - panel.width / 2
      break
    default:
      top = anchor.bottom + gap
      left = placement === 'bottom-end' ? anchor.right - panel.width : anchor.left + anchor.width / 2 - panel.width / 2
  }

  // Flip vertically only for the vertical placements.
  const vertical = placement === 'bottom' || placement === 'bottom-end' || placement === 'top' || placement === 'top-end'
  if (vertical) {
    const fitsBelow = anchor.bottom + gap + panel.height <= vh - VIEWPORT_PAD
    const fitsAbove = anchor.top - gap - panel.height >= VIEWPORT_PAD
    if (placement.startsWith('bottom') && !fitsBelow && fitsAbove) {
      top = anchor.top - panel.height - gap
    } else if (placement.startsWith('top') && !fitsAbove && fitsBelow) {
      top = anchor.bottom + gap
    }
  }

  left = clamp(left, VIEWPORT_PAD, vw - panel.width - VIEWPORT_PAD)
  top = clamp(top, VIEWPORT_PAD, vh - panel.height - VIEWPORT_PAD)
  return { top, left }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export interface UseFloatingOptions {
  anchor: Ref<HTMLElement | null | undefined>
  panel: Ref<HTMLElement | null | undefined>
  open: Ref<boolean>
  placement?: Placement
  gap?: number
  /** Popovers that belong to a field stretch to the trigger width. */
  matchWidth?: boolean
}

export function useFloating(options: UseFloatingOptions): {
  style: Ref<Record<string, string>>
  update: () => void
} {
  const placement = options.placement ?? 'bottom'
  const gap = options.gap ?? 6
  const style = ref<Record<string, string>>({})

  function update(): void {
    const anchor = options.anchor.value
    const panel = options.panel.value
    if (!anchor || !panel) return
    const anchorRect = anchor.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const pos = computePosition(anchorRect, { width: panelRect.width, height: panelRect.height }, placement, gap)
    const next: Record<string, string> = {
      position: 'fixed',
      top: `${Math.round(pos.top)}px`,
      left: `${Math.round(pos.left)}px`
    }
    if (options.matchWidth) next.minWidth = `${Math.round(anchorRect.width)}px`
    style.value = next
  }

  function onScrollOrResize(): void {
    if (options.open.value) update()
  }

  watch(
    () => options.open.value,
    (open) => {
      if (!open) return
      // One frame with the panel invisible keeps the measurement honest.
      requestAnimationFrame(update)
      window.addEventListener('scroll', onScrollOrResize, true)
      window.addEventListener('resize', onScrollOrResize)
    },
    { flush: 'post' }
  )

  onBeforeUnmount(() => {
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
  })

  return { style, update }
}

/** Closes a popover on outside pointer-down or Escape; returns nothing to render. */
export function useDismiss(
  open: Ref<boolean>,
  refs: Array<Ref<HTMLElement | null | undefined>>,
  onClose: () => void = () => {
    open.value = false
  }
): void {
  function onPointerDown(event: PointerEvent): void {
    if (!open.value) return
    const target = event.target as Node | null
    if (!target) return
    const inside = refs.some((entry) => entry.value?.contains(target))
    if (!inside) onClose()
  }
  function onKeydown(event: KeyboardEvent): void {
    if (open.value && event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }
  watch(open, (value) => {
    if (value) {
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeydown, true)
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeydown, true)
    }
  })
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeydown, true)
  })
}

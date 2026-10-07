/**
 * Shared open/closed state for the shell's floating panels.
 *
 * Upstream keeps `dlOpen` / `noticeOpen` / `notesOpen` as refs inside `App.vue` because the
 * sidebar health chip and the top-bar buttons both toggle the same panels. This module is
 * that piece of upstream state, extracted so both chrome components reach it without
 * prop-drilling through the shell.
 */
import { ref } from 'vue'

export const dlOpen = ref(false)
export const noticeOpen = ref(false)
export const notesOpen = ref(false)

/** 顶栏空白处点击关闭已展开的下拉面板（顶栏是 `-webkit-app-region: drag`，点击不会落到遮罩上） */
export function closePanels(): void {
  dlOpen.value = false
  noticeOpen.value = false
  notesOpen.value = false
}

export function anyPanelOpen(): boolean {
  return dlOpen.value || noticeOpen.value || notesOpen.value
}

/**
 * Ported from upstream `onGlobalPointerDown`: a click outside the panel and its trigger
 * closes it. Returns the removal function so the shell can clean up on unmount.
 */
export function installPanelClickAway(): () => void {
  const handler = (event: PointerEvent): void => {
    if (!anyPanelOpen()) return
    const target = event.target as HTMLElement | null
    if (target?.closest?.('.notice-panel, .dl-toggle, .palette-menu, .float-menu, .sidebar-health')) return
    closePanels()
  }
  window.addEventListener('pointerdown', handler, true)
  return () => window.removeEventListener('pointerdown', handler, true)
}

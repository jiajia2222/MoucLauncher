import { BrowserWindow } from 'electron'
import { EVENTS, type EventName } from '@shared/ipc'

/** Push events to every live window. Renderer subscribes through `mouc.on`. */
export function emit(event: EventName, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(event, payload)
  }
}

export function emitProgress(payload: import('@shared/types').DownloadProgress): void {
  emit(EVENTS.progress, payload)
}

export function emitLog(payload: import('@shared/types').GameLogLine): void {
  emit(EVENTS.log, payload)
}

export function emitExit(payload: import('@shared/types').GameExitInfo): void {
  emit(EVENTS.gameExit, payload)
}

export function emitLan(payload: import('@shared/types').LanGame): void {
  emit(EVENTS.lan, payload)
}

export function emitRelay(payload: import('@shared/types').RelayStatus): void {
  emit(EVENTS.relay, payload)
}

export function emitMicrosoft(payload: import('@shared/types').MicrosoftLoginProgress): void {
  emit(EVENTS.microsoft, payload)
}

export function emitSettings(payload: import('@shared/types').Settings): void {
  emit(EVENTS.settings, payload)
}

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENTS, IPC, type EventName, type MoucApi } from '@shared/ipc'

/**
 * Every MoucApi method maps to `ipcRenderer.invoke(IPC[namespace][method], ...)`.
 * Building it from the table means a new handler only needs the table + main side.
 */
function invokeNamespace<K extends keyof typeof IPC>(namespace: K): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const method of Object.keys(IPC[namespace]) as string[]) {
    const channel = (IPC[namespace] as Record<string, string>)[method]
    out[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  }
  return out
}

const api: MoucApi = {
  app: invokeNamespace('app') as unknown as MoucApi['app'],
  settings: invokeNamespace('settings') as unknown as MoucApi['settings'],
  version: invokeNamespace('version') as unknown as MoucApi['version'],
  instance: invokeNamespace('instance') as unknown as MoucApi['instance'],
  java: invokeNamespace('java') as unknown as MoucApi['java'],
  account: invokeNamespace('account') as unknown as MoucApi['account'],
  download: invokeNamespace('download') as unknown as MoucApi['download'],
  game: invokeNamespace('game') as unknown as MoucApi['game'],
  mod: invokeNamespace('mod') as unknown as MoucApi['mod'],
  server: invokeNamespace('server') as unknown as MoucApi['server'],
  loader: invokeNamespace('loader') as unknown as MoucApi['loader'],
  win: {
    minimize: () => ipcRenderer.send(IPC.win.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.win.toggleMaximize),
    close: () => ipcRenderer.send(IPC.win.close),
    state: () => ipcRenderer.invoke(IPC.win.state),
    setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke(IPC.win.setAlwaysOnTop, value)
  },
  on: (event: EventName, handler: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  }
}

// Sanity check: a typo in the table must not silently produce `undefined` handlers.
for (const [namespace, methods] of Object.entries(api)) {
  if (namespace === 'on' || namespace === 'win') continue
  const record = methods as Record<string, unknown>
  for (const [name, fn] of Object.entries(record)) {
    if (typeof fn !== 'function') {
      throw new Error(`preload: mouc.${namespace}.${name} is not a function`)
    }
  }
}

contextBridge.exposeInMainWorld('mouc', api)

export const EVENT_NAMES = EVENTS

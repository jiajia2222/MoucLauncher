import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/ipc'

/**
 * The preload builds `window.mouc` from the IPC table, so a table entry with no
 * `ipcMain.handle` would surface as a runtime "no handler" error instead of a compile
 * error. This test closes that gap by checking every channel is registered.
 */
const HANDLER_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/main/ipc.ts'), 'utf8')

describe('IPC table completeness', () => {
  const namespaces = Object.entries(IPC) as [string, Record<string, string>][]

  it('has at least the expected namespaces', () => {
    expect(namespaces.map(([name]) => name).sort()).toEqual(
      ['account', 'app', 'download', 'game', 'instance', 'java', 'loader', 'mod', 'server', 'settings', 'version', 'win'].sort()
    )
  })

  it('uses unique channel strings', () => {
    const channels = namespaces.flatMap(([, methods]) => Object.values(methods))
    expect(new Set(channels).size).toBe(channels.length)
  })

  for (const [namespace, methods] of namespaces) {
    for (const method of Object.keys(methods)) {
      it(`mouc.${namespace}.${method} is registered in the main process`, () => {
        expect(HANDLER_SOURCE, `${namespace}.${method}`).toContain(`IPC.${namespace}.${method}`)
      })
    }
  }
})

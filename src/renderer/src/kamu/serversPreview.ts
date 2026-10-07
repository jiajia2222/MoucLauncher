/// <reference types="vite/client" />
/**
 * TEMPORARY verification harness for the ported KAMUCL servers view (deleted after the
 * screenshot pass). Mounts `kamu/views/Servers.vue` the way the ported shell will wrap
 * it — `.shell > .content > .route-view` — against the browser mock API and the vendored
 * stylesheets. `?norelay` blanks the configured relay endpoint so the setup card is
 * exercised; `?demo` pre-triggers a LAN scan and an open room so those panels show data.
 */
import { createApp, defineComponent, h } from 'vue'
import type { MoucApi } from '@shared/ipc'
import './styles/kamu.css'
import './styles/ui-system.css'
import './styles/connection.css'
import { createMockApi } from '../mock/api'
import Servers from './views/Servers.vue'

const query = new URLSearchParams(location.search)

function installBridge(): MoucApi {
  const bridge = createMockApi({ empty: false })
  if (query.has('norelay')) {
    const get = bridge.settings.get
    bridge.settings.get = async () => {
      const result = await get()
      return result.ok ? { ok: true as const, data: { ...result.data, relayServerUrl: '' } } : result
    }
  }
  return bridge
}

if (!window.mouc) {
  window.mouc = installBridge()
  window.__MOUC_WEB__ = true
}

if (query.has('demo')) {
  void window.mouc.server.lanScan()
  window.setTimeout(() => void window.mouc.server.relayHost({ targetPort: 25_565, room: 'MOUC-DEMO' }), 300)
}

const Shell = defineComponent({
  setup() {
    return () =>
      h('div', { class: 'shell', style: 'display:flex;height:100vh;background:var(--bg)' }, [
        h('main', { class: 'content', style: 'flex:1;min-width:0;display:flex;flex-direction:column' }, [
          h('div', { class: 'route-view', style: 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:24px' }, [h(Servers)])
        ])
      ])
  }
})

createApp(Shell).mount('#app')

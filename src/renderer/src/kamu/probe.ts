/// <reference types="vite/client" />
/**
 * TEMPORARY verification harness (deleted after screenshots).
 * Renders one ported KAMUCL view on its own against the browser mock API, using the
 * vendored kamu.css + ui-system.css, exactly the way the ported shell will wrap it.
 */
import { createApp, defineComponent, h, ref } from 'vue'
import './styles/kamu.css'
import './styles/ui-system.css'
import { createMockApi } from '../mock/api'
import Instances from './views/Instances.vue'
import Versions from './views/Versions.vue'

if (!window.mouc) {
  window.mouc = createMockApi({ empty: new URLSearchParams(location.search).has('empty') })
  window.__MOUC_WEB__ = true
}

const hash = /^#view=(\w[\w-]*)/i.exec(window.location.hash)?.[1] ?? 'instances'
const view = hash === 'versions' ? Versions : Instances

const Shell = defineComponent({
  setup() {
    const booted = ref(true)
    return () =>
      h('div', { class: 'shell', style: 'display:flex;height:100vh;background:var(--bg)' }, [
        h('main', { class: 'content', style: 'flex:1;min-width:0;display:flex;flex-direction:column' }, [
          h('div', { class: 'route-view', style: 'flex:1;min-height:0;display:flex' }, booted.value ? [h(view)] : [])
        ])
      ])
  }
})

createApp(Shell).mount('#app')

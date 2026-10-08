/* TEMPORARY verification harness for the ported Home view — deleted after screenshot QA. */
import { createApp } from 'vue'
import Home from './src/kamu/views/Home.vue'
import './src/kamu/styles/kamu.css'
import './src/kamu/styles/ui-system.css'
import { createMockApi } from './src/mock/api'

const params = new URLSearchParams(window.location.search)
window.mouc = createMockApi({ empty: params.has('empty') })
window.__MOUCX_WEB__ = true
document.documentElement.dataset.theme = params.get('theme') ?? 'dark'
createApp(Home).mount('#app')

// TEMP probe: report the computed colours of the progress strip.
setTimeout(() => {
  const strip = document.querySelector('.status-strip')
  if (!strip) {
    document.title = 'NO STRIP'
    return
  }
  const style = getComputedStyle(strip)
  document.title = `bg=${style.backgroundColor} color=${style.color} accentSoft=${getComputedStyle(document.documentElement).getPropertyValue('--accent-soft')} theme=${document.documentElement.dataset.theme}`
}, 1500)


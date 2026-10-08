/* TEMPORARY verification harness for the ported Accounts + Java views — deleted after screenshot QA. */
import { createApp } from 'vue'
import Accounts from './src/kamu/views/Accounts.vue'
import Java from './src/kamu/views/Java.vue'
import MToast from './src/components/ui/MToast.vue'
import './src/styles/tokens.css'
import './src/kamu/styles/kamu.css'
import './src/kamu/styles/ui-system.css'
import { createMockApi } from './src/mock/api'

const params = new URLSearchParams(window.location.search)
window.mouc = createMockApi({ empty: params.has('empty') })
window.__MOUCX_WEB__ = true

document.documentElement.dataset.theme = params.get('theme') ?? 'dark'
document.documentElement.dataset.platform = 'win32'

const viewId = /^#view=([\w-]+)/.exec(window.location.hash)?.[1] ?? 'accounts'
const view = viewId === 'java' ? Java : Accounts

const root = document.getElementById('app')
if (root) {
  root.classList.add('content')
  const toastHost = document.createElement('div')
  toastHost.id = 'toast-host'
  document.body.appendChild(toastHost)
}

createApp(view).mount('#app')
createApp(MToast).mount('#toast-host')

// Headless screenshot runs cannot click: `&autoclick=ms|pin|ygg` drives the flow.
const autoclick = params.get('autoclick')
if (autoclick) {
  const pattern =
    autoclick === 'ms'
      ? /开始微软登录|Start Microsoft/i
      : autoclick === 'pin'
        ? /选择 Java|Choose Java/i
        : /外置 Yggdrasil 登录|Third-party/i
  window.setTimeout(() => {
    const button = [...document.querySelectorAll('button')].find((entry) =>
      pattern.test(entry.textContent ?? '')
    )
    button?.click()
  }, 400)
}

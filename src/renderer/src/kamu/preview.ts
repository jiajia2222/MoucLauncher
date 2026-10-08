/**
 * TEMPORARY verification entry for the ported kamu views.
 *
 * The shell agent owns `App.vue` / `main.ts` and has not repointed the view registry at
 * `kamu/views/*` yet, so this harness mounts one ported view inside the upstream shell
 * chrome (sidebar + content) with the vendored stylesheets, purely for the screenshot
 * pass. Delete it once App.vue renders `kamu/views` itself.
 */
import { createApp, h, defineComponent } from 'vue'
import '../styles/tokens.css'
import './styles/kamu.css'
import './styles/ui-system.css'
import { createMockApi } from '../mock/api'
import Settings from './views/Settings.vue'

if (!window.mouc) {
  window.mouc = createMockApi({ empty: false })
  window.__MOUCX_WEB__ = true
}

const Harness = defineComponent({
  name: 'KamuPreviewHarness',
  setup() {
    return () =>
      h('div', { class: 'shell', style: 'display:flex;height:100%;background:linear-gradient(160deg,#0d1719 0%,#10191b 45%,#16261f 100%)' }, [
        h('aside', { class: 'sidebar', style: 'width:208px;flex:none' }),
        h('main', { class: 'content', style: 'flex:1;min-width:0;padding:16px;display:flex' }, [h(Settings)])
      ])
  }
})

createApp(Harness).mount('#app')

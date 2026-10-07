<script setup lang="ts">
/**
 * MoucLauncher shell.
 *
 * The visual layer is the ported KAMUCL shell (see /THIRD_PARTY_NOTICES.md): `Topbar`
 * carries the drag region, download centre, notices and window chrome; `Sidebar` carries
 * the brand block, grouped nav, health chip and the six-palette theme switcher. This file
 * only resolves which `kamu/views/*.vue` is on stage and keeps the shell alive.
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import MToast from './components/ui/MToast.vue'
import { navigate, useNav, type ViewId } from './composables/useNav'
import { VIEW_FILES } from './kamu/shell/nav'
import { installPanelClickAway, noticeOpen } from './kamu/shell/panels'
import { startShell, stopShell } from './kamu/shell/state'
import { initShellTheme } from './kamu/shell/theme'
import Sidebar from './kamu/shell/Sidebar.vue'
import Topbar from './kamu/shell/Topbar.vue'

const nav = useNav()

/** Views are code-split; the glob key is produced by `nav.ts` so ids never drift. */
const viewModules = import.meta.glob<{ default: Component }>('./kamu/views/*.vue')
const cache = new Map<string, Component>()

function resolve(id: ViewId): Component | null {
  const key = `./kamu/views/${VIEW_FILES[id]}`
  const hit = cache.get(key)
  if (hit) return hit
  const loader = viewModules[key]
  if (!loader) return null
  const component = defineAsyncComponent({
    loader: () => loader().catch((error: unknown) => {
      console.error(`视图 ${key} 加载失败`, error)
      throw error
    }),
    onError: (_error, retry, fail) => (retryCount < 2 ? (retryCount += 1, retry()) : fail())
  })
  cache.set(key, component)
  return component
}

let retryCount = 0
const currentView = computed(() => resolve(nav.activeId.value))

/** Back button history: the rail can be walked, so the top bar needs somewhere to go. */
const history = ref<ViewId[]>([])
const canGoBack = computed(() => history.value.length > 1)

watch(
  () => nav.activeId.value,
  (id) => {
    retryCount = 0
    const last = history.value[history.value.length - 1]
    if (last !== id) history.value = [...history.value.slice(-19), id]
  },
  { immediate: true }
)

function goBack(): void {
  if (history.value.length < 2) return
  history.value = history.value.slice(0, -1)
  const previous = history.value[history.value.length - 1]
  if (previous) navigate(previous)
}

function onSelect(id: string): void {
  navigate(id as ViewId)
}

const stage = ref<HTMLElement | null>(null)
let teardownClickAway: (() => void) | undefined

onMounted(() => {
  teardownClickAway = installPanelClickAway()
  void initShellTheme()
  void startShell()
  stage.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  teardownClickAway?.()
  void stopShell()
})

function onStageKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && noticeOpen.value) noticeOpen.value = false
}
</script>

<template>
  <div class="app-shell" @keydown="onStageKeydown">
    <Topbar :view="nav.activeId.value" :can-go-back="canGoBack" @back="goBack" />
    <div class="app-body">
      <Sidebar :active="nav.activeId.value" @select="onSelect" @notices="noticeOpen = true" />
      <main ref="stage" class="app-stage" tabindex="-1">
        <component :is="currentView" v-if="currentView" :key="nav.activeId.value" />
        <p v-else class="app-missing">{{ nav.activeId.value }}</p>
      </main>
    </div>
    <MToast />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.app-stage {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: var(--sec-gap, 20px) var(--card-gap, 18px);
  outline: none;
}

.app-missing {
  color: var(--text-dim);
  font-size: var(--text-md, 13px);
}
</style>

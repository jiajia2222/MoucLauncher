<script setup lang="ts">
/**
 * Top bar: the drag region, the panel toggles and the window chrome buttons.
 *
 * Upstream `App.vue` puts the draggable `.topbar`, `.top-back`, `.topbar-spacer`,
 * `.top-actions`, `.top-btn` / `.top-icon-btn` / `.top-divider` / `.win-btn` markup and CSS
 * in the shell itself, so they are kept here with the same class names and the same
 * `-webkit-app-region` split (bar drags, controls do not).
 *
 * Wired to MoucX: `mouc.win.minimize()/toggleMaximize()/close()` plus the
 * `mouc:window-state` push, and the game-running close hint ported from upstream's `win()`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../../i18n'
import { copy } from './copy'
import { ICONS } from './icons'
import { closePanels, dlOpen, installPanelClickAway, noticeOpen, notesOpen } from './panels'
import { activeTaskCount, closeWindow, markNoticesRead, minimizeWindow, noticesUnread, shell, toggleMaximize, windowState } from './state'
import { checkUpdate, errorText, importModpack, pickPackFile } from './bridge'
import { useToast } from '../../composables/useToast'
import type { UpdateInfo } from '@shared/types'
import DownloadCenter from './DownloadCenter.vue'
import NoticesPanel from './NoticesPanel.vue'

const props = defineProps<{ view: string; canGoBack: boolean }>()
const emit = defineEmits<{ back: [] }>()

const toast = useToast()
const tasks = activeTaskCount
const unread = noticesUnread
const status = shell.status
const win = windowState
const platform = computed(() => status.value?.platform ?? 'win32')

const dl = dlOpen
const notes = notesOpen

const update = ref<UpdateInfo | null>(null)
const updateError = ref('')

function toggleDownloads(): void {
  notes.value = false
  noticeOpen.value = false
  dl.value = !dl.value
}

function toggleNotices(): void {
  notes.value = false
  dl.value = false
  noticeOpen.value = !noticeOpen.value
  if (noticeOpen.value) markNoticesRead()
}

async function toggleNotes(): Promise<void> {
  dl.value = false
  noticeOpen.value = false
  notes.value = !notes.value
  if (!notes.value) return
  updateError.value = ''
  const info = await checkUpdate()
  if (info) update.value = info
  else updateError.value = copy.text('noUpdate', { error: copy.text('unknownError') })
}

/** 导入 button: pick a pack, the download centre row takes it from there. */
async function onImportClick(): Promise<void> {
  try {
    const file = await pickPackFile(copy.text('pickPack'))
    if (!file) return
    const name = file.split(/[\\/]/).pop() ?? 'modpack'
    // The importer sniffs the archive; no format guess here.
    const result = await importModpack({ file, name: name.replace(/\.(mrpack|zip)$/i, '') })
    dl.value = true
    toast.push({ kind: 'success', title: `${result.job.title}` })
  } catch (error) {
    toast.push({ kind: 'danger', title: errorText(error) })
  }
}

/** Upstream: the bar is a drag region, so a click on it never reaches a panel mask. */
function onTopbarPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement
  if (!target.closest('button, input, select, textarea, a, [role="button"]')) closePanels()
}

let offClickAway: (() => void) | null = null
onMounted(() => {
  offClickAway = installPanelClickAway()
})
onBeforeUnmount(() => {
  offClickAway?.()
})
</script>

<template>
  <header class="topbar" @pointerdown="onTopbarPointerDown">
    <button v-if="props.canGoBack && props.view !== 'home'" class="top-back" :title="copy.text('backPrevious')" @click="emit('back')">
      <span v-html="ICONS.back"></span>
    </button>

    <div class="topbar-spacer">
      <span class="top-motto">{{ copy.text('motto') }}</span>
    </div>

    <div class="top-actions">
      <button v-if="props.view !== 'home'" class="top-btn dl-toggle" @click="toggleDownloads">
        <span class="top-btn-icon" v-html="ICONS.download"></span>
        {{ copy.text('downloadCenter') }}
        <span v-if="tasks" class="dl-badge">{{ tasks }}</span>
      </button>
      <button v-if="props.view !== 'home'" class="top-btn" @click="onImportClick">
        <span class="top-btn-icon" v-html="ICONS.upload"></span>
        {{ t('common.import') }}
      </button>
      <button
        v-if="props.view === 'home' && tasks"
        class="top-icon-btn dl-toggle"
        :title="copy.text('downloadCenter')"
        @click="toggleDownloads"
      >
        <span v-html="ICONS.download"></span>
        <span class="dl-badge compact">{{ tasks }}</span>
      </button>
      <button v-if="props.view === 'home'" class="top-icon-btn" :title="copy.text('updateLog')" @click="toggleNotes">
        <span v-html="ICONS.notes"></span>
      </button>
      <button class="top-icon-btn" :title="copy.text('notices')" @click="toggleNotices">
        <span v-html="ICONS.bell"></span>
        <span v-if="unread" class="bell-dot"></span>
      </button>

      <template v-if="platform !== 'darwin'">
        <span class="top-divider"></span>
        <button class="win-btn" :title="t('win.minimize')" @click="minimizeWindow">
          <span v-html="ICONS.minimize"></span>
        </button>
        <button class="win-btn" :title="win.maximized ? t('win.restore') : t('win.maximize')" @click="toggleMaximize">
          <span v-html="ICONS.maximize"></span>
        </button>
        <button class="win-btn win-close" :title="t('win.close')" @click="closeWindow">
          <span v-html="ICONS.close"></span>
        </button>
      </template>
    </div>

    <DownloadCenter v-if="dl" />
    <NoticesPanel v-if="noticeOpen" />

    <!-- 更新日志 panel: MoucApi exposes `app.checkUpdate()` instead of bundled notes -->
    <Teleport to="body">
      <div v-if="notes" class="notice-mask" @click="notes = false"></div>
      <div v-if="notes" class="notice-panel notes-panel">
        <div class="notice-head">
          <span class="notice-title">{{ copy.text('updateLog') }}</span>
          <span class="muted">{{ update?.latest ?? status?.version ?? '' }}</span>
        </div>
        <div v-if="updateError" class="notice-empty">{{ updateError }}</div>
        <div v-else class="notes-list">
          <section class="note-version">
            <h4 class="note-head">
              <span class="note-ver">{{ status?.version ?? '--' }}</span>
              <span class="muted">{{ update?.available ? copy.text('hasUpdate', { version: update.latest }) : copy.text('noUpdateLine') }}</span>
            </h4>
            <ul class="note-changes">
              <li>{{ t('status.online') }}：{{ status?.online ? t('common.yes') : t('common.no') }}</li>
              <li>Electron {{ status?.electron ?? '--' }} · Node {{ status?.node ?? '--' }}</li>
              <li>{{ status?.platform ?? 'win32' }} · {{ status?.arch ?? 'x64' }}</li>
              <li>{{ t('settings.gameRoot') }}：{{ status?.gameRoot ?? '' }}</li>
            </ul>
          </section>
        </div>
      </div>
    </Teleport>
  </header>
</template>

<style scoped>
/* ---------- copied from the ported shell's top-bar block ---------- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  height: 72px;
  flex-shrink: 0;
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-2) 78%, transparent);
  -webkit-app-region: drag;
}

.top-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--ctl-h);
  height: var(--ctl-h);
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  color: var(--text-dim);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.top-back:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}
.top-back :deep(svg) {
  width: 16px;
  height: 16px;
}

.topbar-spacer {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
}
.top-motto {
  font-size: var(--text-sm);
  color: var(--text-dim);
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  -webkit-app-region: no-drag;
}
.top-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: var(--ctl-h);
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.top-btn:hover {
  background: var(--card-2);
  color: var(--accent-2);
}
.top-btn-icon :deep(svg),
.top-btn :deep(svg) {
  width: 15px;
  height: 15px;
  display: block;
}

.top-icon-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--ctl-h);
  height: var(--ctl-h);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.top-icon-btn:hover {
  background: var(--card-2);
  color: var(--text);
}
.top-icon-btn :deep(svg) {
  width: 17px;
  height: 17px;
  display: block;
}
.bell-dot {
  position: absolute;
  top: 7px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  border: 1.5px solid var(--bg-2);
}
.dl-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--text-xs);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dl-badge.compact {
  position: absolute;
  top: 2px;
  right: 0;
  min-width: 14px;
  height: 14px;
  font-size: var(--text-xs);
}

.top-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 8px;
  flex-shrink: 0;
}

.win-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: var(--ctl-h);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.win-btn :deep(svg) {
  width: 15px;
  height: 15px;
  display: block;
}
.win-btn:hover {
  background: var(--card-2);
  color: var(--text);
}
.win-close:hover {
  background: var(--danger);
  color: #fff;
}

/* ---------- changelog panel (upstream `.notice-panel` shape) ---------- */
.notice-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
}
.notice-panel {
  position: fixed;
  top: 82px;
  right: 92px;
  width: 320px;
  max-height: 420px;
  z-index: 9001;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--card-solid, var(--card)) 94%, transparent);
  backdrop-filter: blur(24px) saturate(130%);
  -webkit-backdrop-filter: blur(24px) saturate(130%);
  -webkit-app-region: no-drag;
  isolation: isolate;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  max-width: calc(100vw - 32px);
}
.notice-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.notice-title {
  font-size: var(--text-md);
  font-weight: 700;
}
.notice-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 96px;
  padding: var(--space-4);
  text-align: center;
  color: var(--text-dim);
  font-size: var(--text-sm);
}
.notes-panel {
  width: 380px;
  max-height: 480px;
}
.notes-list {
  overflow-y: auto;
  padding: 2px var(--space-4) var(--space-4);
}
.note-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin: 0 0 var(--space-2);
}
.note-ver {
  font-weight: 700;
  font-size: var(--text-sm);
}
.note-changes {
  margin: 0;
  padding-left: var(--space-4);
  line-height: 1.7;
  font-size: var(--text-xs);
  color: var(--text);
}

@media (max-width: 1050px) {
  .topbar-spacer {
    overflow: hidden;
  }
  .top-motto {
    visibility: hidden;
  }
  .top-actions {
    flex-shrink: 0;
  }
  .top-actions .top-btn {
    white-space: nowrap;
    flex-shrink: 0;
    padding-inline: 6px;
    gap: 4px;
  }
}
</style>

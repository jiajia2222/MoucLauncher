<script setup lang="ts">
/**
 * Sidebar: brand block, grouped nav, footer.
 *
 * Layout, class names and the sidebar CSS come from the ported shell (`kamu.css` has no
 * sidebar rules — the shell keeps them locally).
 *
 * Local differences on purpose:
 *  - the brand is MoucLauncher's own wordmark with an inline pixel-block face instead of
 *    upstream's mascot avatar + PNG asset (our art is self-drawn, see THIRD_PARTY_NOTICES);
 *  - grouped nav comes from `composables/useNav.ts` sections instead of upstream's
 *    hardcoded view list;
 *  - the footer keeps the `.sidebar-health` chip and adds the theme switcher that
 *    lists all six palettes shipped by the ported theme layer.
 */
import { computed, onMounted, ref } from 'vue'
import { LANGUAGES, setLocale, t, useI18n } from '../../i18n'
import { copy } from './copy'
import { SHELL_NAV } from './nav'
import { launcherHealth, markNoticesRead, noticesUnread, versionText } from './state'
import { useNavigationBubble } from './useNavigationBubble'
import { commitPalette, palette, PALETTES, type PaletteName } from './theme'
import { saveSettings } from '../api/settings'
import { errorText } from './bridge'
import { useToast } from '../../composables/useToast'
import { ICONS } from './icons'
import ThemeMenu from './ThemeMenu.vue'

const props = defineProps<{ active: string }>()
const emit = defineEmits<{ select: [id: string]; notices: [] }>()

const themeOpen = ref(false)
const { locale } = useI18n()
const toast = useToast()

const selected = computed(() => props.active)
const { navEl, bubbleStyle, selectionStyle, retarget, reset, focusOut, measure } = useNavigationBubble(
  selected,
  computed(() => [themeOpen.value, locale.value])
)

const health = launcherHealth
const unread = noticesUnread
const version = versionText

// The selection bubble has no position until the nav has been measured once.
onMounted(() => {
  if (navEl.value) measure()
})

const swatchIcon = ICONS.palette
const globeIcon = ICONS.globe

function pick(id: string): void {
  emit('select', id)
}

function openNotices(): void {
  markNoticesRead()
  emit('notices')
}

async function choosePalette(name: PaletteName): Promise<void> {
  themeOpen.value = false
  await commitPalette(name)
}

async function cycleLanguage(): Promise<void> {
  const index = LANGUAGES.findIndex((entry) => entry.value === locale.value)
  const next = LANGUAGES[(index + 1) % LANGUAGES.length]
  if (!next) return
  setLocale(next.value)
  try {
    await saveSettings({ language: next.value })
  } catch (error) {
    toast.push({ kind: 'danger', title: errorText(error) })
  }
}
</script>

<template>
  <aside class="sidebar">
    <!-- Logo 区 -->
    <div class="logo-area">
      <div class="brand-slot">
        <span class="brand-avatar" aria-hidden="true">
          <!-- Self-drawn pixel block (upstream uses its own mascot PNG here). -->
          <svg class="brand-head" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">
            <rect width="8" height="8" fill="var(--accent-deep)" />
            <rect y="0" width="8" height="3" fill="var(--accent)" />
            <rect x="1" y="4" width="2" height="2" fill="var(--on-accent)" opacity="0.9" />
            <rect x="5" y="4" width="2" height="2" fill="var(--on-accent)" opacity="0.9" />
            <rect x="3" y="6" width="2" height="1" fill="var(--on-accent)" opacity="0.7" />
          </svg>
        </span>
      </div>
      <div class="logo-text">
        <span class="logo-name">{{ copy.text('brandName') }}</span>
        <span class="logo-version">v{{ version || '0.1.0' }}</span>
      </div>
    </div>

    <!-- 导航 -->
    <nav
      ref="navEl"
      class="nav"
      :aria-label="t('app.name')"
      @pointerover="retarget"
      @pointerleave="reset"
      @focusin="retarget"
      @focusout="focusOut"
      @scroll.passive="measure"
    >
      <div class="nav-bubble" :style="bubbleStyle" aria-hidden="true"></div>
      <div class="nav-selection" :style="selectionStyle" aria-hidden="true"></div>

      <section v-for="section in SHELL_NAV" :key="section.id" class="nav-group">
        <h2 class="nav-group-label">{{ t(section.labelKey) }}</h2>
        <button
          v-for="item in section.items"
          :key="item.id"
          class="nav-item"
          :data-nav="item.id"
          :class="{ active: active === item.id }"
          :aria-current="active === item.id ? 'page' : undefined"
          :title="item.hotkey ? `${t(item.labelKey)} · Alt+${item.hotkey}` : t(item.labelKey)"
          @click="pick(item.id)"
        >
          <span class="nav-icon" v-html="item.icon"></span>
          <span class="nav-label">{{ t(item.labelKey) }}</span>
        </button>
      </section>
    </nav>

    <!-- 侧栏底部：健康状态 + 主题/语言 -->
    <div class="sidebar-foot">
      <button class="sidebar-health" :class="`is-${health.tone}`" :title="copy.text('openNotices')" @click="openNotices">
        <i></i>
        <span>{{ health.text }}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
        <span v-if="unread" class="health-badge">{{ unread }}</span>
      </button>

      <div class="foot-actions">
        <button class="foot-btn" :class="{ active: themeOpen }" :title="copy.text('switchTheme')" :aria-expanded="themeOpen" @click="themeOpen = !themeOpen">
          <span class="foot-icon" v-html="swatchIcon"></span>
          <span class="foot-label">{{ t('status.theme') }}</span>
        </button>
        <button class="foot-btn" :title="copy.text('switchLanguage')" @click="cycleLanguage">
          <span class="foot-icon" v-html="globeIcon"></span>
          <span class="foot-label">{{ t('status.language') }}</span>
        </button>
      </div>
    </div>

    <ThemeMenu
      v-if="themeOpen"
      :current="palette"
      :palettes="PALETTES"
      @close="themeOpen = false"
      @pick="choosePalette"
    />
  </aside>
</template>

<style scoped>
/* ---------- copied from upstream App.vue scoped block ---------- */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg-2) 92%, transparent);
  border-right: 1px solid var(--border);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 88px;
  padding: 0 var(--space-4);
  flex-shrink: 0;
}
.brand-slot {
  position: relative;
  z-index: 5;
  width: 48px;
  height: 72px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
}
.brand-avatar {
  display: block;
  background: transparent;
  border: 0;
  padding: 0;
  border-radius: 12px;
  flex-shrink: 0;
}
.brand-head {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  image-rendering: pixelated;
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 255, 255, 0.26);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.18);
  display: block;
}
.logo-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.logo-name {
  font-family: 'Segoe UI Variable Display', 'Segoe UI', sans-serif;
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1.2;
  color: var(--text);
}
.logo-version {
  align-self: flex-end;
  padding-right: 2px;
  font-size: var(--text-xs);
  color: var(--accent-2);
  opacity: 0.85;
}

.nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3) var(--space-3);
  overflow-y: auto;
  position: relative;
}
.nav-group + .nav-group {
  margin-top: var(--space-3);
}
.nav-group-label {
  padding: var(--space-1) var(--space-4) 2px;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  opacity: 0.75;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--space-7);
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--sidebar-text);
  font-size: var(--text-md);
  font-family: inherit;
  cursor: pointer;
  transition: color var(--motion-fast) ease, background var(--motion-fast) ease;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}
.nav-item:hover {
  background: transparent;
  color: var(--text);
}
.nav-item.active {
  background: transparent;
  color: color-mix(in srgb, var(--text) 84%, var(--accent));
}
.nav-bubble {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent-soft) 80%, transparent), var(--hover));
  border: none;
  box-shadow: 0 3px 12px #00000008;
  transition:
    transform 300ms cubic-bezier(0.22, 1, 0.36, 1),
    width 300ms cubic-bezier(0.22, 1, 0.36, 1),
    height 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 120ms ease;
  will-change: transform;
}
.nav-selection {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  border-radius: var(--radius-md);
  box-shadow: inset 3px 0 0 var(--accent);
  z-index: 2;
  transition:
    transform 300ms cubic-bezier(0.22, 1, 0.36, 1),
    width 300ms cubic-bezier(0.22, 1, 0.36, 1),
    height 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 120ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .nav-bubble,
  .nav-selection {
    transition: none;
  }
}
.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
.nav-icon :deep(svg) {
  width: 19px;
  height: 19px;
  display: block;
}
.nav-label {
  font-weight: 500;
}
.nav-item.active .nav-label {
  font-weight: 600;
}

.sidebar-health {
  position: relative;
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) 14px;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  margin: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--card) 48%, transparent);
  color: var(--text-dim);
  font-family: inherit;
  font-size: var(--text-xs);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.sidebar-health:hover {
  background: var(--card-2);
  color: var(--text);
}
.sidebar-health i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
}
.sidebar-health.is-busy i {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.sidebar-health.is-error i {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-soft);
}
.sidebar-health span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-health svg {
  width: 14px;
  height: 14px;
}
.health-badge {
  position: absolute;
  top: -5px;
  right: -3px;
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

/* ---------- sidebar footer ---------- */
.sidebar-foot {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--border);
}
.foot-actions {
  display: flex;
  gap: var(--space-2);
}
.foot-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  min-height: calc(var(--ctl-h) - 6px);
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    border-color 0.16s ease;
  -webkit-app-region: no-drag;
}
.foot-btn:hover {
  background: var(--card-2);
  color: var(--text);
}
.foot-btn.active {
  border-color: var(--accent);
  color: var(--accent-2);
  background: var(--accent-soft);
}
.foot-icon {
  display: flex;
  align-items: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.foot-icon :deep(svg) {
  width: 15px;
  height: 15px;
  display: block;
}
.foot-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

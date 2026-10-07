<script setup lang="ts">
/**
 * ModsInstalled — the 「已安装」 panel of the 模组 page.
 *
 * Row metrics follow the ported instance library (`min-height` row, name + tag line, muted
 * meta line, commands pinned right, `.switch` for the enabled state); the fields are exactly
 * what `mouc.mod.installed()` reports: parsed jar metadata (`name` / `modId` / `version` /
 * `loader`), the file size, the `.disabled` suffix, and the provenance-backed
 * `updateAvailable` a `checkUpdates()` pass fills in.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed } from 'vue'
import type { InstalledMod, ProjectKind } from '@shared/types'
import { formatRelative } from '../../composables/format'
import { defineDict, t } from '../../i18n'
import ModsSkeleton from './ModsSkeleton.vue'
import { KIND_LABELS, formatSize, providerLabel } from '../api/mods'

const props = withDefaults(
  defineProps<{
    mods: InstalledMod[]
    loading: boolean
    error: string
    busyFile: string
    checking: boolean
    updatingAll: boolean
    hasInstance: boolean
    instanceText: string
    kind?: ProjectKind
  }>(),
  { kind: 'mod' }
)

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'toggle', mod: InstalledMod, disabled: boolean): void
  (e: 'remove', mod: InstalledMod): void
  (e: 'update', mod: InstalledMod): void
  (e: 'update-all'): void
  (e: 'check-updates'): void
  (e: 'from-disk'): void
  (e: 'browse'): void
  (e: 'open-folder'): void
  (e: 'create-instance'): void
}>()

const copy = defineDict({
  title: ['{kind}文件', '{kind} files'],
  subtitle: ['{n} 个文件 · 共 {size}', '{n} files · {size} total'],
  noInstance: ['还没有实例', 'No instances yet'],
  noInstanceHint: [
    '{kind}按实例保存在游戏目录里，先创建一个实例。',
    'Content lives inside an instance — create one first.'
  ],
  createInstance: ['前往实例页创建', 'Create an instance'],
  loading: ['正在读取已安装内容…', 'Reading installed files…'],
  readFailed: ['读取失败：{error}', 'Could not read the folder: {error}'],
  retry: ['重新读取', 'Reload'],
  emptyTitle: ['这个实例还没有{kind}', 'This instance has no {kind} yet'],
  emptyHint: [
    '从磁盘选择 .jar / .zip，或到「浏览」里搜索 Modrinth 与 CurseForge。',
    'Pick a local .jar / .zip, or search Modrinth and CurseForge in Browse.'
  ],
  fromDisk: ['从磁盘安装', 'Install from file'],
  browse: ['浏览仓库', 'Browse'],
  openFolder: ['打开文件夹', 'Open folder'],
  checkUpdates: ['检查更新', 'Check updates'],
  checking: ['检查中…', 'Checking…'],
  updateAll: ['全部更新（{n}）', 'Update all ({n})'],
  updatesFound: ['{n} 个可更新', '{n} updatable'],
  disabled: ['已停用', 'Disabled'],
  update: ['更新', 'Update'],
  updateTo: ['可更新到 {version}', 'Updates to {version}'],
  remove: ['删除文件', 'Delete file'],
  localFile: ['本地文件', 'Local file'],
  unknown: ['未知', 'unknown']
})

const totalBytes = computed(() => props.mods.reduce((acc, mod) => acc + mod.size, 0))
const updatable = computed(() => props.mods.filter((mod) => !!mod.updateAvailable))

function nameOf(mod: InstalledMod): string {
  return mod.name || mod.modId || mod.fileName
}

function versionOf(mod: InstalledMod): string {
  return mod.version || copy.text('unknown')
}

function kindName(): string {
  return KIND_LABELS[props.kind]
}

function providerOf(mod: InstalledMod): string {
  return mod.provider === 'local' ? copy.text('localFile') : providerLabel(mod.provider)
}
</script>

<template>
  <section class="card mods-panel">
    <header class="mods-panel-head">
      <div class="mods-panel-title">
        <h3>
          {{ copy.text('title', { kind: kindName() }) }}
          <span v-if="mods.length" class="mods-panel-count">{{ mods.length }}</span>
        </h3>
        <p class="page-sub">
          <template v-if="!hasInstance">{{ copy.text('noInstance') }}</template>
          <template v-else-if="loading">{{ copy.text('loading') }}</template>
          <template v-else>
            {{ instanceText }} · {{ copy.text('subtitle', { n: mods.length, size: formatSize(totalBytes) }) }}
            <span v-if="updatable.length" class="mods-panel-warn">· {{ copy.text('updatesFound', { n: updatable.length }) }}</span>
          </template>
        </p>
      </div>
      <div class="row-actions">
        <button class="btn btn-ghost btn-sm" :disabled="!hasInstance || busyFile !== ''" @click="emit('from-disk')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v11" />
            <path d="m7 10 5 5 5-5" />
            <path d="M4 21h16" />
          </svg>
          {{ copy.text('fromDisk') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="!hasInstance || loading || checking" @click="emit('check-updates')">
          <span v-if="checking" class="spin" aria-hidden="true"></span>
          {{ checking ? copy.text('checking') : copy.text('checkUpdates') }}
        </button>
        <button class="btn btn-gold btn-sm" :disabled="!updatable.length || updatingAll" @click="emit('update-all')">
          {{ updatingAll ? copy.text('checking') : copy.text('updateAll', { n: updatable.length }) }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="!hasInstance" @click="emit('open-folder')">{{ copy.text('openFolder') }}</button>
      </div>
    </header>

    <p v-if="error" class="status-strip error" role="alert">
      {{ copy.text('readFailed', { error }) }}
      <button class="btn btn-ghost btn-sm" @click="emit('retry')">{{ copy.text('retry') }}</button>
    </p>

    <ModsSkeleton v-else-if="loading && !mods.length" :label="copy.text('loading')" :rows="5" retry @retry="emit('retry')" />

    <div v-else-if="!hasInstance" class="empty">
      <span>{{ copy.text('noInstanceHint', { kind: kindName() }) }}</span>
      <button class="btn btn-gold btn-sm" @click="emit('create-instance')">{{ copy.text('createInstance') }}</button>
    </div>

    <div v-else-if="!mods.length" class="empty">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
        <path d="m3 8 9 5 9-5" />
        <path d="M12 13v8" />
      </svg>
      <span>{{ copy.text('emptyTitle', { kind: kindName() }) }}</span>
      <span class="mods-empty-hint">{{ copy.text('emptyHint') }}</span>
      <div class="row-actions">
        <button class="btn btn-gold btn-sm" @click="emit('from-disk')">{{ copy.text('fromDisk') }}</button>
        <button class="btn btn-ghost btn-sm" @click="emit('browse')">{{ copy.text('browse') }}</button>
      </div>
    </div>

    <div v-else class="mods-rows">
      <article v-for="mod in mods" :key="mod.fileName" class="mods-row" :class="{ 'is-off': mod.disabled }">
        <span class="mods-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
            <path d="m3 8 9 5 9-5" />
            <path d="M12 13v8" />
          </svg>
        </span>

        <div class="mods-row-main">
          <div class="mods-row-line">
            <strong :title="nameOf(mod)">{{ nameOf(mod) }}</strong>
            <span v-if="mod.updateAvailable" class="tag tag-cyan">{{ t('mod.update') }}</span>
            <span v-if="mod.disabled" class="tag">{{ copy.text('disabled') }}</span>
            <span v-if="mod.loader" class="tag tag-accent">{{ mod.loader }}</span>
            <span v-if="providerOf(mod)" class="tag">{{ providerOf(mod) }}</span>
          </div>
          <div class="mods-row-meta muted">
            <span class="mono">{{ versionOf(mod) }}</span>
            <span class="sep">·</span>
            <span class="mono mods-row-id" :title="mod.modId ?? mod.fileName">{{ mod.modId ?? mod.fileName }}</span>
            <span class="sep">·</span>
            <span class="mono">{{ formatSize(mod.size) }}</span>
            <span class="sep">·</span>
            <span>{{ formatRelative(mod.updatedAt) }}</span>
            <template v-if="mod.updateAvailable">
              <span class="sep">·</span>
              <span class="mods-row-update">{{ copy.text('updateTo', { version: mod.updateAvailable.versionNumber }) }}</span>
            </template>
          </div>
          <p v-if="mod.description" class="mods-row-desc muted" :title="mod.description">{{ mod.description }}</p>
        </div>

        <div class="mods-row-tools">
          <label class="switch" :title="mod.disabled ? t('mod.enable') : t('mod.disable')">
            <input
              type="checkbox"
              :checked="!mod.disabled"
              :disabled="busyFile === mod.fileName"
              :aria-label="`${mod.disabled ? t('mod.enable') : t('mod.disable')} ${nameOf(mod)}`"
              @change="emit('toggle', mod, !($event.target as HTMLInputElement).checked)"
            />
            <span class="switch-ui"></span>
          </label>
          <button
            v-if="mod.updateAvailable"
            class="btn btn-ghost btn-sm"
            :disabled="busyFile !== ''"
            @click="emit('update', mod)"
          >
            {{ copy.text('update') }}
          </button>
          <button
            class="icon-btn mods-row-remove"
            :disabled="busyFile !== ''"
            :aria-label="`${t('mod.remove')} ${nameOf(mod)}`"
            :title="t('mod.remove')"
            @click="emit('remove', mod)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7h16" />
              <path d="M9 7V5h6v2" />
              <path d="M6 7l1 13h10l1-13" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.mods-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
}
.mods-panel-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.mods-panel-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mods-panel-title h3 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-lg);
  font-weight: 700;
}
.mods-panel-count {
  padding: 0 var(--space-2);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-2);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.mods-panel-warn {
  color: var(--accent-2);
}
.mods-rows {
  display: flex;
  flex-direction: column;
}
.mods-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 72px;
  padding: var(--space-3) var(--space-1);
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: background var(--motion-fast) ease;
}
.mods-row:last-child {
  border-bottom: none;
}
.mods-row:hover {
  background: var(--hover);
}
.mods-row.is-off .mods-glyph,
.mods-row.is-off .mods-row-main strong {
  color: var(--text-dim);
  opacity: 0.7;
}
.mods-glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  color: var(--text-dim);
}
.mods-glyph svg {
  width: 20px;
  height: 20px;
}
.mods-row-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mods-row-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex-wrap: wrap;
}
.mods-row-line strong {
  overflow: hidden;
  font-size: var(--text-md);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.mods-row-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--text-xs);
}
.mods-row-meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mods-row-id {
  max-width: 220px;
}
.mods-row-meta .sep {
  color: var(--text-dim);
  opacity: 0.6;
  flex: none;
}
.mods-row-update {
  color: var(--accent-2);
}
.mods-row-desc {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--text-xs);
  line-height: 1.6;
}
.mods-row-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.mods-row-remove:hover {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: var(--danger-border);
}
.mods-empty-hint {
  font-size: var(--text-xs);
  line-height: 1.6;
  max-width: 46ch;
}
@media (max-width: 720px) {
  .mods-row {
    flex-wrap: wrap;
  }
  .mods-row-tools {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>

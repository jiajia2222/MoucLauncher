<script setup lang="ts">
/**
 * VersionsPicker — port of KAMUCL's `MinecraftVersionPicker.vue`.
 *
 * Same floating combobox: anchored panel, category capsules, keyboard-activelist, manual
 * fallback entry. The data layer is `window.mouc.version` instead of upstream's manifest
 * cache, and rows carry an 已安装 marker because the bridge can tell us what is on disk.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { VersionRef } from '@shared/types'
import {
  categoryLabel,
  filterVersions,
  listVersions,
  refreshVersions,
  releaseDateOf,
  versionCategories,
  versionCategory,
  type VersionCategory
} from '../api/versions'

const props = withDefaults(
  defineProps<{
    modelValue: string
    disabled?: boolean
    installed?: string[]
    placeholder?: string
  }>(),
  { disabled: false, installed: () => [], placeholder: '选择目标游戏版本' }
)
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const open = ref(false)
const loading = ref(false)
const error = ref('')
const query = ref('')
const category = ref<VersionCategory>('release')
const versions = ref<VersionRef[]>([])
const active = ref(0)
const manual = ref(false)
const manualValue = ref('')
const anchor = ref<HTMLElement>()
const panel = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const list = ref<HTMLElement>()
const position = ref<Record<string, string>>({})

const rows = computed(() => filterVersions(versions.value, category.value, query.value))
const installedSet = computed(() => new Set(props.installed))

function locate(): void {
  const rect = anchor.value?.getBoundingClientRect()
  if (!rect) return
  const below = window.innerHeight - rect.bottom - 16
  const above = rect.top - 16
  const upward = below < 300 && above > below
  const height = Math.max(100, Math.min(430, upward ? above : below))
  const width = Math.min(Math.max(420, rect.width), window.innerWidth - 24)
  position.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    width: `${width}px`,
    height: `${height}px`,
    ...(upward ? { bottom: `${window.innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` })
  }
}

async function load(force = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    versions.value = force ? await refreshVersions() : await listVersions()
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '版本列表加载失败'
  } finally {
    loading.value = false
  }
}

async function show(): Promise<void> {
  if (props.disabled) return
  if (open.value) {
    close()
    return
  }
  open.value = true
  locate()
  window.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', keyboard, true)
  window.addEventListener('resize', locate)
  window.addEventListener('scroll', onScroll, true)
  if (!versions.value.length) await load()
  active.value = Math.max(
    0,
    rows.value.findIndex((entry) => entry.id === props.modelValue)
  )
  await nextTick()
  search.value?.focus()
  reveal()
}

function close(): void {
  open.value = false
  manual.value = false
  window.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('resize', locate)
  window.removeEventListener('scroll', onScroll, true)
}

function outside(event: PointerEvent): void {
  if (!panel.value?.contains(event.target as Node) && !anchor.value?.contains(event.target as Node)) close()
}

function onScroll(event: Event): void {
  if (!panel.value?.contains(event.target as Node)) locate()
}

function choose(id: string): void {
  const value = id.trim()
  if (!value) return
  emit('update:modelValue', value)
  close()
  anchor.value?.focus()
}

function reveal(): void {
  void nextTick(() => {
    list.value?.querySelector<HTMLElement>('[data-active=true]')?.scrollIntoView({ block: 'nearest' })
  })
}

function reset(): void {
  active.value = 0
  if (list.value) list.value.scrollTop = 0
}

function keyboard(event: KeyboardEvent): void {
  if (!open.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
    anchor.value?.focus()
    return
  }
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && !manual.value) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const last = rows.value.length - 1
    active.value =
      event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, last) : Math.max(0, Math.min(last, active.value + (event.key === 'ArrowDown' ? 1 : -1)))
    reveal()
  }
  if (event.key === 'Enter' && event.target === search.value && rows.value[active.value]) {
    event.preventDefault()
    const picked = rows.value[active.value]
    if (picked) choose(picked.id)
  }
}

onBeforeUnmount(close)
</script>

<template>
  <button
    ref="anchor"
    type="button"
    class="version-picker-trigger input"
    :disabled="disabled"
    :aria-expanded="open"
    aria-haspopup="listbox"
    :aria-label="placeholder"
    @click="show"
  >
    <span>{{ modelValue || placeholder }}</span>
    <span class="version-picker-caret">⌄</span>
  </button>
  <Teleport to="body">
    <Transition name="popover">
      <section v-if="open" ref="panel" class="version-picker-popup" :style="position" @wheel.stop>
        <div class="version-picker-top">
          <input
            ref="search"
            v-model="query"
            class="input"
            role="combobox"
            aria-label="搜索游戏版本"
            aria-controls="version-picker-list"
            :aria-expanded="open"
            :aria-activedescendant="`mc-option-${active}`"
            placeholder="搜索版本号，例如 1.21"
            @input="reset"
          />
          <div class="version-categories">
            <button
              v-for="item in versionCategories"
              :key="item.value"
              :class="{ active: category === item.value }"
              :aria-pressed="category === item.value"
              @click="category = item.value; reset()"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
        <div
          id="version-picker-list"
          ref="list"
          class="version-picker-list"
          role="listbox"
          aria-label="游戏版本"
        >
          <div v-if="loading" class="version-picker-message"><span class="spin"></span> 正在获取版本列表…</div>
          <div v-else-if="error" class="version-picker-message">
            {{ error }}
            <span class="version-picker-message-actions">
              <button class="btn btn-ghost btn-sm" @click="load(true)">重试</button>
              <button class="btn btn-ghost btn-sm" @click="manual = true">手动输入</button>
            </span>
          </div>
          <div v-else-if="!rows.length" class="version-picker-message">
            当前分类没有匹配版本
            <span class="version-picker-message-actions">
              <button class="btn btn-ghost btn-sm" @click="category = 'all'; reset()">搜索全部分类</button>
            </span>
          </div>
          <button
            v-for="(item, index) in rows"
            v-else
            :id="`mc-option-${index}`"
            :key="item.id"
            role="option"
            :aria-selected="modelValue === item.id"
            :data-active="active === index"
            class="version-picker-option"
            @pointermove="active = index"
            @click="choose(item.id)"
          >
            <span>
              <strong>{{ item.id }}</strong>
              <small>{{ categoryLabel(versionCategory(item)) }}</small>
            </span>
            <span v-if="installedSet.has(item.id)" class="tag tag-success">已安装</span>
            <time :datetime="item.releaseTime">{{ releaseDateOf(item).toISOString().slice(0, 10) }}</time>
            <b>{{ item.id === modelValue ? '✓' : '' }}</b>
          </button>
        </div>
        <form v-if="manual" class="version-picker-manual" @submit.prevent="choose(manualValue)">
          <input v-model="manualValue" class="input" placeholder="完整版本号" aria-label="手动输入版本号" />
          <button class="btn btn-gold btn-sm" type="submit" :disabled="!manualValue.trim()">选择</button>
        </form>
        <footer>已选择：{{ modelValue || '尚未选择' }} · {{ rows.length }} 个结果</footer>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.version-picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-align: left;
  cursor: pointer;
  width: 100%;
  gap: 12px;
}
.version-picker-trigger span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.version-picker-caret {
  flex-shrink: 0;
  color: var(--text-dim);
}
.version-picker-popup {
  position: fixed;
  z-index: 12000;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--card-solid, var(--card-2));
  color: var(--text);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  max-height: calc(100vh - 24px);
}
.version-picker-top {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.version-picker-top .input {
  width: 100%;
}
.version-categories {
  display: flex;
  gap: 4px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.version-categories button {
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--text-xs);
  padding: 6px 8px;
  cursor: pointer;
}
.version-categories button.active {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
}
.version-picker-list {
  overflow: auto;
  overscroll-behavior: contain;
  min-height: 0;
  flex: 1;
  padding: 6px;
}
.version-picker-option {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  flex-shrink: 0;
  gap: 12px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.version-picker-option[data-active='true'] {
  background: var(--hover);
}
.version-picker-option[aria-selected='true'] {
  background: var(--accent-soft);
}
.version-picker-option > span {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}
.version-picker-option > span strong {
  font-variant-numeric: tabular-nums;
}
.version-picker-option small {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
.version-picker-option time {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.version-picker-option b {
  width: 12px;
  color: var(--accent);
}
.version-picker-message {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--text-dim);
  line-height: 1.6;
}
.version-picker-message-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.version-picker-manual {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.version-picker-popup footer {
  flex-shrink: 0;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}
</style>

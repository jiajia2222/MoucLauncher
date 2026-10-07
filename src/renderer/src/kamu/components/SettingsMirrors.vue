<script setup lang="ts">
/**
 * Mirror-rule editor for `settings.mirrors`.
 *
 * Upstream offered two radio buttons (official / BMCLAPI); this launcher rewrites hosts
 * per rule instead (see `src/main/download/mirror.ts`), and BMCLAPI is verified dead
 * (`OFFICIAL_TO_MIRROR` note in `src/shared/constants.ts`), so the rules are editable:
 * a name, an on/off switch, a priority, and the official-host -> mirror-host table.
 *
 * Rows reuse upstream's list vocabulary (`java-list` / `java-list-head` / `java-item` /
 * `dir-row` / `switch`), and every write goes through the parent's `write`, which adopts
 * the record the process returns — a rejected write snaps this editor back to it.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { OFFICIAL_HOSTS } from '@shared/constants'
import type { MirrorRule, Settings } from '@shared/types'
import { uid } from '@shared/utils'

const props = defineProps<{
  rules: MirrorRule[]
  /** Parent's debounced/immediate write; resolves false when the process rejected it. */
  write: (patch: Partial<Settings>) => Promise<boolean>
}>()

const emit = defineEmits<{ notify: [text: string, type: 'success' | 'error' | 'info'] }>()

/** Free-text fields are held here until the debounced commit lands. */
const drafts = ref<Record<string, string>>({})
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const removing = ref('')
const busy = ref(false)

/** The five hosts the downloader can rewrite; a rule cannot list one twice. */
const officialHosts = Object.values(OFFICIAL_HOSTS) as string[]

/** Authoritative rules + whatever the user has typed on top of them. */
const sorted = computed<MirrorRule[]>(() =>
  [...props.rules].sort((a, b) => a.priority - b.priority)
)

const activeCount = computed(() => props.rules.filter((rule) => rule.enabled).length)

function text(key: string, fallback: string): string {
  return drafts.value[key] ?? fallback
}

/** Priorities are a small non-negative integer; the downloader sorts ascending. */
function clampPriority(value: number): number {
  return Math.min(9999, Math.max(0, Math.round(value)))
}

function labelOf(rule: MirrorRule): string {
  return text(`${rule.id}:label`, rule.label)
}

function mirrorOf(rule: MirrorRule, host: string): string {
  return text(`${rule.id}:host:${host}`, rule.hosts[host] ?? '')
}

function priorityOf(rule: MirrorRule): string {
  return text(`${rule.id}:priority`, String(rule.priority))
}

/** Replace the whole array with the current edits folded in. */
function commit(ruleId: string, field: string, value: string | number): Promise<boolean> {
  const mirrors = props.rules.map((rule) => {
    if (rule.id !== ruleId) return rule
    if (field === 'label') return { ...rule, label: String(value).trim() || rule.label }
    if (field === 'priority') return { ...rule, priority: Number(value) }
    const hosts = { ...rule.hosts }
    const host = field
    if (String(value).trim().length === 0) delete hosts[host]
    else hosts[host] = String(value).trim()
    return { ...rule, hosts }
  })
  return props.write({ mirrors })
}

function schedule(key: string, run: () => Promise<boolean>): void {
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void run().then((ok) => {
        if (!ok) drop(key)
      })
    }, 500)
  )
}

function drop(key: string): void {
  delete drafts.value[key]
}

/** `@change` (blur / Enter) commits at once instead of waiting for the debounce. */
function flush(key: string, run: () => Promise<boolean>): void {
  const pending = timers.get(key)
  if (pending) {
    clearTimeout(pending)
    timers.delete(key)
  }
  void run().then(() => drop(key))
}

function settleLabel(rule: MirrorRule): void {
  const key = `${rule.id}:label`
  const value = drafts.value[key]
  if (value === undefined) return
  flush(key, () => commit(rule.id, 'label', value))
}

function settlePriority(rule: MirrorRule): void {
  const key = `${rule.id}:priority`
  const value = Number(drafts.value[key])
  if (!Number.isFinite(value)) return
  flush(key, () => commit(rule.id, 'priority', clampPriority(value)))
}

function settleHost(rule: MirrorRule, host: string): void {
  const key = `${rule.id}:host:${host}`
  const value = drafts.value[key]
  if (value === undefined) return
  flush(key, () => commit(rule.id, host, value))
}

function onLabelInput(rule: MirrorRule, event: Event): void {
  const value = (event.target as HTMLInputElement).value
  const key = `${rule.id}:label`
  drafts.value[key] = value
  schedule(key, () => commit(rule.id, 'label', value))
}

function onHostInput(rule: MirrorRule, host: string, event: Event): void {
  const value = (event.target as HTMLInputElement).value
  const key = `${rule.id}:host:${host}`
  drafts.value[key] = value
  schedule(key, () => commit(rule.id, host, value))
}

function onPriorityInput(rule: MirrorRule, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  const key = `${rule.id}:priority`
  drafts.value[key] = raw
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  schedule(key, () => commit(rule.id, 'priority', clampPriority(value)))
}

async function toggle(rule: MirrorRule, enabled: boolean): Promise<void> {
  busy.value = true
  const ok = await props.write({
    mirrors: props.rules.map((item) => (item.id === rule.id ? { ...item, enabled } : item))
  })
  busy.value = false
  if (!ok) emit('notify', '切换下载源失败，已恢复原状态', 'error')
}

async function addRule(): Promise<void> {
  const rule: MirrorRule = { id: uid('mirror'), label: '自建镜像', enabled: false, hosts: {}, priority: 50 }
  const ok = await props.write({ mirrors: [...props.rules, rule] })
  if (ok) {
    emit('notify', '已新增下载源规则，填写镜像域名后生效', 'info')
    drafts.value[`${rule.id}:label`] = rule.label
  } else emit('notify', '新增下载源失败', 'error')
}

function freeHosts(rule: MirrorRule): string[] {
  return officialHosts.filter((host) => !(host in rule.hosts))
}

async function addHost(rule: MirrorRule): Promise<void> {
  const host = freeHosts(rule)[0]
  if (!host) return
  await props.write({ mirrors: props.rules.map((item) => (item.id === rule.id ? { ...item, hosts: { ...item.hosts, [host]: '' } } : item)) })
}

async function removeHost(rule: MirrorRule, host: string): Promise<void> {
  drop(`${rule.id}:host:${host}`)
  const hosts = { ...rule.hosts }
  delete hosts[host]
  await props.write({ mirrors: props.rules.map((item) => (item.id === rule.id ? { ...item, hosts } : item)) })
}

/** Delete needs a second click, matching upstream's plugin removal. */
async function removeRule(rule: MirrorRule): Promise<void> {
  if (removing.value !== rule.id) {
    removing.value = rule.id
    setTimeout(() => {
      if (removing.value === rule.id) removing.value = ''
    }, 3000)
    return
  }
  removing.value = ''
  const ok = await props.write({ mirrors: props.rules.filter((item) => item.id !== rule.id) })
  emit('notify', ok ? `已删除下载源：${rule.label}` : '删除失败，规则已恢复', ok ? 'success' : 'error')
}

// The record is the truth again after every accepted write: clear the buffers.
watch(
  () => props.rules,
  () => {
    drafts.value = {}
  }
)

onUnmounted(() => {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
})
</script>

<template>
  <div class="mirror-editor">
    <div class="java-list-head">
      <span class="muted">已配置 {{ rules.length }} 条 · 启用 {{ activeCount }} 条</span>
      <button class="btn btn-ghost btn-sm" :disabled="busy" @click="addRule">新建规则</button>
    </div>

    <p v-if="!sorted.length" class="muted group-hint">
      没有规则时全部下载都走 Mojang 官方域名。填写镜像域名后，下载器会优先尝试镜像，官方地址始终作为最后的兜底。
    </p>

    <div v-for="rule in sorted" :key="rule.id" class="mirror-rule" :class="{ off: !rule.enabled }">
      <div class="mirror-rule-head">
        <input
          class="input mirror-rule-name"
          :value="labelOf(rule)"
          aria-label="下载源名称"
          spellcheck="false"
          maxlength="40"
          @input="onLabelInput(rule, $event)"
          @change="settleLabel(rule)"
        />
        <label class="switch" :title="rule.enabled ? '停用该下载源' : '启用该下载源'">
          <input type="checkbox" :checked="rule.enabled" :disabled="busy" @change="toggle(rule, ($event.target as HTMLInputElement).checked)" />
          <span class="switch-ui"></span>
        </label>
        <button
          class="btn btn-sm"
          :class="removing === rule.id ? 'btn-danger' : 'btn-ghost'"
          :aria-label="removing === rule.id ? '确认删除该下载源' : '删除该下载源'"
          @click="removeRule(rule)"
        >{{ removing === rule.id ? '确认删除' : '删除' }}</button>
      </div>

      <div class="mirror-rule-meta">
        <label class="download-setting">
          <span>优先级<small class="muted">（数字小的先试）</small></span>
          <input
            class="input"
            type="number"
            min="0"
            max="9999"
            step="1"
            :value="priorityOf(rule)"
            @input="onPriorityInput(rule, $event)"
            @change="settlePriority(rule)"
          />
        </label>
        <span class="muted mirror-rule-count">{{ Object.keys(rule.hosts).length }} / {{ officialHosts.length }} 个官方域名已改写</span>
      </div>

      <div class="mirror-hosts">
        <div v-for="(host, index) in Object.keys(rule.hosts)" :key="host" class="mirror-host-row">
          <span class="muted mirror-host-from">{{ host }}</span>
          <span class="mirror-host-arrow" aria-hidden="true"></span>
          <input
            class="input mono mirror-host-to"
            :value="mirrorOf(rule, host)"
            :aria-label="`第 ${index + 1} 个域名的镜像地址`"
            placeholder="mirror.example.com"
            spellcheck="false"
            @input="onHostInput(rule, host, $event)"
            @change="settleHost(rule, host)"
          />
          <button class="java-item-hide" title="不再改写该域名" @click="removeHost(rule, host)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <button v-if="freeHosts(rule).length" class="btn btn-ghost btn-sm mirror-add" @click="addHost(rule)">添加官方域名</button>
        <p v-else class="muted group-hint">所有官方域名都已在该规则中。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mirror-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  padding: var(--space-3);
}
.mirror-rule {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.mirror-rule.off {
  opacity: 0.62;
}
.mirror-rule-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.mirror-rule-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}
.mirror-rule-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.mirror-rule-meta .download-setting {
  flex: 1;
  min-width: 220px;
}
.mirror-rule-meta small {
  font-weight: 400;
  margin-left: 4px;
}
.mirror-rule-count {
  font-size: var(--text-xs);
}
.mirror-hosts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.mirror-host-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.mirror-host-from {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--text-xs);
}
.mirror-host-arrow {
  width: 7px;
  height: 7px;
  border-top: 2px solid var(--text-dim);
  border-right: 2px solid var(--text-dim);
  transform: rotate(45deg);
  flex-shrink: 0;
}
.mirror-host-to {
  flex: 1.4;
  min-width: 0;
  font-size: var(--text-sm);
}
.mirror-add {
  align-self: flex-start;
}
.java-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.download-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.download-setting .input {
  width: 96px;
}
</style>

<script setup lang="ts">
/**
 * InstanceCenterPanel — port of KAMUCL's `InstanceCenter.vue`.
 *
 * Keeps upstream's dialog chrome (`.ic-*`), tab strip, row density and confirmation sheet,
 * with the tabs the MoucLauncher bridge can actually serve:
 *   概览  -> instance record + integrity summary + duplicate
 *   备份  -> export/import modpack (upstream's backup manifests have no backend here)
 *   诊断  -> instance.state flags, java.resolve, version.repair
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Instance, InstanceSummary, JavaRuntime, PathInfo } from '@shared/types'
import { formatBytes, formatDateTime, formatRelative } from '../../composables/format'
import { api, maybe } from '../api/core'
import {
  duplicateInstance,
  gameVersionOf,
  instanceHealth,
  instanceDirLabel,
  javaRuntimes,
  loaderLabel,
  openInstanceFolder,
  provisionJava,
  refreshInstanceState,
  resolveInstanceJava,
  updateInstance,
  validateInstanceName
} from '../api/instances'
import { repairVersion } from '../api/versions'

const props = defineProps<{
  summary: InstanceSummary
  /** Siblings of this instance, so a rename can be checked for collisions. */
  instances: Instance[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'refresh'): void
  (e: 'export', instance: Instance): void
  (e: 'import'): void
}>()

type IcTab = 'overview' | 'backup' | 'diagnostics'

const sections: Array<{ value: IcTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'backup', label: '备份' },
  { value: 'diagnostics', label: '诊断' }
]

const tab = ref<IcTab>('overview')
const busy = ref(false)
const error = ref('')
const live = ref<InstanceSummary>(props.summary)

const name = ref(live.value.instance.name)
const description = ref(live.value.instance.description)
const memoryMb = ref(live.value.instance.memoryMb)
const nameError = ref('')
const savedAt = ref('')

const cloneOpen = ref(false)
const cloneName = ref('')
const paths = ref<PathInfo | null>(null)

const runtimes = ref<JavaRuntime[]>([])
const javaPath = ref('')
const javaMajor = ref(0)
const javaNote = ref('')
const checking = ref(false)

const dialog = ref<HTMLElement>()

/** Advice line per integrity finding, upstream's `DiagnosticFinding.advice` shape. */
const ADVICE: Record<string, string> = {
  '版本 json 无法解析': '版本 JSON 可能已被手动删除。修复会重新下载并合并继承链。',
  'client jar 缺失或校验失败': '客户端 jar 缺失或 SHA-1 不匹配，修复会重新下载该文件。',
  '模组加载器未安装': '加载器尚未安装完成，可在版本管理中为这个游戏版本安装加载器。',
  '资源文件不完整': 'assets 索引或对象文件缺失，修复会补齐资源。',
  '依赖库不完整': 'libraries 中有依赖缺失，修复会按解析结果重新下载。'
}

const instance = computed(() => live.value.instance)
const health = computed(() => instanceHealth(live.value.state))
const version = computed(() => gameVersionOf(live.value))
const directory = computed(() => {
  if (!paths.value) return ''
  return live.value.instance.isolated ? `${paths.value.instancesDir}\\${live.value.instance.id}` : paths.value.gameRoot
})
const findings = computed(() =>
  health.value.problems.map((problem) => ({
    title: problem,
    advice: ADVICE[problem] ?? '校验并修复运行文件会重新拉取缺失或损坏的依赖。',
    repairable: true
  }))
)
const canSave = computed(() => !busy.value && !!name.value.trim() && !validateInstanceName(name.value, props.instances, instance.value.id))

function sync(source: InstanceSummary): void {
  live.value = source
  name.value = source.instance.name
  description.value = source.instance.description
  memoryMb.value = source.instance.memoryMb
  javaMajor.value = source.instance.java.major ?? 0
  javaPath.value = source.instance.java.path ?? ''
}

watch(
  () => props.summary,
  (next) => {
    sync(next)
  },
  { deep: false }
)

async function run(action: () => Promise<unknown>, notice: string): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
    savedAt.value = notice
    emit('refresh')
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '操作失败'
  } finally {
    busy.value = false
  }
}

async function saveProfile(): Promise<void> {
  nameError.value = validateInstanceName(name.value, props.instances, instance.value.id)
  if (nameError.value) return
  await run(
    () =>
      updateInstance({
        id: instance.value.id,
        name: name.value.trim(),
        description: description.value.trim(),
        memoryMb: Number.isFinite(memoryMb.value) ? Math.round(memoryMb.value) : instance.value.memoryMb
      }),
    `已保存 ${formatDateTime(Date.now())}`
  )
}

async function loadPaths(): Promise<void> {
  // The path strip is decoration; a failed read just leaves it empty, the buttons still work.
  paths.value = await maybe(api().app.paths(), null)
}

async function checkState(): Promise<void> {
  checking.value = true
  error.value = ''
  try {
    sync(await refreshInstanceState(instance.value.id))
    savedAt.value = `状态已校验 ${formatDateTime(Date.now())}`
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '状态校验失败'
  } finally {
    checking.value = false
  }
}

async function repair(): Promise<void> {
  await run(() => repairVersion(instance.value.versionId), '修复任务已加入下载队列')
}

async function loadJava(): Promise<void> {
  error.value = ''
  try {
    const [resolved, list] = await Promise.all([resolveInstanceJava(instance.value.id), javaRuntimes()])
    runtimes.value = list
    javaMajor.value = resolved.major
    javaPath.value = resolved.runtime?.executable ?? ''
    javaNote.value = resolved.runtime
      ? `将使用 Java ${resolved.runtime.major} · ${resolved.runtime.vendor}`
      : `没有发现 Java ${resolved.major} 的运行时，可以下载。`
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : 'Java 环境读取失败'
  }
}

async function applyJava(): Promise<void> {
  const runtime = runtimes.value.find((entry) => entry.executable === javaPath.value || entry.path === javaPath.value)
  if (!runtime) {
    error.value = '请先选择一个 Java 运行时'
    return
  }
  await run(
    () =>
      updateInstance({
        id: instance.value.id,
        java: { mode: 'pinned', path: runtime.executable, major: runtime.major }
      }),
    `已应用 Java ${runtime.major}`
  )
}

async function downloadJava(): Promise<void> {
  if (!javaMajor.value) return
  await run(async () => {
    const result = await provisionJava(javaMajor.value)
    const list = await javaRuntimes()
    runtimes.value = list
    javaPath.value = result.runtime.executable
    javaNote.value = result.fromCache
      ? `已从本地缓存准备 Java ${result.runtime.major}`
      : `已下载 Java ${result.runtime.major}（${formatBytes(result.downloadedBytes)}）`
  }, '运行时已就绪')
}

async function useAutoJava(): Promise<void> {
  await run(
    () => updateInstance({ id: instance.value.id, java: { mode: 'auto', major: javaMajor.value || undefined } }),
    '已改为自动选择 Java'
  )
}

function openClone(): void {
  cloneName.value = `${instance.value.name}-副本`
  cloneOpen.value = true
}

async function confirmClone(): Promise<void> {
  await run(async () => {
    const copy = await duplicateInstance(instance.value.id, cloneName.value)
    cloneOpen.value = false
    return copy
  }, '副本已创建')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopImmediatePropagation()
    if (cloneOpen.value) cloneOpen.value = false
    else emit('close')
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const nodes = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(
    (node) => node.getClientRects().length > 0
  )
  if (!nodes.length) return
  const index = nodes.indexOf(document.activeElement as HTMLElement)
  if ((event.shiftKey && index <= 0) || (!event.shiftKey && (index === nodes.length - 1 || index === -1))) {
    event.preventDefault()
    nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown, true)
  dialog.value?.querySelector<HTMLElement>('[aria-label="关闭实例管理"]')?.focus()
  await loadPaths()
  if (tab.value === 'diagnostics') await loadJava()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
})

async function chooseTab(value: IcTab): Promise<void> {
  tab.value = value
  cloneOpen.value = false
  savedAt.value = ''
  if (value === 'diagnostics') await loadJava()
}
</script>

<template>
  <Teleport to="body">
    <div class="ic-mask" @pointerdown.self="emit('close')">
      <section ref="dialog" class="ic" role="dialog" aria-modal="true" aria-labelledby="ic-title" data-ui="instance-center:page">
        <header class="ic-header">
          <div>
            <small>实例管理中心</small>
            <h2 id="ic-title">{{ instance.name }}</h2>
            <p>{{ version }} · {{ loaderLabel(instance.loader, instance.loaderVersion) }} · {{ instanceDirLabel(live) }}</p>
          </div>
          <button class="icon-btn" aria-label="关闭实例管理" @click="emit('close')">✕</button>
        </header>

        <nav class="ic-tabs" aria-label="实例功能">
          <button v-for="section in sections" :key="section.value" :class="{ active: tab === section.value }" @click="chooseTab(section.value)">
            {{ section.label }}
          </button>
        </nav>

        <div :key="tab" class="ic-content">
          <p v-if="error" class="ic-error" role="alert">
            {{ error }}
            <button class="btn btn-sm" :disabled="busy" @click="error = ''; chooseTab(tab)">重新加载</button>
          </p>
          <p v-if="savedAt" class="ic-hint" role="status">{{ savedAt }}</p>

          <template v-if="tab === 'overview'">
            <div class="ic-summary" data-ui="instance-center:overview">
              <div>
                <h3>{{ instance.isolated ? '你的游戏，独立管理' : '共享游戏目录' }}</h3>
                <p class="ic-path mono">{{ directory || '正在读取实例路径…' }}</p>
              </div>
              <button class="btn btn-ghost" :disabled="busy" @click="run(() => openInstanceFolder(instance.id), '已在资源管理器中打开')">打开目录</button>
            </div>

            <div class="ic-grid">
              <div class="ic-card">
                <div class="ic-row-plain">
                  <span class="ic-metric"><small>安装状态</small><strong :class="health.tone">{{ health.label }}</strong></span>
                  <span class="ic-metric"><small>磁盘占用</small><strong>{{ formatBytes(live.state.sizeBytes) }}</strong></span>
                  <span class="ic-metric"><small>模组数量</small><strong>{{ live.modCount }}</strong></span>
                  <span class="ic-metric"><small>最近游玩</small><strong>{{ instance.lastPlayedAt ? formatRelative(instance.lastPlayedAt) : '从未' }}</strong></span>
                </div>
                <p class="muted ic-note">最近一次校验：{{ live.state.lastCheckedAt ? formatDateTime(live.state.lastCheckedAt) : '尚未校验' }}</p>
              </div>
              <div class="ic-card">
                <h3>复制一个独立实例</h3>
                <p>保留名称、版本与加载器设置，原实例保持完整。可在副本里尝试新的模组组合。</p>
                <button class="btn btn-gold" :disabled="busy" @click="openClone">复制实例</button>
              </div>
            </div>

            <div class="ic-card">
              <h3>实例设置</h3>
              <div class="ic-form">
                <label>
                  名称
                  <input v-model="name" class="input" maxlength="64" @input="nameError = validateInstanceName(name, instances, instance.id)" />
                </label>
                <p v-if="nameError" class="ic-error">{{ nameError }}</p>
                <label>
                  说明
                  <input v-model="description" class="input" maxlength="120" placeholder="这个实例是用来做什么的" />
                </label>
                <label>
                  内存（MB）
                  <input v-model.number="memoryMb" class="input" type="number" min="512" max="32768" step="512" />
                </label>
              </div>
              <div class="ic-actions">
                <button class="btn btn-gold" :disabled="!canSave" @click="saveProfile">保存设置</button>
                <button class="btn btn-ghost" :disabled="checking" @click="checkState">{{ checking ? '校验中…' : '校验运行状态' }}</button>
              </div>
            </div>
          </template>

          <template v-else-if="tab === 'backup'">
            <div class="ic-summary">
              <div>
                <h3>备份与迁移</h3>
                <p>导出整合包会记录版本、加载器与模组清单，可在其他设备用「导入整合包」还原成一个新实例。</p>
              </div>
              <button class="btn btn-gold" :disabled="busy" @click="emit('export', instance)">导出整合包…</button>
            </div>
            <div class="ic-card">
              <h3>从整合包恢复</h3>
              <p>选择一个 .mrpack 或 MultiMC / CurseForge 压缩包；导入结果作为新实例出现，不会覆盖当前实例。</p>
              <button class="btn btn-ghost" :disabled="busy" @click="emit('import')">导入整合包…</button>
            </div>
            <div class="ic-card">
              <h3>改动保护</h3>
              <p>本启动器不维护实例备份清单，也不会自动保留改动记录。重要实例请定期导出整合包。</p>
            </div>
          </template>

          <template v-else>
            <div class="ic-summary">
              <div>
                <h3>检查运行环境</h3>
                <p>本地分析 Java 与运行文件状态；{{ formatDateTime(live.state.lastCheckedAt || Date.now()) }} 完成最近一次校验。</p>
              </div>
              <button class="btn btn-gold" :disabled="busy || checking" @click="checkState">{{ checking ? '正在检查…' : '开始检查' }}</button>
            </div>

            <div class="ic-card">
              <h3>Java 运行时</h3>
              <p class="muted ic-note">{{ javaNote || `该版本需要 Java ${javaMajor || '自动'}` }}</p>
              <div class="ic-tools">
                <select v-model="javaPath" class="select" aria-label="选择 Java 运行时">
                  <option value="">尚未发现兼容运行时</option>
                  <option v-for="runtime in runtimes" :key="runtime.id" :value="runtime.executable">
                    Java {{ runtime.major }} · {{ runtime.vendor }} · {{ runtime.path }}
                  </option>
                </select>
              </div>
              <div class="ic-actions">
                <button class="btn btn-gold" :disabled="busy || !javaPath" @click="applyJava">为此实例应用</button>
                <button class="btn btn-ghost" :disabled="busy || !javaMajor" @click="downloadJava">下载 Java {{ javaMajor }}</button>
                <button class="btn btn-ghost" :disabled="busy" @click="useAutoJava">自动选择</button>
              </div>
            </div>

            <div v-for="(finding, index) in findings" :key="index" class="ic-card">
              <div class="ic-tools">
                <strong>{{ finding.title }}</strong>
                <span class="ic-badge">{{ health.label }}</span>
              </div>
              <p>{{ finding.advice }}</p>
              <div class="ic-actions">
                <button v-if="finding.repairable" class="btn btn-sm" :disabled="busy" @click="repair">校验并修复运行文件</button>
              </div>
            </div>
            <div v-if="!findings.length" class="ic-card">
              <div class="ic-tools">
                <strong>运行文件完整</strong>
                <span class="ic-badge">{{ health.label }}</span>
              </div>
              <p class="muted">client jar、资源、依赖库与加载器均通过校验。</p>
              <div class="ic-actions">
                <button class="btn btn-ghost btn-sm" :disabled="busy" @click="repair">重新校验运行文件</button>
              </div>
            </div>
            <p v-if="busy" class="ic-hint" role="status">任务正在执行。进度及取消入口位于下载面板，关闭本页面不会取消任务。</p>
          </template>
        </div>

        <div v-if="cloneOpen" class="ic-dialog-mask">
          <section class="ic-dialog" role="dialog" aria-label="复制实例确认">
            <header>
              <h3>复制实例</h3>
              <button class="btn btn-sm" aria-label="关闭操作确认" @click="cloneOpen = false">✕</button>
            </header>
            <label>
              新实例名称
              <input v-model="cloneName" class="input" maxlength="120" />
            </label>
            <p class="muted">副本沿用当前实例的版本与加载器设置，模组文件按实例目录独立保存。</p>
            <footer>
              <button class="btn btn-ghost" @click="cloneOpen = false">取消</button>
              <button class="btn btn-gold" :disabled="busy || !cloneName.trim() || !!validateInstanceName(cloneName, instances, instance.id)" @click="confirmClone">
                {{ busy ? '正在处理…' : '确认执行' }}
              </button>
            </footer>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ic-mask {
  position: fixed;
  inset: 0;
  z-index: 9500;
  background: #0009;
  backdrop-filter: blur(8px);
  padding: 28px;
  display: grid;
  place-items: center;
}
.ic {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  height: min(860px, 100%);
  background: var(--card-solid, var(--card-2));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.ic-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 26px 30px 18px;
  gap: 24px;
}
.ic-header h2 {
  margin: 6px 0;
  font-size: 26px;
  overflow-wrap: anywhere;
}
.ic-header p,
.ic-header small {
  color: var(--text-dim);
  margin: 0;
}
.ic-tabs {
  display: flex;
  gap: 6px;
  padding: 0 30px 16px;
  border-bottom: 1px solid var(--border);
  overflow: auto;
  flex-shrink: 0;
}
.ic-tabs button {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  padding: 10px 24px;
  white-space: nowrap;
  border-radius: 12px;
  font: inherit;
  cursor: pointer;
}
.ic-tabs button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.ic-content {
  padding: 24px 30px;
  overflow: auto;
  min-height: 0;
  overscroll-behavior: contain;
}
.ic-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}
.ic-summary h3 {
  margin: 0 0 10px;
}
.ic p {
  line-height: 1.65;
  color: var(--text-dim);
}
.ic-path {
  overflow-wrap: anywhere;
  font-size: 12px;
}
.ic-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}
.ic-card {
  display: block;
  min-width: 0;
  text-align: left;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 16px;
  color: var(--text);
  background: var(--card);
  margin-bottom: 14px;
}
.ic-card h3 {
  margin: 0 0 8px;
  font-size: var(--text-lg);
}
.ic-card span.ic-grow,
.ic-card > p {
  display: block;
  color: var(--text-dim);
  font-size: var(--text-sm);
  margin-top: 8px;
}
.ic-row-plain {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.ic-metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ic-metric small {
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.ic-metric strong {
  font-size: var(--text-md);
  font-weight: 700;
}
.ic-note {
  font-size: var(--text-xs);
  margin-top: 10px;
}
.ic-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 14px 0 18px;
}
.ic-form label {
  display: block;
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.ic-form .input {
  display: block;
  width: 100%;
  margin-top: 8px;
}
.ic-actions,
.ic-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.ic-tools {
  margin-bottom: 12px;
}
.ic-tools .select,
.ic-tools .input {
  flex: 1;
  min-width: 220px;
}
.ic-empty {
  text-align: center;
  padding: 40px 12px;
}
.ic-error {
  color: var(--danger) !important;
  overflow-wrap: anywhere;
}
.ic-hint {
  background: var(--accent-soft);
  padding: 12px 16px;
  border-radius: 12px;
  margin-bottom: 14px;
}
.ic-badge {
  font-size: var(--text-xs);
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--accent-soft);
}
.ic-dialog-mask {
  position: absolute;
  inset: 0;
  background: #0008;
  display: grid;
  place-items: center;
  padding: 24px;
  z-index: 2;
}
.ic-dialog {
  background: var(--card-solid, var(--card-2));
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 24px;
  width: min(560px, 100%);
  max-height: 100%;
  overflow: auto;
}
.ic-dialog header,
.ic-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ic-dialog footer {
  justify-content: flex-end;
  margin-top: 20px;
}
.ic-dialog label {
  display: block;
  margin: 18px 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.ic-dialog label .input {
  display: block;
  width: 100%;
  margin-top: 8px;
}
@media (max-width: 800px) {
  .ic-mask {
    padding: 10px;
  }
  .ic-header,
  .ic-content {
    padding: 18px;
  }
  .ic-tabs {
    padding: 0 14px 14px;
  }
  .ic-tabs button {
    padding: 10px 15px;
  }
  .ic-summary,
  .ic-grid,
  .ic-row-plain {
    flex-wrap: wrap;
    grid-template-columns: minmax(0, 1fr);
  }
  .ic-header h2 {
    font-size: 21px;
  }
  .ic-actions {
    width: 100%;
  }
}
</style>

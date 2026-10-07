<script setup lang="ts">
/**
 * InstancesCreateModal — the "新建实例" dialog, ported from the KAMUCL install sheet
 * (`GameView.vue` -> `.game-install-modal`) and rewired to `mouc.instance.create`.
 *
 * Loader choices come from the real `mouc.loader.options(version)` feed; validation mirrors
 * the main-process name rules so a rejected create never reaches IPC.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { InstanceCreateRequest } from '@shared/ipc'
import type { Account, Instance, LoaderId } from '@shared/types'
import { api, maybe } from '../api/core'
import { asLoaderId, createInstance, suggestedInstanceName, validateInstanceName } from '../api/instances'
import { loaderOptions } from '../api/versions'
import VersionsPicker from './VersionsPicker.vue'

const props = withDefaults(
  defineProps<{
    instances: Instance[]
    installed: string[]
    defaultMemoryMb?: number
  }>(),
  { defaultMemoryMb: 4096 }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', instance: Instance): void
}>()

const name = ref('')
const versionId = ref('')
const description = ref('')
const isolated = ref(true)
const memoryMb = ref(props.defaultMemoryMb)
const accountId = ref('')
const accounts = ref<Account[]>([])

const loader = ref<LoaderId | null>(null)
const loaderVersion = ref('')
const loaderChoices = ref<{ id: LoaderId; label: string; versions: string[] }[]>([])
const loadingLoaders = ref(false)
const loaderError = ref('')

const nameError = ref('')
const error = ref('')
const busy = ref(false)

const loaderVersions = computed(() => loaderChoices.value.find((entry) => entry.id === loader.value)?.versions ?? [])

const canSubmit = computed(
  () =>
    !busy.value &&
    !!versionId.value.trim() &&
    !validateInstanceName(name.value, props.instances) &&
    (loader.value === null || !!loaderVersion.value)
)

/** The create request needs the loader-patched version id, same as the main process expects. */
const effectiveVersionId = computed(() => {
  const base = versionId.value.trim()
  if (!loader.value || !loaderVersion.value) return base
  return `${base}+${loader.value}.${loaderVersion.value}`
})

async function loadAccounts(): Promise<void> {
  accounts.value = await maybe(api().account.list(), [])
}

async function loadLoaders(): Promise<void> {
  const target = versionId.value.trim()
  loaderVersion.value = ''
  loaderChoices.value = []
  loaderError.value = ''
  if (!target) return
  loadingLoaders.value = true
  try {
    const options = await loaderOptions(target)
    loaderChoices.value = options
      .map((option) => {
        const id = asLoaderId(option.id)
        return id
          ? { id, label: option.label, versions: option.versions.map((entry) => entry.version) }
          : null
      })
      .filter((entry): entry is { id: LoaderId; label: string; versions: string[] } => entry !== null)
    if (loader.value) {
      const kept = loaderVersions.value
      loaderVersion.value = kept.includes(loaderVersion.value) ? loaderVersion.value : (kept[0] ?? '')
    }
  } catch (cause: unknown) {
    loaderError.value = cause instanceof Error ? cause.message : '加载器列表获取失败'
  } finally {
    loadingLoaders.value = false
  }
}

function pickLoader(id: LoaderId | null): void {
  loader.value = id
  loaderVersion.value = id ? (loaderVersions.value[0] ?? '') : ''
}

function syncName(): void {
  if (name.value.trim()) return
  name.value = suggestedInstanceName(versionId.value, loader.value)
}

watch(versionId, () => {
  void loadLoaders()
  syncName()
})
watch(loader, syncName)
watch(name, (value) => {
  nameError.value = validateInstanceName(value, props.instances)
})

async function submit(): Promise<void> {
  const invalid = validateInstanceName(name.value, props.instances)
  nameError.value = invalid
  if (invalid || !versionId.value.trim()) return
  busy.value = true
  error.value = ''
  const request: InstanceCreateRequest = {
    name: name.value.trim(),
    versionId: effectiveVersionId.value,
    isolated: isolated.value,
    description: description.value.trim(),
    memoryMb: Number.isFinite(memoryMb.value) ? Math.round(memoryMb.value) : props.defaultMemoryMb
  }
  if (loader.value && loaderVersion.value) {
    request.loader = { id: loader.value, version: loaderVersion.value }
  }
  if (accountId.value) request.accountId = accountId.value
  try {
    const created = await createInstance(request)
    emit('created', created)
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '创建实例失败'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void loadAccounts()
})
</script>

<template>
  <div class="modal-mask" @pointerdown.self="emit('close')">
    <section class="modal instances-create-modal" role="dialog" aria-modal="true" aria-label="新建实例">
      <header class="install-header">
        <h3 class="modal-title">新建实例</h3>
        <button class="icon-btn" aria-label="关闭新建实例窗口" @click="emit('close')">✕</button>
      </header>
      <div class="install-content">
        <p class="modal-label">实例名称</p>
        <input v-model="name" class="input" maxlength="64" placeholder="例如 Fabric 1.21.1 测试场" />
        <p v-if="nameError" class="loaders-error">{{ nameError }}</p>

        <p class="modal-label">游戏版本</p>
        <VersionsPicker v-model="versionId" :installed="installed" placeholder="选择目标 Minecraft 版本" />

        <p class="modal-label">选择模组加载器</p>
        <div v-if="loadingLoaders" class="loaders-loading">
          <span class="spin"></span>
          <span class="muted">正在获取加载器版本列表…</span>
        </div>
        <template v-else>
          <div class="loader-options">
            <button
              class="loader-option"
              :class="{ active: loader === null }"
              :aria-pressed="loader === null"
              :disabled="!versionId"
              @click="pickLoader(null)"
            >
              原版
            </button>
            <button
              v-for="option in loaderChoices"
              :key="option.id"
              class="loader-option"
              :class="{ active: loader === option.id }"
              :aria-pressed="loader === option.id"
              :disabled="!versionId"
              @click="pickLoader(option.id)"
            >
              {{ option.label }}
            </button>
          </div>
          <p v-if="loaderError" class="loaders-error">{{ loaderError }} <button class="btn btn-ghost btn-sm" @click="loadLoaders">重试</button></p>
          <p v-else-if="versionId && !loaderChoices.length" class="muted inst-hint">该版本没有可用的模组加载器，将安装纯净原版。</p>
        </template>

        <template v-if="loader">
          <p class="modal-label">加载器版本</p>
          <select v-if="loaderVersions.length" v-model="loaderVersion" class="select">
            <option v-for="value in loaderVersions" :key="value" :value="value">{{ value }}</option>
          </select>
          <p v-else class="loaders-error">该版本下没有可用的加载器构建。</p>
        </template>

        <p class="modal-label">运行设置</p>
        <label class="check-option">
          <input v-model="isolated" type="checkbox" />
          <span>
            <strong>独立游戏目录</strong>
            <small>模组、存档与配置单独保存，不影响其他实例。</small>
          </span>
        </label>
        <div class="instances-field-row">
          <label class="instances-field">
            <span>内存（MB）</span>
            <input v-model.number="memoryMb" class="input" type="number" min="512" max="32768" step="512" />
          </label>
          <label class="instances-field">
            <span>启动账户</span>
            <select v-model="accountId" class="select">
              <option value="">跟随默认账户</option>
              <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option>
            </select>
          </label>
        </div>

        <p class="modal-label">说明（可选）</p>
        <input v-model="description" class="input" maxlength="120" placeholder="这个实例是用来做什么的" />

        <p v-if="error" class="loaders-error" role="alert">{{ error }}</p>
        <p class="muted inst-hint">创建后会登记为 <span class="mono">{{ effectiveVersionId || '尚未选择版本' }}</span>，运行文件在首次启动或安装时下载。</p>
      </div>
      <footer class="modal-actions install-footer">
        <button class="btn btn-ghost" @click="emit('close')">取消</button>
        <button class="btn btn-gold" :disabled="!canSubmit" @click="submit">{{ busy ? '正在创建…' : '创建实例' }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.instances-create-modal {
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 20px;
}
.install-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 8px;
  flex-shrink: 0;
}
.install-header .modal-title {
  font-size: 24px;
  margin: 0;
}
.install-content {
  padding: 0 24px 20px;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.install-footer {
  padding: 16px 24px;
  margin: 0 !important;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.install-footer .btn {
  min-height: 42px;
  min-width: 116px;
  border-radius: 12px;
}
.modal-label {
  font-size: var(--text-md);
  font-weight: 600;
  margin: 14px 0 4px;
}
.loader-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.loader-option {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 52px;
  border-radius: 14px;
  padding: 10px 6px;
  font-size: var(--text-sm);
  font-family: inherit;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text);
  cursor: pointer;
}
.loader-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 12%, transparent);
}
.loader-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.loaders-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 12px 0;
}
.loaders-error {
  padding: 9px 12px;
  background: var(--danger-soft);
  border-radius: 9px;
  line-height: 1.5;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.instances-field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.instances-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.inst-hint {
  font-size: var(--text-sm);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
@media (max-width: 520px) {
  .install-header {
    padding: 16px;
  }
  .install-content {
    padding: 0 16px 16px;
  }
  .install-footer {
    padding: 12px 16px;
  }
  .loader-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .instances-field-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

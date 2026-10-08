<script setup lang="ts">
/**
 * InstancesModpackModal — 导入 / 导出整合包, the MoucX shape of upstream's
 * InstanceCenter backup & restore sheet.
 *
 * Upstream backs those tabs with its own manifest store; this bridge exposes
 * `instance.exportModpack` / `instance.importModpack`, so "备份" becomes a real mrpack/zip
 * export and "恢复" a real import. File and folder picking go through `mouc.app`.
 *
 * Upstream: KAMUCL (https://github.com/kamubaba-i/KAMUCL), MIT — see /THIRD_PARTY_NOTICES.md.
 */
import { computed, ref } from 'vue'
import type { Instance, ModpackFormat, ModpackManifest } from '@shared/types'
import {
  MODPACK_IMPORT_FORMATS,
  exportInstanceModpack,
  importModpack,
  pickExportFolder,
  pickModpackFile,
  validateInstanceName
} from '../api/instances'
import type { ModpackExportFormat } from '../api/instances'

const props = defineProps<{
  mode: 'import' | 'export'
  /** Only used by the export flow. */
  instance?: Instance | null
  /** Existing instances, for the import name check. */
  instances?: Instance[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', payload: { kind: 'import' | 'export'; manifest?: ModpackManifest }): void
}>()

const file = ref('')
const format = ref<ModpackFormat>('mrpack')
const name = ref('')
const target = ref('')
const exportFormat = ref<ModpackExportFormat>('mrpack')
const busy = ref(false)
const error = ref('')
const nameError = ref('')

const isImport = computed(() => props.mode === 'import')
const title = computed(() => (isImport.value ? '导入整合包' : '导出整合包'))
const canSubmit = computed(() => {
  if (busy.value) return false
  return isImport.value ? !!file.value && !!name.value.trim() && !validateInstanceName(name.value, props.instances ?? []) : !!props.instance && !!target.value
})

function guessFormat(path: string): ModpackFormat {
  if (path.toLowerCase().endsWith('.mrpack')) return 'mrpack'
  if (path.toLowerCase().endsWith('.zip')) return 'zip-multimc'
  return format.value
}

async function chooseFile(): Promise<void> {
  error.value = ''
  try {
    const picked = await pickModpackFile()
    if (!picked) return
    file.value = picked
    format.value = guessFormat(picked)
    if (!name.value.trim()) name.value = picked.split(/[\\/]/).pop()?.replace(/\.(mrpack|zip)$/i, '') ?? ''
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '选择文件失败'
  }
}

async function chooseTarget(): Promise<void> {
  error.value = ''
  try {
    const picked = await pickExportFolder()
    if (picked) target.value = picked
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '选择目录失败'
  }
}

async function submit(): Promise<void> {
  error.value = ''
  if (isImport.value) {
    nameError.value = validateInstanceName(name.value, props.instances ?? [])
    if (nameError.value || !file.value) return
  }
  busy.value = true
  try {
    if (isImport.value) {
      const result = await importModpack({ file: file.value, format: format.value, name: name.value.trim() })
      emit('done', { kind: 'import', manifest: result.manifest })
      return
    }
    if (!props.instance || !target.value) {
      error.value = '请先选择导出位置'
      return
    }
    await exportInstanceModpack(props.instance.id, target.value, exportFormat.value)
    emit('done', { kind: 'export' })
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '操作失败'
  } finally {
    busy.value = false
  }
}

function onNameInput(): void {
  nameError.value = validateInstanceName(name.value, props.instances ?? [])
}
</script>

<template>
  <div class="modal-mask" @pointerdown.self="emit('close')">
    <section class="modal instances-modpack-modal" role="dialog" :aria-label="title">
      <header class="modal-head">
        <h3>{{ title }}</h3>
        <button class="icon-btn" :aria-label="'关闭' + title" @click="emit('close')">✕</button>
      </header>
      <div class="modal-body">
        <template v-if="isImport">
          <p class="modal-desc">选择 .mrpack 或 MultiMC / CurseForge 压缩包，导入为一个独立的新实例。</p>
          <div class="ic-tools">
            <input class="input mono" :value="file" readonly :placeholder="'尚未选择整合包文件'" aria-label="整合包文件路径" />
            <button class="btn btn-ghost" @click="chooseFile">浏览…</button>
          </div>
          <label class="modal-label">整合包格式</label>
          <select v-model="format" class="select">
            <option v-for="option in MODPACK_IMPORT_FORMATS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <label class="modal-label">新实例名称</label>
          <input v-model="name" class="input" maxlength="64" placeholder="例如 卡牌地牢" @input="onNameInput" />
          <p v-if="nameError" class="modal-error">{{ nameError }}</p>
        </template>
        <template v-else>
          <p class="modal-desc">
            把「{{ instance?.name }}」打包导出，用来迁移或分享。导出内容不包含 Java 与可重新下载的公共运行文件。
          </p>
          <label class="modal-label">导出格式</label>
          <div class="instances-export-formats">
            <button
              v-for="option in (['mrpack', 'zip'] as const)"
              :key="option"
              class="loader-option"
              :class="{ active: exportFormat === option }"
              :aria-pressed="exportFormat === option"
              @click="exportFormat = option"
            >
              {{ option === 'mrpack' ? 'Modrinth (.mrpack)' : '压缩包 (.zip)' }}
            </button>
          </div>
          <label class="modal-label">保存位置</label>
          <div class="ic-tools">
            <input class="input mono" :value="target" readonly placeholder="尚未选择目录" aria-label="导出目录" />
            <button class="btn btn-ghost" @click="chooseTarget">浏览…</button>
          </div>
        </template>
        <p v-if="error" class="modal-error" role="alert">{{ error }}</p>
        <p class="muted modal-tip">任务开始后可以在下载面板里查看进度或取消；关闭本窗口不会取消任务。</p>
      </div>
      <footer class="modal-actions">
        <button class="btn btn-ghost" @click="emit('close')">取消</button>
        <button class="btn btn-gold" :disabled="!canSubmit" @click="submit">
          {{ busy ? '正在处理…' : isImport ? '开始导入' : '开始导出' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.instances-modpack-modal {
  width: min(560px, calc(100vw - 32px));
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.modal-head h3 {
  font-size: 22px;
}
.modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modal-desc {
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--text-dim);
}
.modal-label {
  font-size: var(--text-sm);
  font-weight: 600;
  margin-top: 6px;
}
.modal-tip {
  font-size: var(--text-xs);
  line-height: 1.6;
  background: var(--accent-soft);
  padding: 10px 12px;
  border-radius: 10px;
}
.modal-error {
  padding: 9px 12px;
  background: var(--danger-soft);
  border-radius: 9px;
  color: var(--danger);
  font-size: var(--text-sm);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.ic-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ic-tools .input {
  flex: 1;
  min-width: 0;
}
.instances-export-formats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.loader-option {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  border-radius: 12px;
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
}
</style>

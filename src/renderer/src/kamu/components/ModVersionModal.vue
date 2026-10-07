<script setup lang="ts">
/**
 * ModVersionModal — the 「选择文件版本」 sheet, ported from the download modal of KAMUCL
 * `views/CommunityView.vue` together with the version columns of `ModVersionModal.vue` (MIT,
 * (c) 2026 kamubaba-i) — see /THIRD_PARTY_NOTICES.md.
 *
 * Upstream fetched files through `communityFiles()`; this calls `mouc.mod.versions()`, which
 * returns `ProjectVersion[]` each carrying its own `files[]`, so the rows are the files and
 * the version metadata sits beside them. Confirming emits the chosen `ModFile` and leaves the
 * write itself to ModInstallDialog, exactly like upstream's 下载 → 安装 hand-off.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { InstanceSummary, LoaderId, ModFile, ModProject, ProjectKind, ProjectVersion } from '@shared/types'
import CommunityVersionFilter from './CommunityVersionFilter.vue'
import ModsSkeleton from './ModsSkeleton.vue'
import {
  LOADER_TABS,
  errText,
  fileMatchesInstance,
  filesOfVersion,
  formatDate,
  formatSize,
  projectSourceUrl,
  projectVersions,
  requiredDependencies,
  usesLoader
} from '../api/mods'

const props = defineProps<{
  project: ModProject
  kind: ProjectKind
  instances: InstanceSummary[]
  currentInstanceId: string
  gameVersion?: string
  loader?: '' | LoaderId
  versionChoices: string[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'install', payload: { instance: InstanceSummary; file: ModFile; kind: ProjectKind }): void
}>()

const versions = ref<ProjectVersion[]>([])
const files = ref<ModFile[]>([])
const loading = ref(true)
const error = ref('')
const mcVersion = ref(props.gameVersion ?? '')
const loader = ref<'' | LoaderId>(props.loader ?? '')
const fileId = ref('')

let generation = 0
let disposed = false

async function load(): Promise<void> {
  const current = ++generation
  loading.value = true
  error.value = ''
  files.value = []
  fileId.value = ''
  try {
    let list = await projectVersions(props.project.provider, props.project.id, mcVersion.value, loader.value)
    // The backend filters by version/loader itself; when nothing matches a *chosen* filter we
    // retry unfiltered so the sheet still shows what the project publishes.
    if (!list.length && (mcVersion.value || loader.value)) {
      list = await projectVersions(props.project.provider, props.project.id)
    }
    if (disposed || current !== generation) return
    versions.value = list
    files.value = filesOfVersion(list)
    fileId.value = (files.value.find((file) => file.primary) ?? files.value[0])?.versionId ?? ''
    if (!files.value.length) {
      error.value = usesLoader(props.kind)
        ? '当前 Minecraft / Loader 条件下没有文件，可手动调整筛选。'
        : '当前 Minecraft 版本下没有文件，可调整版本筛选。'
    }
  } catch (reason) {
    if (!disposed && current === generation) error.value = `获取文件列表失败：${errText(reason)}`
  } finally {
    if (!disposed && current === generation) loading.value = false
  }
}

const selectedFile = computed<ModFile | null>(() => files.value.find((file) => file.versionId === fileId.value) ?? null)

const dependencies = computed(() => requiredDependencies(selectedFile.value))

/** Upstream `targetOptions`: MOD files only offer instances they actually match. */
const targetOptions = computed(() => {
  const file = selectedFile.value
  if (!file || props.kind !== 'mod') return props.instances
  const matched = props.instances.filter((item) => fileMatchesInstance(file, item))
  return matched.length ? matched : props.instances
})

const instanceId = ref(props.currentInstanceId)

watch(targetOptions, (list) => {
  if (!list.some((item) => item.instance.id === instanceId.value)) {
    const fallback = list.find((item) => item.instance.id === props.currentInstanceId) ?? list[0]
    instanceId.value = fallback?.instance.id ?? ''
  }
})

const target = computed(() => targetOptions.value.find((item) => item.instance.id === instanceId.value) ?? null)

const canConfirm = computed(() => !!selectedFile.value && !loading.value && (!!target.value || props.kind === 'modpack'))

/** `1.21.1 / 1.21.4` — upstream shows at most three game versions per row. */
function versionText(values: string[]): string {
  if (!values.length) return '通用'
  return values.slice(0, 3).join(' / ') + (values.length > 3 ? ` 等 ${values.length} 项` : '')
}

function confirm(): void {
  const file = selectedFile.value
  const instance = target.value
  if (!file || !instance) return
  emit('install', { instance, file, kind: props.kind })
}

function filterChanged(): void {
  void load()
}

onMounted(() => void load())
onBeforeUnmount(() => {
  disposed = true
  generation++
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-mask" @pointerdown.self="emit('close')">
      <section class="modal download-modal" role="dialog" aria-modal="true" :aria-label="`下载 ${project.title}`">
        <h3 class="modal-title" :title="`下载 ${project.title}`">下载 {{ project.title }}</h3>

        <div class="modal-links">
          <a
            v-if="projectSourceUrl(project, kind)"
            class="btn btn-ghost btn-sm"
            :href="projectSourceUrl(project, kind)"
            target="_blank"
            rel="noreferrer"
          >
            {{ project.provider === 'modrinth' ? 'Modrinth 源页面' : 'CurseForge 源页面' }}
          </a>
          <span v-for="category in project.categories.slice(0, 4)" :key="category" class="tag">{{ category }}</span>
        </div>

        <div class="filter-row">
          <label class="modal-field">
            Minecraft 版本
            <CommunityVersionFilter
              v-model="mcVersion"
              :versions="versionChoices"
              @change="filterChanged"
            />
          </label>
          <label v-if="usesLoader(kind)" class="modal-field">
            加载器
            <select v-model="loader" class="select" aria-label="加载器" @change="filterChanged">
              <option v-for="option in LOADER_TABS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
        </div>

        <p class="modal-label">选择文件版本</p>
        <ModsSkeleton v-if="loading" label="正在获取文件列表…" :rows="4" />
        <template v-else>
          <div v-if="files.length" class="file-list">
            <button
              v-for="file in files"
              :key="file.versionId"
              class="file-row"
              :class="{ active: fileId === file.versionId }"
              :aria-pressed="fileId === file.versionId"
              @click="fileId = file.versionId"
            >
              <span class="file-main">
                <span class="file-name" :title="file.fileName">{{ file.fileName }}</span>
                <span class="file-sub">
                  版本 {{ versions.find((v) => v.id === file.versionId)?.versionNumber || file.versionId }} · MC
                  {{ versionText(file.gameVersions) }}<template v-if="usesLoader(kind) && file.loaders.length">
                    · {{ file.loaders.join(' / ') }}</template
                  >
                </span>
              </span>
              <span class="file-side">
                <span class="tag" :class="file.primary ? 'tag-gold' : ''">{{ file.primary ? '主文件' : '备用文件' }}</span>
                <span class="muted file-meta">
                  {{ formatDate(versions.find((v) => v.id === file.versionId)?.datePublished || '') }} ·
                  {{ formatSize(file.size) }}
                </span>
              </span>
            </button>
          </div>
          <p v-if="error" class="files-error" role="alert">{{ error }}</p>
          <p v-if="selectedFile && dependencies.length" class="muted modal-note">
            该文件声明 {{ dependencies.length }} 个必要前置，安装时可一起下载。
          </p>
        </template>

        <template v-if="kind !== 'modpack'">
          <p class="modal-label">下载到实例</p>
          <select v-if="targetOptions.length" v-model="instanceId" class="select" aria-label="下载到实例">
            <option v-for="item in targetOptions" :key="item.instance.id" :value="item.instance.id">
              {{ item.instance.name }} · {{ item.instance.gameVersion }} / {{ item.instance.loader }} ·
              {{ item.instance.isolated ? '独立目录' : '共享目录' }}
            </option>
          </select>
          <p v-else class="files-error">没有已安装实例；可调整文件筛选，或先到实例页创建。</p>
        </template>
        <p v-else class="muted pack-tip">整合包将下载后自动放入临时目录，可在实例页导入</p>

        <div class="modal-actions">
          <button class="btn btn-ghost" @click="emit('close')">取消</button>
          <button class="btn btn-gold" :disabled="!canConfirm" @click="confirm">确认下载</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.download-modal { width: min(740px, calc(100vw - 40px)); max-height: 88vh; overflow-y: auto }
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.modal-links { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center }
.modal-links a { text-decoration: none }
.filter-row { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-4) }
.modal-field { display: grid; flex: 1; min-width: 0; gap: var(--space-1); font-size: var(--text-xs); color: var(--text-dim) }
.modal-label { font-size: var(--text-sm); color: var(--text-dim); margin: var(--space-4) 0 var(--space-2) }
.modal-note { font-size: var(--text-sm); line-height: 1.6; color: var(--text-dim); margin-top: var(--space-3) }
.pack-tip { font-size: var(--text-sm); margin: var(--space-4) 0 0 }
.files-error { font-size: var(--text-sm); color: var(--danger); padding: var(--space-1) 0 }
.file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 280px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-1) var(--space-1) 0;
}
.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, transform 0.16s ease, box-shadow 0.2s ease;
}
.file-row:hover { background: var(--hover); border-color: var(--border-strong); transform: translateY(-1px) }
.file-row.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent), 0 4px 14px var(--accent-soft);
}
.file-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px }
.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
  font-size: var(--text-sm);
  font-family: ui-monospace, Consolas, monospace;
}
.file-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--text-dim) }
.file-side { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 4px }
.file-meta { font-size: var(--text-xs); white-space: nowrap }
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-5);
}
</style>

<script setup lang="ts">
/**
 * Java 运行时页 —— 移植自 KAMUCL `views/SettingsView.vue` 的「Java 运行时」分组与
 * `views/HomeView.vue` 的实例 Java 选择弹窗（MIT），在本项目里独立成一级视图。
 * 视觉全部走 vendored `kamu.css` 的 `.java-*` / `.card` / `.tag` 类名与尺寸令牌。
 *
 * 数据层映射：`mouc.java.*` 提供扫描/下载/删除/解析，按实例固定写入
 * `mouc.instance.update({ id, java })`，全局策略读写 `mouc.settings`。
 * 未移植：upstream 的可取消全盘扫描进度通道与 `hideJava`（本机没有对应后端能力）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import type { InstanceJavaConfig, InstanceSummary, JavaRuntime, JavaSource, Settings } from '@shared/types'
import {
  ARCH_LABELS,
  JAVA_MAJORS,
  JAVA_SOURCE_LABELS,
  listInstances,
  listRuntimes,
  pickJavaExecutable,
  pickScanDir,
  provisionRuntime,
  readJavaSettings,
  removeRuntime,
  resolveRuntime,
  saveJavaSettings,
  scanRuntimes,
  setInstanceJava
} from '../api/java'
import { formatBytes } from '../../composables/format'
import { navigate } from '../../composables/useNav'
import { useModal } from '../../composables/useModal'
import { useToast } from '../../composables/useToast'
import { defineDict, t, type I18nKey } from '../../i18n'

const copy = defineDict({
  backHome: ['返回首页', 'Back to home'],
  title: ['Java 运行时', 'Java runtimes'],
  subtitle: ['扫描本机 Java、按需下载所需主版本，并为单个实例固定运行时', 'Scan this machine, download the majors you need, pin a runtime per instance'],
  policyTitle: ['全局策略', 'Global policy'],
  autoTitle: ['自动匹配并下载所需 Java（推荐）', 'Match and download the required Java automatically (recommended)'],
  autoDesc: [
    '启动时按游戏版本自动选择匹配的 Java；本机没有时自动下载安装。关闭后使用下方手动策略。',
    'Launches pick the matching Java per game version and download it when missing. Turning this off falls back to the manual policy below.'
  ],
  modeLabel: ['策略', 'Policy'],
  customLabel: ['自定义 javaw.exe', 'Custom javaw.exe'],
  notSet: ['未设置', 'Not set'],
  pickFile: ['选择文件', 'Choose file'],
  picking: ['打开中…', 'Opening…'],
  clear: ['清除', 'Clear'],
  scanDirsTitle: ['额外扫描目录（{n}）', 'Extra scan folders ({n})'],
  scanDirsHint: [
    '注册表、PATH 与启动器目录始终会扫描，这里只补充自定义安装位置。',
    'The registry, PATH and launcher folders are always scanned; these folders are added on top.'
  ],
  addDir: ['添加目录', 'Add folder'],
  dirEmpty: ['未配置额外扫描目录。', 'No extra scan folders configured.'],
  dirDuplicate: ['该目录已在扫描列表中', 'That folder is already in the scan list'],
  scanHint: [
    '扫描注册表、PATH、启动器下载目录与额外目录；异常运行时保留并标注原因。',
    'Scans the registry, PATH, launcher download folders and the extra ones; broken runtimes stay listed with the reason.'
  ],
  rescan: ['重新扫描', 'Scan again'],
  scanning: ['正在扫描…', 'Scanning…'],
  detecting: ['正在检测本机 Java…', 'Detecting local Java…'],
  scanFailed: ['Java 检测失败：{error}', 'Java detection failed: {error}'],
  scanEmpty: [
    '未检测到本机 Java，可继续扫描，或在下方按需下载一个主版本。',
    'No local Java detected. Scan again, or download a major below.'
  ],
  identified: ['已识别 {n} 个 · 可用 {usable} 个', '{n} found · {usable} usable'],
  byMajor: ['按主版本排序', 'Sorted by major'],
  brokenTag: ['不可用', 'Unusable'],
  readyTag: ['可用', 'Usable'],
  majorLabel: ['主版本', 'Major'],
  readySuffix: ['（已就绪）', ' (ready)'],
  imageLabel: ['镜像', 'Image'],
  imageJre: ['JRE（更小）', 'JRE (smaller)'],
  imageJdk: ['JDK（含编译工具）', 'JDK (with compilers)'],
  downloading: ['正在下载…', 'Downloading…'],
  instancesTitle: ['实例运行时解析（{n}）', 'Per-instance resolution ({n})'],
  instancesHint: [
    '每个实例可单独固定运行时；「需要下载」表示该主版本本机尚无可用运行时。',
    'Each instance can pin its own runtime; “needs download” means no usable runtime for that major yet.'
  ],
  resolving: ['正在解析实例运行时…', 'Resolving instance runtimes…'],
  resolveFailed: ['解析实例 Java 失败：{error}', 'Could not resolve instance Java: {error}'],
  instancesEmpty: ['还没有实例，先在实例页创建一个。', 'No instances yet — create one from the instances view.'],
  instancesHeader: ['实例', 'Instance'],
  requirementHeader: ['需求 / 命中', 'Required / resolved'],
  requires: ['需 {major}', 'Needs {major}'],
  requiresUnknown: ['需 Java ?', 'Needs Java ?'],
  resolve: ['需要下载', 'Needs download'],
  chooseJava: ['选择 Java', 'Choose Java'],
  pinnedAuto: ['自动', 'Auto'],
  pinnedMajor: ['已固定 Java {major}', 'Pinned Java {major}'],
  pinnedCustom: ['已固定自定义路径', 'Pinned custom path'],
  pickerTitle: ['选择 Java 运行环境', 'Choose a Java runtime'],
  pickerDesc: ['{name} · 仅修改此实例，不影响其他实例', '{name} · this instance only'],
  optionAuto: ['自动选择', 'Automatic'],
  optionAutoDesc: ['按游戏的真实版本要求匹配 Java，必要时自动下载', 'Match the version the game really needs, download it if missing'],
  optionCustom: ['自定义路径', 'Custom path'],
  customPlaceholder: ['粘贴 javaw.exe 完整路径，或点右侧选择', 'Paste a full javaw.exe path, or choose it'],
  pickerEmpty: [
    '未发现可用本地 Java，可使用自动选择，或先在本页下载一个主版本。',
    'No usable local Java. Keep it automatic, or download a major on this page first.'
  ],
  saveChoice: ['保存选择', 'Save choice'],
  saving: ['保存中…', 'Saving…'],
  confirmRemoveTitle: ['删除 Java 运行时', 'Delete Java runtime'],
  confirmRemoveText: [
    '删除 Java {major}（{vendor}）的下载目录？本机自动发现的运行时只会从列表移除记录。',
    'Delete the download folder for Java {major} ({vendor})? Runtimes discovered on this machine are only unlisted.'
  ],
  removedToast: ['已删除 Java {major}', 'Java {major} deleted'],
  removeFailed: ['删除失败：{error}', 'Could not delete: {error}'],
  scanDone: ['Java 扫描完成，共 {n} 个', 'Java scan finished — {n} found'],
  scanFailedToast: ['扫描失败：{error}', 'Scan failed: {error}'],
  fromCache: ['Java {major} 已在本地缓存，无需下载', 'Java {major} was already cached'],
  downloaded: ['已下载 Java {major}（{size}）', 'Downloaded Java {major} ({size})'],
  provisionFailed: ['下载 Java {major} 失败：{error}', 'Could not download Java {major}: {error}'],
  policySaved: ['Java 策略已切换为「{label}」', 'Java policy switched to “{label}”'],
  autoOn: ['已开启自动匹配', 'Automatic matching enabled'],
  autoOff: ['已切换为手动策略', 'Fell back to the manual policy'],
  customSaved: ['已固定自定义 Java 路径', 'Custom Java path pinned'],
  customCleared: ['已清除自定义 Java 路径', 'Custom Java path cleared'],
  dirAdded: ['已添加 Java 扫描目录', 'Scan folder added'],
  dirRemoved: ['已移除扫描目录', 'Scan folder removed'],
  saveFailed: ['保存失败：{error}', 'Could not save: {error}'],
  readFailed: ['读取 Java 设置失败：{error}', 'Could not read the Java settings: {error}'],
  pickFailed: ['选择 Java 失败：{error}', 'Could not pick Java: {error}'],
  instanceSaved: ['已更新 {name} 的 Java 设置', 'Java settings updated for {name}'],
  noRuntimeReady: ['所选运行时尚未就绪，请重新扫描', 'That runtime is not listed any more — scan again'],
  customPathMissing: ['请先选择自定义 javaw.exe 路径', 'Pick the custom javaw.exe path first']
})

const MODE_LABEL_KEYS: Record<Settings['javaMode'], I18nKey> = {
  auto: 'java.mode.auto',
  'mojang-component': 'java.mode.mojang',
  adoptium: 'java.mode.adoptium',
  custom: 'java.mode.custom'
}
const MODE_ORDER: Settings['javaMode'][] = ['auto', 'mojang-component', 'adoptium', 'custom']

const toasts = useToast()
const modal = useModal()

type ToastKind = 'info' | 'success' | 'warning' | 'danger'
function toast(title: string, kind: ToastKind = 'info'): void {
  toasts.push({ kind, title })
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ---------------- 全局策略 ----------------
const settings = ref<Settings | null>(null)
const settingsError = ref('')
const savingMode = ref(false)

const javaMode = computed<Settings['javaMode']>(() => settings.value?.javaMode ?? 'auto')
const customJavaPath = computed(() => settings.value?.customJavaPath ?? '')
const javaScanDirs = computed<string[]>(() => settings.value?.javaScanDirs ?? [])

/** Locale-reactive hint under the policy select; labels themselves come from `java.mode.*`. */
const modeHints = defineDict({
  auto: ['按游戏版本的 java_version 要求选择运行时，缺失时自动下载', 'Follow the manifest java_version requirement and download what is missing'],
  'mojang-component': ['只使用 Mojang 发布的 java-runtime 组件', 'Only the java-runtime components Mojang publishes'],
  adoptium: ['优先 Adoptium 发行版，其次本机已发现的运行时', 'Prefer Adoptium, otherwise any runtime found locally'],
  custom: ['始终使用下方手动指定的 javaw.exe', 'Always launch with the javaw.exe picked below']
})

const modeLabel = (value: Settings['javaMode']): string => t(MODE_LABEL_KEYS[value])
const activeModeHint = computed(() => modeHints.text(javaMode.value))

async function loadSettings(): Promise<void> {
  settingsError.value = ''
  try {
    settings.value = await readJavaSettings()
  } catch (e) {
    settingsError.value = errorText(e)
    toast(copy.text('readFailed', { error: settingsError.value }), 'danger')
  }
}

async function saveSettings(patch: Partial<Settings>, announce: string): Promise<void> {
  savingMode.value = true
  try {
    settings.value = await saveJavaSettings(patch)
    toast(announce, 'success')
  } catch (e) {
    toast(copy.text('saveFailed', { error: errorText(e) }), 'danger')
  } finally {
    savingMode.value = false
  }
}

async function onModeChange(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value as Settings['javaMode']
  await saveSettings({ javaMode: value }, copy.text('policySaved', { label: modeLabel(value) }))
}

async function onAutoChange(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  // 关闭「自动」等价于回落到具体策略：有自定义路径就固定它，否则优先 Temurin。
  const fallback: Settings['javaMode'] = customJavaPath.value ? 'custom' : 'adoptium'
  await saveSettings({ javaMode: checked ? 'auto' : fallback }, checked ? copy.text('autoOn') : copy.text('autoOff'))
}

async function chooseCustomJava(): Promise<void> {
  try {
    const picked = await pickJavaExecutable()
    if (!picked) return
    await saveSettings({ customJavaPath: picked, javaMode: 'custom' }, copy.text('customSaved'))
  } catch (e) {
    toast(copy.text('pickFailed', { error: errorText(e) }), 'danger')
  }
}

async function clearCustomJava(): Promise<void> {
  await saveSettings({ customJavaPath: '' }, copy.text('customCleared'))
}

async function addScanDir(): Promise<void> {
  try {
    const dir = await pickScanDir()
    if (!dir) return
    if (javaScanDirs.value.includes(dir)) {
      toast(copy.text('dirDuplicate'), 'warning')
      return
    }
    await saveSettings({ javaScanDirs: [...javaScanDirs.value, dir] }, copy.text('dirAdded'))
  } catch (e) {
    toast(copy.text('pickFailed', { error: errorText(e) }), 'danger')
  }
}

async function removeScanDir(dir: string): Promise<void> {
  await saveSettings(
    { javaScanDirs: javaScanDirs.value.filter((entry) => entry !== dir) },
    copy.text('dirRemoved')
  )
}

// ---------------- 本机运行时 ----------------
const runtimes = ref<JavaRuntime[]>([])
const runtimeLoading = ref(true)
const runtimeError = ref('')
const scanning = ref(false)
const removingId = ref<string | null>(null)

const usableRuntimes = computed(() => runtimes.value.filter((item) => !item.broken))

async function loadRuntimes(): Promise<void> {
  runtimeLoading.value = true
  runtimeError.value = ''
  try {
    runtimes.value = await listRuntimes()
  } catch (e) {
    runtimeError.value = errorText(e)
  } finally {
    runtimeLoading.value = false
  }
}

async function onScan(): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  runtimeError.value = ''
  try {
    runtimes.value = await scanRuntimes()
    toast(copy.text('scanDone', { n: runtimes.value.length }), 'success')
  } catch (e) {
    runtimeError.value = errorText(e)
    toast(copy.text('scanFailedToast', { error: runtimeError.value }), 'danger')
  } finally {
    scanning.value = false
  }
}

async function onRemoveRuntime(runtime: JavaRuntime): Promise<void> {
  const confirmed = await modal.confirm({
    title: copy.text('confirmRemoveTitle'),
    text: copy.text('confirmRemoveText', { major: runtime.major, vendor: runtime.vendor }),
    tone: 'danger'
  })
  if (!confirmed) return
  removingId.value = runtime.id
  try {
    await removeRuntime(runtime.id)
    runtimes.value = await listRuntimes()
    toast(copy.text('removedToast', { major: runtime.major }), 'success')
    void resolveInstances()
  } catch (e) {
    toast(copy.text('removeFailed', { error: errorText(e) }), 'danger')
  } finally {
    removingId.value = null
  }
}

const sourceLabel = (source: JavaSource): string => JAVA_SOURCE_LABELS[source]
const archLabel = (runtime: JavaRuntime): string => ARCH_LABELS[runtime.arch]

function runtimeTitle(runtime: JavaRuntime): string {
  const parts = [runtime.vendor || t('java.vendor'), archLabel(runtime), sourceLabel(runtime.source)]
  if (runtime.broken) parts.push(t('java.broken', { reason: runtime.broken }))
  return `${parts.join(' · ')}\n${runtime.path}`
}

// ---------------- 按需下载 ----------------
const download = reactive({ major: 21, imageType: 'jre' as 'jre' | 'jdk', busy: false })
const hasMajor = (major: number): boolean =>
  runtimes.value.some((item) => item.major === major && !item.broken)

async function onProvision(): Promise<void> {
  if (download.busy) return
  download.busy = true
  try {
    const result = await provisionRuntime(download.major, download.imageType)
    runtimes.value = await listRuntimes()
    toast(
      result.fromCache
        ? copy.text('fromCache', { major: result.runtime.major })
        : copy.text('downloaded', { major: result.runtime.major, size: formatBytes(result.downloadedBytes) }),
      'success'
    )
    void resolveInstances()
  } catch (e) {
    toast(copy.text('provisionFailed', { major: download.major, error: errorText(e) }), 'danger')
  } finally {
    download.busy = false
  }
}

// ---------------- 实例解析与固定 ----------------
interface InstanceRow {
  summary: InstanceSummary
  major: number
  runtime: JavaRuntime | null
}

const instances = ref<InstanceRow[]>([])
const instanceLoading = ref(true)
const instanceError = ref('')

async function loadInstances(): Promise<void> {
  instanceLoading.value = true
  instanceError.value = ''
  try {
    const summaries = await listInstances()
    instances.value = summaries.map((summary) => ({
      summary,
      major: summary.instance.java.major ?? 0,
      runtime: null as JavaRuntime | null
    }))
  } catch (e) {
    instanceError.value = errorText(e)
    instances.value = []
    toast(copy.text('resolveFailed', { error: instanceError.value }), 'danger')
  } finally {
    instanceLoading.value = false
  }
  await resolveInstances()
}

/** `java.resolve` is per instance, so one bad instance cannot blank the whole table. */
async function resolveInstances(): Promise<void> {
  const failures: string[] = []
  for (const row of instances.value) {
    try {
      const resolved = await resolveRuntime(row.summary.instance.id)
      row.major = resolved.major
      row.runtime = resolved.runtime
    } catch (e) {
      failures.push(`${row.summary.instance.name}: ${errorText(e)}`)
    }
  }
  if (!failures.length) return
  instanceError.value = failures.join('；')
  toast(copy.text('resolveFailed', { error: instanceError.value }), 'danger')
}

function pinLabel(row: InstanceRow): string {
  const java = row.summary.instance.java
  if (java.mode === 'pinned') return copy.text('pinnedMajor', { major: java.major ?? t('common.unknown') })
  if (java.mode === 'custom') return copy.text('pinnedCustom')
  return copy.text('pinnedAuto')
}

// ---------------- 固定弹窗（upstream HomeView java-picker） ----------------
const picker = reactive({
  open: false,
  instanceId: '',
  choice: '@auto',
  customPath: '',
  saving: false,
  busy: false
})

const pickerRow = computed(() => instances.value.find((row) => row.summary.instance.id === picker.instanceId) ?? null)

function openPicker(row: InstanceRow): void {
  const java = row.summary.instance.java
  const pinned = runtimes.value.find((item) => item.executable === java.path)
  Object.assign(picker, {
    open: true,
    instanceId: row.summary.instance.id,
    choice: java.mode === 'auto' ? '@auto' : pinned ? pinned.id : '@custom',
    customPath: java.mode === 'auto' ? '' : (java.path ?? ''),
    saving: false,
    busy: false
  })
}

async function pickCustomForInstance(): Promise<void> {
  picker.busy = true
  try {
    const picked = await pickJavaExecutable()
    if (picked) {
      picker.customPath = picked
      picker.choice = '@custom'
    }
  } catch (e) {
    toast(copy.text('pickFailed', { error: errorText(e) }), 'danger')
  } finally {
    picker.busy = false
  }
}

async function confirmPicker(): Promise<void> {
  const row = pickerRow.value
  if (!row || picker.saving) return
  let config: InstanceJavaConfig
  if (picker.choice === '@auto') {
    config = { mode: 'auto' }
  } else if (picker.choice === '@custom') {
    if (!picker.customPath) {
      toast(copy.text('customPathMissing'), 'warning')
      return
    }
    config = { mode: 'custom', path: picker.customPath }
  } else {
    const runtime = runtimes.value.find((item) => item.id === picker.choice)
    if (!runtime) {
      toast(copy.text('noRuntimeReady'), 'warning')
      return
    }
    config = { mode: 'pinned', path: runtime.executable, major: runtime.major }
  }
  picker.saving = true
  try {
    const updated = await setInstanceJava(row.summary.instance, config)
    row.summary = { ...row.summary, instance: updated }
    picker.open = false
    toast(copy.text('instanceSaved', { name: updated.name }), 'success')
    const resolved = await resolveRuntime(updated.id)
    row.major = resolved.major
    row.runtime = resolved.runtime
  } catch (e) {
    toast(copy.text('saveFailed', { error: errorText(e) }), 'danger')
  } finally {
    picker.saving = false
  }
}

function goHome(): void {
  window.location.hash = '#view=home'
  navigate('home')
}

onMounted(() => {
  void loadSettings()
  void loadRuntimes()
  void loadInstances()
})
</script>

<template>
  <div class="page">
    <div class="acc-top">
      <button class="back-btn" type="button" @click="goHome">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </svg>
        {{ copy.text('backHome') }}
      </button>
      <div class="page-head">
        <h1 class="page-title">{{ copy.text('title') }}</h1>
        <p class="page-sub">{{ copy.text('subtitle') }}</p>
      </div>
    </div>

    <!-- 全局策略 -->
    <div class="card">
      <h3 class="section-title">{{ copy.text('policyTitle') }}</h3>
      <p v-if="settingsError" class="group-error">{{ copy.text('readFailed', { error: settingsError }) }}</p>

      <label class="java-auto-row">
        <span class="java-auto-text">
          <span class="java-auto-title">{{ copy.text('autoTitle') }}</span>
          <span class="muted java-auto-desc">{{ copy.text('autoDesc') }}</span>
        </span>
        <span class="switch">
          <input type="checkbox" :checked="javaMode === 'auto'" :disabled="savingMode" @change="onAutoChange" />
          <span class="switch-ui"></span>
        </span>
      </label>

      <div class="runtime-grid">
        <label class="field">
          <span>{{ copy.text('modeLabel') }}</span>
          <select class="select" :value="javaMode" :disabled="savingMode" @change="onModeChange">
            <option v-for="value in MODE_ORDER" :key="value" :value="value">{{ modeLabel(value) }}</option>
          </select>
          <span class="muted field-hint">{{ activeModeHint }}</span>
        </label>

        <div class="field">
          <span class="field-label">{{ copy.text('customLabel') }}</span>
          <div class="entry-row">
            <input class="input mono" :value="customJavaPath || copy.text('notSet')" readonly />
            <button class="btn btn-ghost" type="button" :disabled="savingMode" @click="chooseCustomJava">
              {{ copy.text('pickFile') }}
            </button>
            <button v-if="customJavaPath" class="btn btn-danger btn-sm" type="button" :disabled="savingMode" @click="clearCustomJava">
              {{ copy.text('clear') }}
            </button>
          </div>
        </div>
      </div>

      <div class="provider-head">
        <div>
          <strong>{{ copy.text('scanDirsTitle', { n: javaScanDirs.length }) }}</strong>
          <p class="muted group-hint">{{ copy.text('scanDirsHint') }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="savingMode" @click="addScanDir">
          {{ copy.text('addDir') }}
        </button>
      </div>
      <div v-if="javaScanDirs.length" class="provider-list">
        <div v-for="dir in javaScanDirs" :key="dir" class="provider-item">
          <p class="muted provider-url" :title="dir">{{ dir }}</p>
          <button class="btn btn-danger btn-sm" type="button" :disabled="savingMode" @click="removeScanDir(dir)">
            {{ t('java.remove') }}
          </button>
        </div>
      </div>
      <div v-else class="provider-empty">{{ copy.text('dirEmpty') }}</div>
    </div>

    <!-- 本机运行时 -->
    <div class="card">
      <div class="provider-head">
        <div>
          <h3 class="section-title">{{ t('java.runtimes') }}（{{ runtimes.length }}）</h3>
          <p class="muted group-hint">{{ copy.text('scanHint') }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="scanning" @click="onScan">
          <span v-if="scanning" class="spin"></span>
          {{ scanning ? copy.text('scanning') : copy.text('rescan') }}
        </button>
      </div>

      <div v-if="runtimeLoading" class="java-loading">
        <span class="spin"></span>
        <span class="muted">{{ copy.text('detecting') }}</span>
      </div>

      <div v-else-if="runtimeError" class="list-error" role="alert">
        <span>{{ copy.text('scanFailed', { error: runtimeError }) }}</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="loadRuntimes">{{ t('common.retry') }}</button>
      </div>

      <div v-else-if="!runtimes.length" class="provider-empty">{{ copy.text('scanEmpty') }}</div>

      <div v-else class="java-list">
        <div class="java-list-head">
          <span class="muted">{{ copy.text('identified', { n: runtimes.length, usable: usableRuntimes.length }) }}</span>
          <span class="muted">{{ copy.text('byMajor') }}</span>
        </div>
        <div v-for="runtime in runtimes" :key="runtime.id" class="java-item">
          <span class="tag" :class="runtime.source === 'manual' ? 'tag-accent' : ''">
            {{ sourceLabel(runtime.source) }}
          </span>
          <span class="java-item-ver">{{ t('java.major', { major: runtime.major }) }}</span>
          <span v-if="runtime.broken" class="tag tag-danger" :title="t('java.broken', { reason: runtime.broken })">
            {{ copy.text('brokenTag') }}
          </span>
          <span v-else class="tag tag-success">{{ copy.text('readyTag') }}</span>
          <span class="muted java-item-path" :title="runtimeTitle(runtime)">
            {{ runtime.vendor || t('java.vendor') }} · {{ archLabel(runtime) }} · {{ runtime.path }}
          </span>
          <button class="btn btn-danger btn-sm" type="button" :disabled="removingId === runtime.id" @click="onRemoveRuntime(runtime)">
            {{ t('java.remove') }}
          </button>
        </div>
      </div>

      <div class="download-row">
        <label class="field inline">
          <span>{{ copy.text('majorLabel') }}</span>
          <select v-model.number="download.major" class="select">
            <option v-for="major in JAVA_MAJORS" :key="major" :value="major">
              {{ t('java.major', { major }) }}{{ hasMajor(major) ? copy.text('readySuffix') : '' }}
            </option>
          </select>
        </label>
        <label class="field inline">
          <span>{{ copy.text('imageLabel') }}</span>
          <select v-model="download.imageType" class="select">
            <option value="jre">{{ copy.text('imageJre') }}</option>
            <option value="jdk">{{ copy.text('imageJdk') }}</option>
          </select>
        </label>
        <button class="btn btn-gold download-btn" type="button" :disabled="download.busy" @click="onProvision">
          <span v-if="download.busy" class="spin"></span>
          {{ download.busy ? copy.text('downloading') : t('java.provision', { major: download.major }) }}
        </button>
      </div>
    </div>

    <!-- 实例解析 -->
    <div class="card">
      <div class="provider-head">
        <div>
          <h3 class="section-title">{{ copy.text('instancesTitle', { n: instances.length }) }}</h3>
          <p class="muted group-hint">{{ copy.text('instancesHint') }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="instanceLoading" @click="loadInstances">
          <span v-if="instanceLoading" class="spin"></span>
          {{ t('common.refresh') }}
        </button>
      </div>

      <div v-if="instanceLoading" class="java-loading">
        <span class="spin"></span>
        <span class="muted">{{ copy.text('resolving') }}</span>
      </div>

      <div v-else-if="!instances.length" class="list-error" role="alert">
        <span>{{ instanceError || copy.text('instancesEmpty') }}</span>
        <button v-if="instanceError" class="btn btn-ghost btn-sm" type="button" @click="loadInstances">
          {{ t('common.retry') }}
        </button>
      </div>

      <div v-else class="java-list">
        <div class="java-list-head">
          <span class="muted">{{ copy.text('instancesHeader') }}</span>
          <span class="muted">{{ copy.text('requirementHeader') }}</span>
        </div>
        <div v-for="row in instances" :key="row.summary.instance.id" class="java-item">
          <div class="instance-cell">
            <strong class="instance-name">{{ row.summary.instance.name }}</strong>
            <span class="muted instance-sub">{{ row.summary.instance.gameVersion }}</span>
          </div>
          <span class="tag" :class="row.summary.instance.java.mode === 'auto' ? '' : 'tag-accent'">
            {{ pinLabel(row) }}
          </span>
          <span class="instance-require">{{ row.major ? copy.text('requires', { major: row.major }) : copy.text('requiresUnknown') }}</span>
          <span v-if="row.runtime" class="muted java-item-path" :title="row.runtime.executable">
            {{ row.runtime.vendor }} · {{ row.runtime.path }}
          </span>
          <span v-else class="tag tag-danger">{{ copy.text('resolve') }}</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="openPicker(row)">{{ copy.text('chooseJava') }}</button>
        </div>
      </div>
      <p v-if="instanceError && instances.length" class="group-error">{{ instanceError }}</p>
    </div>

    <!-- 固定运行时弹窗：upstream HomeView java-picker -->
    <Teleport to="body">
      <div
        v-if="picker.open"
        class="modal-mask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="java-picker-title"
        @pointerdown.self="!picker.saving && (picker.open = false)"
      >
        <section class="modal java-picker">
          <h3 id="java-picker-title" class="modal-title">{{ copy.text('pickerTitle') }}</h3>
          <p class="java-picker-description">
            {{ copy.text('pickerDesc', { name: pickerRow?.summary.instance.name ?? '' }) }}
          </p>

          <label class="java-option">
            <input v-model="picker.choice" type="radio" value="@auto" name="java-picker" />
            <span><strong>{{ copy.text('optionAuto') }}</strong><small>{{ copy.text('optionAutoDesc') }}</small></span>
          </label>

          <div class="java-options">
            <label v-for="runtime in usableRuntimes" :key="runtime.id" class="java-option">
              <input v-model="picker.choice" type="radio" :value="runtime.id" name="java-picker" />
              <span>
                <strong>
                  {{ t('java.major', { major: runtime.major }) }} · {{ runtime.vendor }} · {{ archLabel(runtime) }}
                </strong>
                <small :title="runtime.path">{{ runtime.path }}</small>
              </span>
            </label>
            <p v-if="!usableRuntimes.length" class="java-picker-description">{{ copy.text('pickerEmpty') }}</p>
          </div>

          <label class="java-option">
            <input v-model="picker.choice" type="radio" value="@custom" name="java-picker" />
            <span class="java-option-custom">
              <strong>{{ copy.text('optionCustom') }}</strong>
              <span class="entry-row">
                <input
                  v-model="picker.customPath"
                  class="input mono"
                  :placeholder="copy.text('customPlaceholder')"
                  spellcheck="false"
                  @focus="picker.choice = '@custom'"
                />
                <button class="btn btn-ghost btn-sm" type="button" :disabled="picker.busy" @click="pickCustomForInstance">
                  {{ picker.busy ? copy.text('picking') : copy.text('pickFile') }}
                </button>
              </span>
            </span>
          </label>

          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" :disabled="picker.saving" @click="picker.open = false">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-gold" type="button" :disabled="picker.saving" @click="confirmPicker">
              {{ picker.saving ? copy.text('saving') : copy.text('saveChoice') }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sec-gap);
  max-width: 880px;
  margin: 0 auto;
}

.acc-top {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  align-self: flex-start;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.back-btn:hover {
  background: var(--card-2);
  color: var(--accent-2);
}
.back-btn svg {
  width: 15px;
  height: 15px;
}

.section-title {
  font-size: var(--text-sm);
  font-weight: 700;
  margin: 0 0 var(--space-3);
  line-height: 1.5;
}
.card > * + * {
  margin-top: var(--space-3);
}
.card > .section-title,
.card > .provider-head + * {
  margin-top: 0;
}
.provider-head .section-title {
  margin: 0 0 var(--space-1);
}
.group-hint {
  font-size: var(--text-xs);
  margin: 0;
  line-height: 1.6;
}
.group-error {
  font-size: var(--text-xs);
  margin: 0;
  color: var(--danger);
  line-height: 1.5;
}

/* 全局策略 */
.java-auto-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  cursor: pointer;
}
.java-auto-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.java-auto-title {
  font-size: var(--text-sm);
  font-weight: 600;
}
.java-auto-desc {
  font-size: var(--text-xs);
  line-height: 1.6;
}
.runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  align-items: start;
}
.field {
  display: grid;
  gap: var(--space-2);
  color: var(--text-dim);
  font-size: var(--text-xs);
  min-width: 0;
}
.field > span,
.field-label {
  font-weight: 600;
}
.field-hint {
  line-height: 1.6;
}
.field.inline {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
}
.entry-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.entry-row .input {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
}

/* 扫描目录 */
.provider-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
}
.provider-head strong {
  font-size: var(--text-sm);
}
.provider-list {
  display: grid;
  gap: var(--space-2);
}
.provider-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.provider-url {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--text-xs) 'Cascadia Code', Consolas, monospace;
}
.provider-empty {
  padding: var(--space-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: var(--text-xs);
  text-align: center;
}

/* Java 列表 */
.java-list {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.java-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--card-2);
  font-size: var(--text-xs);
}
.java-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}
.java-item-ver {
  font-weight: 600;
  flex-shrink: 0;
}
.java-item-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--text-xs);
}
.java-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  font-size: var(--text-sm);
}
.list-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-md);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-sm);
}

/* 按需下载 */
.download-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.download-btn {
  flex-shrink: 0;
}

/* 实例解析 */
.instance-cell {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  flex: 0 0 210px;
}
.instance-name {
  font-size: var(--text-sm);
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.instance-sub {
  font-size: var(--text-xs);
  font-family: 'Cascadia Code', Consolas, monospace;
  flex-shrink: 0;
}
.instance-require {
  font-size: var(--text-xs);
  color: var(--text-dim);
  flex-shrink: 0;
}

/* 固定弹窗 */
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-3);
}
.java-picker {
  width: min(580px, calc(100vw - 40px));
}
.java-picker-description {
  color: var(--text-dim);
  font-size: var(--text-xs);
  margin: 0 0 var(--space-4);
  overflow-wrap: anywhere;
}
.java-options {
  display: grid;
  gap: var(--space-2);
  max-height: 32vh;
  overflow: auto;
  margin: var(--space-2) 0;
}
.java-option {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: 13px;
  margin-bottom: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.java-option:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.java-option input {
  accent-color: var(--accent);
  flex: none;
}
.java-option > span {
  min-width: 0;
}
.java-option strong,
.java-option small {
  display: block;
}
.java-option strong {
  font-size: var(--text-sm);
}
.java-option small {
  margin-top: 5px;
  font-size: var(--text-xs);
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.java-option-custom {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
}

@media (max-width: 760px) {
  .runtime-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .instance-cell {
    flex-basis: 120px;
  }
}
</style>

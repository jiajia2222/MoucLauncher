<script setup lang="ts">
/**
 * HomeView — the launch screen.
 *
 * One instance is "current" (persisted by the instance store); everything else on this page
 * hangs off it: the account that will launch it, the Java runtime that resolves for it, the
 * live download jobs it may still need, and the crash analysis of its last exit.
 * All values come from `window.mouc` — no fixture text, no assumed shapes.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { Account, GameLogLine, GameProcessInfo, JavaRuntime, LaunchPlan } from '@shared/types'
import { navigate } from '../composables/useNav'
import { formatBytes, formatClock, formatDuration, formatEta, formatRelative } from '../composables/format'
import { useToast } from '../composables/useToast'
import { useModal } from '../composables/useModal'
import { defineDict, t, type I18nKey } from '../i18n'
import { badgeFor, iconFor, loaderLabel, useInstances } from '../stores/useInstances'
import { useLauncher } from '../stores/useLauncher'
import { useVersions } from '../stores/useVersions'
import type { SelectOption } from '../components/ui/types'
import MIcon from '../components/icons/MIcon.vue'
import MButton from '../components/ui/MButton.vue'
import MCard from '../components/ui/MCard.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MProgress from '../components/ui/MProgress.vue'
import MSelect from '../components/ui/MSelect.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MTag from '../components/ui/MTag.vue'
import MTooltip from '../components/ui/MTooltip.vue'
import MModal from '../components/ui/MModal.vue'

const homeText = defineDict({
  intoServer: ['启动并进入服务器', 'Launch into server'],
  noServer: ['该实例没有配置服务器地址，可在「实例 → 设置 → 服务器」里添加。', 'This instance has no server target. Add one under Instances → Settings.'],
  viewLog: ['查看日志', 'View log'],
  previewTitle: ['启动参数预览', 'Launch command preview'],
  previewFailed: ['无法生成启动参数', 'Could not build the launch plan'],
  logsFailed: ['读取日志失败', 'Could not read the log'],
  copyLog: ['复制全部日志', 'Copy all logs'],
  copied: ['已复制到剪贴板', 'Copied to the clipboard'],
  copyFailed: ['复制失败', 'Copy failed'],
  commandLine: ['完整命令行', 'Full command line'],
  gameArgs: ['游戏参数', 'Game arguments'],
  classpath: ['类路径', 'Classpath'],
  runtime: ['运行时 / 目录', 'Runtime / folders'],
  jobs: ['下载任务', 'Download jobs'],
  jobsEmpty: ['当前没有下载任务。', 'No downloads in flight.'],
  jobHistory: ['最近完成', 'Recently finished'],
  clearHistory: ['清理记录', 'Clear history'],
  switchFailed: ['切换账户失败', 'Could not switch account'],
  javaReady: ['Java {major} 已就绪', 'Java {major} is ready'],
  javaProvisionFailed: ['下载 Java 失败', 'Could not download Java'],
  javaNone: ['未解析', 'Not resolved'],
  checkVersion: ['版本文件', 'Version files'],
  checkJava: ['Java 运行时', 'Java runtime'],
  checkAccount: ['启动账户', 'Launch account'],
  accountsFailed: ['读取账户失败', 'Could not load accounts'],
  files: ['{done} / {total} 个文件', '{done} / {total} files'],
  runningFor: ['已运行 {time}', 'Running {time}']
})

const SEVERITY_KEYS: Record<'info' | 'warning' | 'critical', I18nKey> = {
  info: 'crash.severity.info',
  warning: 'crash.severity.warning',
  critical: 'crash.severity.critical'
}

const LEVEL_TONES: Record<GameLogLine['level'], 'neutral' | 'accent' | 'warning' | 'danger'> = {
  system: 'accent',
  info: 'neutral',
  warn: 'warning',
  error: 'danger'
}

const launcher = useLauncher()
const instances = useInstances()
const versions = useVersions()
const toast = useToast()
const modal = useModal()

const accounts = ref<Account[]>([])
const accountsError = ref('')
const java = ref<{ runtime: JavaRuntime | null; major: number } | null>(null)
const javaError = ref('')
const provisioning = ref(false)
const repairing = ref(false)

const logOpen = ref(false)
const logs = ref<GameLogLine[]>([])
const logsLoading = ref(false)
const logsError = ref('')

const previewOpen = ref(false)
const previewLoading = ref(false)
const preview = ref<LaunchPlan | null>(null)
const previewError = ref('')

const summary = computed(() => instances.current.value)
const instance = computed(() => summary.value?.instance ?? null)
const badge = computed(() => (summary.value ? badgeFor(summary.value.state) : null))
const runningGame = computed<GameProcessInfo | null>(() =>
  instance.value ? launcher.runningOf(instance.value.id) : null
)
const elapsed = computed(() =>
  runningGame.value ? formatDuration(launcher.clock.value - runningGame.value.startedAt) : ''
)
const account = computed<Account | null>(() => accounts.value.find((entry) => entry.selected) ?? accounts.value[0] ?? null)

const accountOptions = computed<SelectOption[]>(() =>
  accounts.value.map((entry) => ({
    value: entry.id,
    label: entry.name,
    hint: `${t(entry.type === 'microsoft' ? 'account.type.microsoft' : 'account.type.offline')} · ${accountTokenText(entry)}`,
    disabled: entry.selected
  }))
)

const instanceOptions = computed<SelectOption[]>(() => instances.pickerOptions.value)

/** Pre-flight: the launch button only lights up when every check has a green answer. */
const checks = computed(() => {
  const state = summary.value?.state
  return [
    {
      id: 'files',
      label: homeText.text('checkVersion'),
      ok: !!state && state.installed && state.clientJarOk && state.versionResolved,
      detail: state ? badgeFor(state).label : t('common.unknown')
    },
    {
      id: 'java',
      label: homeText.text('checkJava'),
      ok: java.value !== null && java.value.runtime !== null,
      detail: java.value
        ? java.value.runtime
          ? `Java ${java.value.runtime.major} · ${java.value.runtime.vendor}`
          : t('java.missing', { major: java.value.major })
        : homeText.text('javaNone')
    },
    {
      id: 'account',
      label: homeText.text('checkAccount'),
      ok: account.value !== null,
      detail: account.value ? account.value.name : t('common.none')
    }
  ]
})

const ready = computed(() => checks.value.every((entry) => entry.ok))
const busy = computed(() => launcher.launchingId.value !== null)
const blocked = computed(() => !ready.value && !busy.value)
const javaDetail = computed(() => checks.value[1]?.detail ?? homeText.text('javaNone'))
const severityTone = computed<'danger' | 'warning' | 'accent'>(() => {
  const severity = crash.value?.severity
  return severity === 'critical' ? 'danger' : severity === 'warning' ? 'warning' : 'accent'
})

function accountTokenText(entry: Account): string {
  if (entry.tokenState === 'valid') return t('account.token.valid')
  if (entry.tokenState === 'needs-refresh') return t('account.token.needsRefresh')
  if (entry.tokenState === 'invalid') return t('account.token.invalid')
  return t('account.token.none')
}

async function loadAccounts(): Promise<void> {
  accountsError.value = ''
  const res = await window.mouc.account.list()
  if (!res.ok) {
    accountsError.value = res.error.message
    toast.push({ kind: 'danger', title: homeText.text('accountsFailed'), message: res.error.message })
    return
  }
  accounts.value = res.data
}

async function selectAccount(id: string): Promise<void> {
  const res = await window.mouc.account.select(id)
  if (!res.ok) {
    toast.push({ kind: 'danger', title: homeText.text('switchFailed'), message: res.error.message })
    return
  }
  accounts.value = accounts.value.map((entry) => ({ ...entry, selected: entry.id === id }))
}

async function loadJava(): Promise<void> {
  javaError.value = ''
  java.value = null
  const target = instance.value
  if (!target) return
  const res = await window.mouc.java.resolve(target.id)
  if (!res.ok) {
    javaError.value = res.error.message
    return
  }
  java.value = res.data
}

async function provisionJava(): Promise<void> {
  const need = java.value
  if (!need || need.runtime || provisioning.value) return
  provisioning.value = true
  const res = await window.mouc.java.provision({ major: need.major, imageType: 'jre' })
  provisioning.value = false
  if (!res.ok) {
    toast.push({ kind: 'danger', title: homeText.text('javaProvisionFailed'), message: res.error.message })
    return
  }
  toast.push({ kind: 'success', title: homeText.text('javaReady', { major: res.data.runtime.major }) })
  await loadJava()
}

async function startLaunch(intoServer = false): Promise<void> {
  const target = instance.value
  if (!target) return
  if (intoServer && !target.server) {
    toast.push({ kind: 'warning', title: homeText.text('intoServer'), message: homeText.text('noServer') })
    return
  }
  const launched = await launcher.launch(
    { instanceId: target.id, accountId: account.value?.id, server: intoServer ? target.server : undefined },
    target.name
  )
  if (launched) await instances.load()
}

async function confirmKill(): Promise<void> {
  const target = instance.value
  const game = runningGame.value
  if (!target || !game) return
  const confirmed = await modal.confirm({
    titleKey: 'game.kill',
    text: t('game.killConfirm', { name: target.name }),
    confirmKey: 'common.confirm',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  await launcher.kill(target.id, target.name)
}

async function repairInstance(): Promise<void> {
  const target = instance.value
  if (!target || repairing.value) return
  repairing.value = true
  await versions.repair(target.versionId)
  repairing.value = false
}

async function loadLogs(): Promise<void> {
  const target = instance.value
  if (!target) return
  logsLoading.value = true
  logsError.value = ''
  const res = await window.mouc.game.logs(target.id, 260)
  logsLoading.value = false
  if (!res.ok) {
    logsError.value = res.error.message
    toast.push({ kind: 'danger', title: homeText.text('logsFailed'), message: res.error.message })
    return
  }
  logs.value = res.data
}

function toggleLog(): void {
  logOpen.value = !logOpen.value
  if (logOpen.value && logs.value.length === 0 && !logsError.value) void loadLogs()
}

async function openPreview(): Promise<void> {
  previewOpen.value = true
  preview.value = null
  previewError.value = ''
  const target = instance.value
  if (!target) {
    previewLoading.value = false
    return
  }
  previewLoading.value = true
  const res = await window.mouc.game.preview(target.id)
  previewLoading.value = false
  if (!res.ok) {
    previewError.value = res.error.message
    toast.push({ kind: 'danger', title: homeText.text('previewFailed'), message: res.error.message })
    return
  }
  preview.value = res.data
}

async function copy(text: string, okTitle: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.push({ kind: 'success', title: okTitle })
  } catch {
    toast.push({ kind: 'warning', title: homeText.text('copyFailed') })
  }
}

const crash = computed(() => launcher.lastExit.value?.analysis ?? null)

const crashEvidenceText = computed(() => {
  const exit = launcher.lastExit.value
  const lines: string[] = []
  if (exit) {
    lines.push(`${t('game.pid', { pid: exit.pid })} · ${t('game.exitCode', { code: exit.code ?? '-' })} · ${formatDuration(exit.durationMs)}`)
  }
  if (crash.value?.reportPath) lines.push(crash.value.reportPath)
  if (crash.value) lines.push(crash.value.title, crash.value.cause, crash.value.suggestion)
  if (crash.value?.evidence.length) lines.push(crash.value.evidence.join('\n'))
  return lines.join('\n')
})

const logText = computed(() =>
  logs.value.map((entry) => `[${formatClock(entry.ts)}] ${entry.level.toUpperCase()} ${entry.text}`).join('\n')
)

function copyPreviewCommand(): void {
  const plan = preview.value
  if (plan) void copy(plan.commandLine, homeText.text('copied'))
}

watch(
  () => instance.value?.id,
  () => {
    void loadJava()
    if (logOpen.value) void loadLogs()
  }
)

// A repair/import job changes what "版本文件" means for the current instance.
watch(
  () => launcher.finishedJobs.value.map((entry) => `${entry.job.id}:${entry.job.status}`).join(','),
  () => {
    const target = instance.value
    if (target) void instances.refreshState(target.id)
  }
)

onMounted(async () => {
  await Promise.all([instances.load(), loadAccounts(), launcher.refreshRunning(), launcher.refreshJobs()])
  await loadJava()
})
</script>

<template>
  <div class="home">
    <header class="page-head">
      <div class="page-head-main">
        <h1 class="page-title">{{ t('nav.home') }}</h1>
        <p class="page-sub u-truncate">
          {{ instance ? `${instance.name} · ${instance.gameVersion}` : t('launch.noInstance') }}
        </p>
      </div>
      <div class="page-actions">
        <MButton size="sm" variant="ghost" icon="eye" @click="openPreview">{{ t('launch.previewArgs') }}</MButton>
        <MButton size="sm" :variant="logOpen ? 'outline' : 'ghost'" :active="logOpen" icon="terminal" @click="toggleLog">
          {{ homeText.text('viewLog') }}
        </MButton>
      </div>
    </header>

    <!-- loading -->
    <MCard v-if="instances.loading.value && !summary" tone="raised" class="hero">
      <div class="hero-top">
        <MSkeleton variant="rect" width="56px" height="56px" rounded="var(--m-r-md)" />
        <div class="u-col">
          <MSkeleton width="220px" height="20px" />
          <MSkeleton width="160px" height="12px" />
        </div>
      </div>
      <MSkeleton :lines="3" height="32px" />
    </MCard>

    <!-- error -->
    <MCard v-else-if="instances.error.value" tone="raised">
      <MEmpty icon="warning" :title="instances.error.value" :description="homeText.text('jobsEmpty')" compact>
        <MButton icon="refresh" @click="instances.load()">{{ t('common.retry') }}</MButton>
      </MEmpty>
    </MCard>

    <!-- zero state -->
    <MCard v-else-if="!instance || !summary" tone="raised">
      <MEmpty icon="cube" :title="t('launch.noInstance')" :description="t('launch.noInstanceHint')">
        <MButton variant="primary" icon="plus" @click="navigate('instances')">{{ t('launch.createFirst') }}</MButton>
        <MButton icon="pack" @click="navigate('instances')">{{ t('launch.importModpack') }}</MButton>
      </MEmpty>
    </MCard>

    <div v-else class="home-body" :class="{ 'has-drawer': logOpen }">
      <div class="u-col stack">
        <!-- ================================================== hero -->
        <MCard tone="raised" class="hero">
          <div class="hero-top">
            <span class="hero-icon"><MIcon :name="iconFor(instance.icon)" :size="28" :stroke-width="1.2" tone="accent" /></span>
            <div class="hero-name">
              <h2 class="hero-title u-truncate" :title="instance.name">{{ instance.name }}</h2>
              <p v-if="instance.description" class="hero-desc u-truncate" :title="instance.description">
                {{ instance.description }}
              </p>
              <p v-else class="hero-desc u-truncate">{{ t('launch.recentPlayed') }} {{ formatRelative(instance.lastPlayedAt ?? 0) }}</p>
            </div>
            <div class="hero-badges">
              <MTag :tone="badge?.tone" :icon="badge?.icon">
                {{ badge?.label ?? t('common.unknown') }}
              </MTag>
              <MTag tone="accent" :icon="iconFor(instance.loader)">{{ loaderLabel(instance.loader) }}</MTag>
              <MTag>{{ instance.gameVersion }}</MTag>
            </div>
          </div>

          <dl class="stats">
            <div class="stat">
              <dt>{{ t('instance.memory') }}</dt>
              <dd class="u-num">{{ formatBytes(instance.memoryMb * 1024 * 1024, 0) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('instance.lastPlayed') }}</dt>
              <dd class="u-truncate">{{ formatRelative(instance.lastPlayedAt ?? 0) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('nav.mods') }}</dt>
              <dd class="u-num">{{ t('instance.modCount', { n: summary.modCount }) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('common.size') }}</dt>
              <dd class="u-num">{{ formatBytes(summary.state.sizeBytes) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ instance.isolated ? t('instance.isolated') : t('instance.sharedRoot') }}</dt>
              <dd class="u-truncate" :title="instance.versionId">{{ instance.versionId }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('java.inUse') }}</dt>
              <dd class="u-truncate" :title="javaDetail">{{ javaDetail }}</dd>
            </div>
          </dl>

          <div class="pickers">
            <MFieldRow :inline="false" :label="t('launch.currentInstance')">
              <MSelect
                :model-value="instance.id"
                :options="instanceOptions"
                searchable
                icon="cube"
                :placeholder="t('launch.currentInstance')"
                @update:model-value="instances.setActive($event)"
              />
            </MFieldRow>

            <MFieldRow :inline="false" :label="t('account.title')" :error="accountsError">
              <div class="account-row">
                <MSelect
                  :model-value="account?.id ?? ''"
                  :options="accountOptions"
                  icon="user"
                  :placeholder="t('account.select')"
                  @update:model-value="selectAccount"
                />
                <MTooltip
                  v-if="account && account.tokenState !== 'none' && account.tokenState !== 'valid'"
                  :content="accountTokenText(account)"
                  :detail="account.label"
                >
                  <MTag tone="warning" icon="warning" size="sm">{{ accountTokenText(account) }}</MTag>
                </MTooltip>
              </div>
            </MFieldRow>
          </div>

          <!-- running banner -->
          <div v-if="runningGame" class="running">
            <MTag tone="success" dot>{{ t('launch.running') }}</MTag>
            <span class="u-num running-meta">{{ t('game.pid', { pid: runningGame.pid }) }}</span>
            <span class="running-meta u-secondary">{{ homeText.text('runningFor', { time: elapsed }) }}</span>
            <MButton size="sm" variant="danger" icon="stop" @click="confirmKill">{{ t('game.kill') }}</MButton>
          </div>

          <!-- pre-flight -->
          <div class="checks">
            <span class="checks-label">{{ t('launch.checking') }}</span>
            <span v-for="entry in checks" :key="entry.id" class="check" :class="entry.ok ? 'is-ok' : 'is-bad'">
              <MIcon :name="entry.ok ? 'check' : 'warning'" :size="16" :tone="entry.ok ? 'success' : 'warning'" />
              <span class="u-truncate" :title="entry.detail">
                <b>{{ entry.label }}</b>
                <i class="check-detail">{{ entry.detail }}</i>
              </span>
            </span>
            <MButton
              v-if="java && !java.runtime"
              size="sm"
              variant="outline"
              icon="download"
              :loading="provisioning"
              @click="provisionJava"
            >
              {{ t('java.provision', { major: java.major }) }}
            </MButton>
          </div>

          <div v-if="javaError" class="inline-error u-mono">{{ javaError }}</div>

          <div class="launch-row">
            <MButton
              class="launch-btn"
              size="lg"
              variant="primary"
              icon="play"
              :loading="busy"
              :disabled="blocked"
              @click="startLaunch(false)"
            >
              {{ busy ? t('launch.launching') : t('launch.start') }}
            </MButton>
            <MTooltip :content="homeText.text('intoServer')" :detail="instance.server ? `${instance.server.address}:${instance.server.port}` : homeText.text('noServer')">
              <MButton size="lg" icon="link" :disabled="busy" @click="startLaunch(true)">
                {{ homeText.text('intoServer') }}
              </MButton>
            </MTooltip>
            <MButton v-if="!ready" size="lg" variant="ghost" icon="shield" :loading="repairing" @click="repairInstance">
              {{ t('version.repair') }}
            </MButton>
            <MButton v-if="runningGame" size="lg" variant="ghost" icon="terminal" @click="toggleLog">
              {{ homeText.text('viewLog') }}
            </MButton>
          </div>
        </MCard>

        <!-- ============================================ downloads -->
        <MCard :title="homeText.text('jobs')" icon="download" class="jobs">
          <template #actions>
            <MButton
              v-if="launcher.finishedJobs.value.length"
              size="sm"
              variant="ghost"
              icon="close-all"
              @click="launcher.clearFinished()"
            >
              {{ homeText.text('clearHistory') }}
            </MButton>
          </template>

          <p v-if="!launcher.activeJobs.value.length && !launcher.finishedJobs.value.length" class="jobs-empty">
            {{ homeText.text('jobsEmpty') }}
          </p>

          <ul v-else class="job-list">
            <li v-for="row in launcher.activeJobs.value" :key="row.job.id" class="job">
              <div class="job-head">
                <span class="job-title u-truncate" :title="row.job.title">{{ row.job.title }}</span>
                <MTag size="sm" :tone="row.job.status === 'error' ? 'danger' : 'accent'">{{ row.statusLabel }}</MTag>
              </div>
              <MProgress
                :percent="row.percent"
                size="sm"
                :status="row.job.status === 'error' ? 'error' : row.job.status === 'paused' ? 'paused' : 'active'"
                :speed="row.live?.speedBps ?? 0"
                :eta-seconds="row.live?.etaSeconds ?? 0"
                show-meta
              />
              <div class="job-meta u-num">
                <span>{{ homeText.text('files', { done: row.job.done, total: row.job.total }) }}</span>
                <span class="u-muted">{{ formatBytes(row.job.bytesDone) }} / {{ formatBytes(row.job.bytesTotal) }}</span>
                <span v-if="row.live">{{ formatEta(row.live.etaSeconds) }}</span>
              </div>
              <p v-if="row.job.error" class="job-error">{{ row.job.error.message }}</p>
              <div class="job-actions">
                <MButton size="sm" variant="ghost" icon="x" @click="launcher.cancelJob(row.job.id)">
                  {{ t('common.cancel') }}
                </MButton>
              </div>
            </li>

            <li
              v-if="launcher.activeJobs.value.length && launcher.finishedJobs.value.length"
              class="job-sub"
              role="presentation"
            >
              {{ homeText.text('jobHistory') }}
            </li>

            <li v-for="row in launcher.finishedJobs.value" :key="row.job.id" class="job is-done">
              <div class="job-head">
                <span class="job-title u-truncate" :title="row.job.title">{{ row.job.title }}</span>
                <MTag
                  size="sm"
                  :tone="row.job.status === 'done' ? 'success' : row.job.status === 'error' ? 'danger' : 'neutral'"
                >
                  {{ row.statusLabel }}
                </MTag>
              </div>
              <p v-if="row.job.error" class="job-error">{{ row.job.error.message }}</p>
              <div v-if="row.job.status === 'error'" class="job-actions">
                <MButton size="sm" variant="outline" icon="refresh" @click="launcher.retryJob(row.job.id)">
                  {{ t('common.retry') }}
                </MButton>
              </div>
            </li>
          </ul>
        </MCard>

        <!-- ====================================== crash analysis -->
        <MCard v-if="crash && launcher.lastExit.value" tone="raised" class="crash">
          <div class="crash-head">
            <MIcon name="warning" :size="20" :tone="severityTone === 'danger' ? 'danger' : 'warning'" />
            <h3 class="crash-title">{{ t('crash.title') }}</h3>
            <MTag :tone="severityTone" size="sm">
              {{ t(SEVERITY_KEYS[crash.severity]) }}
            </MTag>
            <span class="u-num crash-code muted">
              {{ t('game.exitCode', { code: launcher.lastExit.value.code ?? '-' }) }}
            </span>
          </div>
          <p class="crash-summary">{{ crash.title }}</p>
          <dl class="crash-body">
            <div>
              <dt>{{ t('crash.cause') }}</dt>
              <dd>{{ crash.cause }}</dd>
            </div>
            <div>
              <dt>{{ t('crash.suggestion') }}</dt>
              <dd>{{ crash.suggestion }}</dd>
            </div>
          </dl>
          <pre v-if="crash.evidence.length" class="evidence u-mono">{{ crash.evidence.join('\n') }}</pre>
          <div class="crash-actions">
            <MButton size="sm" icon="copy" @click="copy(crashEvidenceText, homeText.text('copied'))">
              {{ t('common.copy') }}
            </MButton>
            <MButton size="sm" variant="ghost" icon="terminal" @click="logOpen = true; loadLogs()">
              {{ homeText.text('viewLog') }}
            </MButton>
            <MButton size="sm" variant="ghost" @click="launcher.clearExit()">{{ t('common.dismiss') }}</MButton>
          </div>
        </MCard>
      </div>

      <!-- ============================================== log drawer -->
      <aside v-if="logOpen" class="drawer">
        <MCard class="drawer-card" :title="t('log.console')" icon="terminal" :padded="false">
          <template #actions>
            <MIconButton icon="copy" :label="homeText.text('copyLog')" size="sm" :disabled="!logs.length" @click="copy(logText, homeText.text('copied'))" />
            <MIconButton icon="refresh" :label="t('common.refresh')" size="sm" @click="loadLogs" />
            <MIconButton icon="x" :label="t('common.close')" size="sm" @click="logOpen = false" />
          </template>

          <div class="drawer-body">
            <template v-if="logsLoading">
              <MSkeleton :lines="6" height="12px" />
            </template>
            <p v-else-if="logsError" class="inline-error">{{ logsError }}</p>
            <MEmpty v-else-if="!logs.length" icon="terminal" :title="t('log.empty')" compact>
              <MButton size="sm" icon="refresh" @click="loadLogs">{{ t('common.refresh') }}</MButton>
            </MEmpty>
            <ul v-else class="log-lines">
              <li v-for="(line, index) in logs" :key="`${line.ts}-${index}`" class="log-line">
                <MTag size="sm" :tone="LEVEL_TONES[line.level]">{{ line.level }}</MTag>
                <span class="log-time u-num">{{ formatClock(line.ts) }}</span>
                <span class="log-text">{{ line.text }}</span>
              </li>
            </ul>
          </div>
        </MCard>
      </aside>
    </div>

    <!-- ========================================== preview modal -->
    <MModal
      :open="previewOpen"
      :title="homeText.text('previewTitle')"
      :description="instance ? `${instance.name} · ${instance.versionId}` : ''"
      :width="720"
      :confirm-text="t('common.copy')"
      :cancel-text="t('common.close')"
      @update:open="previewOpen = $event"
      @close="previewOpen = false"
      @confirm="copyPreviewCommand"
    >
      <template v-if="previewLoading">
        <MSkeleton :lines="4" height="16px" />
      </template>
      <p v-else-if="previewError" class="inline-error">{{ previewError }}</p>
      <template v-else-if="preview">
        <div class="plan-cell">
          <span class="plan-label">{{ homeText.text('commandLine') }}</span>
          <p class="mono-block u-mono">{{ preview.commandLine }}</p>
        </div>
        <div class="plan-grid">
          <div class="plan-cell">
            <span class="plan-label u-num">{{ t('settings.jvmArgs') }} · {{ preview.jvmArgs.length }}</span>
            <p class="mono-block u-mono">{{ preview.jvmArgs.join(' ') }}</p>
          </div>
          <div class="plan-cell">
            <span class="plan-label u-num">{{ homeText.text('gameArgs') }} · {{ preview.gameArgs.length }}</span>
            <p class="mono-block u-mono">{{ preview.gameArgs.join(' ') }}</p>
          </div>
          <div class="plan-cell">
            <span class="plan-label u-num">{{ homeText.text('classpath') }} · {{ preview.classpath.length }}</span>
            <p class="mono-block u-mono">{{ preview.classpath.join('\n') }}</p>
          </div>
          <div class="plan-cell">
            <span class="plan-label u-num">{{ homeText.text('runtime') }}</span>
            <p class="mono-block u-mono">{{ preview.javaExecutable }}</p>
            <p class="mono-block u-mono">Java {{ preview.javaMajor }} · {{ preview.versionName }}</p>
            <p class="mono-block u-mono">{{ preview.gameDir }}</p>
            <p class="mono-block u-mono">{{ preview.nativesDir }}</p>
          </div>
        </div>
        <ul v-if="preview.notes.length" class="plan-notes">
          <li v-for="note in preview.notes" :key="note">
            <MIcon name="info" :size="16" tone="muted" />
            <span>{{ note }}</span>
          </li>
        </ul>
      </template>
    </MModal>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-4);
  min-height: 100%;
  padding: var(--m-sp-5);
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--m-sp-4);
}

.page-title {
  font-size: var(--m-fs-20);
  line-height: var(--m-lh-tight);
}

.page-sub {
  margin-top: 2px;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.page-actions {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex: none;
}

.home-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--m-sp-4);
  align-items: start;
}

.home-body.has-drawer {
  grid-template-columns: minmax(0, 1fr) 360px;
}

.stack {
  gap: var(--m-sp-4);
}

.drawer {
  position: sticky;
  top: 0;
  min-width: 0;
}

/* --------------------------------------------------------------- hero */
.hero-top {
  display: flex;
  align-items: flex-start;
  gap: var(--m-sp-3);
}

.hero-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  flex: none;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-md);
  background: var(--m-surface-sunken);
}

.hero-name {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hero-title {
  font-size: var(--m-fs-16);
}

.hero-desc {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.hero-badges {
  display: flex;
  align-items: center;
  gap: var(--m-sp-1);
  flex: none;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--m-sp-2) var(--m-sp-4);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stat dt {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.stat dd {
  font-size: var(--m-fs-14);
  color: var(--m-text-primary);
}

.pickers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--m-sp-3);
}

.account-row {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  min-width: 0;
}

.running {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-2) var(--m-sp-3);
  border: var(--m-line) solid var(--m-success);
  border-radius: var(--m-r-sm);
  background: var(--m-success-soft);
  font-size: var(--m-fs-12);
}

.running-meta {
  color: var(--m-text-secondary);
}

.checks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--m-sp-2) var(--m-sp-4);
}

.checks-label {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-1);
  max-width: 100%;
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.check b {
  font-weight: 500;
}

.check-detail {
  margin-left: var(--m-sp-1);
  font-style: normal;
  color: var(--m-text-muted);
}

.check.is-ok .check-detail {
  color: var(--m-success);
}

.check.is-bad .check-detail {
  color: var(--m-warning);
}

.launch-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--m-sp-2);
}

.launch-btn {
  min-width: 168px;
}

.inline-error {
  padding: var(--m-sp-2) var(--m-sp-3);
  border: var(--m-line) solid var(--m-danger);
  border-radius: var(--m-r-sm);
  background: var(--m-danger-soft);
  color: var(--m-danger);
  font-size: var(--m-fs-12);
  overflow-wrap: anywhere;
}

/* ------------------------------------------------------------- jobs */
.jobs-empty {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.job-list {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
}

.job {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
  padding-bottom: var(--m-sp-2);
  border-bottom: var(--m-line) solid var(--m-border-hairline);
}

.job:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.job.is-done {
  gap: var(--m-sp-1);
}

.job-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--m-sp-2);
  min-width: 0;
}

.job-title {
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
}

.job-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--m-sp-3);
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.job-error {
  font-size: var(--m-fs-12);
  color: var(--m-danger);
}

.job-sub {
  padding-top: var(--m-sp-1);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.job-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--m-sp-2);
}

/* ------------------------------------------------------------ crash */
.crash-head {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
}

.crash-title {
  font-size: var(--m-fs-14);
}

.crash-code {
  margin-left: auto;
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.crash-summary {
  font-size: var(--m-fs-14);
  font-weight: 600;
  color: var(--m-text-primary);
}

.crash-body {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
}

.crash-body dt {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.crash-body dd {
  font-size: var(--m-fs-13);
  line-height: var(--m-lh-loose);
  color: var(--m-text-secondary);
}

.evidence {
  max-height: 132px;
  padding: var(--m-sp-3);
  overflow: auto;
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
  font-size: var(--m-fs-12);
  line-height: var(--m-lh-loose);
  color: var(--m-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.crash-actions {
  display: flex;
  gap: var(--m-sp-2);
}

/* ------------------------------------------------------------ drawer */
.drawer-card {
  height: 100%;
}

.drawer-body {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  max-height: 560px;
  padding: var(--m-sp-3);
  overflow: auto;
}

.log-lines {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.log-line {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  align-items: baseline;
  gap: var(--m-sp-2);
  padding-bottom: var(--m-sp-1);
  border-bottom: var(--m-line) solid var(--m-border-hairline);
  font-size: var(--m-fs-12);
}

.log-time {
  grid-row: 1 / span 2;
  color: var(--m-text-muted);
}

.log-text {
  grid-column: 2;
  min-width: 0;
  color: var(--m-text-secondary);
  overflow-wrap: anywhere;
}

/* ----------------------------------------------------------- preview */
.mono-block {
  display: block;
  max-height: 96px;
  padding: var(--m-sp-2) var(--m-sp-3);
  overflow: auto;
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
  font-size: var(--m-fs-12);
  line-height: var(--m-lh-loose);
  color: var(--m-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.plan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--m-sp-3);
}

.plan-cell {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
  min-width: 0;
}

.plan-label {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.plan-notes {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.plan-notes li {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}

.muted {
  color: var(--m-text-muted);
}
</style>

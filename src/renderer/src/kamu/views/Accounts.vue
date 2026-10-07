<script setup lang="ts">
/**
 * 账号页 —— 移植自 KAMUCL `views/AccountsView.vue`（MIT）。卡片/列表/行密度、类型阶梯与
 * 按钮样式沿用 vendored `kamu.css` 的类名；数据层改接 `window.mouc`（见 `api/accounts.ts`）。
 *
 * 与 upstream 的差异是后端的真实能力，不是遗漏：
 * - 设备码轮询在渲染端驱动（`microsoftStart` → 反复 `microsoftPoll`），阶段推送走
 *   `mouc:microsoft-login` 事件。
 * - 未移植：authlib-injector 运行组件、提供商增删改、皮肤上传/历史、3D 皮肤查看器、披风、
 *   modsync、桌宠。外置登录只做 `mouc.account.servers()` 支持的服务器列表查询，其余明确标注不支持。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { Account, LoginStage, MicrosoftStartResult } from '@shared/types'
import {
  MS_STAGES,
  addOfflineAccount,
  copyText,
  listAccounts,
  msBeginLogin,
  msCancelLogin,
  msPollLogin,
  onMsLoginProgress,
  openExternal,
  refreshAccount,
  removeAccount,
  selectAccount,
  yggdrasilServers,
  type YggdrasilServerEntry
} from '../api/accounts'
import AccountsAvatar from '../components/AccountsAvatar.vue'
import { navigate } from '../../composables/useNav'
import { useToast } from '../../composables/useToast'
import { defineDict, t } from '../../i18n'

const copy = defineDict({
  backHome: ['返回首页', 'Back to home'],
  subtitle: ['管理微软正版与离线账号', 'Manage Microsoft and offline accounts'],
  addTitle: ['添加账号', 'Add an account'],
  tabMicrosoft: ['Microsoft 正版登录', 'Microsoft sign-in'],
  tabOffline: ['离线登录', 'Offline login'],
  tabYggdrasil: ['外置 Yggdrasil 登录', 'Third-party Yggdrasil login'],
  msIntro: [
    '通过微软设备代码完成正版授权，本启动器不会接触你的微软密码。',
    'The device-code flow grants the licence without this launcher ever seeing your Microsoft password.'
  ],
  msSsl: [
    'SSL 证书验证已启用：校验证书链、域名及有效期，证书异常时终止登录。',
    'TLS verification is enabled: chain, hostname and validity are checked, otherwise the sign-in aborts.'
  ],
  msStart: ['开始微软登录', 'Start Microsoft sign-in'],
  msStarting: ['正在获取登录码…', 'Requesting the code…'],
  msRunning: ['登录进行中…', 'Sign-in in progress…'],
  namePlaceholder: ['离线账号用户名（3-16 位字母数字下划线）', 'Offline username (3-16 letters, digits, underscore)'],
  nameRule: ['用户名需为 3-16 位字母、数字或下划线', 'A username is 3-16 letters, digits or underscores'],
  addOffline: ['添加离线账号', 'Add offline account'],
  adding: ['添加中…', 'Adding…'],
  listTitle: ['我的账号（{n}）', 'My accounts ({n})'],
  listSubtitle: ['共 {n} 个', '{n} in total'],
  empty: ['还没有账号，先添加一个离线账号或登录微软账号吧', 'No accounts yet — add an offline one, or sign in with Microsoft'],
  loading: ['正在读取账号列表…', 'Loading accounts…'],
  loadFailed: ['读取账号列表失败：{error}', 'Could not load the account list: {error}'],
  inUse: ['使用中', 'In use'],
  verifySession: ['验证会话', 'Verify session'],
  verifying: ['验证中…', 'Verifying…'],
  removing: ['删除中…', 'Removing…'],
  yggUnsupported: [
    '当前版本没有接入第三方认证：无法在此登录外置账号，只能查询认证服务器公布的服务器列表。',
    'This build has no third-party authentication: signing in here is unavailable, only the server list an API Root publishes.'
  ],
  apiRoot: ['API Root', 'API Root'],
  apiRootHint: [
    '输入 authlib-injector 风格的 API Root，查询其公布的服务器列表。',
    'Enter an authlib-injector style API Root to read the server list it publishes.'
  ],
  lookup: ['查询服务器列表', 'List servers'],
  lookingUp: ['正在查询…', 'Querying…'],
  lookupEmpty: ['该 API Root 未公布服务器列表，或尚未发起查询。', 'That API Root publishes no server list, or no query has run yet.'],
  copyUrl: ['复制地址', 'Copy address'],
  rootSchemeError: ['API Root 需要以 http(s):// 开头', 'The API Root must start with http(s)://'],
  securityNote: ['密码等凭据不会被发送到任何第三方服务。', 'Passwords and tokens are never sent to a third-party service.'],
  modalTitle: ['微软账号登录', 'Microsoft account sign-in'],
  modalTip: [
    '请在浏览器中打开验证地址，输入下方代码完成授权。登录成功后本窗口会自动关闭。',
    'Open the verification address in any browser and enter the code below. This dialog closes itself once the sign-in succeeds.'
  ],
  codeAutoCopied: ['已自动复制到剪贴板，到验证页直接粘贴即可', 'Copied to the clipboard automatically — paste it on the verification page'],
  codeClickCopy: ['点击代码即可复制', 'Click the code to copy it'],
  copyDone: ['已复制验证码', 'Code copied'],
  copyFailed: ['复制失败，请手动复制', 'Copy failed — copy it manually'],
  openVerify: ['打开验证页面', 'Open verification page'],
  openVerifyFailed: ['打开验证页面失败：{error}', 'Could not open the verification page: {error}'],
  codeRemains: ['代码剩余 {time}', 'Code valid for {time}'],
  expiredNote: ['设备代码已过期，请重新获取后再试。', 'The device code expired — request a new one.'],
  expiredToast: ['设备代码已过期，请重新获取', 'The device code expired — request a new one'],
  aborted: ['登录中断：{error}', 'Sign-in interrupted: {error}'],
  retryCode: ['重新获取代码', 'Request a new code'],
  cancelLogin: ['取消登录', 'Cancel sign-in'],
  waiting: ['正在等待授权完成…', 'Waiting for authorisation…'],
  startFailed: ['无法开始微软登录：{error}', 'Could not start the Microsoft sign-in: {error}'],
  loginFailed: ['微软登录失败：{error}', 'Microsoft sign-in failed: {error}'],
  loginDone: ['登录成功，欢迎 {name}', 'Signed in — welcome {name}'],
  loginDoneNoAccount: ['微软登录完成', 'Microsoft sign-in completed'],
  cancelFailed: ['取消登录失败：{error}', 'Could not cancel the sign-in: {error}'],
  addedToast: ['已添加离线账号 {name}', 'Offline account {name} added'],
  addFailed: ['添加失败：{error}', 'Could not add the account: {error}'],
  selectFailed: ['切换账号失败：{error}', 'Could not switch accounts: {error}'],
  removedToast: ['已删除账号 {name}', 'Removed account {name}'],
  removeFailed: ['删除失败：{error}', 'Could not delete: {error}'],
  refreshOk: ['{name} 的会话有效', '{name} has a valid session'],
  refreshFailed: ['会话刷新失败：{error}', 'Could not refresh the session: {error}'],
  lookupFailed: ['查询服务器列表失败：{error}', 'Could not read the server list: {error}'],
  typeMicrosoft: ['微软正版', 'Microsoft'],
  typeOffline: ['离线', 'Offline'],
  typeYggdrasil: ['外置 · {server}', 'Third-party · {server}'],
  typeAuthlib: ['外置 · authlib-injector', 'Third-party · authlib-injector']
})

const stageCopy = defineDict({
  'waiting-user': ['等待浏览器授权', 'Awaiting the browser'],
  'microsoft-ok': ['微软令牌', 'Microsoft token'],
  'xbox-ok': ['Xbox Live', 'Xbox Live'],
  'live-ok': ['XBL 令牌', 'XBL token'],
  'minecraft-ok': ['Minecraft 令牌', 'Minecraft token'],
  'profile-ok': ['玩家档案', 'Player profile'],
  done: ['登录完成', 'Signed in'],
  failed: ['登录失败', 'Failed']
})

const toasts = useToast()
type ToastKind = 'info' | 'success' | 'warning' | 'danger'

function toast(title: string, kind: ToastKind = 'info'): void {
  toasts.push({ kind, title })
}

// `ApiError` 已是干净的中文消息，不需要 upstream 那套 IPC 前缀剥离。
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const accountMode = ref<'microsoft' | 'offline' | 'yggdrasil'>('microsoft')

// ---------------- 账号列表 ----------------
const accounts = ref<Account[]>([])
const loading = ref(true)
const listError = ref('')
const selectedId = computed(() => accounts.value.find((item) => item.selected)?.id ?? '')

async function loadAccounts(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    accounts.value = await listAccounts()
  } catch (e) {
    listError.value = errorText(e)
  } finally {
    loading.value = false
  }
}

// ---------------- 添加离线账号 ----------------
const newName = ref('')
const adding = ref(false)

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/
const nameError = computed(() =>
  newName.value && !NAME_RE.test(newName.value) ? copy.text('nameRule') : ''
)

async function onAddOffline(): Promise<void> {
  const name = newName.value.trim()
  if (!NAME_RE.test(name)) {
    toast(copy.text('nameRule'), 'danger')
    return
  }
  adding.value = true
  try {
    await addOfflineAccount(name)
    await loadAccounts()
    newName.value = ''
    toast(copy.text('addedToast', { name }), 'success')
  } catch (e) {
    toast(copy.text('addFailed', { error: errorText(e) }), 'danger')
  } finally {
    adding.value = false
  }
}

// ---------------- 微软设备码登录 ----------------
const ms = reactive({
  open: false,
  starting: false,
  waiting: false,
  autoCopied: false,
  info: null as MicrosoftStartResult | null,
  stage: null as LoginStage | null,
  message: '',
  secondsLeft: 0,
  expired: false,
  error: ''
})

let pollTimer: number | null = null
let clockTimer: number | null = null
let sessionKey = ''
let settled = false

const stageIndex = computed(() => (ms.stage ? MS_STAGES.indexOf(ms.stage) : -1))
const countdown = computed(() => {
  const total = Math.max(0, ms.secondsLeft)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
})
const countdownPercent = computed(() => {
  const span = ms.info?.expiresIn ?? 0
  if (span <= 0) return 0
  return Math.max(0, Math.min(100, (ms.secondsLeft / span) * 100))
})

function stopTimers(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
  if (clockTimer !== null) window.clearInterval(clockTimer)
  pollTimer = null
  clockTimer = null
}

function closeFlow(): void {
  stopTimers()
  ms.open = false
  ms.waiting = false
  ms.info = null
  ms.stage = null
  ms.message = ''
  ms.error = ''
  ms.expired = false
  ms.secondsLeft = 0
  sessionKey = ''
  settled = false
}

function applyProgress(stage: LoginStage, message: string, account: Account | null): void {
  if (settled) return
  ms.stage = stage
  ms.message = message
  if (stage === 'done') {
    settled = true
    void finishLogin(account)
  } else if (stage === 'failed') {
    settled = true
    ms.error = message || t('account.loginFailed')
    stopTimers()
    toast(copy.text('loginFailed', { error: ms.error }), 'danger')
  }
}

async function finishLogin(account: Account | null): Promise<void> {
  closeFlow()
  await loadAccounts()
  toast(account ? copy.text('loginDone', { name: account.name }) : copy.text('loginDoneNoAccount'), 'success')
}

function schedulePoll(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
  pollTimer = window.setTimeout(pollOnce, Math.max(1, ms.info?.interval ?? 5) * 1000)
}

async function pollOnce(): Promise<void> {
  if (!ms.open || settled || ms.expired) return
  try {
    const progress = await msPollLogin(sessionKey)
    // 事件推送可能先落地同一阶段，这里只负责推进轮询节奏。
    applyProgress(progress.stage, progress.message, progress.account ?? null)
  } catch (e) {
    ms.error = errorText(e)
    stopTimers()
    toast(copy.text('loginFailed', { error: ms.error }), 'danger')
    return
  }
  if (!settled) schedulePoll()
}

function startCountdown(): void {
  if (clockTimer !== null) window.clearInterval(clockTimer)
  clockTimer = window.setInterval(() => {
    if (ms.expired) return
    ms.secondsLeft = Math.max(0, ms.secondsLeft - 1)
    if (ms.secondsLeft > 0) return
    ms.expired = true
    stopTimers()
    toast(copy.text('expiredToast'), 'warning')
  }, 1000)
}

async function beginMsLogin(): Promise<void> {
  if (ms.starting) return
  ms.starting = true
  try {
    const info = await msBeginLogin()
    sessionKey = info.sessionKey
    settled = false
    Object.assign(ms, {
      open: true,
      waiting: true,
      info,
      stage: 'waiting-user' as LoginStage,
      message: info.message,
      expired: false,
      error: '',
      secondsLeft: info.expiresIn
    })
    // 设备代码出现的瞬间自动写入剪贴板，玩家到验证页直接粘贴即可
    ms.autoCopied = info.userCode ? await copyText(info.userCode) : false
    schedulePoll()
    startCountdown()
  } catch (e) {
    toast(copy.text('startFailed', { error: errorText(e) }), 'danger')
  } finally {
    ms.starting = false
  }
}

async function restartMsLogin(): Promise<void> {
  if (sessionKey) {
    try {
      await msCancelLogin(sessionKey)
    } catch {
      /* 旧会话已过期或不存在，取消失败无需打扰用户 */
    }
  }
  closeFlow()
  await beginMsLogin()
}

async function cancelMsLogin(): Promise<void> {
  const key = sessionKey
  closeFlow()
  if (!key) return
  try {
    await msCancelLogin(key)
  } catch (e) {
    toast(copy.text('cancelFailed', { error: errorText(e) }), 'warning')
  }
}

async function copyCode(): Promise<void> {
  if (!ms.info) return
  const ok = await copyText(ms.info.userCode)
  toast(ok ? copy.text('copyDone') : copy.text('copyFailed'), ok ? 'success' : 'danger')
}

async function openVerifyPage(): Promise<void> {
  const info = ms.info
  if (!info) return
  try {
    // 带代码的完整链接可用时优先，玩家不必再手动粘贴。
    await openExternal(info.verificationUriComplete || info.verificationUri)
  } catch (e) {
    toast(copy.text('openVerifyFailed', { error: errorText(e) }), 'danger')
  }
}

const stageLabel = (stage: LoginStage): string => stageCopy.text(stage)

// ---------------- 外置 Yggdrasil：仅服务器列表查询 ----------------
const ygg = reactive({
  busy: false,
  baseUrl: 'https://littleskin.cn/api/yggdrasil',
  error: '',
  entries: [] as YggdrasilServerEntry[]
})

async function lookupServers(): Promise<void> {
  if (ygg.busy) return
  const url = ygg.baseUrl.trim()
  ygg.error = ''
  if (!/^https?:\/\//.test(url)) {
    ygg.error = copy.text('rootSchemeError')
    return
  }
  ygg.busy = true
  try {
    ygg.entries = await yggdrasilServers(url)
  } catch (e) {
    ygg.entries = []
    ygg.error = errorText(e)
    toast(copy.text('lookupFailed', { error: ygg.error }), 'danger')
  } finally {
    ygg.busy = false
  }
}

async function copyServer(url: string): Promise<void> {
  const ok = await copyText(url)
  toast(ok ? t('common.copyDone') : copy.text('copyFailed'), ok ? 'success' : 'danger')
}

// ---------------- 账号操作 ----------------
const removingId = ref<string | null>(null)
const selectingId = ref<string | null>(null)
const refreshingId = ref<string | null>(null)

async function onSelect(acc: Account): Promise<void> {
  if (selectedId.value === acc.id) return
  selectingId.value = acc.id
  try {
    await selectAccount(acc.id)
    await loadAccounts()
  } catch (e) {
    toast(copy.text('selectFailed', { error: errorText(e) }), 'danger')
  } finally {
    selectingId.value = null
  }
}

async function onRemove(acc: Account): Promise<void> {
  if (removingId.value) return
  removingId.value = acc.id
  try {
    await removeAccount(acc.id)
    await loadAccounts()
    toast(copy.text('removedToast', { name: acc.name }), 'success')
  } catch (e) {
    toast(copy.text('removeFailed', { error: errorText(e) }), 'danger')
  } finally {
    removingId.value = null
  }
}

async function onRefresh(acc: Account): Promise<void> {
  if (refreshingId.value) return
  refreshingId.value = acc.id
  try {
    await refreshAccount(acc.id)
    await loadAccounts()
    toast(copy.text('refreshOk', { name: acc.name }), 'success')
  } catch (e) {
    toast(copy.text('refreshFailed', { error: errorText(e) }), 'danger')
  } finally {
    refreshingId.value = null
  }
}

function accountTypeLabel(acc: Account): string {
  if (acc.type === 'microsoft') return copy.text('typeMicrosoft')
  if (acc.type === 'yggdrasil') return copy.text('typeYggdrasil', { server: acc.server || t('common.unknown') })
  if (acc.type === 'authlib-injector') return copy.text('typeAuthlib')
  return copy.text('typeOffline')
}

const typeTagClass = (acc: Account): string =>
  acc.type === 'microsoft' ? 'tag-gold' : acc.type === 'offline' ? '' : 'tag-cyan'

const TOKEN_TAG_CLASS: Record<Account['tokenState'], string> = {
  none: '',
  valid: 'tag-success',
  'needs-refresh': 'tag-cyan',
  invalid: 'tag-danger'
}

function tokenLabel(state: Account['tokenState']): string {
  if (state === 'valid') return t('account.token.valid')
  if (state === 'needs-refresh') return t('account.token.needsRefresh')
  if (state === 'invalid') return t('account.token.invalid')
  return ''
}

function goHome(): void {
  window.location.hash = '#view=home'
  navigate('home')
}

let offMsProgress: (() => void) | null = null

onMounted(() => {
  void loadAccounts()
  offMsProgress = onMsLoginProgress((progress) => {
    if (!ms.open || progress.sessionKey !== sessionKey) return
    applyProgress(progress.stage, progress.message, progress.account ?? null)
  })
})

onUnmounted(() => {
  offMsProgress?.()
  // 离开页面时停止轮询；主进程会话仍在，回来可重新发起。
  stopTimers()
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
        <h1 class="page-title">{{ t('account.title') }}</h1>
        <p class="page-sub">{{ copy.text('subtitle') }}</p>
      </div>
    </div>

    <!-- 添加账号 -->
    <div class="card">
      <h3 class="section-title">{{ copy.text('addTitle') }}</h3>
      <div class="account-type-tabs" role="tablist" :aria-label="copy.text('addTitle')">
        <button type="button" role="tab" :aria-selected="accountMode === 'microsoft'" :class="{ active: accountMode === 'microsoft' }" @click="accountMode = 'microsoft'">
          {{ copy.text('tabMicrosoft') }}
        </button>
        <button type="button" role="tab" :aria-selected="accountMode === 'offline'" :class="{ active: accountMode === 'offline' }" @click="accountMode = 'offline'">
          {{ copy.text('tabOffline') }}
        </button>
        <button type="button" role="tab" :aria-selected="accountMode === 'yggdrasil'" :class="{ active: accountMode === 'yggdrasil' }" @click="accountMode = 'yggdrasil'">
          {{ copy.text('tabYggdrasil') }}
        </button>
      </div>

      <div v-if="accountMode === 'microsoft'" class="account-mode-panel">
        <p class="muted mode-description">{{ copy.text('msIntro') }}</p>
        <p class="muted mode-description">{{ copy.text('msSsl') }}</p>
        <button class="btn btn-gold ms-btn" type="button" :disabled="ms.starting || ms.open" @click="beginMsLogin">
          <span v-if="ms.starting" class="spin"></span>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
            <path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" />
          </svg>
          {{ ms.starting ? copy.text('msStarting') : ms.open ? copy.text('msRunning') : copy.text('msStart') }}
        </button>
      </div>

      <div v-else-if="accountMode === 'offline'" class="account-mode-panel add-row">
        <div class="add-input-wrap">
          <input
            v-model="newName"
            class="input"
            :class="{ 'input-error': nameError }"
            :placeholder="copy.text('namePlaceholder')"
            maxlength="16"
            @keyup.enter="onAddOffline"
          />
          <p v-if="nameError" class="field-error">{{ nameError }}</p>
        </div>
        <button class="btn btn-gold add-btn" type="button" :disabled="adding || !newName || !!nameError" @click="onAddOffline">
          {{ adding ? copy.text('adding') : copy.text('addOffline') }}
        </button>
      </div>

      <div v-else class="account-mode-panel ygg-panel">
        <p class="provider-unsupported" role="status">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16.5h.01" />
          </svg>
          {{ copy.text('yggUnsupported') }}
        </p>
        <div class="provider-head">
          <div>
            <strong>{{ copy.text('apiRoot') }}</strong>
            <p class="muted mode-description">{{ copy.text('apiRootHint') }}</p>
          </div>
        </div>
        <div class="entry-row">
          <input v-model="ygg.baseUrl" class="input mono" placeholder="https://littleskin.cn/api/yggdrasil" spellcheck="false" @keyup.enter="lookupServers" />
          <button class="btn btn-ghost" type="button" :disabled="ygg.busy" @click="lookupServers">
            <span v-if="ygg.busy" class="spin"></span>
            {{ ygg.busy ? copy.text('lookingUp') : copy.text('lookup') }}
          </button>
        </div>
        <p v-if="ygg.error" class="provider-error">{{ ygg.error }}</p>
        <div v-else-if="ygg.entries.length" class="provider-list">
          <div v-for="entry in ygg.entries" :key="entry.serverUrl" class="provider-item">
            <div class="provider-item-main">
              <strong>{{ entry.serverName }}</strong>
              <p class="muted provider-url" :title="entry.serverUrl">{{ entry.serverUrl }}</p>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" @click="copyServer(entry.serverUrl)">{{ copy.text('copyUrl') }}</button>
          </div>
        </div>
        <div v-else class="provider-empty">{{ copy.text('lookupEmpty') }}</div>
        <p class="security-note">{{ copy.text('securityNote') }}</p>
      </div>
    </div>

    <!-- 账号列表 -->
    <div class="card">
      <h3 class="section-title">{{ copy.text('listTitle', { n: accounts.length }) }}</h3>

      <div v-if="loading" class="row-loading">
        <span class="spin"></span>
        <span class="muted">{{ copy.text('loading') }}</span>
      </div>

      <div v-else-if="listError" class="list-error" role="alert">
        <span>{{ copy.text('loadFailed', { error: listError }) }}</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="loadAccounts">{{ t('common.retry') }}</button>
      </div>

      <div v-else-if="!accounts.length" class="empty list-empty">
        <span>{{ copy.text('empty') }}</span>
        <div class="empty-actions">
          <button class="btn btn-ghost btn-sm" type="button" @click="accountMode = 'offline'">{{ copy.text('addOffline') }}</button>
          <button class="btn btn-gold btn-sm" type="button" @click="accountMode = 'microsoft'">{{ copy.text('msStart') }}</button>
        </div>
      </div>

      <div v-else class="account-list">
        <div
          v-for="acc in accounts"
          :key="acc.id"
          class="account-row"
          :class="{ selected: selectedId === acc.id }"
          role="button"
          tabindex="0"
          @click="onSelect(acc)"
          @keyup.enter="onSelect(acc)"
        >
          <AccountsAvatar :account="acc" :size="42" />
          <div class="account-meta">
            <div class="account-name">
              {{ acc.name }}
              <span class="tag" :class="typeTagClass(acc)">{{ accountTypeLabel(acc) }}</span>
              <span v-if="acc.tokenState !== 'none'" class="tag" :class="TOKEN_TAG_CLASS[acc.tokenState]">
                {{ tokenLabel(acc.tokenState) }}
              </span>
            </div>
            <span class="muted uuid">{{ acc.uuid.slice(0, 8) }} · {{ acc.label }}</span>
          </div>
          <span v-if="selectedId === acc.id" class="selected-badge">{{ copy.text('inUse') }}</span>
          <span v-else-if="selectingId === acc.id" class="spin"></span>
          <button
            v-if="acc.type !== 'offline'"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="refreshingId === acc.id"
            @click.stop="onRefresh(acc)"
          >
            {{ refreshingId === acc.id ? copy.text('verifying') : copy.text('verifySession') }}
          </button>
          <button
            class="btn btn-danger btn-sm remove-btn"
            type="button"
            :disabled="removingId === acc.id"
            @click.stop="onRemove(acc)"
          >
            {{ removingId === acc.id ? copy.text('removing') : t('common.delete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 微软登录模态框 -->
    <Teleport to="body">
      <div v-if="ms.open" class="modal-mask">
        <div class="modal ms-modal" role="dialog" aria-modal="true" aria-labelledby="ms-modal-title">
          <h3 id="ms-modal-title" class="modal-title">{{ copy.text('modalTitle') }}</h3>
          <p class="muted ms-tip">{{ copy.text('modalTip') }}</p>

          <button class="user-code" type="button" :title="copy.text('codeClickCopy')" :disabled="ms.expired" @click="copyCode">
            {{ ms.info?.userCode }}
          </button>
          <p v-if="ms.autoCopied" class="copy-hint copied">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
            {{ copy.text('codeAutoCopied') }}
          </p>
          <p v-else class="muted copy-hint">{{ copy.text('codeClickCopy') }}</p>

          <div class="ms-uri-row">
            <input class="input mono" :value="ms.info?.verificationUri" readonly />
            <button class="btn btn-gold" type="button" @click="openVerifyPage">{{ copy.text('openVerify') }}</button>
          </div>

          <div class="ms-meter">
            <span class="ms-countdown" :class="{ expired: ms.expired }">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              {{ copy.text('codeRemains', { time: countdown }) }}
            </span>
            <div class="ms-track"><span :style="{ width: `${countdownPercent}%` }"></span></div>
          </div>

          <ol class="ms-stages">
            <li
              v-for="(stage, index) in MS_STAGES"
              :key="stage"
              class="ms-stage"
              :class="{ done: index < stageIndex, active: index === stageIndex }"
            >
              <span class="ms-stage-mark">
                <svg v-if="index < stageIndex" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                <span v-else-if="index === stageIndex" class="spin"></span>
                <span v-else class="ms-stage-dot"></span>
              </span>
              <span class="ms-stage-name">{{ stageLabel(stage) }}</span>
            </li>
          </ol>

          <div v-if="ms.waiting" class="ms-waiting">
            <span class="spin"></span>
            <span class="muted">{{ ms.message || copy.text('waiting') }}</span>
          </div>

          <p v-if="ms.expired || ms.error" class="provider-error">
            {{ ms.expired ? copy.text('expiredNote') : copy.text('aborted', { error: ms.error }) }}
          </p>

          <div class="modal-actions">
            <button v-if="ms.expired || ms.error" class="btn btn-gold" type="button" :disabled="ms.starting" @click="restartMsLogin">
              {{ copy.text('retryCode') }}
            </button>
            <button class="btn btn-ghost" type="button" @click="cancelMsLogin">{{ copy.text('cancelLogin') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sec-gap);
  max-width: 720px;
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

.account-type-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.account-type-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--ctl-h);
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}
.account-type-tabs button:hover {
  color: var(--text);
}
.account-type-tabs button.active {
  color: var(--on-accent);
  background: var(--accent-grad);
  font-weight: 600;
}
.account-mode-panel {
  margin-top: var(--space-4);
}
.mode-description {
  margin-bottom: var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.6;
}

/* 添加账号 */
.add-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
.add-input-wrap {
  flex: 1;
  min-width: 0;
}
.input-error {
  border-color: var(--danger);
}
.field-error {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--danger);
}
.add-btn,
.ms-btn {
  flex-shrink: 0;
}
.ygg-panel {
  display: grid;
  gap: var(--space-4);
}
.provider-unsupported {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.provider-unsupported svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.provider-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
}
.provider-head strong {
  font-size: var(--text-sm);
}
.provider-head .mode-description {
  margin: var(--space-1) 0 0;
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
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.provider-item-main {
  min-width: 0;
}
.provider-item strong {
  font-size: var(--text-sm);
}
.provider-url {
  max-width: 520px;
  margin-top: var(--space-1);
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
.provider-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.entry-row {
  display: flex;
  gap: var(--space-2);
}
.entry-row .input {
  flex: 1;
  min-width: 0;
}
.security-note {
  margin: 0;
  color: var(--ok);
  font-size: var(--text-xs);
}

/* 账号列表 */
.row-loading {
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
.list-empty {
  padding: var(--space-6) var(--space-5);
}
.empty-actions {
  display: flex;
  gap: var(--space-2);
}
.account-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.account-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.account-row:hover {
  border-color: var(--accent-deep);
}
.account-row.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.account-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}
.account-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
}
.uuid {
  font-size: var(--text-xs);
  font-family: 'Cascadia Code', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-badge {
  display: inline-flex;
  align-items: center;
  font-size: var(--text-xs);
  color: var(--accent);
  flex-shrink: 0;
}
.remove-btn {
  flex-shrink: 0;
}

/* 微软登录模态框 */
.ms-modal {
  text-align: center;
}
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-3);
}
.ms-tip {
  font-size: var(--text-sm);
  line-height: 1.6;
}
.user-code {
  display: block;
  width: 100%;
  margin: var(--space-4) auto var(--space-2);
  padding: var(--space-4) var(--space-5);
  border: 1px dashed var(--accent);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent-2);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: 4px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.user-code:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.user-code:disabled {
  opacity: 0.5;
  cursor: default;
}
.copy-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  margin-bottom: var(--space-4);
}
.copy-hint.copied {
  color: var(--ok);
}
.ms-uri-row {
  display: flex;
  gap: var(--space-3);
}
.ms-uri-row .input {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
}
.ms-uri-row .btn {
  flex-shrink: 0;
}
.ms-meter {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-4);
  text-align: left;
}
.ms-countdown {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font: var(--text-xs) 'Cascadia Code', Consolas, monospace;
  color: var(--text-dim);
}
.ms-countdown.expired {
  color: var(--danger);
}
.ms-track {
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border);
}
.ms-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.15s ease;
}
.ms-stages {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-4) 0 0;
  padding: 0;
  list-style: none;
  text-align: left;
}
.ms-stage {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.ms-stage.active {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
}
.ms-stage.done {
  color: var(--text);
}
.ms-stage-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--ok);
}
.ms-stage-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border);
}
.ms-waiting {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  font-size: var(--text-sm);
}

@media (max-width: 680px) {
  .account-type-tabs {
    grid-template-columns: 1fr;
  }
  .add-row,
  .ms-uri-row,
  .entry-row {
    flex-direction: column;
  }
  .add-btn {
    width: 100%;
  }
}
</style>

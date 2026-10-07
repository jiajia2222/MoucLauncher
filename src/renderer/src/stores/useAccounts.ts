/**
 * useAccounts — shared state for AccountsView.
 *
 * The Microsoft device-code flow lives here rather than in the view: the poll timer has
 * to survive nav changes (leaving the page mid-login must not orphan the session), and a
 * session that completes in the background still has to refresh the list and announce it.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { EVENTS } from '@shared/ipc'
import type { Account, AppErrorPayload, MicrosoftLoginProgress, MicrosoftStartResult, Settings, SkinInfo } from '@shared/types'
import { defineDict } from '../i18n'
import { useToast } from '../composables/useToast'

/** The stage order the main process walks; used to render a stepper. */
export const LOGIN_STAGES = ['waiting-user', 'microsoft-ok', 'xbox-ok', 'live-ok', 'minecraft-ok', 'profile-ok', 'done'] as const

const copy = defineDict({
  loginDone: ['微软账户登录完成', 'Microsoft account added'],
  codeExpired: ['设备码已过期，请重新开始', 'The device code expired — start again'],
  copyFailed: ['复制失败', 'Copy failed'],
  refreshOk: ['令牌已刷新', 'Token refreshed']
})

const POLL_MIN_MS = 1200

const accounts: Ref<Account[]> = ref([])
const skins: Ref<Record<string, SkinInfo>> = ref({})
const loading: Ref<boolean> = ref(false)
const error: Ref<AppErrorPayload | null> = ref(null)
const busyId: Ref<string> = ref('')
const settings: Ref<Settings | null> = ref(null)

const flow: Ref<MicrosoftStartResult | null> = ref(null)
const progress: Ref<MicrosoftLoginProgress | null> = ref(null)
const flowError: Ref<AppErrorPayload | null> = ref(null)
const polling: Ref<boolean> = ref(false)
/** Seconds left before the device code expires; drives the countdown chip. */
const secondsLeft: Ref<number> = ref(0)

let pollTimer: number | null = null
let tickTimer: number | null = null
let attached = false
/** Guards the terminal stage: it arrives twice (poll return + `EVENTS.microsoft`). */
let settled = false

function reportError(payload: AppErrorPayload): void {
  useToast().push({ kind: 'danger', title: payload.message, message: payload.detail, duration: 6000 })
}

function describeError(payload: AppErrorPayload): string {
  return payload.detail ? `${payload.message} — ${payload.detail}` : payload.message
}

function clearTimers(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
  pollTimer = null
  if (tickTimer !== null) window.clearInterval(tickTimer)
  tickTimer = null
}

const flowActive = computed(() => flow.value !== null && progress.value?.stage !== 'done' && progress.value?.stage !== 'failed')
const selectedAccount: ComputedRef<Account | null> = computed(
  () => accounts.value.find((entry) => entry.selected) ?? accounts.value[0] ?? null
)
const microsoftConfigured: ComputedRef<boolean> = computed(() => (settings.value?.microsoftClientId ?? '').trim().length > 0)

/** `SkinInfo.previewPng` is a data url in the preview and a temp file path in Electron. */
function skinSrc(value: string): string {
  if (/^(data:|https?:|blob:|file:)/i.test(value)) return value
  return `file:///${value.replace(/\\/g, '/')}`
}

function stopFlow(): void {
  clearTimers()
  polling.value = false
}

function applyProgress(next: MicrosoftLoginProgress): void {
  progress.value = next
  const terminal = next.stage === 'done' || next.stage === 'failed'
  if (terminal && settled) return
  if (terminal) settled = true
  if (next.stage === 'done') {
    stopFlow()
    void loadAccounts()
    useToast().push({ kind: 'success', title: copy.text('loginDone'), message: next.account?.name ?? next.message })
  } else if (next.stage === 'failed') {
    stopFlow()
    useToast().push({ kind: 'danger', titleKey: 'account.loginFailed', message: next.message })
  }
}

async function poll(): Promise<void> {
  const session = flow.value
  if (!session) return
  polling.value = true
  const res = await window.mouc.account.microsoftPoll(session.sessionKey)
  polling.value = false
  if (!res.ok) {
    flowError.value = res.error
    stopFlow()
    reportError(res.error)
    return
  }
  applyProgress(res.data)
  if (flowActive.value && pollTimer === null) schedulePoll()
}

function schedulePoll(): void {
  const intervalSeconds = flow.value?.interval ?? 5
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    void poll()
  }, Math.max(POLL_MIN_MS, intervalSeconds * 1000))
}

function startExpiryClock(totalSeconds: number): void {
  secondsLeft.value = totalSeconds
  if (tickTimer !== null) window.clearInterval(tickTimer)
  tickTimer = window.setInterval(() => {
    secondsLeft.value = Math.max(0, secondsLeft.value - 1)
    if (secondsLeft.value === 0) {
      stopFlow()
      flowError.value = { code: 'cancelled', message: copy.text('codeExpired'), retryable: true }
    }
  }, 1000)
}

async function startMicrosoft(): Promise<boolean> {
  if (!microsoftConfigured.value) return false
  clearTimers()
  settled = false
  flowError.value = null
  progress.value = null
  const res = await window.mouc.account.microsoftStart()
  if (!res.ok) {
    flowError.value = res.error
    reportError(res.error)
    return false
  }
  flow.value = res.data
  startExpiryClock(res.data.expiresIn)
  void poll()
  return true
}

async function cancelMicrosoft(): Promise<void> {
  const session = flow.value
  stopFlow()
  if (!session) {
    progress.value = null
    flowError.value = null
    return
  }
  const res = await window.mouc.account.microsoftCancel(session.sessionKey)
  if (!res.ok) reportError(res.error)
  flow.value = null
  progress.value = null
  secondsLeft.value = 0
}

/** Expired or denied: drop the session and request a brand new device code. */
async function retryMicrosoft(): Promise<boolean> {
  await cancelMicrosoft()
  flowError.value = null
  return startMicrosoft()
}

async function openVerificationPage(): Promise<void> {
  const session = flow.value
  if (!session) return
  const res = await window.mouc.app.openExternal(session.verificationUriComplete || session.verificationUri)
  if (!res.ok) reportError(res.error)
}

async function copyDeviceCode(): Promise<boolean> {
  const code = flow.value?.userCode ?? ''
  if (!code) return false
  try {
    await navigator.clipboard.writeText(code)
  } catch (reason) {
    reportError({ code: 'internal', message: copy.text('copyFailed'), detail: String(reason) })
    return false
  }
  useToast().push({ kind: 'success', titleKey: 'common.copyDone', message: code })
  return true
}

async function loadSettings(): Promise<void> {
  const res = await window.mouc.settings.get()
  if (res.ok) settings.value = res.data
  else reportError(res.error)
}

/** Client id entered from the inline setup panel; the flow is gated on it. */
async function saveClientId(value: string): Promise<boolean> {
  const trimmed = value.trim()
  const res = await window.mouc.settings.set({ microsoftClientId: trimmed })
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  settings.value = res.data
  useToast().push({ kind: 'success', titleKey: 'settings.saved' })
  return true
}

async function loadAccounts(): Promise<void> {
  loading.value = true
  error.value = null
  const res = await window.mouc.account.list()
  if (!res.ok) {
    error.value = res.error
    loading.value = false
    reportError(res.error)
    return
  }
  accounts.value = res.data
  loading.value = false
  // Skins are best-effort: one failing head must never blank the page.
  const next: Record<string, SkinInfo> = {}
  await Promise.all(
    res.data.map(async (account) => {
      const skin = await window.mouc.account.skin(account.id)
      if (skin.ok) next[account.id] = skin.data
    })
  )
  skins.value = next
}

async function select(id: string): Promise<boolean> {
  busyId.value = id
  const res = await window.mouc.account.select(id)
  busyId.value = ''
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  accounts.value = accounts.value.map((entry) => ({ ...entry, selected: entry.id === id }))
  return true
}

async function refresh(id: string): Promise<boolean> {
  busyId.value = id
  const res = await window.mouc.account.refresh(id)
  busyId.value = ''
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  accounts.value = accounts.value.map((entry) => (entry.id === id ? res.data : entry))
  useToast().push({ kind: 'success', title: copy.text('refreshOk'), message: res.data.name })
  return true
}

async function remove(id: string): Promise<boolean> {
  busyId.value = id
  const res = await window.mouc.account.remove(id)
  busyId.value = ''
  if (!res.ok) {
    reportError(res.error)
    return false
  }
  accounts.value = accounts.value.filter((entry) => entry.id !== id)
  delete skins.value[id]
  return true
}

async function addOffline(name: string, uuid?: string): Promise<Account | null> {
  const res = await window.mouc.account.addOffline(uuid ? { name, uuid } : { name })
  if (!res.ok) {
    reportError(res.error)
    return null
  }
  accounts.value = [...accounts.value, res.data]
  const skin = await window.mouc.account.skin(res.data.id)
  if (skin.ok) skins.value = { ...skins.value, [res.data.id]: skin.data }
  useToast().push({ kind: 'success', titleKey: 'account.addOffline', message: res.data.name })
  return res.data
}

function attach(): void {
  if (attached) return
  attached = true
  window.mouc.on(EVENTS.microsoft, (payload) => {
    const next = payload as MicrosoftLoginProgress
    if (flow.value && next.sessionKey === flow.value.sessionKey) applyProgress(next)
  })
  window.mouc.on(EVENTS.settings, (payload) => {
    settings.value = payload as Settings
  })
}

export interface AccountsStore {
  accounts: Ref<Account[]>
  skins: Ref<Record<string, SkinInfo>>
  loading: Ref<boolean>
  error: Ref<AppErrorPayload | null>
  busyId: Ref<string>
  settings: Ref<Settings | null>
  selectedAccount: ComputedRef<Account | null>
  microsoftConfigured: ComputedRef<boolean>

  flow: Ref<MicrosoftStartResult | null>
  progress: Ref<MicrosoftLoginProgress | null>
  flowError: Ref<AppErrorPayload | null>
  polling: Ref<boolean>
  flowActive: ComputedRef<boolean>
  secondsLeft: Ref<number>

  skinSrc: (value: string) => string
  describeError: (payload: AppErrorPayload) => string
  loadSettings: () => Promise<void>
  loadAccounts: () => Promise<void>
  select: (id: string) => Promise<boolean>
  refresh: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  addOffline: (name: string, uuid?: string) => Promise<Account | null>
  startMicrosoft: () => Promise<boolean>
  cancelMicrosoft: () => Promise<void>
  retryMicrosoft: () => Promise<boolean>
  openVerificationPage: () => Promise<void>
  copyDeviceCode: () => Promise<boolean>
  saveClientId: (value: string) => Promise<boolean>
}

export function useAccounts(): AccountsStore {
  attach()
  return {
    accounts,
    skins,
    loading,
    error,
    busyId,
    settings,
    selectedAccount,
    microsoftConfigured,
    flow,
    progress,
    flowError,
    polling,
    flowActive,
    secondsLeft,
    skinSrc,
    describeError,
    loadSettings,
    loadAccounts,
    select,
    refresh,
    remove,
    addOffline,
    startMicrosoft,
    cancelMicrosoft,
    retryMicrosoft,
    openVerificationPage,
    copyDeviceCode,
    saveClientId
  }
}

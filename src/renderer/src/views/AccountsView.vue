<script setup lang="ts">
/**
 * AccountsView — account cards, offline add, and the Microsoft device-code flow.
 *
 * The flow is rendered straight from the store (`mouc.account.microsoftStart` + repeated
 * `microsoftPoll`), one stepper row per `LoginStage`, so the progress survives leaving the
 * view. Without a `microsoftClientId` the flow cannot start at all: the setup instructions
 * are shown inline instead of a spinner.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import type { Account, LoginStage, TokenState } from '@shared/types'
import { defineDict, t } from '../i18n'
import { LOGIN_STAGES, useAccounts } from '../stores/useAccounts'
import { useModal } from '../composables/useModal'
import { formatDateTime, formatDuration, formatRelative } from '../composables/format'
import MIcon from '../components/icons/MIcon.vue'
import MButton from '../components/ui/MButton.vue'
import MIconButton from '../components/ui/MIconButton.vue'
import MCard from '../components/ui/MCard.vue'
import MEmpty from '../components/ui/MEmpty.vue'
import MFieldRow from '../components/ui/MFieldRow.vue'
import MInput from '../components/ui/MInput.vue'
import MModal from '../components/ui/MModal.vue'
import MSkeleton from '../components/ui/MSkeleton.vue'
import MTag from '../components/ui/MTag.vue'
import MTooltip from '../components/ui/MTooltip.vue'

const copy = defineDict({
  subtitle: ['启动器用这里的账户进入游戏；正版账户走微软设备码流程，离线账户只用于本地或离线服务器。', 'The launcher signs in with one of these. Official accounts use the Microsoft device-code flow; offline accounts work locally only.'],
  typeMicrosoft: ['正版', 'Official'],
  typeOffline: ['离线', 'Offline'],
  typeYggdrasil: ['Yggdrasil', 'Yggdrasil'],
  typeAuthlib: ['authlib-injector', 'authlib-injector'],
  active: ['当前账户', 'Active'],
  setActive: ['设为当前', 'Set active'],
  refreshToken: ['刷新令牌', 'Refresh token'],
  removeAccount: ['移除账户', 'Remove account'],
  removeBody: ['移除「{name}」？本地保存的令牌会一并删除。', 'Remove “{name}”? The stored token is deleted as well.'],
  emptyTitle: ['还没有账户', 'No accounts yet'],
  emptyHint: ['添加一个离线账户先玩起来，或用微软账户登录以进入正版服务器。', 'Add an offline account to play now, or sign in with Microsoft for official servers.'],
  deviceTitle: ['微软设备码登录', 'Microsoft device-code sign-in'],
  deviceHint: ['在任意设备上打开下面的地址并输入代码，完成后可关闭此页面。', 'Open the address on any device and enter the code. You may close this page afterwards.'],
  openVerifyPage: ['打开验证页', 'Open verification page'],
  copyCode: ['复制代码', 'Copy code'],
  expires: ['代码剩余有效时间 {time}', 'Code valid for {time}'],
  cancelLogin: ['取消登录', 'Cancel sign-in'],
  retryLogin: ['重新开始', 'Start over'],
  clientIdTitle: ['需要先配置客户端 ID', 'A client id is required first'],
  clientIdBody: [
    '启动器不内置任何 Azure 客户端 ID。设备码流程需要 settings.microsoftClientId 有值，否则无法向 login.microsoftonline.com 申请代码。',
    'No Azure client id is bundled. The device-code flow needs settings.microsoftClientId, otherwise no code can be requested.'
  ],
  clientIdStep1: [
    '在 portal.azure.com 注册应用（公共客户端，无需重定向 URI）',
    'Register an app in portal.azure.com (public client, no redirect URI needed)'
  ],
  clientIdStep2: [
    '为应用添加 delegated 权限 XboxLive.signin 与 offline_access',
    'Add the delegated permissions XboxLive.signin and offline_access'
  ],
  clientIdStep3: [
    '复制“应用程序(客户端) ID”填入下方并保存',
    'Copy the application (client) id into the field below and save'
  ],
  clientIdLabel: ['客户端 ID', 'Client id'],
  docsPath: ['docs/microsoft-auth.md', 'docs/microsoft-auth.md'],
  docsHint: ['完整链路与已验证/未验证的部分见', 'The full flow and what is still unverified are documented in'],
  offlineTitle: ['添加离线账户', 'Add an offline account'],
  nameLabel: ['游戏名', 'Player name'],
  nameHint: ['1-16 位字母、数字或下划线。', '1-16 letters, digits or underscore.'],
  uuidLabel: ['UUID', 'UUID'],
  uuidHint: ['留空则自动生成一个离线 UUID。', 'Leave empty to generate one.'],
  nameRequired: ['请输入游戏名', 'A player name is required'],
  lastUsed: ['最近使用 {time}', 'Last used {time}'],
  addedAt: ['添加于 {time}', 'Added {time}'],
  skinAlt: ['皮肤预览', 'Skin preview'],
  model: ['模型', 'Model'],
  modelSlim: ['纤细', 'Slim'],
  modelClassic: ['经典', 'Classic']
})

/** One dict entry per `LoginStage` so the stepper labels stay translatable. */
const stageDict = defineDict({
  'waiting-user': ['等待浏览器授权', 'Awaiting browser authorisation'],
  'microsoft-ok': ['微软令牌', 'Microsoft token'],
  'xbox-ok': ['Xbox Live', 'Xbox Live'],
  'live-ok': ['XBL 令牌', 'XBL token'],
  'minecraft-ok': ['Minecraft 令牌', 'Minecraft token'],
  'profile-ok': ['玩家档案', 'Player profile'],
  done: ['登录完成', 'Signed in'],
  failed: ['登录失败', 'Failed']
})

const store = reactive(useAccounts())
const modal = useModal()

const offlineOpen = ref(false)
const offlineName = ref('')
const offlineUuid = ref('')
const formError = ref('')
const clientIdDraft = ref('')
const brokenSkins = ref<Set<string>>(new Set())

const tokenTone: Record<TokenState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  valid: 'success',
  'needs-refresh': 'warning',
  invalid: 'danger',
  none: 'neutral'
}

const stageIndex = computed(() => {
  const stage = store.progress?.stage
  if (!stage || stage === 'failed') return -1
  return LOGIN_STAGES.indexOf(stage)
})

const flowFailed = computed(() => store.progress?.stage === 'failed' || store.flowError !== null)

const clientIdSteps = computed(() => [copy.text('clientIdStep1'), copy.text('clientIdStep2'), copy.text('clientIdStep3')])

function typeLabel(account: Account): string {
  if (account.type === 'microsoft') return copy.text('typeMicrosoft')
  if (account.type === 'offline') return copy.text('typeOffline')
  if (account.type === 'yggdrasil') return copy.text('typeYggdrasil')
  return copy.text('typeAuthlib')
}

function typeTone(account: Account): 'success' | 'neutral' {
  return account.type === 'microsoft' ? 'success' : 'neutral'
}

function tokenLabel(account: Account): string {
  if (account.tokenState === 'valid') return t('account.token.valid')
  if (account.tokenState === 'needs-refresh') return t('account.token.needsRefresh')
  if (account.tokenState === 'invalid') return t('account.token.invalid')
  return t('account.token.none')
}

function stageLabel(stage: LoginStage): string {
  return stageDict.text(stage)
}

function skinFor(account: Account): string | null {
  const info = store.skins[account.id]
  if (!info || brokenSkins.value.has(account.id)) return null
  return store.skinSrc(info.previewPng)
}

function onSkinError(account: Account): void {
  brokenSkins.value = new Set([...brokenSkins.value, account.id])
}

function modelLabel(account: Account): string {
  const model = store.skins[account.id]?.model
  if (!model) return ''
  return model === 'slim' ? copy.text('modelSlim') : copy.text('modelClassic')
}

function expiresIn(account: Account): string {
  if (!account.expiresAt) return ''
  return t('account.expiresAt', { time: formatDuration(Math.max(0, account.expiresAt - Date.now())) })
}

async function onRemove(account: Account): Promise<void> {
  const confirmed = await modal.confirm({
    titleKey: 'account.title',
    text: copy.text('removeBody', { name: account.name }),
    confirmKey: 'common.delete',
    cancelKey: 'common.cancel',
    tone: 'danger'
  })
  if (!confirmed) return
  await store.remove(account.id)
}

async function onSubmitOffline(): Promise<void> {
  if (offlineName.value.trim().length === 0) {
    formError.value = copy.text('nameRequired')
    return
  }
  formError.value = ''
  const created = await store.addOffline(offlineName.value.trim(), offlineUuid.value.trim() || undefined)
  if (!created) return
  offlineOpen.value = false
  offlineName.value = ''
  offlineUuid.value = ''
}

async function onStartMicrosoft(): Promise<void> {
  await store.startMicrosoft()
}

async function onSaveClientId(): Promise<void> {
  await store.saveClientId(clientIdDraft.value)
}

onMounted(async () => {
  clientIdDraft.value = store.settings?.microsoftClientId ?? ''
  await Promise.all([store.loadSettings(), store.loadAccounts()])
  clientIdDraft.value = store.settings?.microsoftClientId ?? ''
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div class="head-text">
        <h1 class="title">{{ t('account.title') }}</h1>
        <p class="sub">{{ copy.text('subtitle') }}</p>
      </div>
      <div class="head-tools">
        <MButton variant="ghost" icon="refresh" :loading="store.loading" @click="store.loadAccounts()">
          {{ t('common.refresh') }}
        </MButton>
        <MButton variant="outline" icon="plus" @click="offlineOpen = true">{{ t('account.addOffline') }}</MButton>
        <MTooltip
          :content="store.microsoftConfigured ? t('account.addMicrosoft') : copy.text('clientIdTitle')"
          :disabled="store.microsoftConfigured"
        >
          <MButton
            variant="primary"
            icon="user"
            :disabled="!store.microsoftConfigured || store.flowActive"
            :loading="store.polling && store.flowActive"
            @click="onStartMicrosoft"
          >
            {{ t('account.addMicrosoft') }}
          </MButton>
        </MTooltip>
      </div>
    </header>

    <!-- ================================================== client id required -->
    <MCard v-if="!store.microsoftConfigured" icon="warning" :title="copy.text('clientIdTitle')" class="notice">
      <p class="notice-body">{{ copy.text('clientIdBody') }}</p>
      <ol class="steps">
        <li v-for="(line, index) in clientIdSteps" :key="line">{{ index + 1 }}. {{ line }}</li>
      </ol>
      <div class="inline-form">
        <MFieldRow :label="copy.text('clientIdLabel')" :hint="`${copy.text('docsHint')} ${copy.text('docsPath')}`" :inline="false">
          <MInput v-model="clientIdDraft" mono :placeholder="'e8f9d8b4-…'" clearable />
        </MFieldRow>
        <MButton variant="primary" icon="check" @click="onSaveClientId">{{ t('common.save') }}</MButton>
      </div>
    </MCard>

    <!-- ==================================================== device-code flow -->
    <MCard v-else-if="store.flow" icon="key" :title="copy.text('deviceTitle')" :subtitle="copy.text('deviceHint')">
      <div class="device">
        <div class="code-block">
          <p class="code-label">{{ t('account.deviceCode') }}</p>
          <p class="code" :class="{ 'is-done': stageIndex === LOGIN_STAGES.length - 1 }">{{ store.flow.userCode }}</p>
          <div class="u-row u-wrap">
            <MButton size="sm" variant="outline" icon="copy" @click="store.copyDeviceCode()">{{ copy.text('copyCode') }}</MButton>
            <MButton size="sm" variant="primary" icon="external" @click="store.openVerificationPage()">
              {{ copy.text('openVerifyPage') }}
            </MButton>
          </div>
          <p class="code-uri u-mono u-truncate">{{ store.flow.verificationUri }}</p>
          <p v-if="store.flowActive" class="remain">
            <MIcon name="clock" :size="16" tone="muted" />
            {{ copy.text('expires', { time: formatDuration(store.secondsLeft * 1000) }) }}
          </p>
        </div>

        <ol class="stages">
          <li
            v-for="(stage, index) in [...LOGIN_STAGES, 'failed']"
            :key="stage"
            class="stage"
            :class="{
              'is-done': stageIndex >= 0 && index < stageIndex,
              'is-active': index === stageIndex,
              'is-failed': flowFailed && stage === 'failed',
              'is-hidden': stage === 'failed' && !flowFailed
            }"
          >
            <span class="stage-mark">
              <MIcon v-if="stage === 'failed' && flowFailed" name="x" :size="16" tone="danger" />
              <MIcon v-else-if="stageIndex >= 0 && index < stageIndex" name="check" :size="16" tone="success" />
              <MIcon v-else-if="index === stageIndex" name="refresh" :size="16" tone="accent" spin />
              <MIcon v-else name="clock" :size="16" tone="muted" />
            </span>
            <span class="stage-name u-truncate">{{ stageLabel(stage) }}</span>
            <span v-if="index === stageIndex && store.progress" class="stage-msg u-truncate">{{ store.progress.message }}</span>
          </li>
        </ol>
      </div>

      <div v-if="flowFailed" class="state-error" role="alert">
        <MIcon name="warning" :size="20" tone="danger" />
        <div class="u-grow">
          <p class="state-title">{{ store.flowError ? store.flowError.message : t('account.loginFailed') }}</p>
          <p v-if="store.flowError?.detail" class="state-detail u-mono u-truncate">{{ store.flowError.detail }}</p>
          <p v-else class="state-detail">{{ t('account.deviceCodeHint', { url: store.flow.verificationUri }) }}</p>
        </div>
        <MButton size="sm" variant="outline" icon="refresh" @click="store.retryMicrosoft()">{{ copy.text('retryLogin') }}</MButton>
      </div>

      <template #footer>
        <div class="u-between">
          <span class="u-num muted">{{ store.progress ? store.progress.message : t('account.waitForLogin') }}</span>
          <MButton size="sm" variant="ghost" icon="x" @click="store.cancelMicrosoft()">{{ copy.text('cancelLogin') }}</MButton>
        </div>
      </template>
    </MCard>

    <!-- ======================================================== account grid -->
    <div v-if="store.loading && store.accounts.length === 0" class="grid" aria-busy="true">
      <div v-for="n in 3" :key="n" class="sk-card">
        <MSkeleton variant="rect" width="48px" height="48px" rounded="var(--m-r-sm)" />
        <div class="sk-lines">
          <MSkeleton variant="line" width="42%" height="16px" />
          <MSkeleton variant="line" :lines="2" height="12px" />
        </div>
      </div>
    </div>

    <div v-else-if="store.error" class="state-error" role="alert">
      <MIcon name="warning" :size="20" tone="danger" />
      <div class="u-grow">
        <p class="state-title">{{ store.error.message }}</p>
        <p v-if="store.error.detail" class="state-detail u-mono u-truncate">{{ store.error.detail }}</p>
      </div>
      <MButton size="sm" variant="outline" icon="refresh" @click="store.loadAccounts()">{{ t('common.retry') }}</MButton>
    </div>

    <MCard v-else-if="store.accounts.length === 0" icon="user" :title="t('account.title')">
      <MEmpty icon="users" :title="copy.text('emptyTitle')" :description="copy.text('emptyHint')">
        <div class="u-row u-wrap">
          <MButton variant="outline" icon="plus" @click="offlineOpen = true">{{ t('account.addOffline') }}</MButton>
          <MButton variant="primary" icon="user" :disabled="!store.microsoftConfigured" @click="onStartMicrosoft">
            {{ t('account.addMicrosoft') }}
          </MButton>
        </div>
      </MEmpty>
    </MCard>

    <div v-else class="grid">
      <article
        v-for="account in store.accounts"
        :key="account.id"
        class="acc"
        :class="{ 'is-active': account.selected }"
      >
        <div class="acc-head">
          <span class="head-skin">
            <img
              v-if="skinFor(account)"
              :src="skinFor(account) ?? undefined"
              :alt="copy.text('skinAlt')"
              width="48"
              height="48"
              @error="onSkinError(account)"
            />
            <MIcon v-else name="user" :size="24" tone="muted" />
          </span>
          <div class="u-grow">
            <p class="acc-name u-truncate">{{ account.name }}</p>
            <p class="acc-label u-mono u-truncate">{{ account.label }}</p>
          </div>
          <div class="acc-badges">
            <MTag size="sm" :tone="typeTone(account)">{{ typeLabel(account) }}</MTag>
            <MTag v-if="account.selected" size="sm" tone="accent" dot>{{ copy.text('active') }}</MTag>
          </div>
        </div>

        <div class="acc-body">
          <MTag size="sm" :tone="tokenTone[account.tokenState]" :dot="account.tokenState === 'valid'">
            {{ tokenLabel(account) }}
          </MTag>
          <span v-if="expiresIn(account)" class="u-num warn">{{ expiresIn(account) }}</span>
          <span class="u-num muted">{{ copy.text('lastUsed', { time: formatRelative(account.lastUsedAt) }) }}</span>
          <span class="u-num muted">{{ copy.text('addedAt', { time: formatDateTime(account.addedAt) }) }}</span>
          <span v-if="modelLabel(account)" class="u-num muted">
            {{ copy.text('model') }}: {{ modelLabel(account) }}
          </span>
        </div>

        <p class="acc-uuid u-mono u-truncate">{{ account.uuid }}</p>

        <div class="acc-foot">
          <MButton
            size="sm"
            :variant="account.selected ? 'ghost' : 'primary'"
            icon="check"
            :disabled="account.selected"
            :loading="store.busyId === account.id"
            @click="store.select(account.id)"
          >
            {{ account.selected ? t('account.selected') : copy.text('setActive') }}
          </MButton>
          <MTooltip
            v-if="account.type !== 'offline'"
            :content="account.tokenState === 'needs-refresh' ? t('account.token.needsRefresh') : copy.text('refreshToken')"
            placement="left"
          >
            <MIconButton
              icon="refresh"
              size="sm"
              :label="copy.text('refreshToken')"
              :loading="store.busyId === account.id"
              @click="store.refresh(account.id)"
            />
          </MTooltip>
          <MTooltip :content="t('common.delete')" placement="left">
            <MIconButton icon="trash" tone="danger" size="sm" :label="copy.text('removeAccount')" @click="onRemove(account)" />
          </MTooltip>
        </div>
      </article>
    </div>

    <!-- ==================================================== offline dialog -->
    <MModal
      v-model:open="offlineOpen"
      :title="copy.text('offlineTitle')"
      :width="440"
      :confirm-text="t('common.add')"
      :cancel-text="t('common.cancel')"
      @confirm="onSubmitOffline"
    >
      <div class="u-col">
        <MFieldRow :label="copy.text('nameLabel')" :hint="copy.text('nameHint')" :error="formError" :inline="false">
          <MInput v-model="offlineName" autofocus :maxlength="16" :placeholder="'Steve_233'" @enter="onSubmitOffline" />
        </MFieldRow>
        <MFieldRow :label="copy.text('uuidLabel')" :hint="copy.text('uuidHint')" :inline="false">
          <MInput v-model="offlineUuid" mono clearable :placeholder="t('common.optional')" />
        </MFieldRow>
      </div>
    </MModal>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-4);
  min-height: 100%;
  padding: var(--m-sp-5) var(--m-sp-6) var(--m-sp-7);
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--m-sp-4);
  flex-wrap: wrap;
}

.title {
  font-size: var(--m-fs-20);
  line-height: var(--m-lh-tight);
}

.sub {
  max-width: 68ch;
  margin-top: var(--m-sp-1);
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.head-tools {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
}

.notice {
  border-color: var(--m-warning);
}

.notice-body {
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.steps {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
  margin: var(--m-sp-3) 0;
  padding-left: var(--m-sp-4);
  font-size: var(--m-fs-13);
  color: var(--m-text-primary);
  list-style: decimal;
}

.inline-form {
  display: flex;
  align-items: flex-end;
  gap: var(--m-sp-3);
  flex-wrap: wrap;
}

/* --------------------------------------------------------------- flow card */
.device {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
  gap: var(--m-sp-5);
  align-items: start;
}

.code-block {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  padding: var(--m-sp-4);
  border: var(--m-line) solid var(--m-border-accent);
  border-radius: var(--m-r-md);
  background: var(--m-surface-sunken);
}

.code-label {
  font-size: var(--m-fs-12);
  letter-spacing: 0.06em;
  color: var(--m-text-muted);
}

.code {
  font-family: var(--m-font-mono);
  font-size: var(--m-fs-32);
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--m-accent-text);
}

.code.is-done {
  color: var(--m-success);
}

.code-uri {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.u-row > .u-num {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-1);
}

.remain {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-1);
  font-family: var(--m-font-mono);
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.stages {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-1);
}

.stage {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  padding: var(--m-sp-2);
  border-radius: var(--m-r-sm);
  font-size: var(--m-fs-13);
  color: var(--m-text-secondary);
}

.stage.is-hidden {
  display: none;
}

.stage.is-active {
  background: var(--m-accent-soft);
  color: var(--m-text-primary);
}

.stage.is-done .stage-name {
  color: var(--m-text-primary);
}

.stage.is-failed {
  background: var(--m-danger-soft);
  color: var(--m-text-primary);
}

.stage-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
}

.stage-name {
  flex: 0 0 auto;
  font-weight: 500;
}

.stage-msg {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

/* -------------------------------------------------------------- accounts */
.grid {
  display: grid;
  /* Capped track width: two accounts on a 1680px stage must not stretch to 700px cards. */
  grid-template-columns: repeat(auto-fill, minmax(320px, 420px));
  gap: var(--m-sp-4);
}

.sk-card {
  display: flex;
  gap: var(--m-sp-3);
  padding: var(--m-sp-4);
  border: var(--m-line) solid var(--m-border-hairline);
  border-radius: var(--m-r-md);
}

.sk-lines {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-2);
  flex: 1 1 auto;
}

.acc {
  display: flex;
  flex-direction: column;
  gap: var(--m-sp-3);
  padding: var(--m-sp-4);
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-md);
  background: var(--m-surface-raised);
}

.acc.is-active {
  border-color: var(--m-border-accent);
  box-shadow: var(--m-shadow-sm);
}

.acc-head {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
}

.head-skin {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  flex: none;
  overflow: hidden;
  border: var(--m-line) solid var(--m-border-weak);
  border-radius: var(--m-r-sm);
  background: var(--m-surface-sunken);
}

.head-skin img {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}

.acc-name {
  font-size: var(--m-fs-14);
  font-weight: 600;
}

.acc-label {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.acc-badges {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--m-sp-1);
  flex: none;
}

.acc-body {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  flex-wrap: wrap;
  font-size: var(--m-fs-12);
}

.muted {
  color: var(--m-text-muted);
}

.warn {
  color: var(--m-warning);
}

.acc-uuid {
  font-size: var(--m-fs-12);
  color: var(--m-text-muted);
}

.acc-foot {
  display: flex;
  align-items: center;
  gap: var(--m-sp-2);
  padding-top: var(--m-sp-2);
  border-top: var(--m-line) solid var(--m-border-hairline);
}

.acc-foot .u-grow {
  flex: 1 1 auto;
}

/* ---------------------------------------------------------------- states */
.state-error {
  display: flex;
  align-items: center;
  gap: var(--m-sp-3);
  padding: var(--m-sp-3);
  border: var(--m-line) solid var(--m-danger);
  border-radius: var(--m-r-sm);
  background: var(--m-danger-soft);
}

.state-title {
  font-size: var(--m-fs-13);
  font-weight: 600;
}

.state-detail {
  font-size: var(--m-fs-12);
  color: var(--m-text-secondary);
}
</style>

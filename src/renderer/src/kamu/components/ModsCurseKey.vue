<script setup lang="ts">
/**
 * ModsCurseKey — the inline CurseForge explanation card.
 *
 * `ModService` answers `unsupported`（「未配置 CurseForge API Key」）for every CurseForge call
 * while the key is empty, so the browse tab shows this card instead of a request that cannot
 * succeed: one field that writes the key through `settings.set`, the free developer-portal
 * link, and a jump to the settings page. The stored config field name never appears here.
 */
import { ref, watch } from 'vue'
import { defineDict } from '../../i18n'

const props = defineProps<{
  current: string
  saving: boolean
  error: string
}>()

const emit = defineEmits<{
  (e: 'save', value: string): void
  (e: 'open-settings'): void
}>()

const copy = defineDict({
  title: ['CurseForge 需要 API Key', 'CurseForge needs an API key'],
  body: [
    'CurseForge 官方接口要求一把免费注册的 API Key。没有它时仓库会直接回答「不支持」，本页不会发起注定失败的请求，也不会留下转圈的列表。',
    'The CurseForge API requires a free key. Without one the repository answers “unsupported”, so this page skips a request that cannot succeed instead of leaving the list spinning.'
  ],
  field: ['CurseForge API Key', 'CurseForge API Key'],
  placeholder: ['粘贴 Key 后即可浏览 CurseForge', 'Paste a key to browse CurseForge'],
  save: ['保存并搜索', 'Save and search'],
  saving: ['保存中…', 'Saving…'],
  portal: ['到 console.curseforge.com 免费申请', 'Get one free at console.curseforge.com'],
  settings: ['在设置中管理', 'Manage in settings'],
  hint: ['Key 只写入本机配置，Modrinth 不需要它。', 'The key stays in this machine’s config; Modrinth never needs one.']
})

const draft = ref(props.current)

watch(
  () => props.current,
  (value) => {
    draft.value = value
  }
)

function submit(): void {
  if (props.saving || !draft.value.trim()) return
  emit('save', draft.value.trim())
}
</script>

<template>
  <section class="card mods-key-card" role="note">
    <header class="mods-key-head">
      <span class="mods-key-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="14" r="4" />
          <path d="M11 11 20 2M16 6l2 2M14 8l2 2" />
        </svg>
      </span>
      <div>
        <h3>{{ copy.text('title') }}</h3>
        <p class="muted">{{ copy.text('body') }}</p>
      </div>
    </header>

    <form class="mods-key-form" @submit.prevent="submit">
      <label class="mods-key-field">
        <span>{{ copy.text('field') }}</span>
        <input
          v-model="draft"
          class="input mono"
          type="password"
          :placeholder="copy.text('placeholder')"
          spellcheck="false"
          autocomplete="off"
          aria-label="CurseForge API Key"
        />
      </label>
      <div class="mods-key-actions">
        <button class="btn btn-gold" type="submit" :disabled="saving || !draft.trim()">
          <span v-if="saving" class="spin" aria-hidden="true"></span>
          {{ saving ? copy.text('saving') : copy.text('save') }}
        </button>
        <button class="btn btn-ghost" type="button" @click="emit('open-settings')">{{ copy.text('settings') }}</button>
      </div>
    </form>

    <p v-if="error" class="mods-key-error" role="alert">{{ error }}</p>
    <p class="muted mods-key-hint">
      <a class="mods-key-link" href="https://console.curseforge.com/" target="_blank" rel="noreferrer">{{ copy.text('portal') }}</a>
      · {{ copy.text('hint') }}
    </p>
  </section>
</template>

<style scoped>
.mods-key-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
}
.mods-key-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
.mods-key-head h3 {
  font-size: var(--text-lg);
  font-weight: 700;
}
.mods-key-head p {
  margin-top: 4px;
  font-size: var(--text-sm);
  line-height: 1.7;
  max-width: 76ch;
}
.mods-key-glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  color: var(--accent-2);
}
.mods-key-glyph svg {
  width: 20px;
  height: 20px;
}
.mods-key-form {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.mods-key-field {
  display: flex;
  flex: 1 1 280px;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.mods-key-field .input {
  width: 100%;
}
.mods-key-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.mods-key-error {
  color: var(--danger);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.mods-key-hint {
  font-size: var(--text-xs);
  line-height: 1.7;
}
.mods-key-link {
  color: var(--accent-2);
}
</style>

<script setup lang="ts">
/**
 * 账号方块头像 —— upstream `Avatar.vue` 的形状（皮肤图 + 首字母兜底），数据源换成
 * `mouc.account.skin()`。主进程返回的是临时 PNG 的绝对路径，浏览器里是 data URL，
 * 所以无协议前缀的路径要先转成 `file://` 才能作为 `<img>` 的 src。
 * 皮肤是装饰信息：失败时静默回落首字母（与 upstream 一致），避免每个列表行都弹 toast。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import type { Account } from '@shared/types'
import { accountSkin } from '../api/accounts'

const props = withDefaults(defineProps<{ account: Account; size?: number }>(), { size: 42 })

const src = ref('')
let generation = 0
onUnmounted(() => {
  generation += 1
})

function toImgSrc(target: string): string {
  if (!target) return ''
  if (/^(data:|blob:|https?:|file:)/i.test(target)) return target
  return `file:///${target.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

async function load(): Promise<void> {
  const request = (generation += 1)
  src.value = ''
  try {
    const skin = await accountSkin(props.account.id)
    const resolved = toImgSrc(skin.previewPng)
    // 列表在加载期间被刷新则丢弃过期结果
    if (request === generation) src.value = resolved
  } catch {
    /* 装饰性失败，见文件头 */
  }
}

watch(() => props.account.id, load, { immediate: true })

const letter = computed(() => props.account.name.charAt(0).toUpperCase() || '?')
const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
const fontPx = computed(() => `${Math.round(props.size * 0.42)}px`)
</script>

<template>
  <img
    v-if="src"
    class="mc-avatar"
    :src="src"
    :style="boxStyle"
    :alt="`${props.account.name} 的皮肤预览`"
    @error="src = ''"
  />
  <div v-else class="mc-avatar letter" :style="{ ...boxStyle, fontSize: fontPx }">
    {{ letter }}
  </div>
</template>

<style scoped>
.mc-avatar {
  border-radius: var(--radius-md);
  image-rendering: pixelated;
  flex-shrink: 0;
}
.letter {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: var(--on-accent);
  background: var(--accent-grad);
  border-radius: 50%;
}
</style>

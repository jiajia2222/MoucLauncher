<script setup lang="ts">
/**
 * Loading skeleton for the ported mod pages — the markup and row metrics come straight from
 * KAMUCL's `components/ContentSkeleton.vue` (MIT); the browse grid gets a card-shaped variant
 * because upstream renders that list as a card grid rather than rows.
 */
import { onMounted, onUnmounted, ref } from 'vue'

withDefaults(
  defineProps<{ label?: string; rows?: number; variant?: 'rows' | 'cards'; retry?: boolean }>(),
  { label: '正在加载…', rows: 5, variant: 'rows', retry: false }
)
defineEmits<{ retry: [] }>()

const delayed = ref(false)
let timer: ReturnType<typeof setTimeout>
onMounted(() => {
  timer = setTimeout(() => {
    delayed.value = true
  }, 8000)
})
onUnmounted(() => clearTimeout(timer))
</script>

<template>
  <div class="content-skeleton" role="status" aria-busy="true">
    <span class="muted">{{ label }}</span>
    <p v-if="delayed" class="muted">
      数据仍未返回，请检查网络或目录是否可用。<button v-if="retry" class="btn btn-ghost btn-sm" @click="$emit('retry')">重新读取</button>
    </p>
    <div v-if="variant === 'cards'" class="skeleton-grid" aria-hidden="true">
      <div v-for="row in rows" :key="row" class="skeleton-card"><i /><span /><b /><em /></div>
    </div>
    <template v-else>
      <div v-for="row in rows" :key="row" class="skeleton-row" aria-hidden="true"><i /><span /><b /></div>
    </template>
  </div>
</template>

<style scoped>
.content-skeleton { display: grid; gap: 12px; padding: 16px 0 }
.skeleton-row { display: flex; align-items: center; gap: 16px; height: 48px }
.skeleton-row i, .skeleton-row span, .skeleton-row b,
.skeleton-card i, .skeleton-card span, .skeleton-card b, .skeleton-card em {
  background: color-mix(in srgb, var(--text) 9%, var(--card));
  border-radius: var(--radius-sm);
}
.skeleton-row i { width: 36px; height: 36px }
.skeleton-row span { flex: 1; height: 18px; max-width: 65% }
.skeleton-row b { margin-left: auto; width: 76px; height: 32px }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: var(--space-3) }
.skeleton-card { display: flex; flex-direction: column; gap: 10px; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg) }
.skeleton-card i { width: 46px; height: 46px; border-radius: var(--radius-md) }
.skeleton-card span { height: 16px; width: 78% }
.skeleton-card b { height: 12px; width: 96% }
.skeleton-card em { height: 12px; width: 46% }
</style>

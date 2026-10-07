<script setup lang="ts">
/**
 * Theme switcher: upstream's floating menu pattern (`.menu-overlay` + `.float-menu` +
 * `.menu-item` from `kamu.css`) anchored above the sidebar footer, listing all six
 * palettes the ported theme layer ships.
 */
import { computed } from 'vue'
import { copy } from './copy'
import { PALETTES, paletteColors, type PaletteName } from './theme'

const props = defineProps<{ current: PaletteName }>()
const emit = defineEmits<{ close: []; pick: [name: PaletteName] }>()

const LABELS: Record<PaletteName, () => string> = {
  transparent: () => copy.text('paletteDefault'),
  'blue-white': () => copy.text('paletteBlueWhite'),
  'black-orange': () => copy.text('paletteBlackOrange'),
  'white-pink': () => copy.text('paletteWhitePink'),
  'black-pink': () => copy.text('paletteBlackPink'),
  custom: () => copy.text('paletteCustom')
}

const rows = computed(() =>
  PALETTES.map((entry) => {
    const colors = paletteColors(entry.name)
    return {
      name: entry.name,
      label: LABELS[entry.name](),
      accent: colors.accent,
      bg: colors.bg,
      text: colors.text
    }
  })
)
</script>

<template>
  <Teleport to="body">
    <div class="menu-overlay" @click="emit('close')"></div>
    <div class="float-menu palette-menu" role="menu" :aria-label="copy.text('themeGroup')">
      <p class="menu-group-label">{{ copy.text('themeGroup') }}</p>
      <button
        v-for="row in rows"
        :key="row.name"
        class="menu-item"
        :class="{ active: row.name === props.current }"
        role="menuitemradio"
        :aria-checked="row.name === props.current"
        @click="emit('pick', row.name)"
      >
        <span class="swatch" :style="{ background: row.bg, borderColor: row.text }">
          <i :style="{ background: row.accent }"></i>
        </span>
        <span class="palette-name">{{ row.label }}</span>
        <svg v-if="row.name === props.current" class="palette-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7" /></svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* anchored above the sidebar footer buttons */
.palette-menu {
  left: var(--space-3);
  bottom: 84px;
  width: calc(var(--sidebar-w) - var(--space-6));
  max-width: 200px;
}
.menu-group-label {
  padding: 2px var(--space-3) var(--space-1);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-dim);
}
.palette-menu .menu-item {
  min-height: 34px;
  padding: 4px var(--space-2);
}
.swatch {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  border: 1px solid;
  border-radius: 7px;
  overflow: hidden;
}
.swatch i {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}
.palette-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--accent-2);
}
</style>

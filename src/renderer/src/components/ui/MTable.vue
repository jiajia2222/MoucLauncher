<script setup lang="ts">
/**
 * MTable — dense tabular data (java runtimes, installed mods, job lists).
 *
 * Cells are plain values by default; anything richer (a tag, a switch, actions) goes
 * through the `cell` slot with `{ row, column }`. Sorting is emitted, not applied, so a
 * view can sort server-side or locally as it prefers.
 */
import MIcon from "../icons/MIcon.vue";
import { t } from "../../i18n";
import type { TableColumn, SortDirection, TableRow } from "./types";

const props = withDefaults(
  defineProps<{
    columns: TableColumn[];
    rows: TableRow[];
    /** Column key currently sorted; paired with `direction`. */
    sortKey?: string;
    direction?: SortDirection;
    dense?: boolean;
    /** Row key accessor, defaults to `row.id` then the row index. */
    rowKey?: (row: TableRow, index: number) => string;
    loading?: boolean;
    selectable?: boolean;
    selectedKey?: string;
    emptyText?: string;
  }>(),
  {
    sortKey: "",
    direction: null,
    dense: false,
    loading: false,
    selectable: false,
    selectedKey: "",
    emptyText: ""
  }
);

const emit = defineEmits<{
  "update:sortKey": [key: string];
  "update:direction": [value: SortDirection];
  sort: [key: string, direction: SortDirection];
  "row-click": [row: TableRow];
}>();

function headerLabel(column: TableColumn): string {
  return column.labelKey ? t(column.labelKey) : column.label ?? column.key;
}

function nextDirection(column: TableColumn): SortDirection {
  if (!column.sortable) return null;
  if (props.sortKey !== column.key) return "asc";
  if (props.direction === "asc") return "desc";
  if (props.direction === "desc") return null;
  return "asc";
}

function sortBy(column: TableColumn): void {
  if (!column.sortable) return;
  const direction = nextDirection(column);
  emit("update:sortKey", direction ? column.key : "");
  emit("update:direction", direction);
  emit("sort", column.key, direction);
}

function keyOf(row: TableRow, index: number): string {
  if (props.rowKey) return props.rowKey(row, index);
  const id = row.id;
  return id === undefined || id === null ? String(index) : String(id);
}

function cellText(row: TableRow, column: TableColumn): string {
  const value = row[column.key];
  if (value === null || value === undefined) return "";
  return String(value);
}
</script>

<template>
  <div class="m-table" :class="{ 'is-dense': dense }">
    <table>
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            :style="column.width ? { width: column.width } : undefined"
            :class="['align-' + (column.align ?? 'start'), { sortable: column.sortable }]"
            :aria-sort="sortKey === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined"
          >
            <button v-if="column.sortable" class="sort" type="button" @click="sortBy(column)">
              <span class="head-text u-truncate">{{ headerLabel(column) }}</span>
              <MIcon
                :name="sortKey === column.key && direction === 'desc' ? 'chevron-down' : 'chevron-up'"
                :size="16"
                class="caret"
                :class="{ 'is-live': sortKey === column.key, 'is-idle': sortKey !== column.key }"
              />
            </button>
            <span v-else class="head-text u-truncate">{{ headerLabel(column) }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading">
          <td :colspan="columns.length" class="state">{{ t('common.loading') }}</td>
        </tr>
        <tr v-else-if="!rows.length">
          <td :colspan="columns.length" class="state">{{ emptyText || t('common.empty') }}</td>
        </tr>
        <tr
          v-for="(row, index) in rows"
          v-else
          :key="keyOf(row, index)"
          class="body-row"
          :class="{ 'is-selected': selectable && selectedKey === keyOf(row, index) }"
          :aria-selected="selectable ? selectedKey === keyOf(row, index) : undefined"
          @click="emit('row-click', row)"
        >
          <td v-for="column in columns" :key="column.key" :class="['align-' + (column.align ?? 'start'), { mono: column.mono }]">
            <slot name="cell" :row="row" :column="column">{{ cellText(row, column) }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.m-table {
  width: 100%;
  overflow: hidden;
  border-radius: var(--m-r-md);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--m-fs-13);
}

thead th {
  position: sticky;
  top: 0;
  z-index: var(--m-z-sticky);
  padding: var(--m-sp-2) var(--m-sp-3);
  border-bottom: var(--m-line) solid var(--m-border-weak);
  background: var(--m-surface-elevated);
  color: var(--m-text-muted);
  font-size: var(--m-fs-12);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}

.is-dense thead th {
  padding: var(--m-sp-1) var(--m-sp-2);
}

.sort {
  display: inline-flex;
  align-items: center;
  gap: var(--m-sp-1);
  max-width: 100%;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.sort:hover,
.sort:focus-visible {
  color: var(--m-text-primary);
}

.sort:focus-visible {
  outline: var(--m-focus-width) solid var(--m-focus-color);
  outline-offset: 2px;
  border-radius: var(--m-r-xs);
}

.head-text {
  min-width: 0;
}

.caret {
  flex: none;
  opacity: 0;
  transition: opacity var(--m-dur-1) var(--m-ease-standard);
}

th:hover .is-idle {
  opacity: 0.45;
}

.is-live {
  opacity: 1;
  color: var(--m-accent-text);
}

tbody td {
  padding: var(--m-sp-2) var(--m-sp-3);
  border-bottom: var(--m-line) solid var(--m-border-hairline);
  color: var(--m-text-primary);
  vertical-align: middle;
}

.is-dense tbody td {
  padding: var(--m-sp-1) var(--m-sp-2);
}

tbody tr:last-child td {
  border-bottom: 0;
}

.body-row {
  cursor: default;
  transition: background-color var(--m-dur-1) var(--m-ease-standard);
}

.body-row:hover td {
  background: var(--m-surface-hover);
}

.body-row.is-selected td {
  background: var(--m-accent-soft);
}

.mono {
  font-family: var(--m-font-mono);
  letter-spacing: 0;
}

.align-end {
  text-align: right;
}

.align-center {
  text-align: center;
}

.state {
  padding: var(--m-sp-6);
  color: var(--m-text-muted);
  text-align: center;
}
</style>

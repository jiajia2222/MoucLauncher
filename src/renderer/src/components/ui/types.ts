/**
 * Shared payload types for the UI primitives.
 *
 * They live here because `<script setup>` blocks may not contain ES exports, and views
 * need these shapes to build their data: `import type { SelectOption } from
 * '@renderer/components/ui/types'`.
 */
import type { IconName } from "../icons/paths";
import type { I18nKey } from "../../i18n";

/** Option row for MSelect / MSegmented. */
export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  icon?: IconName;
  disabled?: boolean;
}

/** Entry for MMenu. Separators reuse the same shape with `separator: true`. */
export interface MenuItem {
  id: string;
  label?: string;
  labelKey?: I18nKey;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
}

/** Row model for MList. */
export interface ListRow {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  meta?: string;
  disabled?: boolean;
}

/** Cell value accepted by MTable; anything else must be rendered through the `cell` slot. */
export type TableCell = string | number | boolean | null | undefined;

export type SortDirection = "asc" | "desc" | null;

export interface TableColumn {
  key: string;
  label?: string;
  /** i18n key for the header, preferred over a literal. */
  labelKey?: I18nKey;
  width?: string;
  align?: "start" | "center" | "end";
  sortable?: boolean;
  /** Monospaced body (sizes, pids, timestamps). */
  mono?: boolean;
}

export type TableRow = Record<string, TableCell>;

/** Segment descriptor for MSegmented. */
export interface SegmentOption {
  value: string;
  label?: string;
  icon?: IconName;
  /** Accessible name when there is no visible label. */
  labelKey?: string;
}

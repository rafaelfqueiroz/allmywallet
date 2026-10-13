/**
 * SPEC-022 BR-022-18 / DL-022-17 — what a column *is*, from which its
 * alignment, its width and whether it truncates all follow.
 *
 * A column declares a `kind` rather than an alignment because the alignment is
 * not a choice: text, dates and badges sit left; quantities, amounts and
 * percentages sit right, in tabular digits, so units stand under units. A
 * per-column `align` let the plain tables each decide on their own, which is
 * the defect (#237) — the kind makes the right answer the only one.
 *
 * Its own module, free of React, so the rules are testable as plain data and a
 * plain (non-`DataTable`) table can size its columns the same way.
 */

export const COLUMN_KINDS = [
  'text',
  'date',
  'badge',
  'number',
  'money',
  'percent',
  // Not in the brief's six: a checkbox or a row-action column. A fixed width,
  // never truncated and no tooltip — there is no text to read in full.
  'control',
] as const;

export type ColumnKind = (typeof COLUMN_KINDS)[number];

/**
 * A column's width. A **number** is characters (`ch`) of content — the cell's
 * padding is added, so the figure is what the content needs, not what the box
 * does. A **string** is a CSS length used verbatim.
 */
export type ColumnWidth = number | string;

/**
 * Horizontal padding a cell adds to its content: `px-2` on each side
 * (`ui/table.tsx`). Column widths are border-box under `table-layout: fixed`.
 */
const CELL_PADDING = '1rem';

/**
 * Default widths, set by the kind and never by the content (BR-022-18), so
 * hiding the amounts (BR-022-24) moves no column.
 *
 * Numbers are sized in `ch` — the advance of a tabular digit — so they are
 * independent of the figures actually shown:
 *
 * - `money` fits the largest plausible figure, thirteen digits —
 *   `R$ 12.345.678.901,23` — with a sign (`−` or `+`) in front, and the masked
 *   placeholder `R$ ••••••` (BR-022-26), which is narrower than any real
 *   figure. 13 digits and the `R$ ` prefix are 17 characters of digits and
 *   currency, four separators are narrower than a digit, and the sign one more:
 *   22 gives the slack a proportional font's `R`, `$` and the non-breaking space
 *   need.
 * - `number` is a quantity: up to the same thirteen digits plus fraction.
 * - `percent` is `−1.234,56%`, and its header ("Participação") is the wider of
 *   the two.
 * - `text` has a width too. Under `table-layout: fixed` a column with none
 *   takes whatever is left over, and when the other columns use it all, nothing:
 *   a text column that vanished on a narrow container is worse than one that
 *   truncates. A table that wants the remainder passes its own width.
 */
const DEFAULT_WIDTH: Record<ColumnKind, ColumnWidth> = {
  text: 24,
  date: 11,
  badge: 14,
  number: 14,
  money: 22,
  percent: 12,
  control: '3rem',
};

/** Figures sit right, in tabular digits (DS-13); everything else sits left. */
const NUMERIC_KINDS: ReadonlySet<ColumnKind> = new Set(['number', 'money', 'percent']);

/** Text that can outgrow its column. Figures never do; controls have none. */
const TRUNCATING_KINDS: ReadonlySet<ColumnKind> = new Set(['text', 'date', 'badge']);

export function isNumericKind(kind: ColumnKind): boolean {
  return NUMERIC_KINDS.has(kind);
}

export function truncatesKind(kind: ColumnKind): boolean {
  return TRUNCATING_KINDS.has(kind);
}

/** The CSS width of a `<col>`: the column's own, else its kind's default. */
export function columnWidth(kind: ColumnKind, width?: ColumnWidth): string {
  const chosen = width ?? DEFAULT_WIDTH[kind];
  return typeof chosen === 'string' ? chosen : `calc(${chosen}ch + ${CELL_PADDING})`;
}

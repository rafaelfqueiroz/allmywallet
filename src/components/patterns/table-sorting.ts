import type { Row } from '@tanstack/react-table';

/**
 * SPEC-022 BR-022-18 — how a table orders text: **pt-BR collation**, not code
 * points.
 *
 * TanStack's own `text`/`alphanumeric` compare characters with `>`, which puts
 * every accented initial after "Z": "Água e Saneamento" sorts below "Varejo" and
 * a wallet called "Ética" below "Zeta". The server already orders with
 * `localeCompare(…, 'pt-BR')` (`settings/watch/data.ts`), so a client re-sort
 * that disagreed would reshuffle the list on the first click.
 *
 * `numeric` keeps "PETR3" before "PETR10"; `sensitivity: 'base'` ignores case
 * and accents when comparing, so "ações" and "Acoes" tie and the stable sort
 * keeps their input order. The collator is created once — building one per
 * comparison is the expensive part of `localeCompare`.
 *
 * One function for every `DataTable` (it is the table's `defaultColumn`), so a
 * column that declares no `sortingFn` — `HoldingsTable`, `WalletsTable`,
 * `ImportHistoryTable` — and every `NodeTable` text column share it. A column
 * of figures still names `'basic'` (ranks, counts, epoch milliseconds);
 * anything that is not a pair of strings falls back to the same comparison.
 */
const COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

export function collatedSortingFn<TData>(rowA: Row<TData>, rowB: Row<TData>, id: string): number {
  const a: unknown = rowA.getValue(id);
  const b: unknown = rowB.getValue(id);
  if (typeof a === 'string' && typeof b === 'string') return COLLATOR.compare(a, b);
  // The `basic` comparison: numbers, dates (epoch ms) and anything else ordered by value.
  return a === b ? 0 : (a as number) > (b as number) ? 1 : -1;
}

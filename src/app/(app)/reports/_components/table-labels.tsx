import { EmptyState } from '@/components/patterns/empty-state';
import type { NodeTableProps } from '@/components/patterns/node-table';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** What `NodeTable` takes from a Relatórios page besides its columns and rows. */
export type ReportTableLabels = Pick<
  NodeTableProps,
  'caption' | 'noun' | 'filterPlaceholder' | 'empty'
>;

/**
 * SPEC-022 BR-022-18 / AR-44 — the labels every Relatórios `NodeTable` carries.
 * The sort labels are `NodeTable`'s own (`cellTable`); the "nothing to show"
 * state comes from the one `reports.tables.empty` key, so the six tables on three
 * tabs say it in the same words. Each table brings only what is its own: its
 * caption, the noun its "Mostrando 1–10 de N …" summary counts, and — when it
 * has a filter — what that filter searches (no placeholder, no filter).
 *
 * `t` is the `reports` namespace.
 */
export function tableLabels(
  t: Translate,
  own: { readonly caption: string; readonly noun: string; readonly filterPlaceholder?: string },
): ReportTableLabels {
  return {
    caption: own.caption,
    noun: own.noun,
    ...(own.filterPlaceholder === undefined ? {} : { filterPlaceholder: own.filterPlaceholder }),
    empty: <EmptyState title={t('tables.empty')} />,
  };
}

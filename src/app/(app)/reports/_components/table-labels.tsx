import { EmptyState } from '@/components/patterns/empty-state';
import type { ReportTableLabels } from '@/app/(app)/reports/_components/ReportTable';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * SPEC-022 BR-022-18 / AR-44 — the labels every `ReportTable` carries, from the
 * one `reports.tables.*` block, so the six tables on three tabs say "Ordenar
 * por" and "Nada para mostrar" in the same words. Each table brings only what is
 * its own: its caption, the noun its "Mostrando 1–10 de N …" summary counts, and
 * — when it has a filter — what that filter searches.
 *
 * `t` is the `reports` namespace.
 */
export function tableLabels(
  t: Translate,
  own: { readonly caption: string; readonly itemNoun: string; readonly filterPlaceholder?: string },
): ReportTableLabels {
  return {
    caption: own.caption,
    itemNoun: own.itemNoun,
    ...(own.filterPlaceholder === undefined ? {} : { filterPlaceholder: own.filterPlaceholder }),
    // Left as `{column}`, which the table fills with the column's own header.
    sortBy: t('tables.sortBy', { column: '{column}' }),
    sortField: t('tables.sortField'),
    sortAscending: t('tables.sortAscending'),
    sortDescending: t('tables.sortDescending'),
    empty: <EmptyState title={t('tables.empty')} />,
  };
}

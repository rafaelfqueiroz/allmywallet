'use client';

import { useMemo, type ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { TRANSACTION_SORT_KEYS } from '@/core/ledger/ports';
import { DataTable } from '@/components/patterns/data-table';
import type { ColumnKind, ColumnWidth } from '@/components/patterns/data-table-columns';
import { LedgerSelection } from '@/app/(app)/transactions/_components/LedgerSelection';

/**
 * SPEC-022 BR-022-18 / SPEC-006 BR-006-07 — the ledger as a `DataTable` in
 * server-paged mode.
 *
 * The ledger runs to 10.000+ rows, so the query sorts and pages it and this
 * table renders the one page it was handed (`DataTable`'s `server` mode). A
 * sort or a page is a link to a new URL; `page.tsx` reads the same parameters
 * through `ledgerViewFrom` and fetches that page.
 *
 * **Every cell arrives rendered.** The page builds each cell on the server —
 * `Money` with the account's masking applied (BR-022-24), the provenance link,
 * the estimate marker, the row menu — and hands this component finished nodes. Nothing here
 * formats a figure, so no `Money` or `Quantity` crosses the client boundary as
 * a number (AR-06–AR-10), and no cell can disagree with the CSV export's
 * formatting. This component owns only the columns: their headers, their
 * order, which of them sort, and what each holds (`KINDS`).
 */

/**
 * SPEC-022 BR-022-40 — eight columns and the row menu, down from eleven: the
 * broker sits under the asset, the origin under the status, and the row actions
 * in a "⋯" menu (DL-022-22).
 */
export const LEDGER_COLUMNS = [
  'select',
  'tradeDate',
  'asset',
  'type',
  'quantity',
  'unitPrice',
  'totalValue',
  'status',
  'actions',
] as const;

export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];

export interface LedgerRow {
  readonly id: string;
  readonly cells: Readonly<Record<LedgerColumn, ReactNode>>;
}

/** Catalogue key under `transactions.table` for each visible header. */
const HEADER_KEYS = {
  tradeDate: 'date',
  asset: 'asset',
  type: 'type',
  quantity: 'quantity',
  unitPrice: 'unitPrice',
  totalValue: 'total',
  status: 'status',
} as const satisfies Partial<Record<LedgerColumn, string>>;

/**
 * The columns the repository can order by (`TransactionSortKey`). `institution`
 * is a sort key with no column of its own since BR-022-40: no header offers it,
 * and a URL naming it still sorts — through every page, because the table keeps
 * every `TransactionSortKey` in its links (`urlSortIds`, #255 review).
 */
const SORTABLE: ReadonlySet<string> = new Set(TRANSACTION_SORT_KEYS);

/**
 * SPEC-022 BR-022-18/40 — each column's kind, which decides its alignment and
 * default width, and the widths this table sets itself. Eight columns and the
 * menu share a 944 px panel at 1280 px, where `1ch` is ~8.8 px, so every column
 * is sized for what it holds rather than for its kind's default. They take
 * ~919 px, which leaves room for a classic 15 px scrollbar (#242 Decision log):
 *
 * - the date is `09/10/2026`, under 9ch;
 * - the asset truncates, and so does its broker under it;
 * - the type fits "Bonificação", "Amortização" and "Grupamento"; longer types
 *   truncate;
 * - the quantity fits the eight decimal places `formatQuantity` allows,
 *   `1.234,12345678` (#255 review), and `1.234.567,89`;
 * - the unit price is sized for "Custo estimado" (BR-007-06), the widest thing
 *   under a price (~125 px), which leaves room for `R$ 99.999.999,99`;
 * - the total fits `R$ 99.999.999,99` — Portfólio sizes a whole holding's value
 *   for ten times that (#245), but one transaction is not a holding;
 * - the status fits "● Substituída", with the origin and "Editada" each on a
 *   line under it; "● Não classificada" truncates, with the full text on demand;
 * - the checkbox needs 2.25rem (a 16 px box and the cell's padding), and the row
 *   menu is one icon button.
 */
const KINDS: Readonly<Record<LedgerColumn, { kind: ColumnKind; width?: ColumnWidth }>> = {
  select: { kind: 'control', width: '2.25rem' },
  tradeDate: { kind: 'date', width: 9.5 },
  asset: { kind: 'text', width: 10 },
  type: { kind: 'text', width: 10 },
  quantity: { kind: 'number', width: 13 },
  unitPrice: { kind: 'money', width: 14.5 },
  totalValue: { kind: 'money', width: 14 },
  status: { kind: 'badge', width: 11 },
  actions: { kind: 'control' },
};

export interface LedgerTableProps {
  readonly rows: readonly LedgerRow[];
  /** How many transactions match the filters, across every page. */
  readonly total: number;
  readonly pageSizeOptions: readonly number[];
  readonly defaultPageSize: number;
  /** The order the query opens on — the server's, so the arrow cannot disagree with it. */
  readonly defaultSort: { readonly id: string; readonly desc: boolean };
  /** The filter bar (BR-006-08/09). Stays visible when nothing matches. */
  readonly toolbar: ReactNode;
  /** An empty ledger, before any filter. Replaces the table and the toolbar. */
  readonly empty?: ReactNode;
  /** Filters that match nothing. Shown under the toolbar. */
  readonly noResults: ReactNode;
}

export function LedgerTable({
  rows,
  total,
  pageSizeOptions,
  defaultPageSize,
  defaultSort,
  toolbar,
  empty,
  noResults,
}: LedgerTableProps) {
  const t = useTranslations('transactions');

  const columns = useMemo<ColumnDef<LedgerRow, unknown>[]>(
    () =>
      LEDGER_COLUMNS.map((id): ColumnDef<LedgerRow, unknown> => ({
        id,
        header:
          id === 'select'
            ? () => <span className="sr-only">{t('bulk.select')}</span>
            : id === 'actions'
              ? () => <span className="sr-only">{t('table.actions')}</span>
              : t(`table.${HEADER_KEYS[id]}`),
        enableSorting: SORTABLE.has(id),
        meta: KINDS[id],
        cell: ({ row }) => row.original.cells[id],
      })),
    [t],
  );

  return (
    // A new page of rows is a new selection: ticks the reader can no longer
    // see must not stay selected (see `LedgerSelection`).
    <LedgerSelection key={rows.map((row) => row.id).join(',')}>
      <DataTable
        columns={columns}
        // TanStack wants a mutable array; the rows are never mutated.
        data={rows as LedgerRow[]}
        server={{ total, rowId: (row) => row.id }}
        caption={t('table.caption')}
        sortable
        urlSortIds={TRANSACTION_SORT_KEYS}
        initialSorting={[defaultSort]}
        sortLabel={(column) => t('table.sortBy', { column })}
        sortControlLabels={{
          field: t('table.sortField'),
          ascending: t('table.sortAscending'),
          descending: t('table.sortDescending'),
        }}
        pageSizeOptions={pageSizeOptions}
        defaultPageSize={defaultPageSize}
        itemNoun={t('table.noun')}
        toolbar={toolbar}
        empty={empty}
        noResults={noResults}
      />
    </LedgerSelection>
  );
}

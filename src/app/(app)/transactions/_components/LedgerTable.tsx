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
 * the estimate marker — and hands this component finished nodes. Nothing here
 * formats a figure, so no `Money` or `Quantity` crosses the client boundary as
 * a number (AR-06–AR-10), and no cell can disagree with the CSV export's
 * formatting. This component owns only the columns: their headers, their
 * order, which of them sort, and what each holds (`KINDS`).
 */

export const LEDGER_COLUMNS = [
  'select',
  'tradeDate',
  'asset',
  'type',
  'institution',
  'quantity',
  'unitPrice',
  'totalValue',
  'status',
  'provenance',
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
  institution: 'institution',
  quantity: 'quantity',
  unitPrice: 'unitPrice',
  totalValue: 'total',
  status: 'status',
  provenance: 'provenance',
} as const satisfies Partial<Record<LedgerColumn, string>>;

/** The columns the repository can order by (`TransactionSortKey`). */
const SORTABLE: ReadonlySet<string> = new Set(TRANSACTION_SORT_KEYS);

/**
 * SPEC-022 BR-022-18 — each column's kind, which decides its alignment and
 * default width, and the widths this table sets itself: the row actions are two
 * icon buttons. The unit price's cost-estimate marker (BR-007-06) sits beside the
 * figure and wraps under it when the column is full — the column is sized for the
 * figure, never for the marker. Restructuring the columns so the ledger fits without scrolling is BR-022-40
 * (#242), not this.
 */
const KINDS: Readonly<Record<LedgerColumn, { kind: ColumnKind; width?: ColumnWidth }>> = {
  select: { kind: 'control' },
  tradeDate: { kind: 'date' },
  asset: { kind: 'text', width: 20 },
  type: { kind: 'text', width: 14 },
  institution: { kind: 'text', width: 18 },
  quantity: { kind: 'number' },
  unitPrice: { kind: 'money' },
  totalValue: { kind: 'money' },
  status: { kind: 'badge' },
  provenance: { kind: 'badge', width: 20 },
  actions: { kind: 'control', width: '5.5rem' },
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

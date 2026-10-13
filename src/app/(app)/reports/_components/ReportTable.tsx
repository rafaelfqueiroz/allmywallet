'use client';

import { useMemo, type ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import {
  isNumericKind,
  type ColumnKind,
  type ColumnWidth,
} from '@/components/patterns/data-table-columns';

/**
 * SPEC-022 BR-022-18 / DS-67 — the Relatórios tables whose rows grow with the
 * history, the months or the holdings, on the table standard.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CELLS ARRIVE RENDERED
 *
 * This is a Client Component, because `DataTable` is. A report's figures are
 * `Money` and `Quantity` — class instances that do not survive serialisation,
 * and converting them to `number` on the way through is exactly the JSON-boundary
 * hazard AR-06–AR-10 name. So the server renders every cell (`<Money>` from
 * `@/app/money`, which applies the eye toggle, BR-022-24) and hands over
 * `ReactNode`s; the table only lays them out. The `LedgerTable` pattern.
 *
 * Sorting a rendered cell needs something to sort *by*, and that is `sort`: a
 * figure's **rank** — its position in that column's ascending order, computed on
 * the server with exact `comparedTo` (`report-rows.ts`) — or, for text and
 * dates, the string itself. A rank is an integer index, not an amount, so a
 * masked column still sorts: an order is not an amount.
 *
 * One component for every report table keeps the definitions as plain data
 * (a column is an id, a header, a kind), which is all that differs between them.
 * ---------------------------------------------------------------------------
 */

export interface ReportColumn {
  readonly id: string;
  /** Already translated — AR-44 keeps the catalogue on the server. */
  readonly header: string;
  /** Alignment, default width and truncation all follow from this (DS-67). */
  readonly kind: ColumnKind;
  /** Overrides the kind's default width — characters of content, or a CSS length. */
  readonly width?: ColumnWidth;
  /** Default `true`. A column with nothing to order by sets `false`. */
  readonly sortable?: boolean;
}

export interface ReportRow {
  /** The cell for each column id, rendered on the server. */
  readonly cells: Readonly<Record<string, ReactNode>>;
  /**
   * What each column sorts by: a rank for a figure, the string for text and
   * dates. A text value is also what the filter searches. `undefined` is a figure
   * that does not exist, which sorts last in both directions — the absence of a
   * value is not the smallest one.
   */
  readonly sort: Readonly<Record<string, string | number | undefined>>;
}

export interface ReportTableLabels {
  readonly caption: string;
  /** A template — "Ordenar por {column}". */
  readonly sortBy: string;
  readonly sortField: string;
  readonly sortAscending: string;
  readonly sortDescending: string;
  /** The plural noun the "Mostrando 1–10 de N …" summary counts. */
  readonly itemNoun: string;
  /** Shown in place of the table when there are no rows (BR-022-18). */
  readonly empty: ReactNode;
  /** Present only when the table has a text filter. */
  readonly filterPlaceholder?: string;
}

export function ReportTable({
  columns,
  rows,
  labels,
  paramPrefix,
  initialSort,
  searchable = false,
  totals,
}: {
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly ReportRow[];
  readonly labels: ReportTableLabels;
  /** Distinct per table — two tables on a page must not share a page number. */
  readonly paramPrefix: string;
  readonly initialSort: { readonly id: string; readonly desc: boolean };
  /** A text filter, over the columns whose sort value is a string. */
  readonly searchable?: boolean;
  /** SPEC-012 BR-012-16 — the whole collection's closing row; see `DataTable`. */
  readonly totals?: {
    readonly label: ReactNode;
    readonly cells: Readonly<Record<string, ReactNode>>;
  };
}) {
  const definitions = useMemo<ColumnDef<ReportRow, unknown>[]>(
    () =>
      columns.map((column) => {
        const numeric = isNumericKind(column.kind);
        return {
          id: column.id,
          header: column.header,
          meta: {
            kind: column.kind,
            ...(column.width === undefined ? {} : { width: column.width }),
          },
          accessorFn: (row) => row.sort[column.id],
          enableSorting: column.sortable !== false,
          // Ranks are numbers, text is compared as text; never inferred from
          // whichever row happens to come first.
          sortingFn: numeric ? 'basic' : 'text',
          sortUndefined: 'last',
          // A figure's first click shows the largest first, as Composição's does.
          sortDescFirst: numeric,
          cell: ({ row }) => row.original.cells[column.id],
        };
      }),
    [columns],
  );

  return (
    <DataTable
      columns={definitions}
      data={[...rows]}
      caption={labels.caption}
      empty={labels.empty}
      sortable
      initialSorting={[initialSort]}
      sortLabel={(column) => labels.sortBy.replace('{column}', column)}
      sortControlLabels={{
        field: labels.sortField,
        ascending: labels.sortAscending,
        descending: labels.sortDescending,
      }}
      itemNoun={labels.itemNoun}
      paramPrefix={paramPrefix}
      {...(searchable && labels.filterPlaceholder !== undefined
        ? { filter: { placeholder: labels.filterPlaceholder } }
        : {})}
      {...(totals === undefined ? {} : { totals })}
    />
  );
}

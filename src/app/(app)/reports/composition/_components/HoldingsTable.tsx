'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { Cluster } from '@/components/layout/cluster';

/**
 * SPEC-015 BR-015-02 / AC-4 — "the table sorts by every column, ascending and
 * descending."
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CELL ARRIVES AS TEXT AND A RANK
 *
 * This is a Client Component, so everything it receives is serialised. `Money`
 * and `Quantity` are class instances and would not survive that; converting
 * them to `number` on the way through is precisely the JSON-boundary hazard
 * AR-06–AR-10 name, and a report is the last place to start doing float
 * arithmetic on somebody's *patrimônio*. AR-35 makes it structural rather than
 * advisory — `decimal.js` is not importable under `src/app/`, so comparing
 * decimal strings here is not an option either, and that is the right answer:
 * a component that computes a portfolio figure is a defect.
 *
 * So each cell carries:
 *
 *  - `text` — the finished figure, formatted on the **server** by the same
 *    `Money`/`formatCurrency` path every other screen uses, so this table
 *    cannot round differently from the totals beneath it;
 *  - `rank` — the row's position in that column's ascending order, computed on
 *    the server with exact `Money.comparedTo`. An **integer index**, not a
 *    figure: nothing can render it by accident, and ordering by it is exact
 *    without any decimal arithmetic crossing the boundary. `undefined` when
 *    the figure does not exist; and
 *  - `negative` — the sign, decided by `Money.isNegative()` rather than by
 *    this component looking for a minus in a string.
 *
 * Sorting is client-side over an already-scoped result set: the rows are all
 * here, so no sort re-queries anything (DL-015-01's "one report", and a
 * re-query would give the sort its own chance to disagree with the total).
 * ---------------------------------------------------------------------------
 */

export interface Cell {
  readonly text: string;
  /**
   * The row's position in this column's ascending order, ranked on the server.
   * `undefined` when the figure does not exist — a price per zero units, a
   * share of a zero total — which `sortUndefined: 'last'` keeps at the bottom
   * in **both** directions. An absent figure is not the smallest value; it is
   * the absence of one, and letting it sort as zero would put it above every
   * negative gain in the table.
   */
  readonly rank: number | undefined;
  /** BR-015-08's sign, decided by `Money.isNegative()` on the server. */
  readonly negative: boolean;
}

export interface HoldingRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Already translated — AR-44 keeps the catalogue on the server. */
  readonly assetClass: string;
  /** BR-015-03: the sector, or the translated "Não classificado". */
  readonly sector: string;
  readonly quantity: Cell;
  readonly averagePrice: Cell;
  readonly currentPrice: Cell;
  readonly value: Cell;
  readonly share: Cell;
  readonly unrealizedGain: Cell;
  /** BR-015-05 — above the user's configured threshold. */
  readonly concentrated: boolean;
  /** BR-015-09 — accrued rather than observed. */
  readonly estimated: boolean;
}

export interface HoldingsTableLabels {
  readonly code: string;
  readonly assetClass: string;
  readonly sector: string;
  readonly quantity: string;
  readonly averagePrice: string;
  readonly currentPrice: string;
  readonly value: string;
  readonly share: string;
  readonly unrealizedGain: string;
  readonly caption: string;
  readonly concentrated: string;
  readonly concentratedTitle: string;
  readonly estimated: string;
  readonly estimatedTitle: string;
  /** A template — "Ordenar por {column}". */
  readonly sortBy: string;
  /** The card rendering's sort control, for viewports with no column headers. */
  readonly sortField: string;
  readonly sortAscending: string;
  readonly sortDescending: string;
}

export function HoldingsTable({
  rows,
  labels,
}: {
  readonly rows: readonly HoldingRow[];
  readonly labels: HoldingsTableLabels;
}) {
  const columns = useMemo<ColumnDef<HoldingRow, unknown>[]>(() => {
    const numeric = (
      id: keyof Pick<
        HoldingRow,
        'quantity' | 'averagePrice' | 'currentPrice' | 'value' | 'share' | 'unrealizedGain'
      >,
      header: string,
      options?: { readonly signed?: boolean },
    ): ColumnDef<HoldingRow, unknown> => ({
      id,
      header,
      accessorFn: (row) => row[id].rank,
      sortingFn: 'basic',
      sortUndefined: 'last',
      /**
       * First click on a money column shows the **largest** first, which is
       * what somebody clicking "Valor" on their own portfolio is asking for.
       * Stated rather than inherited: TanStack infers this from the first
       * value being a number, so leaving it implicit would make the direction
       * of the first click depend on whether a column happened to be numeric —
       * and these accessors return ranks, which are numeric for every column
       * whether the figure behind them is or not.
       */
      sortDescFirst: true,
      cell: ({ row }) => {
        const cell = row.original[id];
        return (
          <Text
            as="span"
            className="tabular-nums"
            // DS-09: colour never carries meaning alone — the server's
            // formatter has already put an explicit sign on the figure.
            {...(options?.signed === true
              ? { tone: cell.negative ? ('negative' as const) : ('positive' as const) }
              : {})}
          >
            {cell.text}
          </Text>
        );
      },
    });

    return [
      {
        id: 'code',
        header: labels.code,
        accessorFn: (row) => row.code,
        cell: ({ row }) => (
          <Cluster gap="sm" align="baseline">
            <span className="font-medium">{row.original.code}</span>
            {row.original.concentrated && (
              /*
               * BR-015-06 — informational, never advice. Both the badge and
               * its title come from the message catalogue, where a human
               * reviewed the wording; nothing is composed here.
               */
              <Badge variant="secondary" title={labels.concentratedTitle}>
                {labels.concentrated}
              </Badge>
            )}
            {row.original.estimated && (
              <Badge variant="outline" title={labels.estimatedTitle}>
                {labels.estimated}
              </Badge>
            )}
          </Cluster>
        ),
      },
      { id: 'assetClass', header: labels.assetClass, accessorFn: (row) => row.assetClass },
      { id: 'sector', header: labels.sector, accessorFn: (row) => row.sector },
      numeric('quantity', labels.quantity),
      numeric('averagePrice', labels.averagePrice),
      numeric('currentPrice', labels.currentPrice),
      numeric('value', labels.value),
      numeric('share', labels.share),
      numeric('unrealizedGain', labels.unrealizedGain, { signed: true }),
    ];
  }, [labels]);

  return (
    <DataTable
      columns={columns}
      data={[...rows]}
      caption={labels.caption}
      sortable
      // Largest first, the order the server already folded them in, so the
      // first paint and the sorted model agree.
      initialSorting={[{ id: 'value', desc: true }]}
      sortLabel={(column) => labels.sortBy.replace('{column}', column)}
      sortControlLabels={{
        field: labels.sortField,
        ascending: labels.sortAscending,
        descending: labels.sortDescending,
      }}
    />
  );
}

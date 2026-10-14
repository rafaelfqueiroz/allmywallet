'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import { Badge } from '@/components/ui/badge';
import { StateBadge, type WatchState } from '@/components/patterns/state-badge';
import { Text } from '@/components/ui/text';
import { CellLabel } from '@/components/patterns/cell-label';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { MoneyMask } from '@/components/patterns/money-mask';

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
  /**
   * SPEC-022 BR-022-24 — the amount is hidden, and `text` is already the
   * placeholder: the figure never left the server. Rendered as `MoneyMask` so
   * the cell's accessible name says so (BR-022-26).
   */
  readonly masked?: boolean;
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
  /**
   * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — this asset's
   * *preço médio* includes an estimated acquisition cost. A different fact
   * from `estimated` above (SPEC-009's valuation estimate) — see
   * `core/reporting/ports.ts`'s `ReportHolding.costEstimated`.
   */
  readonly costEstimated: boolean;
  /**
   * SPEC-018 BR-018-19 — the same buy/hold/sell/unknown state the rules screen shows,
   * `null` only when this asset carries no opportunity rule at all (most
   * holdings). A rule's `unknown` state (BR-018-16 — no usable quote) still
   * renders, deliberately, as the muted `StateBadge` rather than being
   * hidden: it is the "watched but nothing to report right now" case, not
   * the same thing as never having watched this asset.
   */
  readonly opportunityState: WatchState | null;
  /** Already translated (AR-44) — a three/four-word label, e.g. "compra". */
  readonly opportunityStateLabel: string;
  /** BR-018-18 — states the user's own rule, never a recommendation. */
  readonly opportunityStateTitle: string;
}

export interface HoldingsTableLabels {
  readonly code: string;
  readonly quantity: string;
  readonly averagePrice: string;
  readonly currentPrice: string;
  readonly value: string;
  /** SPEC-022 BR-022-41 — a template, "{share} do total", under the value. */
  readonly shareOf: string;
  readonly unrealizedGain: string;
  readonly caption: string;
  readonly concentrated: string;
  readonly concentratedTitle: string;
  readonly estimated: string;
  readonly estimatedTitle: string;
  /** SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12. */
  readonly costEstimated: string;
  readonly costEstimatedTitle: string;
  /** A template — "Ordenar por {column}". */
  readonly sortBy: string;
  /** The card rendering's sort control, for viewports with no column headers. */
  readonly sortField: string;
  readonly sortAscending: string;
  readonly sortDescending: string;
  /** SPEC-022 BR-022-18 — the holdings list can run past one page. */
  readonly filterPlaceholder: string;
}

/**
 * Details a tab may leave out of the asset cell. SPEC-022 BR-022-02: Patrimônio
 * reads value by asset, so it drops the two categorical details Composição
 * keeps — the sector (a composition dimension) and the watch state (SPEC-018
 * BR-018-19 places it in Composição's holdings list).
 */
export type OptionalHoldingDetail = 'sector' | 'opportunityState';

// One instance, so the default does not change the memoised columns on every
// render — a new `columns` array re-renders DataTable's model (see its #204
// Decision log #7 on what an unstable table input does).
const NONE_HIDDEN: readonly OptionalHoldingDetail[] = [];

export function HoldingsTable({
  rows,
  labels,
  hidden = NONE_HIDDEN,
}: {
  readonly rows: readonly HoldingRow[];
  readonly labels: HoldingsTableLabels;
  readonly hidden?: readonly OptionalHoldingDetail[];
}) {
  const showSector = !hidden.includes('sector');
  const showState = !hidden.includes('opportunityState');

  const columns = useMemo<ColumnDef<HoldingRow, unknown>[]>(() => {
    const numeric = (
      id: keyof Pick<
        HoldingRow,
        'quantity' | 'averagePrice' | 'currentPrice' | 'value' | 'unrealizedGain'
      >,
      header: string,
      width: number,
      options?: { readonly signed?: boolean },
    ): ColumnDef<HoldingRow, unknown> => ({
      id,
      header,
      /*
       * SPEC-022 BR-022-18 / BR-022-41: sized to the figure each column holds,
       * not the 19ch default for the largest amount, so the six columns fit the
       * panel at 1280 px (#245):
       *  - a price — *preço médio*, preço atual — 14ch: R$ 9.999.999,99;
       *  - a holding's value and its gain 16ch: ±R$ 999.999.999,99;
       *  - a quantity 12ch.
       */
      meta: { kind: id === 'quantity' ? 'number' : 'money', width },
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
            // SPEC-022 BR-022-26: a masked cell carries no colour either.
            {...(options?.signed === true && !cell.masked
              ? { tone: cell.negative ? ('negative' as const) : ('positive' as const) }
              : {})}
          >
            <CellText cell={cell} />
          </Text>
        );
      },
    });

    return [
      {
        /*
         * SPEC-022 BR-022-41 — the asset carries its categories: the class (and
         * on Composição the sector) on a second line, and the watch state under
         * them. They are no longer columns of their own, so they no longer sort;
         * Composição's groups table breaks the portfolio down by both.
         *
         * The column's value is the code followed by those words, so the filter
         * still finds a holding by class, sector or state ("Filtrar por ativo,
         * classe ou setor") and the sort, by the code that leads it.
         */
        id: 'code',
        header: labels.code,
        meta: { kind: 'text', width: 20 },
        accessorFn: (row) =>
          [
            row.code,
            row.assetClass,
            showSector ? row.sector : '',
            showState ? row.opportunityStateLabel : '',
          ].join(' '),
        cell: ({ row }) => {
          const asset = (
            <CellLabel
              badge={
                row.original.concentrated && (
                  /*
                   * BR-015-06 — informational, never advice. Both the badge and
                   * its title come from the message catalogue, where a human
                   * reviewed the wording; nothing is composed here.
                   */
                  <Badge variant="secondary" title={labels.concentratedTitle}>
                    {labels.concentrated}
                  </Badge>
                )
              }
              detail={
                showSector
                  ? `${row.original.assetClass} · ${row.original.sector}`
                  : row.original.assetClass
              }
            >
              {row.original.code}
            </CellLabel>
          );
          /*
           * SPEC-018 BR-018-19 — the watch state is which of the user's own
           * rules currently matches (BR-018-18), not a figure: server-formatted
           * label and title, like every other cell here. Absent for a holding
           * with no rule, which is most of them.
           */
          const state = row.original.opportunityState;
          return showState && state !== null ? (
            <Stack gap="xs" align="start">
              {asset}
              <StateBadge
                state={state}
                label={row.original.opportunityStateLabel}
                title={row.original.opportunityStateTitle}
              />
            </Stack>
          ) : (
            asset
          );
        },
      },
      numeric('quantity', labels.quantity, 12),
      /*
       * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — *preço médio* is
       * exactly the figure this column shows, so the marker sits next to it
       * rather than back on the `code` column above: "wherever its cost or
       * preço médio is shown" (the acceptance criterion's own wording), and a
       * reader scanning this column is looking at the number the marker
       * qualifies.
       */
      {
        ...numeric('averagePrice', labels.averagePrice, 14),
        cell: ({ row }) => (
          <Stack gap="xs" align="end">
            <Text as="span" className="tabular-nums">
              <CellText cell={row.original.averagePrice} />
            </Text>
            {row.original.costEstimated && (
              <Badge variant="outline" title={labels.costEstimatedTitle}>
                {labels.costEstimated}
              </Badge>
            )}
          </Stack>
        ),
      },
      numeric('currentPrice', labels.currentPrice, 14),
      /*
       * SPEC-009's valuation estimate qualifies the *current value* — how the
       * holding was priced today — so its marker sits beside that figure, the
       * way the cost estimate sits beside *preço médio*. On the code column the
       * one word "Estimado" could not say which figure it meant (SPEC-022
       * BR-022-32: the label sits beside the figure it qualifies).
       */
      /*
       * SPEC-022 BR-022-41 — the holding's share of the scope sits under its
       * value rather than in a column of its own. No sort is lost: every share
       * is a value over the one total, so the shares order exactly as the
       * values do.
       */
      {
        ...numeric('value', labels.value, 16),
        cell: ({ row }) => (
          <Stack gap="xs" align="end">
            <Text as="span" className="tabular-nums">
              <CellText cell={row.original.value} />
            </Text>
            <Cluster gap="xs" justify="end" align="baseline">
              {row.original.estimated && (
                <Badge variant="outline" title={labels.estimatedTitle}>
                  {labels.estimated}
                </Badge>
              )}
              {/* A share of a zero total does not exist (`Cell.rank`). */}
              {row.original.share.rank !== undefined && (
                <Text as="span" size="xs" tone="muted" className="tabular-nums">
                  {labels.shareOf.replace('{share}', row.original.share.text)}
                </Text>
              )}
            </Cluster>
          </Stack>
        ),
      },
      numeric('unrealizedGain', labels.unrealizedGain, 16, { signed: true }),
    ];
  }, [labels, showSector, showState]);

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
      filter={{ placeholder: labels.filterPlaceholder }}
    />
  );
}

/**
 * A cell's figure, or — masked — the placeholder with its accessible name.
 * Like `Money`, a masked gain shows no sign and no colour (BR-022-26).
 */
function CellText({ cell }: { readonly cell: Cell }) {
  return cell.masked ? <MoneyMask /> : cell.text;
}

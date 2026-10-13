'use client';

import { useMemo, type ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { DataTable } from '@/components/patterns/data-table';
import { collatedSortingFn } from '@/components/patterns/table-sorting';
import {
  isNumericKind,
  type ColumnKind,
  type ColumnWidth,
} from '@/components/patterns/data-table-columns';

/**
 * SPEC-022 BR-022-18 — a `DataTable` over cells a **Server Component** has
 * already rendered.
 *
 * The growing lists on the Portfólio and Configurações screens each had their
 * own rows of money, quantities, badges and links. Money must not cross the
 * server→client boundary as a number (AR-06–AR-10), and masking (BR-022-24) is
 * decided where `Money` renders, so every cell arrives as a finished node and
 * this component owns only what a table owns: its columns (header, kind,
 * width), which of them sort, and the keys they sort and search by — the
 * pattern `LedgerTable` set, made reusable instead of copied per screen.
 *
 * `keys` is what the page decides for each column and this component never
 * computes. A **number** orders numerically — an integer **rank** the server
 * took from exact `Money.comparedTo` (see `holding-rows.ts`), epoch
 * milliseconds for a date, a count — never a figure parsed back out of text.
 * A **string** orders alphabetically *and is what the filter searches*; a
 * column with no key is neither sorted nor searched. `undefined` is "no figure
 * here" and sorts last in both directions, as an absence rather than a zero.
 *
 * One component serves every table over server-rendered cells — Portfólio,
 * Configurações and Relatórios — so the sort labels come from its own
 * `cellTable` catalogue namespace and a page brings only what is its own: the
 * caption, the noun, the filter's placeholder and the empty state (AR-44).
 *
 * **No form belongs in a cell** (DS-28 renders each cell twice, so a form id
 * or an input name would exist twice). A row control is a link, or a button
 * naming a form outside the table through its `form` attribute.
 */
export interface NodeColumn {
  readonly id: string;
  /** Translated — AR-44. */
  readonly header: string;
  readonly kind: ColumnKind;
  readonly width?: ColumnWidth;
  /** Whether the header sorts the table, by this column's `keys`. */
  readonly sortable?: boolean;
  /** A control column's header is read by assistive technology and not shown. */
  readonly srOnlyHeader?: boolean;
}

export interface NodeRow {
  /** A stable id for the record, where it has one; the table itself never reads it. */
  readonly id?: string;
  /** One finished node per column id. */
  readonly cells: Readonly<Record<string, ReactNode>>;
  readonly keys?: Readonly<Record<string, string | number | undefined>>;
  /** The element id a deep link names (`#regra-…`); see `DataTable`'s `rowAnchor`. */
  readonly anchor?: string;
}

export interface NodeTableProps {
  readonly columns: readonly NodeColumn[];
  readonly rows: readonly NodeRow[];
  /** The table's accessible name. */
  readonly caption: string;
  /** The plural noun the "Mostrando 1–10 de N …" summary counts. */
  readonly noun: string;
  /** Present when the list can run past a page: a text filter over the string keys. */
  readonly filterPlaceholder?: string;
  /** The order the table opens on. */
  readonly sort?: { readonly id: string; readonly desc: boolean };
  /** Two tables on one page need distinct prefixes (BR-022-18). */
  readonly paramPrefix?: string;
  readonly empty?: ReactNode;
  /** `false` only for a list bounded by construction; say why where it is passed. */
  readonly pagination?: boolean;
  /**
   * The whole collection's closing row, shown on every page and never filtered —
   * `DataTable`'s `totals`, whose cells arrive rendered like these.
   */
  readonly totals?: {
    readonly label: ReactNode;
    readonly cells: Readonly<Record<string, ReactNode>>;
  };
  /**
   * Server-paged (DS-66): `rows` is **one page**, already cut by the server from
   * the URL's `<prefix>_page`/`<prefix>_size` (`parseTableUrlState`, with this
   * table's `paramPrefix` and no sortable column), and `total` counts them all.
   * Page and size links navigate, so the server decides which rows to render —
   * the way for a list whose rows hold server-rendered forms that must not be
   * rendered for a page nobody is on. Every row needs an `id`. Sorting is off:
   * the page's rows come in the order the server holds them.
   */
  readonly server?: { readonly total: number };
  /** `false` for rows that hold forms: see `DataTable`'s `cards`. */
  readonly cards?: boolean;
  /** Server mode: the fragment the page links end in. */
  readonly linkHash?: string;
}

export function NodeTable({
  columns,
  rows,
  caption,
  noun,
  filterPlaceholder,
  sort,
  paramPrefix,
  empty,
  pagination,
  totals,
  server,
  cards,
  linkHash,
}: NodeTableProps) {
  const t = useTranslations('cellTable');
  // A server-paged page arrives in the server's order; no header re-sorts it.
  const sortable = server === undefined && columns.some((column) => column.sortable === true);

  const defs = useMemo<ColumnDef<NodeRow, unknown>[]>(
    () =>
      columns.map((column): ColumnDef<NodeRow, unknown> => {
        // A figure, a count or a date orders by its number; text by its string.
        const numeric = isNumericKind(column.kind) || column.kind === 'date';
        return {
          id: column.id,
          header: column.srOnlyHeader
            ? () => <span className="sr-only">{column.header}</span>
            : column.header,
          enableSorting: server === undefined && column.sortable === true,
          meta: {
            kind: column.kind,
            ...(column.width !== undefined ? { width: column.width } : {}),
          },
          accessorFn: (row) => row.keys?.[column.id],
          // pt-BR collation for text (`collatedSortingFn`), not TanStack's code points.
          sortingFn: numeric ? 'basic' : collatedSortingFn,
          sortUndefined: 'last',
          // The first press on a column of figures shows the largest first, the
          // order somebody pressing "Valor" is asking for (see `HoldingsTable`).
          sortDescFirst: numeric,
          cell: ({ row }) => row.original.cells[column.id] ?? null,
        };
      }),
    [columns],
  );

  return (
    <DataTable
      columns={defs}
      data={rows as NodeRow[]}
      caption={caption}
      sortable={sortable}
      {...(sortable && sort ? { initialSorting: [{ id: sort.id, desc: sort.desc }] } : {})}
      sortLabel={(column) => t('sortBy', { column })}
      sortControlLabels={{
        field: t('sortField'),
        ascending: t('sortAscending'),
        descending: t('sortDescending'),
      }}
      {...(filterPlaceholder !== undefined ? { filter: { placeholder: filterPlaceholder } } : {})}
      {...(paramPrefix !== undefined ? { paramPrefix } : {})}
      {...(pagination !== undefined ? { pagination } : {})}
      {...(totals !== undefined ? { totals } : {})}
      {...(server !== undefined
        ? {
            server: {
              total: server.total,
              rowId: (row: NodeRow) => {
                if (row.id === undefined)
                  throw new Error('A server-paged NodeTable row needs an id');
                return row.id;
              },
            },
          }
        : {})}
      {...(cards !== undefined ? { cards } : {})}
      {...(linkHash !== undefined ? { linkHash } : {})}
      {...(empty !== undefined ? { empty } : {})}
      itemNoun={noun}
      rowAnchor={(row) => row.anchor}
    />
  );
}

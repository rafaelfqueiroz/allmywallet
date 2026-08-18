'use client';

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useId, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';

/**
 * DL-12/DL-13 — one dataset, two renderings.
 *
 * From `md` up this is a real `<table>`, at compact density, because a ledger
 * is a table and twenty visible rows beat eight. Below `md` the same rows
 * render as cards with the column header repeated as each field's label: a
 * six-column table on a 375px screen is either unreadable or a horizontal
 * scroll nobody discovers.
 *
 * Both renderings are always in the DOM, one hidden per breakpoint. That costs
 * markup and buys a layout that is correct on resize and on print without a
 * viewport-width hook — which would be wrong on the server anyway, and would
 * make every consumer of this component client-rendered on a guess.
 *
 * `caption` is required rather than optional: an unnamed table is a WCAG
 * failure the axe suite will catch, and the name is never obvious from data.
 *
 * **Sorting is opt-in** (`sortable`). SPEC-015 AC-4 wants the Composition
 * table sorted by every column in both directions, and it happens here rather
 * than in that one screen for the reason the design system exists at all: the
 * next sortable table would otherwise re-decide the affordance, the icon and
 * the `aria-sort` wiring, and get one of the three subtly wrong. A table that
 * does not pass the prop renders exactly as it did before — same markup, no
 * buttons, no sorted row model.
 *
 * Sorting is **client-side over an already-scoped result set**: the rows are
 * all present, so re-ordering them is not a question anybody needs to ask the
 * database again. A re-query per sort would also give the sort its own chance
 * to disagree with the totals underneath it.
 */
export type DataTableProps<TData> = {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  /** Accessible name for the table. Translated text — AR-44. */
  caption: ReactNode;
  /** Shown in place of both renderings when `data` is empty — an EmptyState. */
  empty?: ReactNode;
  /** Turn column headers into sort controls. Off by default. */
  sortable?: boolean;
  /** The column the table opens on, when sortable. */
  initialSorting?: SortingState;
  /**
   * Accessible name for a sort control, as a template taking the column's own
   * header text — "Ordenar por {column}". Required when `sortable`, because a
   * button labelled only "Valor" does not say what pressing it does (AR-44
   * keeps the wording in the catalogue, not here).
   */
  sortLabel?: (column: string) => string;
  /**
   * Labels for the **card rendering's** sort control. Below `md` there is no
   * table and therefore no column header to click, so without these the rows
   * would be unsortable on a phone — which is not what "sorts by every column"
   * means. See the control itself, below.
   */
  sortControlLabels?: {
    readonly field: string;
    readonly ascending: string;
    readonly descending: string;
  };
  className?: string;
};

export function DataTable<TData>({
  columns,
  data,
  caption,
  empty,
  sortable = false,
  initialSorting,
  sortLabel,
  sortControlLabels,
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(sortable
      ? {
          state: { sorting },
          onSortingChange: setSorting,
          getSortedRowModel: getSortedRowModel(),
        }
      : {}),
  });
  const captionId = useId();

  const rows = table.getRowModel().rows;

  /**
   * The card list repeats each column's header as its field label, and a header
   * may be a render function needing *header* context — not the cell context
   * that happens to be in scope down there. Resolving them once, from the real
   * header groups, is the only way to render a function header correctly.
   */
  const headerLabels = new Map<string, ReactNode>(
    table
      .getHeaderGroups()
      .flatMap((group) => group.headers)
      .filter((header) => !header.isPlaceholder)
      .map((header) => [
        header.column.id,
        flexRender(header.column.columnDef.header, header.getContext()),
      ]),
  );

  if (data.length === 0 && empty) return <>{empty}</>;

  return (
    <div data-slot="data-table" className={className}>
      <div className="hidden md:block">
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const label = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  const canSort = sortable && header.column.getCanSort();
                  const direction = header.column.getIsSorted();

                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      className="py-row"
                      /*
                       * `aria-sort` belongs on the header cell, not on the
                       * button inside it — a screen reader announces the
                       * column's state from the cell as it moves across the
                       * row. Only the sorted column carries it; "none" on
                       * every other column is noise.
                       */
                      aria-sort={
                        direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : undefined
                      }
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          aria-label={sortLabel?.(headerText(label))}
                          className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                        >
                          {label}
                          {direction === 'asc' ? (
                            <ArrowUp aria-hidden="true" className="size-3" />
                          ) : direction === 'desc' ? (
                            <ArrowDown aria-hidden="true" className="size-3" />
                          ) : (
                            <ChevronsUpDown aria-hidden="true" className="size-3 opacity-50" />
                          )}
                        </button>
                      ) : (
                        label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="py-row">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="md:hidden">
        <p id={captionId} className="sr-only">
          {caption}
        </p>

        {/*
          DL-12 puts the rows in cards below `md`, which removes every column
          header — and with them the only way to sort. A phone is where a
          holdings list is *most* likely to be long enough to need it, so the
          affordance is rebuilt rather than dropped: one native select for the
          column, one button for the direction.

          Native controls on purpose. They are the sort control that works
          before hydration finishes, with a screen reader, and with the
          system's own picker on a phone — the same reasoning that makes the
          report's period and scope a plain GET form.
        */}
        {sortable && sortControlLabels && (
          <div className="mb-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {sortControlLabels.field}
              <select
                className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
                value={sorting[0]?.id ?? ''}
                onChange={(event) =>
                  setSorting([{ id: event.target.value, desc: sorting[0]?.desc ?? true }])
                }
              >
                {table
                  .getAllColumns()
                  .filter((column) => column.getCanSort())
                  .map((column) => (
                    <option key={column.id} value={column.id}>
                      {headerText(headerLabels.get(column.id))}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-sm"
              aria-label={
                sorting[0]?.desc === false
                  ? sortControlLabels.ascending
                  : sortControlLabels.descending
              }
              onClick={() =>
                setSorting((current) => {
                  const first = current[0];
                  return first === undefined ? current : [{ ...first, desc: !first.desc }];
                })
              }
            >
              {sorting[0]?.desc === false ? (
                <ArrowUp aria-hidden="true" className="size-3.5" />
              ) : (
                <ArrowDown aria-hidden="true" className="size-3.5" />
              )}
            </button>
          </div>
        )}
        <ul aria-labelledby={captionId} className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Card size="sm">
                <CardContent>
                  {/*
                   * Deliberately plain elements rather than Stack/Cluster: HTML
                   * allows a `dt`/`dd` pair to sit inside *one* wrapping div
                   * under the `dl`, and nesting two layout components produces
                   * two — which axe rejects as `dlitem`, correctly, because it
                   * breaks the term/definition association a screen reader
                   * relies on.
                   */}
                  <dl className="flex flex-col gap-1">
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        className="flex flex-wrap items-baseline justify-between gap-2"
                      >
                        <dt className="text-xs text-muted-foreground">
                          {headerLabels.get(cell.column.id)}
                        </dt>
                        <dd className="text-sm">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * A header is `ReactNode`, and the sort control needs it as *text* for its
 * accessible name. Every header in this codebase is a translated string, so
 * the common case is exact; anything else falls back to the empty string
 * rather than stringifying an element into `[object Object]`.
 */
function headerText(label: ReactNode): string {
  return typeof label === 'string' ? label : '';
}

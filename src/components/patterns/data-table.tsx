'use client';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useId, type ReactNode } from 'react';
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
 */
export type DataTableProps<TData> = {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  /** Accessible name for the table. Translated text — AR-44. */
  caption: ReactNode;
  /** Shown in place of both renderings when `data` is empty — an EmptyState. */
  empty?: ReactNode;
  className?: string;
};

export function DataTable<TData>({
  columns,
  data,
  caption,
  empty,
  className,
}: DataTableProps<TData>) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
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
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} scope="col" className="py-row">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
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

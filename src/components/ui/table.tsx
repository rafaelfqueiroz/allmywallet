'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * SPEC-022 BR-022-18 / DL-022-17 — **a width per column, set by the table's
 * definition and never by its content**, so hiding the amounts (BR-022-24)
 * moves no column.
 *
 * `fixed` is `table-layout: fixed`: the browser takes each column's width from
 * the `<colgroup>` (`TableColGroup`) and ignores what the cells hold. The table
 * stays `w-full`; when the columns add up to more than the container, the
 * wrapper below scrolls and no number is squeezed to fit.
 *
 * **Opt-in**, because fixed layout without widths gives every column the same
 * width and clips what does not fit, and a table that has not been given its
 * widths yet must not be quietly broken by this primitive changing under it.
 * `DataTable` always sets it; a plain table sets it together with its
 * `TableColGroup`.
 */
function Table({
  className,
  fixed = false,
  ...props
}: React.ComponentProps<'table'> & { readonly fixed?: boolean }) {
  return (
    /*
     * `tabIndex={0}` and the group role are an accessibility requirement, not
     * decoration (axe `scrollable-region-focusable`, WCAG 2.1.1). The wrapper
     * scrolls horizontally, and a region that can only be scrolled by dragging
     * is unreachable to anyone navigating by keyboard — the columns past the
     * fold simply do not exist for them. Focusable, it scrolls with the arrow
     * keys.
     *
     * `aria-label` comes from the table's own `aria-label`/`aria-labelledby`
     * when the caller sets one, so the focus stop announces which table it is
     * rather than an anonymous "group".
     */
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
      tabIndex={0}
      role="group"
      {...(typeof props['aria-label'] === 'string' ? { 'aria-label': props['aria-label'] } : {})}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', fixed && 'table-fixed', className)}
        {...props}
      />
    </div>
  );
}

/**
 * The `<colgroup>` of a `fixed` table: one CSS width per column, in column
 * order (`patterns/data-table-columns.ts` derives them from a column's kind).
 * Place it after the caption and before the header — the order HTML gives a
 * table. A column given `undefined` takes the space the others leave, which is
 * none when they already fill the container.
 */
function TableColGroup({ widths }: { readonly widths: readonly (string | undefined)[] }) {
  return (
    <colgroup data-slot="table-colgroup">
      {widths.map((width, index) => (
        <col key={index} {...(width === undefined ? {} : { style: { width } })} />
      ))}
    </colgroup>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Table,
  TableColGroup,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};

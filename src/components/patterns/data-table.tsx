'use client';

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type SortingState,
} from '@tanstack/react-table';
import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  pageWindow,
  parseTableUrlState,
  writeTableUrlState,
  type TableUrlOptions,
  type TableUrlState,
} from '@/lib/table-url-state';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { EmptyState } from '@/components/patterns/empty-state';

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
 * to disagree with the totals underneath it. Filtering and paging are the same
 * argument: they narrow a set that is already here.
 *
 * ---------------------------------------------------------------------------
 * SPEC-022 BR-022-18 — "a list never grows a page without bound."
 *
 * **Pagination is on by default**, with a selectable page size, because the
 * table that is bounded today (a user's holdings) is the one that is not in a
 * year. A caller turns it off with `pagination={false}` only for a list that is
 * bounded by construction, and says why where it does.
 *
 * **State lives in the URL** — sort, page, page size and filter text — so a
 * view can be bookmarked and a reload does not lose it (SPEC-011 BR-011-11's
 * reasoning; `lib/table-url-state.ts` is the parser). While mounted the
 * component's own state is the truth and the URL is a mirror of it, and the URL
 * is adopted again only when something *else* changed it. Without that rule a
 * write landing behind a fast typist would put the input back to what it said
 * a moment ago.
 *
 * The mirror is written with **`window.history.replaceState`, not
 * `router.replace`**. Next syncs `replaceState` into `useSearchParams`, so the
 * URL is still the shareable, reloadable truth — but nothing goes to the
 * server. The rows are already here and sorting, paging and filtering narrow
 * them locally; `router.replace` would refetch the whole page's server data
 * (a report's use case, on every sort click and every keystroke) to learn
 * nothing new. It replaces rather than pushes, so Back leaves the page instead
 * of stepping through column clicks. With no server round trip the write is
 * cheap enough to happen per keystroke, so the filter text is not debounced.
 * A control that *should* refetch (the scope selector) navigates instead.
 *
 * `useSearchParams` makes a statically rendered page bail out to client
 * rendering up to the nearest Suspense boundary, so the connected table sits in
 * its own: callers need not wrap it, and the fallback is the same table at its
 * default state rather than a hole.
 * ---------------------------------------------------------------------------
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
  /**
   * BR-022-18 — paginate. Default `true`; pass `false` only for a list bounded
   * by construction, and say so where it is passed.
   */
  pagination?: boolean;
  /** The page sizes offered. Default 10 / 25 / 50 / 100. */
  pageSizeOptions?: readonly number[];
  /** The page size a view opens on; must be one of the options. Default 25. */
  defaultPageSize?: number;
  /**
   * The plural noun the summary counts — "importações" gives "Mostrando 1–5 de
   * 23 importações". Translated text. Without it the summary is the generic
   * "Mostrando 1–5 de 23".
   */
  itemNoun?: string;
  /**
   * A text filter over the columns whose value is a string. Numeric columns are
   * not searched: a rank or a `Decimal` is not what the user sees. `label` is
   * the control's accessible name (catalogue default otherwise); `placeholder`
   * is the caller's, because "Filtrar por arquivo" says what is being filtered.
   */
  filter?: { readonly placeholder: string; readonly label?: string };
  /** Extra filters (a status select, say), rendered beside the text filter. */
  toolbar?: ReactNode;
  /**
   * Prefix for this table's URL parameters, so two tables on one page do not
   * share a page number. Without it: `sort`, `page`, `size`, `q`.
   */
  paramPrefix?: string;
  /** Shown when a filter matches nothing. Catalogue default otherwise. */
  noResults?: ReactNode;
  className?: string;
};

const DEFAULT_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

/** A column's id, as TanStack will derive it — needed before the table exists. */
function columnId<TData>(column: ColumnDef<TData, unknown>): string | undefined {
  if (column.id !== undefined) return column.id;
  return 'accessorKey' in column ? String(column.accessorKey) : undefined;
}

function urlOptions<TData>({
  columns,
  sortable = false,
  initialSorting,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  defaultPageSize = DEFAULT_PAGE_SIZE,
  paramPrefix,
}: DataTableProps<TData>): TableUrlOptions {
  const first = initialSorting?.[0];
  return {
    ...(paramPrefix ? { prefix: paramPrefix } : {}),
    pageSizeOptions,
    sortableIds: sortable
      ? columns.flatMap((column) => {
          const id = columnId(column);
          return id === undefined ? [] : [id];
        })
      : [],
    defaults: {
      sort: first ? { id: first.id, desc: first.desc } : null,
      pageSize: pageSizeOptions.includes(defaultPageSize)
        ? defaultPageSize
        : (pageSizeOptions[0] ?? DEFAULT_PAGE_SIZE),
    },
  };
}

type StateChange = (next: TableUrlState) => void;

export function DataTable<TData>(props: DataTableProps<TData>) {
  const options = urlOptions(props);

  return (
    <Suspense
      fallback={
        <DataTableView
          {...props}
          state={{
            sort: options.defaults.sort,
            page: 1,
            pageSize: options.defaults.pageSize,
            query: '',
          }}
          onStateChange={() => {}}
        />
      }
    >
      <UrlDataTable {...props} options={options} />
    </Suspense>
  );
}

/**
 * The connected table: URL → state on the way in, state → URL on the way out.
 * See the doc comment on `DataTableProps` for why the state is local and the
 * URL a mirror.
 */
function UrlDataTable<TData>({
  options,
  ...props
}: DataTableProps<TData> & { options: TableUrlOptions }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();

  const [state, setState] = useState(() => parseTableUrlState(searchParams, options));
  // Query strings this component wrote itself, so that their arrival back
  // through `useSearchParams` is not mistaken for an outside change.
  const written = useRef(new Set<string>());

  useEffect(() => {
    // Consumed on arrival: one write explains one arrival, so a later outside
    // navigation to the same URL is still followed.
    if (written.current.delete(urlKey)) return;
    // Someone else moved the URL (a Link, the Back button): follow it.
    written.current.clear();
    setState(parseTableUrlState(new URLSearchParams(urlKey), options));
    // `options` is rebuilt every render and only its content matters; the URL
    // is the one input whose change should re-read.
  }, [urlKey]);

  const onStateChange: StateChange = (next) => {
    setState(next);

    const query = writeTableUrlState(urlKey, next, options);
    // An unchanged URL produces no arrival to explain, and a stale entry
    // would swallow the next outside navigation to it.
    if (query !== urlKey) written.current.add(query);
    window.history.replaceState(
      window.history.state,
      '',
      `${query === '' ? pathname : `${pathname}?${query}`}${window.location.hash}`,
    );
  };

  return <DataTableView {...props} state={state} onStateChange={onStateChange} />;
}

/** Diacritic- and case-insensitive: "acoes" finds "Ações". */
function normalise(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The global filter. TanStack calls it once per column and keeps the row if any
 * call says yes; a column whose value is not a string says no, which is how
 * "string columns only" is expressed.
 */
function matchesQuery<TData>(row: Row<TData>, columnId: string, filterValue: unknown): boolean {
  const value: unknown = row.getValue(columnId);
  return (
    typeof value === 'string' &&
    typeof filterValue === 'string' &&
    // Trimmed, as the URL stores it: "PETR4 " must find what `?q=PETR4` finds.
    normalise(value).includes(normalise(filterValue.trim()))
  );
}

function DataTableView<TData>({
  columns,
  data,
  caption,
  empty,
  sortable = false,
  sortLabel,
  sortControlLabels,
  pagination = true,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  itemNoun,
  filter,
  toolbar,
  noResults,
  className,
  state,
  onStateChange,
}: DataTableProps<TData> & { state: TableUrlState; onStateChange: StateChange }) {
  const t = useTranslations('dataTable');
  // Memoised on the sort's content: a fresh array every render reads to
  // TanStack as a new sort, which re-derives the sorted rows on every render.
  const sortId = sortable ? (state.sort?.id ?? null) : null;
  const sortDesc = state.sort?.desc ?? false;
  const sorting: SortingState = useMemo(
    () => (sortId === null ? [] : [{ id: sortId, desc: sortDesc }]),
    [sortId, sortDesc],
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    /*
     * Paging is ours (the slice below), so TanStack's own reset must be off.
     * Left on, it queues a page-index reset whenever the row model re-derives,
     * that reset is a state update, the update re-renders, and the render
     * re-derives the rows: an endless render loop that only a real browser
     * shows — it froze the page on the first click (#204), and jsdom never
     * reproduced it. `tests/e2e/composition.spec.ts`'s sort journeys are the
     * guard.
     */
    autoResetAll: false,
    ...(sortable
      ? {
          getSortedRowModel: getSortedRowModel(),
          onSortingChange: (updater: SortingState | ((old: SortingState) => SortingState)) => {
            const next = (typeof updater === 'function' ? updater(sorting) : updater)[0];
            // A new order starts from the top; staying on page 3 of a list that
            // has just been re-ordered shows rows that are no longer neighbours.
            onStateChange({
              ...state,
              sort: next ? { id: next.id, desc: next.desc } : null,
              page: 1,
            });
          },
        }
      : {}),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: matchesQuery,
    // TanStack searches a column only if its *first* value is a string, which a
    // leading `undefined` quietly defeats. `matchesQuery` decides per value.
    getColumnCanGlobalFilter: () => true,
    state: { sorting, globalFilter: state.query },
  });
  const captionId = useId();
  const filterId = useId();
  const sizeId = useId();

  // Sorted and filtered, not yet paged: paging is a slice, done here rather
  // than in a row model so a page the list has shrunk below can be clamped
  // before it is applied.
  const matching = table.getRowModel().rows;
  const total = matching.length;
  const pageCount = pagination ? Math.max(1, Math.ceil(total / state.pageSize)) : 1;
  // A shared link can carry a page the list has since shrunk below.
  const page = Math.min(state.page, pageCount);
  const rows = pagination
    ? matching.slice((page - 1) * state.pageSize, page * state.pageSize)
    : matching;

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

  // The caller's empty state wins over everything: with no data there is
  // nothing to filter, and a toolbar over an empty table would only invite a
  // search that cannot find anything.
  if (data.length === 0 && empty) return <>{empty}</>;

  const toolbarRow =
    filter || toolbar ? (
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        {filter && (
          <div className="relative w-full min-w-48 sm:w-64">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={filterId}
              type="search"
              value={state.query}
              aria-label={filter.label ?? t('filterLabel')}
              placeholder={filter.placeholder}
              className="pl-8"
              onChange={(event) => onStateChange({ ...state, query: event.target.value, page: 1 })}
            />
          </div>
        )}
        {toolbar}
      </div>
    ) : null;

  // A filter that matches nothing is not an empty collection: the records
  // exist, and the way back is to change the filter, so the toolbar stays.
  if (total === 0 && data.length > 0) {
    return (
      <div data-slot="data-table" className={className}>
        {toolbarRow}
        {noResults ?? (
          <EmptyState
            title={t('noResultsTitle')}
            description={t('noResultsBody')}
            {...(state.query !== ''
              ? {
                  action: (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onStateChange({ ...state, query: '', page: 1 })}
                    >
                      {t('clearFilter')}
                    </Button>
                  ),
                }
              : {})}
          />
        )}
      </div>
    );
  }

  const from = total === 0 ? 0 : (page - 1) * state.pageSize + 1;
  const to = pagination ? Math.min(total, page * state.pageSize) : total;

  return (
    <div data-slot="data-table" className={className}>
      {toolbarRow}
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
              <NativeSelect
                className="w-auto text-foreground"
                value={sorting[0]?.id ?? ''}
                onChange={(event) =>
                  onStateChange({
                    ...state,
                    sort: { id: event.target.value, desc: sorting[0]?.desc ?? true },
                    page: 1,
                  })
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
              </NativeSelect>
            </label>
            <Button
              variant="outline"
              size="icon"
              aria-label={
                sorting[0]?.desc === false
                  ? sortControlLabels.ascending
                  : sortControlLabels.descending
              }
              onClick={() => {
                const first = sorting[0];
                if (first === undefined) return;
                onStateChange({ ...state, sort: { id: first.id, desc: !first.desc }, page: 1 });
              }}
            >
              {sorting[0]?.desc === false ? (
                <ArrowUp aria-hidden="true" className="size-3.5" />
              ) : (
                <ArrowDown aria-hidden="true" className="size-3.5" />
              )}
            </Button>
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

      {pagination && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <p className="text-muted-foreground">
            {itemNoun
              ? t('summaryWithNoun', { from, to, total, noun: itemNoun })
              : t('summary', { from, to, total })}
          </p>

          <nav aria-label={t('pagination')} className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('previousPage')}
              // `aria-disabled`, not `disabled`: the button a keyboard user just
              // pressed to reach the first page would otherwise be disabled
              // under their focus, which drops focus to <body>.
              {...(page <= 1 ? { 'aria-disabled': true } : {})}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (page > 1) onStateChange({ ...state, page: page - 1 });
              }}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            {pageWindow(page, pageCount).map((number) => (
              <Button
                key={number}
                variant="ghost"
                size="icon-sm"
                aria-label={t('page', { page: number })}
                {...(number === page ? { 'aria-current': 'page' as const } : {})}
                className={cn(
                  'tabular-nums',
                  // BR-022-33 — the current page is a fill, like the current
                  // destination; the focus ring stays a ring.
                  number === page &&
                    'bg-nav-active font-medium text-nav-active-foreground hover:bg-nav-active',
                )}
                onClick={() => onStateChange({ ...state, page: number })}
              >
                {number}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('nextPage')}
              {...(page >= pageCount ? { 'aria-disabled': true } : {})}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (page < pageCount) onStateChange({ ...state, page: page + 1 });
              }}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>

          <div className="flex items-center gap-2">
            <label htmlFor={sizeId} className="text-muted-foreground">
              {t('pageSize')}
            </label>
            <NativeSelect
              id={sizeId}
              className="w-auto"
              value={state.pageSize}
              onChange={(event) =>
                onStateChange({ ...state, pageSize: Number(event.target.value), page: 1 })
              }
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}
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

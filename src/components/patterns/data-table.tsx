'use client';

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
  TableColGroup,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  columnWidth,
  isNumericKind,
  truncatesKind,
  type ColumnKind,
  type ColumnWidth,
} from '@/components/patterns/data-table-columns';
import { TruncatedCell } from '@/components/patterns/truncated-cell';
import { collatedSortingFn } from '@/components/patterns/table-sorting';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * DL-12/DL-13 — one dataset, two renderings.
 *
 * From `md` up this is a real `<table>`, at compact density, because a ledger
 * is a table and twenty visible rows beat eight. Below `md` the same rows
 * render as flat rows under hairlines — never a card inside the panel the table
 * sits in (BR-022-36) — with the column header repeated as each field's label: a
 * six-column table on a 375px screen is either unreadable or a horizontal
 * scroll nobody discovers. Kinds, widths and truncation (BR-022-18, DS-67) belong
 * to the table rendering; a row under a hairline lets its text wrap.
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
 * `router.replace`**. Next syncs `replaceState` into `useSearchParams` — as
 * long as the call does not pass Next's own history state back (see the call) — so the
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
 * **Server-paged mode** (`server`). Everything above assumes the rows are all
 * here. A collection that is not — the transaction ledger runs to 10.000+ rows
 * (SPEC-006 BR-006-07) — is sorted, filtered and paged by its query, and the
 * table renders the one page it was handed. The URL is then the *only* state:
 * the server read it to fetch these rows, so a sort or a page is a navigation
 * to a new URL, never a local re-order of rows the server did not choose.
 *
 * Sort headers and page buttons are real links in this mode, so a reader
 * without JavaScript can still sort and page; the page-size select navigates
 * on change. The parameters are the same ones `lib/table-url-state.ts` writes
 * in the client mode, so the server parses them with the same options.
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
  /** The page sizes offered. Default 10 / 25 / 50 (BR-022-18). */
  pageSizeOptions?: readonly number[];
  /** The page size a view opens on; must be one of the options. Default 10. */
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
   * A closing row for the whole collection, not for the page on screen — the
   * "Total" under a breakdown, which a reader checks the rows against
   * (SPEC-012 BR-012-16: "the contributions sum to the total"). `label` sits in
   * the first column; `cells` maps a column id to its figure, and a column it
   * does not name is left empty. It is shown on every page and is never
   * filtered: a total that changed with the search box would no longer be the
   * total. Cells arrive rendered (money never crosses as a number, DS-66).
   */
  totals?: {
    readonly label: ReactNode;
    readonly cells: Readonly<Record<string, ReactNode>>;
  };
  /**
   * Prefix for this table's URL parameters, so two tables on one page do not
   * share a page number. Without it: `sort`, `page`, `size`, `q`.
   */
  paramPrefix?: string;
  /** Shown when a filter matches nothing. Catalogue default otherwise. */
  noResults?: ReactNode;
  /**
   * The id a link elsewhere points at (`#regra-…`), per row. The table row
   * carries it, and the card rendering `<id>-card` — a document has one element
   * per id, and CSS shows only one rendering. Client mode only. On arrival, and
   * whenever the hash changes, the table pages to the row, scrolls to the
   * rendering that is visible and marks it (`data-linked`) — a row on page 3 is
   * where a deep link must land, not on page 1 (SPEC-022 BR-022-07/18).
   */
  rowAnchor?: (row: TData) => string | undefined;
  /**
   * Server-paged mode: `data` is the current page, already sorted and filtered
   * by the server, and `total` is how many rows match in all. `filter` does
   * not apply — the search belongs to the query, so it lives in `toolbar`.
   */
  server?: {
    readonly total: number;
    /**
     * A row's stable identity. Required here: a sort or a page is a
     * navigation that keeps this component mounted, so rows keyed by position
     * would hand a ticked checkbox in row 3 to whatever transaction is row 3
     * next (#214 review F1).
     */
    readonly rowId: (row: TData) => string;
  };
  className?: string;
};

declare module '@tanstack/react-table' {
  // `TData`/`TValue` are TanStack's own parameters; the interface must repeat them.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /**
     * SPEC-022 BR-022-18 — what the column holds, from which its alignment,
     * its default width and its truncation follow
     * (`data-table-columns.ts`). Text, dates and badges sit left; numbers,
     * amounts and percentages sit right in tabular digits, so a column of
     * figures reads down its decimal point (DS-13), and the header sits like
     * its column. Default `text`. The card rendering ignores it: there the
     * label is on the left and the value already on the right.
     */
    readonly kind?: ColumnKind;
    /**
     * The column's width, set by the definition and never by the content
     * (BR-022-18): a number is characters of content, a string a CSS length.
     * Defaults to the kind's.
     */
    readonly width?: ColumnWidth;
  }
}

// SPEC-022 BR-022-18: 10, 25 or 50 rows a page, opening on 10.
const DEFAULT_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 10;

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
          // A column that opted out cannot be named by a link either.
          return id === undefined || column.enableSorting === false ? [] : [id];
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
/** Server mode: the URL a state lives at, for controls that are links. */
type HrefFor = (next: TableUrlState) => string;

export function DataTable<TData>(props: DataTableProps<TData>) {
  const options = urlOptions(props);
  const Connected = props.server ? ServerDataTable : UrlDataTable;

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
      <Connected {...props} options={options} />
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
    // `null`, never `window.history.state`: Next's own entries carry its
    // `__NA` marker, and its patched `replaceState` treats a call carrying that
    // marker as internal and skips syncing `useSearchParams`. The address bar
    // would move while every other reader of the URL — the scope selector
    // building its next href — kept the stale query and dropped this table's
    // state on the next navigation. Next restores its own history state
    // itself when handed `null`.
    window.history.replaceState(
      null,
      '',
      `${query === '' ? pathname : `${pathname}?${query}`}${window.location.hash}`,
    );
  };

  return <DataTableView {...props} state={state} onStateChange={onStateChange} />;
}

/**
 * The server-paged table: the URL is the state, and every change navigates.
 * `push`, not `replace`, unlike the client mode: each of these is a new
 * server render the reader asked for, and Back should return to the previous
 * page of the ledger rather than leave it.
 */
function ServerDataTable<TData>({
  options,
  ...props
}: DataTableProps<TData> & { options: TableUrlOptions }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const parsed = parseTableUrlState(searchParams, options);
  // A server-paged list is always in some order — its query's default — so a
  // cleared sort (`sort=`) shows that default rather than no indicator.
  const state = parsed.sort === null ? { ...parsed, sort: options.defaults.sort } : parsed;

  const hrefFor: HrefFor = (next) => {
    const query = writeTableUrlState(searchParams.toString(), next, options);
    return query === '' ? pathname : `${pathname}?${query}`;
  };

  return (
    <DataTableView
      {...props}
      state={state}
      hrefFor={hrefFor}
      sortableIds={options.sortableIds}
      onStateChange={(next) => router.push(hrefFor(next))}
    />
  );
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
  totals,
  noResults,
  rowAnchor,
  server,
  className,
  state,
  onStateChange,
  hrefFor,
  sortableIds,
}: DataTableProps<TData> & {
  state: TableUrlState;
  onStateChange: StateChange;
  hrefFor?: HrefFor;
  sortableIds?: readonly string[];
}) {
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
    // pt-BR collation for every text column that names no function of its own.
    defaultColumn: { sortingFn: collatedSortingFn<TData> },
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
    ...(server ? { getRowId: server.rowId } : {}),
    // Server mode: the rows arrive in the order the query chose, and the
    // sort state only drives the headers' indicators.
    manualSorting: server !== undefined,
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
    ...(server === undefined ? { getFilteredRowModel: getFilteredRowModel() } : {}),
    manualFiltering: server !== undefined,
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
  const total = server ? server.total : matching.length;
  const pageCount = pagination ? Math.max(1, Math.ceil(total / state.pageSize)) : 1;
  // A shared link can carry a page the list has since shrunk below. In server
  // mode the server clamped the same way before it fetched.
  const page = Math.min(state.page, pageCount);
  const rows =
    pagination && !server
      ? matching.slice((page - 1) * state.pageSize, page * state.pageSize)
      : matching;

  /*
   * SPEC-022 BR-022-07/18 — a deep link to a row (`#regra-<id>`) lands on the
   * row even when pagination put it on another page: follow the hash to the
   * page that holds the row, then scroll to whichever rendering is visible
   * (the table from `md` up, the cards below) and mark it. Run on arrival and
   * on `hashchange` only — never on a page change, or paging away from the
   * linked row would pull the reader straight back to it.
   */
  const [linked, setLinked] = useState<string | null>(null);
  const latest = useRef({ matching, page, state, onStateChange });
  useEffect(() => {
    latest.current = { matching, page, state, onStateChange };
  });
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    if (!rowAnchor || server) return;
    const follow = () => {
      const hash = decodeHash(window.location.hash);
      const current = latest.current;
      const index =
        hash === '' ? -1 : current.matching.findIndex((row) => rowAnchor(row.original) === hash);
      if (index < 0) {
        setLinked(null);
        return;
      }
      setLinked(hash);
      pendingScroll.current = hash;
      const target = pagination ? Math.floor(index / current.state.pageSize) + 1 : 1;
      if (target !== current.page) current.onStateChange({ ...current.state, page: target });
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // The row set and the page are read through `latest`: the hash is the input.
  }, []);
  useEffect(() => {
    const hash = pendingScroll.current;
    if (hash === null) return;
    const row = document.getElementById(hash);
    const visible =
      row !== null && row.getClientRects().length > 0
        ? row
        : document.getElementById(`${hash}-card`);
    if (visible === null) return;
    pendingScroll.current = null;
    if (typeof visible.scrollIntoView === 'function') visible.scrollIntoView({ block: 'center' });
  });

  /** Server mode decides sortability from the URL's own list, not TanStack's accessors. */
  const canSortColumn = (id: string, tanstack: boolean): boolean =>
    sortable && (sortableIds ? sortableIds.includes(id) : tanstack);

  /** Server mode: a header press asks for ascending first, then flips. */
  const nextSort = (id: string): TableUrlState['sort'] =>
    state.sort?.id === id ? { id, desc: !state.sort.desc } : { id, desc: false };

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
  // search that cannot find anything. A client-mode table with no rows and no
  // `empty` of its own gets the catalogue's, never bare headers over nothing
  // and a pager reading "Mostrando 0–0 de 0" (BR-022-18, #237 review F2): a
  // caller names *why* the list is empty by passing its own.
  if (data.length === 0 && (empty || server === undefined)) {
    return <>{empty ?? <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />}</>;
  }

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
  if (total === 0 && (data.length > 0 || server)) {
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
        {/* BR-022-18: widths come from the column definitions, never the cells. */}
        <Table fixed>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableColGroup
            widths={table
              .getVisibleLeafColumns()
              .map((column) =>
                columnWidth(column.columnDef.meta?.kind ?? 'text', column.columnDef.meta?.width),
              )}
          />
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const label = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  const canSort = canSortColumn(header.column.id, header.column.getCanSort());
                  const direction = header.column.getIsSorted();
                  const sortIcon =
                    direction === 'asc' ? (
                      <ArrowUp aria-hidden="true" className="size-3" />
                    ) : direction === 'desc' ? (
                      <ArrowDown aria-hidden="true" className="size-3" />
                    ) : (
                      <ChevronsUpDown aria-hidden="true" className="size-3 opacity-50" />
                    );

                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      className={cn(
                        'py-row',
                        isNumericKind(header.column.columnDef.meta?.kind ?? 'text') && 'text-right',
                      )}
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
                      {canSort && hrefFor ? (
                        <Link
                          href={hrefFor({
                            ...state,
                            sort: nextSort(header.column.id),
                            page: 1,
                          })}
                          aria-label={sortLabel?.(headerText(label))}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {label}
                          {sortIcon}
                        </Link>
                      ) : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          aria-label={sortLabel?.(headerText(label))}
                          className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                        >
                          {label}
                          {sortIcon}
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
            {rows.map((row) => {
              const anchor = rowAnchor?.(row.original);
              return (
                <TableRow
                  key={row.id}
                  {...(anchor !== undefined
                    ? { id: anchor, ...(linked === anchor ? { 'data-linked': true } : {}) }
                    : {})}
                  className={cn(
                    anchor !== undefined &&
                      'scroll-mt-20 data-linked:outline-2 data-linked:-outline-offset-2 data-linked:outline-ring',
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const kind = cell.column.columnDef.meta?.kind ?? 'text';
                    const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn('py-row', isNumericKind(kind) && 'text-right tabular-nums')}
                      >
                        {/* BR-022-18: text that does not fit ends in an ellipsis, with
                          its full text on hover, focus and tap; a number never does. */}
                        {truncatesKind(kind) ? <TruncatedCell>{content}</TruncatedCell> : content}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
          {totals && (
            <TableFooter>
              <TableRow>
                {table.getVisibleLeafColumns().map((column, index) =>
                  index === 0 ? (
                    <TableHead key={column.id} scope="row" className="py-row text-left">
                      {totals.label}
                    </TableHead>
                  ) : (
                    <TableCell
                      key={column.id}
                      className={cn(
                        'py-row',
                        isNumericKind(column.columnDef.meta?.kind ?? 'text') &&
                          'text-right tabular-nums',
                      )}
                    >
                      {totals.cells[column.id]}
                    </TableCell>
                  ),
                )}
              </TableRow>
            </TableFooter>
          )}
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
                  .filter((column) => canSortColumn(column.id, column.getCanSort()))
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
        <ul aria-labelledby={captionId} className="flex flex-col divide-y">
          {rows.map((row) => {
            const anchor = rowAnchor?.(row.original);
            return (
              <li
                key={row.id}
                {...(anchor !== undefined
                  ? { id: `${anchor}-card`, ...(linked === anchor ? { 'data-linked': true } : {}) }
                  : {})}
                className={cn(
                  'py-3',
                  anchor !== undefined &&
                    'scroll-mt-20 data-linked:outline-2 data-linked:-outline-offset-2 data-linked:outline-ring',
                )}
              >
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
                      <dd className="min-w-0 text-sm break-words">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
        {/*
         * Outside the list: a total sums the records, it is not one of them, so
         * it neither counts as an item nor sits among them for a screen reader.
         */}
        {totals && (
          <div className="border-t py-3">
            <p className="mb-1 text-sm font-medium">{totals.label}</p>
            <dl className="flex flex-col gap-1">
              {table
                .getVisibleLeafColumns()
                .filter((column) => totals.cells[column.id] !== undefined)
                .map((column) => (
                  <div
                    key={column.id}
                    className="flex flex-wrap items-baseline justify-between gap-2"
                  >
                    <dt className="text-xs text-muted-foreground">{headerLabels.get(column.id)}</dt>
                    <dd className="min-w-0 text-sm font-medium break-words">
                      {totals.cells[column.id]}
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        )}
      </div>

      {pagination && (
        <footer
          data-slot="table-pager"
          className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm group-[[data-variant=panel]]/panel:-mx-4 group-[[data-variant=panel]]/panel:-mb-4 group-[[data-variant=panel]]/panel:border-t group-[[data-variant=panel]]/panel:px-4 group-[[data-variant=panel]]/panel:py-3"
        >
          <p className="text-muted-foreground">
            {itemNoun
              ? t('summaryWithNoun', { from, to, total, noun: itemNoun })
              : t('summary', { from, to, total })}
          </p>

          <nav aria-label={t('pagination')} className="flex items-center gap-1">
            {hrefFor ? (
              <PageLinks
                page={page}
                pageCount={pageCount}
                hrefFor={(n) => hrefFor({ ...state, page: n })}
              />
            ) : (
              <>
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
              </>
            )}
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
        </footer>
      )}
    </div>
  );
}

/**
 * Server mode's page controls: the same buttons, as links to the page's URL,
 * so paging needs no JavaScript. The edges stay `aria-disabled` buttons rather
 * than links to nowhere — a disabled link is not a thing HTML has.
 */
function PageLinks({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  const t = useTranslations('dataTable');
  const edge = (label: string, icon: ReactNode, target: number, enabled: boolean) =>
    enabled ? (
      <Button asChild variant="ghost" size="icon-sm">
        <Link href={hrefFor(target)} aria-label={label}>
          {icon}
        </Link>
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-disabled
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      >
        {icon}
      </Button>
    );

  return (
    <>
      {edge(t('previousPage'), <ChevronLeft aria-hidden="true" />, page - 1, page > 1)}
      {pageWindow(page, pageCount).map((number) => (
        <Button
          key={number}
          asChild
          variant="ghost"
          size="icon-sm"
          className={cn(
            'tabular-nums',
            number === page &&
              'bg-nav-active font-medium text-nav-active-foreground hover:bg-nav-active',
          )}
        >
          <Link
            href={hrefFor(number)}
            aria-label={t('page', { page: number })}
            {...(number === page ? { 'aria-current': 'page' as const } : {})}
          >
            {number}
          </Link>
        </Button>
      ))}
      {edge(t('nextPage'), <ChevronRight aria-hidden="true" />, page + 1, page < pageCount)}
    </>
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

/** `location.hash` without its `#`, decoded; unreadable escapes read as no hash. */
function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return '';
  }
}

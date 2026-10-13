import {
  parseTableUrlState,
  type ReadableParams,
  type TableUrlOptions,
} from '@/lib/table-url-state';

/**
 * SPEC-022 BR-022-18 (#211, #237) — a batch page's row tables are paged on the
 * server, as `DataTable` server mode (DS-66): the URL is the state, the page
 * parses it with the same options the table writes with, and cuts the rows
 * before they are rendered. A file with a few thousand rows has a few thousand
 * mirrors in Ignoradas, each with its classify form; rendering them all at once
 * was one unbounded page, and rendering only the page asked for keeps the
 * forms to ten, twenty-five or fifty.
 *
 * Each table has a prefix of its own (`resumo_page`, `atencao_size`, …), so
 * they keep their places independently and a link to one table leaves the
 * others where they were. 10, 25 or 50 rows a page, opening on 10, like every
 * table in the product — a choice that lives in the URL.
 *
 * **Sorting is off** for all three. The rows are the batch's own, in file
 * order, held in memory by the page; the table renders the page it is handed
 * and no query exists that could order it. `sortableIds` is empty, so a stray
 * `?atencao_sort=` is unreadable rather than a different order.
 */
export const ROW_TABLE_PREFIX = {
  summary: 'resumo',
  attention: 'atencao',
  ignored: 'ignoradas',
} as const;

export type RowTable = keyof typeof ROW_TABLE_PREFIX;

export const ROW_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50];
export const ROW_DEFAULT_PAGE_SIZE = 10;

/** The options the table writes with (`paramPrefix`) and the server reads with. */
export function rowTableOptions(table: RowTable): TableUrlOptions {
  return {
    prefix: ROW_TABLE_PREFIX[table],
    pageSizeOptions: ROW_PAGE_SIZE_OPTIONS,
    sortableIds: [],
    defaults: { sort: null, pageSize: ROW_DEFAULT_PAGE_SIZE },
  };
}

/** Next hands the page `searchParams` as a record; the parser reads `.get`. */
export function readableParams(
  query: Readonly<Record<string, string | string[] | undefined>>,
): ReadableParams {
  return {
    get: (name) => {
      const value = query[name];
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    },
  };
}

export interface RowPage<T> {
  /** 1-based, clamped into the table's range. */
  readonly page: number;
  readonly pageSize: number;
  readonly rows: readonly T[];
  readonly total: number;
}

/**
 * The page of `items` the URL asks `table` for. A missing, malformed or
 * out-of-range page clamps rather than empties: after the last row of a page is
 * classified the same link must still land on rows, not on nothing — and the
 * table clamps the same way, so the page it labels is the page it shows.
 */
export function rowPage<T>(
  items: readonly T[],
  query: Readonly<Record<string, string | string[] | undefined>>,
  table: RowTable,
): RowPage<T> {
  const { page: requested, pageSize } = parseTableUrlState(
    readableParams(query),
    rowTableOptions(table),
  );
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requested, pages);
  return {
    page,
    pageSize,
    rows: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
  };
}

/**
 * Whether the URL addresses `table` at all: any of its parameters is present.
 * Ignoradas renders open on it — a closed disclosure would swallow the rows and
 * the pager a shared link points at.
 */
export function rowTableAddressed(
  query: Readonly<Record<string, string | string[] | undefined>>,
  table: RowTable,
): boolean {
  const prefix = `${ROW_TABLE_PREFIX[table]}_`;
  return Object.keys(query).some((name) => name.startsWith(prefix));
}

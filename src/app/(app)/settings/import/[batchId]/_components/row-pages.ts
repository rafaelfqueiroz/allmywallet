/**
 * SPEC-022 BR-022-18 (#211) — a batch page's row tables are paged on the
 * server, one URL parameter per table, so paging works without JavaScript
 * (DS-37) and each table keeps its own place. A file with a few thousand rows
 * has a few thousand mirrors in Ignoradas; rendered at once, each with its
 * classify form, that was one unbounded page.
 *
 * Not `DataTable`: it renders every cell twice (table and cards, DS-28), and
 * these cells hold forms — two copies of each control id, one hidden, is a
 * label that points at the wrong input.
 */
export const ROW_PAGE_SIZE = 50;

export const ROW_PAGE_PARAMS = {
  summary: 'resumo',
  attention: 'atencao',
  ignored: 'ignoradas',
} as const;

export type RowTable = keyof typeof ROW_PAGE_PARAMS;

export interface RowPage<T> {
  /** 1-based, clamped into the table's range. */
  readonly page: number;
  readonly rows: readonly T[];
  readonly total: number;
}

/**
 * The requested page of `items`. A missing, malformed or out-of-range page
 * clamps rather than empties: after the last row of a page is classified the
 * same link must still land on rows, not on nothing.
 */
export function rowPage<T>(
  items: readonly T[],
  requested: string | string[] | undefined,
  size: number = ROW_PAGE_SIZE,
): RowPage<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const parsed = Number.parseInt(
    Array.isArray(requested) ? (requested[0] ?? '') : (requested ?? ''),
    10,
  );
  const page = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), pages) : 1;
  return { page, rows: items.slice((page - 1) * size, page * size), total: items.length };
}

/**
 * The batch page's URL with one table moved to `page`, the others kept.
 *
 * The table being paged keeps its parameter even on page 1: its presence is
 * what says the user is working in that table — Ignoradas renders open on it
 * (a closed disclosure would swallow the rows and the pager the user just
 * clicked). The other tables drop a page-1 parameter, their default.
 */
export function rowPageHref(
  basePath: string,
  current: Readonly<Partial<Record<RowTable, number>>>,
  table: RowTable,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(ROW_PAGE_PARAMS) as RowTable[]) {
    const value = key === table ? page : current[key];
    if (value === undefined || (key !== table && value <= 1)) continue;
    params.set(ROW_PAGE_PARAMS[key], String(value));
  }
  const query = params.toString();
  return `${basePath}${query === '' ? '' : `?${query}`}#${table}`;
}

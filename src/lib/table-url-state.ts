/**
 * SPEC-022 BR-022-18 — a table's sort, page, page size and filter text, held in
 * the URL.
 *
 * The reasoning is `report-url-state.ts`'s (SPEC-011 DL-011-06): a view that
 * can be bookmarked, reloaded and pasted into a bug report is worth more than
 * one that lives in component state and evaporates on the back button.
 *
 * **Parsing never throws.** Every value is user-editable text — a truncated
 * link, a page number from before a filter shrank the list, a column that was
 * renamed since the bookmark. An unreadable value falls back to the default
 * for that one field; it never fails the page and never turns into a
 * *different* valid value (`size=30` is not rounded to 25, it is the default).
 *
 * **Only non-default values are written**, so the common link stays short and
 * `?q=extrato` says exactly what is unusual about the view.
 *
 * **Several tables on one page** do not collide because every parameter name
 * takes an optional prefix; **any other parameter in the URL is preserved**
 * on write, which is what lets a table live under a scope selector's `wallet`
 * parameter (BR-022-17) without erasing it.
 */

export interface TableUrlState {
  /** `null` means "no sort", an explicit state distinct from "the default". */
  readonly sort: { readonly id: string; readonly desc: boolean } | null;
  readonly page: number;
  readonly pageSize: number;
  readonly query: string;
}

export interface TableUrlDefaults {
  readonly sort: TableUrlState['sort'];
  readonly pageSize: number;
}

export interface TableUrlOptions {
  readonly prefix?: string | undefined;
  readonly pageSizeOptions: readonly number[];
  /** Column ids a `sort` may name; anything else is unreadable. */
  readonly sortableIds: readonly string[];
  readonly defaults: TableUrlDefaults;
}

export interface ReadableParams {
  get(name: string): string | null;
}

/** The filter text is bounded so a pasted novel cannot become a URL novel. */
export const MAX_QUERY_LENGTH = 100;

const SEPARATOR = ':';

export function tableParamNames(prefix: string | undefined) {
  const p = prefix ? `${prefix}_` : '';
  return {
    sort: `${p}sort`,
    page: `${p}page`,
    size: `${p}size`,
    query: `${p}q`,
  } as const;
}

function parseSort(
  raw: string | null,
  options: TableUrlOptions,
): { readonly value: TableUrlState['sort'] } {
  // Absent: the caller's default. Present but empty (`sort=`): the user
  // cleared the sort, and a default that silently came back would undo that.
  if (raw === null) return { value: options.defaults.sort };
  if (raw === '') return { value: null };

  const at = raw.lastIndexOf(SEPARATOR);
  if (at < 1) return { value: options.defaults.sort };
  const id = raw.slice(0, at);
  const direction = raw.slice(at + 1);
  if (!options.sortableIds.includes(id)) return { value: options.defaults.sort };
  if (direction !== 'asc' && direction !== 'desc') return { value: options.defaults.sort };
  return { value: { id, desc: direction === 'desc' } };
}

function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

export function parseTableUrlState(
  params: ReadableParams,
  options: TableUrlOptions,
): TableUrlState {
  const names = tableParamNames(options.prefix);

  const size = parsePositiveInt(params.get(names.size));
  const rawQuery = params.get(names.query);

  return {
    sort: parseSort(params.get(names.sort), options).value,
    page: parsePositiveInt(params.get(names.page)) ?? 1,
    pageSize:
      size !== null && options.pageSizeOptions.includes(size) ? size : options.defaults.pageSize,
    query: rawQuery === null ? '' : rawQuery.trim().slice(0, MAX_QUERY_LENGTH),
  };
}

function sameSort(a: TableUrlState['sort'], b: TableUrlState['sort']): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.desc === b.desc;
}

/**
 * State → the full query string, starting from `current` so unrelated
 * parameters survive. Returns the string without a leading `?`.
 */
export function writeTableUrlState(
  current: URLSearchParams | string,
  state: TableUrlState,
  options: TableUrlOptions,
): string {
  const params = new URLSearchParams(current);
  const names = tableParamNames(options.prefix);

  if (sameSort(state.sort, options.defaults.sort)) params.delete(names.sort);
  else
    params.set(
      names.sort,
      state.sort === null ? '' : `${state.sort.id}${SEPARATOR}${state.sort.desc ? 'desc' : 'asc'}`,
    );

  if (state.page > 1) params.set(names.page, String(state.page));
  else params.delete(names.page);

  if (state.pageSize !== options.defaults.pageSize) params.set(names.size, String(state.pageSize));
  else params.delete(names.size);

  const query = state.query.trim().slice(0, MAX_QUERY_LENGTH);
  if (query !== '') params.set(names.query, query);
  else params.delete(names.query);

  return params.toString();
}

/**
 * The window of page numbers to offer: up to `width` consecutive pages
 * centred on the current one, sliding at the ends. A 40-page list shows five
 * buttons, not forty; previous/next cover the rest.
 */
export function pageWindow(current: number, pageCount: number, width = 5): readonly number[] {
  const size = Math.min(width, pageCount);
  const start = Math.max(1, Math.min(current - Math.floor(size / 2), pageCount - size + 1));
  return Array.from({ length: size }, (_, index) => start + index);
}

import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId, WalletId, isUuid } from '@/core/shared/ids';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  type TransactionStatus,
  type TransactionType,
} from '@/core/ledger/transaction';
import {
  DEFAULT_TRANSACTION_SORT,
  TRANSACTION_SORT_KEYS,
  type Pagination,
  type TransactionFilter,
  type TransactionSort,
  type TransactionSortKey,
} from '@/core/ledger/ports';
import { ASSET_CLASSES, type AssetClass } from '@/db/schema/assets';
import { parseTableUrlState, type TableUrlOptions } from '@/lib/table-url-state';

/**
 * SPEC-006 BR-006-07/08/09/10 — the transaction history's filters and
 * pagination, held in the URL.
 *
 * Same rationale as `report-url-state.ts` (SPEC-011 DL-011-06): a bookmarked
 * or shared link has to reproduce the exact view, and a plain `<form
 * method="get">` (`Controls.tsx`) is what puts the state there without a
 * client-side mirror that can drift from it on the back button.
 *
 * **One URL parameter per filter dimension, no exceptions.** SPEC-011's
 * `Controls` shipped a whole milestone with the scope control inert because
 * two parameters (`scope` and `wallet`) could disagree and the parser trusted
 * the wrong one first (see that file's `parseScope`). Every field here is
 * independent and single-valued by construction, so there is nothing for a
 * second parameter to contradict.
 *
 * **Parsing never throws and never fails the page** — the same contract
 * `report-url-state.ts` documents. A hand-edited or stale URL falls back to
 * "no constraint" for that one field rather than erroring the whole list.
 */

export const PARAM = {
  from: 'from',
  to: 'to',
  asset: 'asset',
  assetClass: 'assetClass',
  type: 'type',
  institution: 'institution',
  status: 'status',
  wallet: 'wallet',
  q: 'q',
} as const;

/**
 * BR-006-07: the list has to work over 10.000+ rows within budget.
 * `core/ledger/list-transactions.ts`'s `MAX_PAGE_SIZE` (200) is the ceiling a
 * caller may request; this is the page size the list opens on.
 */
export const PAGE_SIZE = 50;

/** SPEC-022 BR-022-18's selectable page size. The largest is `MAX_PAGE_SIZE`. */
export const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 200];

/**
 * SPEC-022 BR-022-18 — the ledger's sort, page and page size, in the
 * parameters `DataTable` reads and writes (`lib/table-url-state.ts`): `sort`,
 * `page`, `size`. The table's `q` **is** BR-006-09's search, the filter bar's
 * field, so the two can never disagree about what was searched (#204 Decision
 * log #11). The server parses with these options and the table writes with
 * them, so the page a link asks for is the page the query fetches.
 *
 * The column ids are `TransactionSortKey`s, so a sort the URL can name is a
 * sort the repository can run.
 */
export const LEDGER_TABLE_URL_OPTIONS: TableUrlOptions = {
  pageSizeOptions: PAGE_SIZE_OPTIONS,
  sortableIds: TRANSACTION_SORT_KEYS,
  defaults: {
    sort: { id: DEFAULT_TRANSACTION_SORT.key, desc: DEFAULT_TRANSACTION_SORT.desc },
    pageSize: PAGE_SIZE,
  },
};

export interface LedgerView {
  readonly sort: TransactionSort;
  /** 1-based, as requested — the page clamps it once the total is known. */
  readonly page: number;
  readonly pageSize: number;
}

function isSortKey(value: string): value is TransactionSortKey {
  return (TRANSACTION_SORT_KEYS as readonly string[]).includes(value);
}

/**
 * The ledger's view parameters. An explicitly cleared sort (`sort=`) is still
 * BR-006-07's chronological order: a ledger has no "unsorted".
 */
export function ledgerViewFrom(params: ReadableParams): LedgerView {
  const state = parseTableUrlState(params, LEDGER_TABLE_URL_OPTIONS);
  return {
    sort:
      state.sort !== null && isSortKey(state.sort.id)
        ? { key: state.sort.id, desc: state.sort.desc }
        : DEFAULT_TRANSACTION_SORT,
    page: state.page,
    pageSize: state.pageSize,
  };
}

/** The last page a list of `total` rows has, at `pageSize`. Never less than 1. */
export function lastPage(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * A read-only view of the query string. `URLSearchParams` and Next's
 * `ReadonlyURLSearchParams` both satisfy it, as does a plain object in a page
 * or a test.
 */
export interface ReadableParams {
  get(name: string): string | null;
}

export interface TransactionsUrlState {
  readonly filter: TransactionFilter;
}

function isAssetClass(value: string): value is AssetClass {
  return (ASSET_CLASSES as readonly string[]).includes(value);
}

function isTransactionType(value: string): value is TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).includes(value);
}

function isTransactionStatus(value: string): value is TransactionStatus {
  return (TRANSACTION_STATUSES as readonly string[]).includes(value);
}

/**
 * `BusinessDate.of` throws on anything that is not a real `YYYY-MM-DD`; caught
 * here and turned into "no constraint" because a hand-edited URL is input,
 * not a bug (mirrors `report-url-state.ts#parseDate`).
 */
function parseDate(raw: string | null): BusinessDate | undefined {
  if (raw === null) return undefined;
  try {
    return BusinessDate.of(raw);
  } catch {
    return undefined;
  }
}

/**
 * Ids are attacker-reachable text that ends up in a tenant-scoped comparison
 * (AR-11) — `isUuid` is checked before `AssetId.of`/`InstitutionId.of` so a
 * non-UUID value falls back to "no constraint" rather than throwing.
 */
function parseAsset(raw: string | null): readonly AssetId[] | undefined {
  if (raw === null || !isUuid(raw)) return undefined;
  return [AssetId.of(raw)];
}

function parseInstitution(raw: string | null): readonly InstitutionId[] | undefined {
  if (raw === null || !isUuid(raw)) return undefined;
  return [InstitutionId.of(raw)];
}

/**
 * BR-006-08's wallet dimension. Same `isUuid` gate as the other two ids and
 * for the same reason — and the empty string matters here specifically,
 * because it is what the "todas as carteiras" option posts.
 */
function parseWallet(raw: string | null): WalletId | undefined {
  if (raw === null || !isUuid(raw)) return undefined;
  return WalletId.of(raw);
}

function parseAssetClass(raw: string | null): readonly AssetClass[] | undefined {
  if (raw === null || !isAssetClass(raw)) return undefined;
  return [raw];
}

function parseType(raw: string | null): readonly TransactionType[] | undefined {
  if (raw === null || !isTransactionType(raw)) return undefined;
  return [raw];
}

function parseStatus(raw: string | null): readonly TransactionStatus[] | undefined {
  if (raw === null || !isTransactionStatus(raw)) return undefined;
  return [raw];
}

/** BR-006-09: full-text search on asset code and name. Blank is "no search". */
function parseSearch(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function fromSearchParams(params: ReadableParams): TransactionsUrlState {
  return {
    filter: {
      from: parseDate(params.get(PARAM.from)),
      to: parseDate(params.get(PARAM.to)),
      assetIds: parseAsset(params.get(PARAM.asset)),
      assetClasses: parseAssetClass(params.get(PARAM.assetClass)),
      types: parseType(params.get(PARAM.type)),
      institutionIds: parseInstitution(params.get(PARAM.institution)),
      statuses: parseStatus(params.get(PARAM.status)),
      walletId: parseWallet(params.get(PARAM.wallet)),
      search: parseSearch(params.get(PARAM.q)),
    },
  };
}

/** `listTransactions`'s `Pagination` for a given 1-based page. */
export function paginationFor(page: number, pageSize: number = PAGE_SIZE): Pagination {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * BR-006-10 / AR-33 — the filter parameters, as a query string, for the CSV
 * export route. Sort, page and page size are not filters and are left out,
 * which is what makes "export what I am looking at" mean the whole filtered
 * set rather than the one page currently on screen.
 */
export function toQueryString(params: ReadableParams): string {
  const usp = new URLSearchParams();
  for (const key of Object.values(PARAM)) {
    const value = params.get(key);
    if (value !== null && value.trim() !== '') usp.set(key, value);
  }
  const query = usp.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * BR-006-08 — whether any filter narrowed the query. The page uses this to
 * tell "your ledger is empty" apart from "nothing matches these filters"
 * (the same distinction `(app)/reports/page.tsx`'s `ReportEmptyState` makes
 * for a period versus a whole portfolio) — extracted here, rather than left
 * as an inline check in the page, so the rule is unit-testable independently
 * of `getTranslations`, which cannot run outside a Next.js request (see this
 * module's test file).
 */
export function hasActiveFilters(filter: TransactionFilter): boolean {
  return Object.values(filter).some((value) => value !== undefined);
}

import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId, isUuid } from '@/core/shared/ids';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  type TransactionStatus,
  type TransactionType,
} from '@/core/ledger/transaction';
import type { Pagination, TransactionFilter } from '@/core/ledger/ports';
import { ASSET_CLASSES, type AssetClass } from '@/db/schema/assets';

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
  q: 'q',
  page: 'page',
} as const;

/**
 * BR-006-07: the list has to work over 10.000+ rows within budget.
 * `core/ledger/list-transactions.ts`'s `MAX_PAGE_SIZE` (200) is the ceiling a
 * caller may request; this is the page size the UI actually asks for.
 */
export const PAGE_SIZE = 50;

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
  /** 1-based. Never less than 1 — an out-of-range or malformed value falls back to 1. */
  readonly page: number;
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

function parsePage(raw: string | null): number {
  if (raw === null) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return value;
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
      search: parseSearch(params.get(PARAM.q)),
    },
    page: parsePage(params.get(PARAM.page)),
  };
}

/** `listTransactions`'s `Pagination` for a given 1-based page. */
export function paginationFor(page: number): Pagination {
  return { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
}

/**
 * BR-006-10 / AR-33 — the same filter parameters, as a query string, for
 * pagination links and the CSV export route. `page` is included only when
 * asked for and greater than 1, so the common "first page" link stays short
 * (mirrors `report-url-state.ts#toSearchParams`'s "only non-default values").
 *
 * The export route reads this **without** a page, which is what makes
 * "export what I am looking at" mean the whole filtered set rather than the
 * one page currently on screen.
 */
export function toQueryString(params: ReadableParams, page?: number): string {
  const usp = new URLSearchParams();
  for (const key of Object.values(PARAM)) {
    if (key === PARAM.page) continue;
    const value = params.get(key);
    if (value !== null && value.trim() !== '') usp.set(key, value);
  }
  if (page !== undefined && page > 1) usp.set(PARAM.page, String(page));
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

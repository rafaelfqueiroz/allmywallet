import type { BusinessDate } from '@/core/shared/clock';
import type { Money, Quantity } from '@/core/shared/money';
import type { AssetId, UserId } from '@/core/shared/ids';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';

export type { Clock } from '@/core/shared/clock';

/**
 * SPEC-008 — domain types and ports. AR-02/AR-03: declared here, next to the
 * use cases in this directory that need them; `src/adapters/quotes/` and
 * `src/adapters/calendar/` implement them, `src/db/schema/market.ts` is the
 * storage shape they are read from and written to.
 */

/**
 * The eight classes the catalog holds — the same set SPEC-006 constrains
 * `assets.class` to, declared here rather than imported because `core/` may
 * not reach into `src/db/` (AR-01).
 *
 * BR-008-11: fixed income (CDB/LCI/LCA) has no intraday behaviour and is
 * priced by SPEC-009's accrual rather than by a quote provider. That is a
 * statement about which assets get *polled*, not about which rows exist —
 * the ledger records CDB purchases, so those rows are in this catalog. The
 * narrowing lives in `derivePollingSet`'s class filter, which is where it can
 * be tested; a narrower type here would only have forced a lie in the
 * repository's row mapping.
 */
export type AssetClass = 'stock' | 'fii' | 'bdr' | 'etf' | 'tesouro_direto' | 'cdb' | 'lci' | 'lca';

export interface Asset {
  readonly id: AssetId;
  /**
   * The catalog's identifying code — `PETR4`, `HGLG11`, `Tesouro IPCA+ 2029`.
   * Named `code` rather than `ticker` because the catalog also holds
   * instruments that have no ticker; `ticker` survives below on the
   * provider-facing ports, where it genuinely is one.
   */
  readonly code: string;
  readonly name: string;
  readonly assetClass: AssetClass;
}

/**
 * BR-008-16: an unknown ticker is validated against the catalog **before**
 * any provider call, so a typo cannot spend budget. AR-02/AR-03: a real seam
 * — the Drizzle-backed adapter in production, a hand-written fake (TS-02) in
 * every use-case test.
 */
export interface AssetCatalogPort {
  findByCode(code: string): Promise<Asset | null>;
  findById(id: AssetId): Promise<Asset | null>;
  findByIds(ids: readonly AssetId[]): Promise<readonly Asset[]>;
  /**
   * BR-008-12: Tesouro Transparente's daily CSV is the catalog for Tesouro
   * Direto titles — there is no separate curation step, so `tesouro.sync`
   * onboards a title into `assets` the first time it sees it and refreshes
   * its name thereafter. Idempotent on `code` (AR-19).
   */
  upsertByCode(input: { code: string; name: string; assetClass: AssetClass }): Promise<Asset>;
}

/**
 * BR-008-08/BR-008-25: the polling set is derived, not configured — exactly
 * the distinct assets held in at least one user's non-zero position, across
 * all tenants (quotes are shared, BR-008-25). This port is the seam between
 * "quotes" and wherever positions eventually live (SPEC-006/007); see the
 * dispatch report for why no concrete adapter ships with this task.
 */
export interface HeldAssetsPort {
  listDistinctHeldAssetIds(): Promise<readonly AssetId[]>;
}

export interface LatestQuote {
  readonly assetId: AssetId;
  readonly price: Money;
  /** When the provider says this price is as-of (BR-008-01: ~30 min behind `fetchedAt`). */
  readonly quotedAt: Date;
  /** When this system actually made the request. Distinct from `quotedAt` — BR-008-04 shows both. */
  readonly fetchedAt: Date;
  readonly source: string;
}

export interface PriceQuote {
  readonly assetId: AssetId;
  readonly date: BusinessDate;
  readonly close: Money;
  readonly source: string;
}

/**
 * BR-008-10: intraday quotes update *current* value only and never rewrite a
 * historical data point — the two methods below are what make that
 * enforceable: `upsertLatestQuote` touches only the single-row-per-asset
 * `latest_quotes` table, `upsertClosePrice` touches only `price_quotes`,
 * keyed by `(assetId, date)`, and nothing in this port lets one path reach
 * the other's storage.
 */
export interface QuoteRepositoryPort {
  getLatestQuote(assetId: AssetId): Promise<LatestQuote | null>;
  upsertLatestQuote(quote: LatestQuote): Promise<void>;
  getClosePrice(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null>;
  /** BR-008-09: the official close supersedes the day's last intraday quote in history. */
  upsertClosePrice(quote: PriceQuote): Promise<void>;
}

export type IndexSeriesCode = 'CDI' | 'IPCA' | 'SELIC' | 'IBOV';

export interface IndexSeriesPointRecord {
  readonly code: IndexSeriesCode;
  readonly date: BusinessDate;
  readonly value: Quantity;
  readonly source: string;
}

export interface IndexSeriesRepositoryPort {
  latestDate(code: IndexSeriesCode): Promise<BusinessDate | null>;
  upsertPoints(points: readonly IndexSeriesPointRecord[]): Promise<void>;
}

/**
 * BR-008-19/BR-008-20: a monthly, provider-wide counter partitioned into
 * 'scheduled' and 'ondemand' — the partition is what makes the reserve
 * (`quotes.ondemand_reserve_pct`) a real budget wall rather than a shared
 * pool a burst of searching could drain. Keyed by a `YYYY-MM` string in the
 * deployment's own clock, not the provider's.
 */
export type BudgetKind = 'scheduled' | 'ondemand';

export interface BudgetUsage {
  readonly scheduled: number;
  readonly ondemand: number;
}

export interface BudgetCounterPort {
  getUsage(yearMonth: string): Promise<BudgetUsage>;
  /** AR-19: called once per successful provider request; a retried job must not double-count. */
  increment(yearMonth: string, kind: BudgetKind): Promise<void>;
}

/** BR-008-17: on-demand lookups are rate-limited per user. */
export interface QuoteRateLimiter {
  tryConsume(userId: UserId): boolean;
}

export interface TradingSession {
  readonly date: BusinessDate;
  readonly openUtc: Date;
  readonly closeUtc: Date;
  readonly isHalfSession: boolean;
}

/**
 * BR-008-07: the calendar, including half-sessions, is data driven by
 * configuration (`market.trading_calendar` selects the dataset), never
 * hardcoded hours scattered through polling logic.
 */
export interface TradingCalendar {
  isTradingDay(date: BusinessDate): boolean;
  sessionFor(date: BusinessDate): TradingSession | undefined;
  /** BR-008-05/06: whether the regular B3 session is open at this exact instant. */
  isSessionOpen(instant: Date): boolean;
  /** The regular (non-half) session length in minutes — cadence/budget arithmetic's input. */
  regularSessionMinutes(): number;
  /** Number of trading days in the given `YYYY-MM` month — budget projection's input. */
  tradingDaysInMonth(yearMonth: string): number;
}

export interface QuoteProviderResult {
  readonly ticker: string;
  readonly price: Money;
  readonly quotedAt: Date;
  /** Names the active `quotes.provider` adapter — persisted so BR-008-04's delay-tier display can name it. */
  readonly source: string;
}

export const QuoteProviderErrorCode = {
  /** BR-008-18: the provider does not have this ticker — not a transient fault. */
  NOT_FOUND: 'QUOTE_PROVIDER_NOT_FOUND',
  /** BR-008-27: a transient failure — retried with backoff by the caller, not looped here. */
  UNAVAILABLE: 'QUOTE_PROVIDER_UNAVAILABLE',
} as const;
export type QuoteProviderErrorCode =
  (typeof QuoteProviderErrorCode)[keyof typeof QuoteProviderErrorCode];

/**
 * AR-02/AR-03/DV-11: named for the role, not `BrapiClient` — BR-008-26
 * requires swapping vendor or delay tier to never touch valuation logic, and
 * this is the seam that makes that true.
 */
export interface QuoteProvider {
  fetchQuote(ticker: string): Promise<Result<QuoteProviderResult, DomainError>>;
}

/** BCB SGS series 12 (CDI), 433 (IPCA), 11 (Selic), plus IBOV (FR-6.x). */
export interface IndexSeriesProvider {
  fetchSeries(
    code: IndexSeriesCode,
    since: BusinessDate,
  ): Promise<Result<readonly IndexSeriesPointRecord[], DomainError>>;
}

export interface TesouroPricePoint {
  readonly ticker: string;
  readonly date: BusinessDate;
  readonly price: Money;
  readonly source: string;
}

/**
 * Tesouro Transparente publishes one CSV covering every title for the day —
 * structurally a batch fetch, not "one ticker per call" like `QuoteProvider`,
 * which is why it is its own port rather than reusing `QuoteProvider`'s shape
 * (a deviation from the issue's Modules table — see the dispatch report).
 */
export interface TesouroPriceProvider {
  fetchDailyPrices(): Promise<Result<readonly TesouroPricePoint[], DomainError>>;
}

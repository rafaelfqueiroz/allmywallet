import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type {
  Asset,
  AssetClass,
  IndexSeriesCode,
  LatestQuote,
  PriceQuote,
  TradingCalendar,
} from '@/core/quotes/ports';

/**
 * SPEC-009 — the valuation engine's domain types and ports.
 *
 * AR-01/AR-02: declared here, next to the use cases in this directory that
 * need them; `src/adapters/db/` implements them and `src/worker/handlers/`
 * wires them. Nothing in this directory imports a framework, a driver or an
 * adapter, which is what lets every rule below be tested with no database.
 */

export type { Asset, AssetClass, IndexSeriesCode, LatestQuote, PriceQuote, TradingCalendar };

/**
 * The three valuation methods, and the reason the spec has three: the
 * available data genuinely differs. Listed assets have an observed market
 * price; Tesouro Direto has a published daily sell price; bank paper
 * (CDB/LCI/LCA) has **no public price at all** and must be accrued from its
 * contracted indexer (BR-009-07, DL-009-01).
 */
export const ValuationMethod = {
  /** BR-009-01/02: quantity × close (history) or × latest quote (now). */
  LISTED_QUOTE: 'listed_quote',
  /** BR-009-05/06, DL-009-04: marked to market at the published **sell** price. */
  TESOURO_SELL_PRICE: 'tesouro_sell_price',
  /** BR-009-07..10: accrued from the contracted indexer. An estimate (BR-009-11). */
  FIXED_INCOME_ACCRUAL: 'fixed_income_accrual',
  /**
   * DL-009-05, generalised: the defensible floor when no price and no usable
   * contract exist. Never zero, never omitted — omitting understates the
   * portfolio silently, with no visible cause.
   */
  COST_FALLBACK: 'cost_fallback',
} as const;
export type ValuationMethod = (typeof ValuationMethod)[keyof typeof ValuationMethod];

/**
 * BR-009-13 / AC-11: a position that could not be valued from data lands in
 * the "Needs attention" queue with a machine-readable reason. AR-38/AR-44: a
 * code, never pre-formatted prose — the i18n layer renders it.
 */
export const NeedsAttentionReason = {
  /** No `FixedIncomeContract` row exists for a CDB/LCI/LCA the ledger holds. */
  FIXED_INCOME_CONTRACT_MISSING: 'FIXED_INCOME_CONTRACT_MISSING',
  /** The contract exists but its indexer or rate could not be determined (BR-009-13). */
  FIXED_INCOME_RATE_UNREADABLE: 'FIXED_INCOME_RATE_UNREADABLE',
  /** A listed or Tesouro asset with no close and no intraday quote, ever. */
  PRICE_UNAVAILABLE: 'PRICE_UNAVAILABLE',
} as const;
export type NeedsAttentionReason = (typeof NeedsAttentionReason)[keyof typeof NeedsAttentionReason];

export const ValuationErrorCode = {
  CONTRACT_MISSING: 'VALUATION_CONTRACT_MISSING',
  RATE_UNREADABLE: 'VALUATION_RATE_UNREADABLE',
  /**
   * The ledger holds a transaction for an asset the catalog does not know.
   * A foreign key makes this unreachable in production, which is exactly why
   * it is an error rather than a fallback: there is no honest class to value
   * it as, and guessing one would put a plausible number on a broken row.
   */
  ASSET_NOT_FOUND: 'VALUATION_ASSET_NOT_FOUND',
} as const;
export type ValuationErrorCode = (typeof ValuationErrorCode)[keyof typeof ValuationErrorCode];

/**
 * SPEC-005 BR-005-06 owns `FixedIncomeContract`. This is the **read model**
 * SPEC-009 needs from it and nothing more — see the dispatch report: the
 * `fixed_income_contracts` table is #8's to create, so this task declares the
 * port and ships a hand-written fake (TS-02) rather than a Drizzle adapter.
 */
export const FIXED_INCOME_INDEXERS = ['cdi_percent', 'prefixado', 'ipca_spread'] as const;
export type FixedIncomeIndexer = (typeof FIXED_INCOME_INDEXERS)[number];

export interface FixedIncomeContract {
  readonly assetId: AssetId;
  /**
   * `null` where the import could not determine it — BR-009-13's "cannot be
   * determined", which is a real outcome of parsing a bank statement, not a
   * defect. Nullable on purpose so the rule has something to test.
   */
  readonly indexer: FixedIncomeIndexer | null;
  /**
   * The contracted rate as a **percentage**, matching how the instrument is
   * sold: `110` for 110% of CDI, `12.5` for 12,5% a.a. prefixado, `6` for
   * IPCA + 6% a.a. Not a fraction — the fraction is derived once, in
   * `accrual.ts`, where the conversion can be read in one place.
   */
  readonly ratePercent: Quantity | null;
  /** Accrual starts here (BR-009-08..10). */
  readonly issueDate: BusinessDate;
  /** BR-009-15: accrual stops here. `null` for an instrument with no stated maturity. */
  readonly maturityDate: BusinessDate | null;
  /**
   * The contracted principal. Carried for reconciliation and for the
   * "Needs attention" surface; **not** the accrual base — see `accrual.ts`,
   * which applies the factor to the ledger's own cost basis so a contract and
   * the ledger can never quietly disagree about what was invested.
   */
  readonly principal: Money;
}

export interface FixedIncomeContractPort {
  findByAssetId(assetId: AssetId): Promise<FixedIncomeContract | null>;
}

/** One point of a BCB SGS series: daily for CDI (12), monthly for IPCA (433). */
export interface IndexSeriesPoint {
  readonly date: BusinessDate;
  /** The published value, **as a percentage** — SGS 12 is % per day, SGS 433 is % per month. */
  readonly value: Quantity;
}

export interface IndexSeriesReaderPort {
  /** Inclusive of both ends, ordered by date ascending. */
  listPoints(
    code: IndexSeriesCode,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly IndexSeriesPoint[]>;
}

/**
 * BR-009-01/02/03 — the read side of SPEC-008's two quote tables, kept as one
 * port because a valuation needs exactly these two questions answered and
 * nothing else. `getCloseOnOrBefore` is the carry-forward lookup: it returns
 * the quote **with its own date**, so the caller can tell a same-day close
 * from a stale one and say so (BR-009-03's "visibly indicated rather than
 * silently").
 */
export interface PriceHistoryPort {
  getCloseOnOrBefore(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null>;
  /**
   * Every close in `[from, to]`, ascending. A snapshot rebuild covers years of
   * dates; asking per date would be one query per asset per day. Paired with a
   * single `getCloseOnOrBefore(asset, from)` anchor, this is the whole price
   * history a rebuild needs, in two queries per asset.
   */
  listCloses(
    assetId: AssetId,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly PriceQuote[]>;
  getLatestQuote(assetId: AssetId): Promise<LatestQuote | null>;
}

/**
 * What the UI needs to render the estimate marker's hover text (BR-009-11,
 * AC-9): which indexer, at what rate, over how many business days, through
 * which date. Structured, not prose — AR-44 keeps the wording in `next-intl`.
 */
export interface EstimateBasis {
  readonly indexer: FixedIncomeIndexer;
  /** AR-10: serialised at the boundary, never a `Decimal` in a JSON payload. */
  readonly ratePercent: string;
  readonly businessDays: number;
  /** BR-009-15: `min(asOf, maturityDate)` — after maturity this stops moving. */
  readonly throughDate: BusinessDate;
  readonly matured: boolean;
  /**
   * Business days inside the accrual window with no published index point.
   * Non-zero means the figure accrued over fewer days than the window holds —
   * surfaced rather than silently absorbed, for the same reason BR-009-03
   * makes a carried-forward close visible.
   */
  readonly missingIndexDays: number;
}

/**
 * One position, valued. Everything a report needs about a single holding on
 * a single date, and everything the UI needs to be honest about how the
 * figure was arrived at.
 */
export interface ValuedPosition {
  readonly assetId: AssetId;
  readonly assetClass: AssetClass;
  readonly quantity: Quantity;
  /** BR-009-19: exact. Rounding happens at display and nowhere else (AR-09). */
  readonly value: Money;
  /** quantity × average cost (SPEC-007). Zero for a closed position. */
  readonly costBasis: Money;
  /** BR-009-04 / AC-4: value − quantity × average cost. */
  readonly unrealizedGain: Money;
  readonly method: ValuationMethod;
  /**
   * BR-009-11 / DL-009-02: `true` means *computed*, not observed. A
   * carried-forward close is still an observed price — an older one — and is
   * reported by `carriedForward` instead, so a weekend does not label an
   * entire portfolio an estimate.
   */
  readonly estimated: boolean;
  /** BR-009-12 / AC-10: fixed income (including Tesouro) is gross of IR and IOF in v1. */
  readonly grossOfTaxes: boolean;
  /** The date the price actually came from. `null` when no price was used at all. */
  readonly priceDate: BusinessDate | null;
  /** BR-009-03 / AC-3: the price is older than the valuation date. */
  readonly carriedForward: boolean;
  readonly needsAttention: NeedsAttentionReason | null;
  /** Populated only for accrued fixed income (BR-009-11). */
  readonly basis: EstimateBasis | null;
}

/**
 * BR-009-16 — one row per user per day. The four figures every report reads
 * (SPEC-016 BR-016-05: reports read this, they never replay five years of
 * ledger per request), plus the marker that drives the UI's estimate badge.
 *
 * BR-009-17 / DL-009-06: **derived cache, never authoritative.** If this ever
 * disagrees with a recomputation from the ledger, the ledger wins and this is
 * rebuilt.
 */
export interface DailyValuationSnapshot {
  readonly date: BusinessDate;
  readonly totalValue: Money;
  /**
   * External flows only: buys and transfers in, less sells and transfers out.
   * Not price change, never earnings — that distinction is what SPEC-012's TWR
   * is built on.
   */
  readonly netContributions: Money;
  /** Proventos recognised at pay date (SPEC-014), cumulative to this date. */
  readonly earningsToDate: Money;
  readonly byAssetClass: ReadonlyMap<AssetClass, Money>;
  /** BR-009-11: any accrued (estimated) component in the total. */
  readonly hasEstimates: boolean;
}

/**
 * AR-10 — the serialisation boundary. `by_asset_class` is `jsonb` and a
 * `Decimal` that goes through `JSON.stringify` comes back a float, so every
 * figure crosses as a plain decimal string produced by `Money.toString()`.
 */
export interface SerializedSnapshot {
  readonly date: string;
  readonly totalValue: string;
  readonly netContributions: string;
  readonly earningsToDate: string;
  readonly byAssetClass: Readonly<Record<string, string>>;
  readonly hasEstimates: boolean;
}

export interface SnapshotRepositoryPort {
  /** AR-19: keyed `(user_id, date)`, so a retried job overwrites rather than duplicating. */
  upsertMany(snapshots: readonly DailyValuationSnapshot[]): Promise<void>;
  /** BR-009-18: invalidation. Returns how many rows were removed. */
  deleteFrom(date: BusinessDate): Promise<number>;
  listRange(from: BusinessDate, to: BusinessDate): Promise<readonly DailyValuationSnapshot[]>;
}

/**
 * Everything the valuation of a whole date range needs, loaded once.
 *
 * The alternative — a port call per asset per day — turns a five-year rebuild
 * into hundreds of thousands of queries. Loading up front also makes
 * `valueHoldingsAt` synchronous and therefore trivially testable: given a
 * context and a set of holdings, the figures are a pure function.
 *
 * Declared here rather than in `snapshot.ts` so that `holdings.ts` and
 * `snapshot.ts` can both depend on it without depending on each other.
 */
export interface ValuationContext {
  readonly calendar: TradingCalendar;
  readonly assets: ReadonlyMap<AssetId, Asset>;
  readonly contracts: ReadonlyMap<AssetId, FixedIncomeContract>;
  /** Ascending by date, per asset. */
  readonly closes: ReadonlyMap<AssetId, readonly PriceQuote[]>;
  readonly latest: ReadonlyMap<AssetId, LatestQuote>;
  /** SGS 12, daily. */
  readonly cdi: readonly IndexSeriesPoint[];
  /** SGS 433, monthly. */
  readonly ipca: readonly IndexSeriesPoint[];
}

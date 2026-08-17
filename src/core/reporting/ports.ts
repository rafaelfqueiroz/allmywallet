import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId, WalletId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type {
  DailyValuationSnapshot,
  EstimateBasis,
  NeedsAttentionReason,
} from '@/core/valuation/ports';

/**
 * SPEC-011 — the reporting framework's domain types and ports.
 *
 * AR-01/AR-02: declared here, next to the use cases in this directory that
 * need them. Nothing in `core/reporting/` imports a framework, a driver or an
 * adapter, which is what lets every rule below be tested with no database.
 *
 * **The shape of this module is the whole point** (DL-011-02). Four reports
 * built on four private implementations of "period, scope, grouping" drift:
 * the options diverge, the boundaries stop matching, and the totals between
 * reports stop reconciling. Built once, BR-011-08 ("switching the grouping
 * must never change any scope-level total") stops being a hope and becomes a
 * property of the construction — see `base-query.ts`.
 */

export type { AssetClass, DailyValuationSnapshot, EstimateBasis, NeedsAttentionReason };

// ---------------------------------------------------------------------------
// The three controls (BR-011-01, BR-011-02, BR-011-03)
// ---------------------------------------------------------------------------

/**
 * BR-011-03 — the five grouping dimensions, and only these. Custom
 * user-defined groupings are explicitly Out of Scope on the spec page.
 */
export const GROUPINGS = ['asset_class', 'wallet', 'asset', 'sector', 'institution'] as const;
export type Grouping = (typeof GROUPINGS)[number];

/**
 * BR-011-02 — scope narrows *what is included*; grouping (above) decides *how
 * the included data is broken apart*. DL-011-01: they are independent
 * controls precisely because a combined "view by" cannot express "this
 * wallet, broken down by asset class", which is a natural and common question.
 */
export type Scope =
  { readonly kind: 'portfolio' } | { readonly kind: 'wallet'; readonly walletId: WalletId };

/** BR-011-01 — the five period options. */
export const PERIOD_KINDS = ['ytd', '12m', '24m', 'all', 'custom'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export type Period =
  | { readonly kind: 'ytd' }
  | { readonly kind: '12m' }
  | { readonly kind: '24m' }
  | { readonly kind: 'all' }
  | { readonly kind: 'custom'; readonly from: BusinessDate; readonly to: BusinessDate };

/**
 * AR-29 — resolved bounds are **dates, never timestamps**. "What was it worth
 * on 15 March" is a date question; a timestamp shifts the answer across a
 * period boundary depending on the reader's timezone, which quietly corrupts
 * every report that straddles one.
 *
 * Both ends are **inclusive**: `from` is the baseline the period is measured
 * from and `to` is the closing date, so a report covers the value on `from`
 * and the value on `to` and everything between.
 */
export interface DateRange {
  readonly from: BusinessDate;
  readonly to: BusinessDate;
}

// ---------------------------------------------------------------------------
// Group keys (BR-011-09, BR-011-10)
// ---------------------------------------------------------------------------

/**
 * BR-011-09 / BR-011-10 — the two "absence" buckets are **first-class group
 * keys, never filters**, and they are deliberately distinct from one another:
 *
 *  - `UNASSIGNED` is the wallet dimension's answer for a holding no wallet has
 *    claimed. It is a real, meaningful state of the data (SPEC-010 BR-010-06:
 *    Unassigned is implicit and always visible), and hiding it would make the
 *    wallet groups fail to sum to the portfolio.
 *  - `NOT_CLASSIFIED` is every other dimension's answer for "this grouping
 *    does not apply to this holding" — sector is undefined for fixed income,
 *    and an institution is not always recorded. Dropping those holdings would
 *    make the sector view disagree with every other view of the same scope,
 *    with no visible cause (DL-011-04).
 *
 * They are separate constants rather than one shared "other" because they mean
 * different things to a user: "you have not filed this yet" versus "this
 * question does not apply here". AR-44 keeps the rendered wording in
 * `next-intl` — these are keys, not labels.
 */
export const UNASSIGNED_GROUP_ID = '__unassigned__';
export const NOT_CLASSIFIED_GROUP_ID = '__not_classified__';

/**
 * One partition of a scope. `id` is a **stable, URL- and CSV-safe string**:
 * it keys the aggregation map, survives a round trip through a bookmark
 * (BR-011-11) and names the group in an export (BR-011-12).
 *
 * `label` is deliberately *not* here. A group's display name is either an
 * i18n message (Unassigned, Not classified, an asset class) or tenant data
 * (a wallet name, an asset code), and resolving it in `core/` would either
 * hardcode Portuguese — violating AR-44 — or force this module to know about
 * message catalogues. The UI joins `id` to a name; the domain only partitions.
 */
export interface GroupKey {
  readonly dimension: Grouping;
  readonly id: string;
  /**
   * True for `UNASSIGNED_GROUP_ID` and `NOT_CLASSIFIED_GROUP_ID`. Carried
   * explicitly so a renderer can pick the i18n message without re-deriving the
   * comparison, and so a test can assert BR-011-09/10 without string matching.
   */
  readonly synthetic: boolean;
}

// ---------------------------------------------------------------------------
// The read model every report partitions
// ---------------------------------------------------------------------------

/**
 * What the catalog knows about an asset, for grouping purposes.
 *
 * `sector` is `string | null` and **is null for every asset today**: the
 * `assets` table has no sector column, and sourcing sector classification is
 * PRD open question Q5, explicitly listed Out of Scope on SPEC-015. That is
 * not a gap this module papers over — BR-011-10 already specifies the
 * behaviour for a holding with no sector ("Not classified"), so a null sector
 * flows through the same honest path fixed income does. When the catalog grows
 * the column, only the adapter changes.
 */
export interface AssetDescriptor {
  readonly assetId: AssetId;
  /** `PETR4`, `HGLG11`, `Tesouro IPCA+ 2029` — the catalog's identifying code. */
  readonly code: string;
  readonly name: string;
  readonly assetClass: AssetClass;
  /** BR-011-10: `null` → "Not classified", never dropped. */
  readonly sector: string | null;
}

/**
 * One valued position on the report's as-of date, at the grain the position
 * cache actually stores: `(asset, institution)` (SPEC-007 BR-007-08).
 *
 * **Where these come from matters** (BR-011-13, TS-32). They are read from the
 * SPEC-007 position cache and the SPEC-009 valuation snapshots — both of which
 * exist precisely so a report never replays five years of ledger per request
 * (DL-011-07). Nothing in `core/reporting/` imports the ledger, and
 * `tests/structural/reports-read-snapshots.test.ts` fails the build if that
 * ever changes.
 */
export interface ReportPosition {
  readonly assetId: AssetId;
  /** BR-011-10: `null` → "Not classified" under institution grouping. */
  readonly institutionId: InstitutionId | null;
  readonly quantity: Quantity;
  /** BR-009-19 / AR-09: exact. Rounding happens at display and nowhere else. */
  readonly value: Money;
  readonly costBasis: Money;
  /** BR-011-15 / BR-009-11: accrued fixed income is an estimate and is marked. */
  readonly estimated: boolean;
  /**
   * SPEC-009 BR-009-03 / AC-3 — the price is real but older than the
   * valuation date, carried forward across a weekend, a holiday, or a halt.
   *
   * **Deliberately not folded into `estimated`.** An estimate is a figure
   * nobody observed; a carried-forward close is one somebody observed, just
   * not today. Merging them would mark every weekend's whole portfolio an
   * estimate and drain the marker of the meaning it exists to carry — which
   * is `ValuedPosition`'s own reasoning, and this boundary used to discard it.
   */
  readonly carriedForward: boolean;
  /** The date the price actually came from. `null` when no price was used. */
  readonly priceDate: BusinessDate | null;
  /**
   * BR-009-13 / AC-11 — this holding could not be valued properly and is
   * sitting at cost. `null` when nothing is wrong.
   */
  readonly needsAttention: NeedsAttentionReason | null;
  /**
   * BR-009-11 / AC-9 — what an accrued figure was computed *from*: the
   * indexer, its rate, the business days elapsed. `null` for anything priced
   * by observation.
   *
   * The whole reason these four fields are here: `core/valuation` computes
   * every one of them and this interface used to carry only `estimated`, so
   * three acceptance criteria had nothing to render from. A field computed and
   * then dropped at a boundary is indistinguishable from one never computed.
   */
  readonly basis: EstimateBasis | null;
}

/** SPEC-010 DM-2 — one row per `(wallet, asset)`, stored by quantity. */
export interface ReportAllocation {
  readonly walletId: WalletId;
  readonly assetId: AssetId;
  readonly quantity: Quantity;
}

export interface ReportWallet {
  readonly walletId: WalletId;
  readonly name: string;
}

export interface ReportInstitution {
  readonly institutionId: InstitutionId;
  readonly name: string;
}

/**
 * **The canonical unit of every report.**
 *
 * One slice of one asset, at one institution, claimed by at most one wallet.
 * This is the finest grain any of the five dimensions can ask about, which is
 * the entire reason BR-011-08 holds: every grouping is a fold over this same
 * set, so switching the grouping re-partitions the same money rather than
 * recomputing it. Two dimensions cannot disagree about a total when neither
 * one is allowed to compute it.
 *
 * `walletId` is `null` for the unallocated remainder (BR-011-09's Unassigned),
 * which is why the wallet groups plus Unassigned always sum to the portfolio —
 * by construction, not by a reconciliation step.
 */
export interface ReportHolding {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly assetName: string;
  readonly assetClass: AssetClass;
  readonly sector: string | null;
  readonly institutionId: InstitutionId | null;
  /** `null` → BR-011-09's Unassigned bucket. */
  readonly walletId: WalletId | null;
  readonly quantity: Quantity;
  readonly value: Money;
  readonly costBasis: Money;
  readonly estimated: boolean;
  /** SPEC-009 AC-3 — see `ReportPosition.carriedForward`. */
  readonly carriedForward: boolean;
  readonly priceDate: BusinessDate | null;
  /** SPEC-009 AC-11 — the holding is at cost because it could not be priced. */
  readonly needsAttention: NeedsAttentionReason | null;
  /** SPEC-009 AC-9 — what an accrued figure was computed from. */
  readonly basis: EstimateBasis | null;
}

/**
 * A grouped result: the groups, and the scope total they sum to.
 *
 * `total` is carried alongside rather than left for the caller to re-add
 * because it is the figure BR-011-08 is about — the assertion "every grouped
 * view sums to the same figure" needs both halves in one place to be checkable
 * at all (AC-6, TS-12).
 */
export interface GroupedReport {
  readonly grouping: Grouping;
  readonly groups: readonly ReportGroup[];
  readonly total: ReportTotals;
}

export interface ReportGroup {
  readonly key: GroupKey;
  readonly totals: ReportTotals;
  /**
   * BR-011-07 / AC-9: a group row drills down to its constituent assets
   * without leaving the report. The constituents ship with the group rather
   * than behind a second query, so expanding one cannot show a figure derived
   * differently from the row it expands.
   */
  readonly holdings: readonly ReportHolding[];
}

export interface ReportTotals {
  readonly value: Money;
  readonly costBasis: Money;
  readonly quantity: Quantity;
  /** BR-011-15 / AC-15: true when any constituent figure is accrued rather than observed. */
  readonly estimated: boolean;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * AR-02/AR-03 — one port, because a report needs exactly these reads and
 * nothing else, and they are always satisfied together by the same adapter
 * inside one `withTenant` transaction (AR-11).
 *
 * Every method here reads a **derived cache** (`positions`,
 * `daily_valuation_snapshots`, `wallet_allocations`) or shared reference data
 * (`assets`, `institutions`). None of them reads `transactions`. That is
 * BR-011-13, and it is the difference between a 3s report and a 5-year replay.
 */
export interface ReportDataPort {
  /**
   * Positions held on `asOf`, already valued, at `(asset, institution)` grain.
   * Positions closed to zero are not returned — they are worth nothing, carry
   * no price, and would render as zero rows in every group.
   */
  listValuedPositions(asOf: BusinessDate): Promise<readonly ReportPosition[]>;
  listAllocations(): Promise<readonly ReportAllocation[]>;
  listWallets(): Promise<readonly ReportWallet[]>;
  listInstitutions(): Promise<readonly ReportInstitution[]>;
  describeAssets(assetIds: readonly AssetId[]): Promise<readonly AssetDescriptor[]>;
  /** BR-011-13 — the persisted period series every report's chart reads. */
  listSnapshots(from: BusinessDate, to: BusinessDate): Promise<readonly DailyValuationSnapshot[]>;
  /**
   * The snapshot immediately **preceding** a date — the period's *baseline*,
   * which is a different thing from its first observation.
   *
   * SPEC-009 values a date by replaying to and including it, so a snapshot
   * dated `from` is the **close** of `from`. Opening a period's series on it
   * therefore measures from the end of the first day and silently discards
   * whatever happened during it — the classic off-by-one, and one that fails
   * quietly because the figure it produces is still entirely plausible.
   * SPEC-013 BR-013-02 needs this for growth decomposition and SPEC-012
   * BR-012-01/03 need it for the return measures, which is why it sits on the
   * shared port rather than on one report's adapter.
   *
   * `null` when the date is at or before the tenant's first snapshot. There is
   * no baseline then, and inventing a zero one would report the whole opening
   * *patrimônio* as a first-day gain.
   */
  findSnapshotBefore(date: BusinessDate): Promise<DailyValuationSnapshot | null>;
  /** BR-011-02 — used to reject a scope naming a wallet this tenant does not have. */
  findWallet(walletId: WalletId): Promise<ReportWallet | null>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ReportingErrorCode = {
  /** BR-011-01: a custom range whose end precedes its start. */
  INVALID_PERIOD_RANGE: 'REPORTING_INVALID_PERIOD_RANGE',
  /** BR-011-02: the scope names a wallet that does not exist for this tenant. */
  WALLET_NOT_FOUND: 'REPORTING_WALLET_NOT_FOUND',
  /** A position carries value but no quantity to apportion it by — see `base-query.ts`. */
  INDIVISIBLE_VALUE: 'REPORTING_INDIVISIBLE_VALUE',
  /** The position cache references an asset the catalog does not describe. */
  ASSET_NOT_DESCRIBED: 'REPORTING_ASSET_NOT_DESCRIBED',
} as const;
export type ReportingErrorCode = (typeof ReportingErrorCode)[keyof typeof ReportingErrorCode];

import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type {
  EstimateBasis,
  GroupKey,
  Grouping,
  NeedsAttentionReason,
  ReportTotals,
} from '@/core/reporting/ports';
import type { SnapshotDerived } from '@/core/reporting/snapshot-derived';

/**
 * SPEC-015 — the Composition report's domain types.
 *
 * The report answers **what am I actually holding, and is it balanced?**
 *
 * ---------------------------------------------------------------------------
 * THE TWO GRAINS, AND WHY THERE ARE TWO
 *
 * BR-015-02 asks for two presentations of one scope, and they are not the same
 * shape:
 *
 *  - **`breakdown`** partitions the scope by SPEC-011's *selected grouping*
 *    (BR-015-01) and carries each partition's share of the total. That is the
 *    chart. Asset class, wallet, asset, sector, institution — five answers to
 *    "how is this split", from one fold over one holding set.
 *  - **`rows`** is one row **per asset**, always, whatever the grouping is.
 *    That is the table.
 *
 * The table is not "the breakdown with more columns", and the reason is
 * arithmetic rather than layout: BR-015-02 requires **average price** and
 * **current price** per row, and a price is a property of an asset. The
 * average price of the "Ações" group, or of the "Aposentadoria" wallet, is not
 * a smaller or rounder number — it is not a number at all. A single grain
 * carrying both would have had to render those two columns blank for four of
 * the five dimensions, or invent a weighted pseudo-price nobody could
 * reconcile against a broker note.
 *
 * Both are folds over the same `ReportHolding[]` that `runReportQuery`
 * produced, so BR-015-10 holds for the same reason BR-011-08 does: neither
 * grain is permitted to compute the total, so neither can disagree about it.
 * ---------------------------------------------------------------------------
 */

/**
 * One partition of the scope, with its share of the whole.
 *
 * `share` is a **fraction** — `0,25`, not `25`. The ×100 belongs to the
 * display layer (`formatPercent`), the same decision SPEC-013's `gainRatio`
 * records: a domain that pre-scales for one renderer has decided how it will
 * be read.
 *
 * `null` when the scope totals zero. A share of nothing is not zero, it is
 * undefined, and rendering `0,00 %` beside a holding somebody owns would be a
 * figure the user cannot tell from a real one. Every share in a report is null
 * together or present together — see `sharesOf`.
 */
export interface CompositionSlice {
  readonly key: GroupKey;
  readonly totals: ReportTotals;
  readonly share: Money | null;
}

/**
 * One asset in the scope, folded across every institution and — at portfolio
 * scope — every wallet holding a piece of it.
 *
 * **At wallet scope these are the allocated figures, not the held ones**
 * (BR-015-11, DL-015-05), and that is true by construction rather than by a
 * filter here: `applyScope` has already sliced the holding set per wallet
 * before this module ever sees it. Showing the full position would double-count
 * a 60/40 split as 100 % in both wallets.
 */
export interface CompositionRow {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly assetName: string;
  readonly assetClass: AssetClass;
  /** BR-015-03: `null` → "Not classified", never dropped. */
  readonly sector: string | null;
  readonly quantity: Quantity;
  /** BR-015-07: current market value, never cost. */
  readonly value: Money;
  readonly costBasis: Money;
  /**
   * `costBasis ÷ quantity` — SPEC-007's *preço médio*, re-derived across the
   * institutions this asset is held at. `null` when the quantity is zero,
   * because a price per nothing is undefined rather than infinite.
   */
  readonly averagePrice: Money | null;
  /** `value ÷ quantity`. `null` for the same reason. */
  readonly currentPrice: Money | null;
  /**
   * BR-015-08 — `value − costBasis`.
   *
   * Stated by the spec as `value − (quantity × average cost)`, and computed
   * here as the subtraction the spec's own form reduces to. The difference is
   * not cosmetic: `averagePrice` above is a *division*, and multiplying it back
   * by the quantity would reintroduce the truncation the division just
   * introduced, so a row's gain would fail to reconcile against its own two
   * columns by an ulp. `costBasis` **is** quantity × average cost, carried
   * exactly from SPEC-007's cache, so subtracting it is the same figure
   * without the round trip.
   */
  readonly unrealizedGain: Money;
  /** Share of the scope's total value. `null` when that total is zero. */
  readonly share: Money | null;
  /** BR-015-05 — this asset's share exceeds the configured threshold. */
  readonly concentrated: boolean;
  /** BR-015-09 / BR-009-11 — accrued rather than observed. */
  readonly estimated: boolean;
  /** SPEC-009 AC-3 — a real price, from an earlier date. */
  readonly carriedForward: boolean;
  /** BR-015-13 — the date the price actually came from. */
  readonly priceDate: BusinessDate | null;
  /** SPEC-009 AC-11 — could not be priced, so it sits at cost. */
  readonly needsAttention: NeedsAttentionReason | null;
  /** SPEC-009 AC-9 — what an accrued figure was computed from. */
  readonly basis: EstimateBasis | null;
}

/**
 * A folded asset row before BR-015-05's flag is applied.
 *
 * The flag is a separate step because it is a separate decision: `breakdown.ts`
 * computes what is true of the portfolio, and `concentration.ts` applies the
 * threshold the *user configured* to it. Building rows with `concentrated:
 * false` and overwriting the field afterwards would put a value on screen that
 * was wrong for one tick of the fold, and would make the flagging step's own
 * test unable to tell "not flagged" from "not yet flagged".
 */
export type UnflaggedRow = Omit<CompositionRow, 'concentrated'>;

/**
 * BR-015-04 — how one group's share of the scope moved across the period.
 *
 * Shares, not values: a portfolio that doubled has every value up and its
 * *allocation* possibly unchanged, and it is the allocation this rule is
 * about. `change` is `closing − opening` in fractional points, so `+0,05` is
 * five percentage points more of the portfolio than at the baseline.
 */
export interface AllocationShift {
  readonly key: GroupKey;
  readonly opening: Money;
  readonly closing: Money;
  readonly change: Money;
}

/**
 * BR-015-05/06 — the concentration flag, and the threshold it fired on.
 *
 * The threshold travels with the report because the screen has to name it:
 * "acima de 20 %" is the difference between a fact the user configured and a
 * judgement the product made. DL-015-03 is explicit that this is a tool the
 * user sets, not an opinion the product holds — and BR-015-06 forbids any
 * wording that suggests an action.
 */
export interface Concentration {
  /** The resolved `reports.concentration_threshold_pct`, as an integer percent. */
  readonly thresholdPct: number;
  /** The assets whose share exceeds it, largest first. */
  readonly flagged: readonly AssetId[];
}

/**
 * BR-015-13 / SPEC-008 BR-008-04 — "every screen showing a current value
 * displays the quote timestamp and the delay tier. The product never implies
 * real-time."
 *
 * Three separate facts, deliberately not collapsed into one line:
 *
 *  - `valuationAsOf` is the **date the report is answering about**.
 *  - `quotedAt` is the provider's own as-of instant for the freshest quote
 *    behind these figures — an *instant*, not a date, because a 30-minute
 *    delay is invisible at date resolution and this field exists precisely to
 *    make the delay visible. `null` when nothing in the scope is priced by a
 *    live quote, which is the ordinary case for a fixed-income-only portfolio.
 *  - `delayMinutes` is the resolved `quotes.cadence_minutes` — the tier, in
 *    the plain terms BR-008-04 asks for.
 */
export interface QuoteFreshness {
  readonly valuationAsOf: BusinessDate;
  readonly quotedAt: Date | null;
  readonly delayMinutes: number;
}

/** SPEC-015 — the assembled report. */
export interface CompositionReport {
  readonly grouping: Grouping;
  /** BR-015-01/07 — the chart's slices, largest first. */
  readonly breakdown: readonly CompositionSlice[];
  /** BR-015-02 — the sortable table's rows, largest first. */
  readonly rows: readonly CompositionRow[];
  /**
   * BR-015-10 — the scope total, summed from the holdings rather than from
   * either grain above, so "the parts sum to the whole" stays an assertion
   * with something to catch. The same figure SPEC-013's headline reports.
   */
  readonly total: ReportTotals;
  /** BR-015-04 — snapshot-derived, so absent at wallet scope (ADR-002). */
  readonly drift: SnapshotDerived<readonly AllocationShift[]>;
  readonly concentration: Concentration;
  readonly quotes: QuoteFreshness;
}

import Decimal from 'decimal.js';
import type { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { Money, Quantity, sumMoney, sumQuantity } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import {
  compareGroupKeys,
  groupKeyResolver,
  resolveGroupNames,
  type GroupNames,
} from '@/core/reporting/grouping';
import { asOfFor, resolvePeriod } from '@/core/reporting/period';
import { applyScope, isEmptyScope, resolveScope, type ResolvedScope } from '@/core/reporting/scope';
import {
  ReportingErrorCode,
  type AssetDescriptor,
  type DailyValuationSnapshot,
  type DateRange,
  type GroupedReport,
  type Grouping,
  type Period,
  type ReportAllocation,
  type ReportDataPort,
  type ReportGroup,
  type ReportHolding,
  type ReportPosition,
  type ReportTotals,
  type Scope,
} from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-08 — "switching the grouping must never change any
 * scope-level total."
 *
 * **How this file makes that true, and why it is built this way.**
 *
 * The tempting implementation is one aggregation query per dimension: sum by
 * asset class, sum by wallet, sum by sector. Five queries, five chances to
 * filter differently, and the failure mode is not a crash — it is two screens
 * that disagree about the same portfolio, with nothing on either one to say
 * which is right (DL-011-03).
 *
 * So instead there is exactly one holding set, built once
 * (`buildHoldingSet`), and every grouping is a **fold over that same set**
 * (`aggregate`). Switching the grouping re-partitions money that has already
 * been computed; it never recomputes it. Two dimensions cannot disagree about
 * a total when neither one is permitted to calculate it.
 *
 * The scope total is deliberately summed from the **holdings**, not from the
 * group subtotals. Summing the groups would make the invariant test
 * tautological — it would assert that a number equals itself. Summing
 * independently is what gives `totals-invariant.test.ts` something real to
 * catch.
 *
 * BR-011-13 / TS-32: nothing here imports the ledger. The inputs arrive from
 * the SPEC-007 position cache and the SPEC-009 valuation snapshots, which
 * exist precisely so a report never replays five years of transactions per
 * request.
 */

// ---------------------------------------------------------------------------
// Exact proportional distribution
// ---------------------------------------------------------------------------

/**
 * Splits `total` across `weights` so that **the parts sum to exactly the
 * whole**, with no residue lost and none invented.
 *
 * This is the single most dangerous arithmetic in the reporting framework, and
 * the reason is worth being explicit about. A wallet holding 60 of 100 ITSA4
 * holds 60% of that position's value, so apportioning value across wallets
 * means dividing — and division of a repeating decimal has to terminate
 * somewhere. `Money.dividedBy` terminates at 40 significant digits, rounding
 * **down** (see `core/shared/money.ts`). Compute every share that way and the
 * shares sum to slightly *less* than the total: a portfolio that silently
 * loses a sliver of itself every time it is grouped by wallet, and gains it
 * back when grouped by asset class. That is BR-011-08 broken by a rounding
 * mode, and it would surface as totals that disagree by 1e-38 — small enough
 * to survive review, large enough to fail an exact-equality invariant.
 *
 * The fix is the classic one: compute the first n−1 shares by division and
 * give the **last share the residual**, `total − Σ(others)`. The sum is then
 * exact by construction rather than by luck, whatever the rounding mode does.
 *
 * Worked example, by hand — R$ 100,00 across three equal weights:
 *
 *   weightSum = 1 + 1 + 1 = 3
 *   share[0]  = 100 × 1 ÷ 3 = 33.333…3   (40 digits, truncated down)
 *   share[1]  = 100 × 1 ÷ 3 = 33.333…3   (identical)
 *   share[2]  = 100 − (share[0] + share[1])
 *             = 100 − 66.666…6 = 33.333…4
 *   Σ = exactly 100.00                    ← the property that must hold
 *
 * The last share therefore differs from its siblings by up to (n−1) ulps at
 * the 40th significant digit. At `NUMERIC(20,8)` that is 30 orders of
 * magnitude below the last stored decimal place: invisible where it is
 * displayed, exact where it is summed.
 *
 * **The zero-weight case is an error, not a zero.** If the weights sum to
 * nothing but there is value to apportion, there is no honest answer — every
 * candidate (drop it, put it all in the first bucket) either loses money or
 * attributes it somewhere arbitrary. It is reported as unavailable instead;
 * a zero here would be a lie the user could not detect.
 */
export function distributeExact(
  total: Money,
  weights: readonly Quantity[],
): Result<readonly Money[], DomainError<ReportingErrorCode>> {
  if (weights.length === 0) {
    // Nothing to distribute across. Only honest when there is nothing to
    // distribute — otherwise the value would simply vanish from the report.
    return total.isZero()
      ? ok([])
      : err(domainError(ReportingErrorCode.INDIVISIBLE_VALUE, { total: total.toString() }));
  }

  const weightSum = sumQuantity(weights);
  if (weightSum.isZero()) {
    if (!total.isZero()) {
      return err(
        domainError(ReportingErrorCode.INDIVISIBLE_VALUE, {
          total: total.toString(),
          weights: weights.length,
        }),
      );
    }
    // Zero split zero ways is zero everywhere — no division, no residue.
    return ok(weights.map(() => Money.zero()));
  }

  const shares: Money[] = [];
  let allocated = Money.zero();
  for (let index = 0; index < weights.length - 1; index += 1) {
    // Non-null: `index` is strictly below `weights.length`.
    const weight = weights[index] as Quantity;
    const share = quantizeToStorageScale(total.times(weight).dividedBy(weightSum));
    shares.push(share);
    allocated = allocated.plus(share);
  }
  // The residual. This line is the whole point of the function.
  shares.push(total.minus(allocated));
  return ok(shares);
}

/**
 * AR-06/AR-28: `NUMERIC(20,8)` is the persisted precision — eight decimal
 * places, and no column in this schema can hold a ninth.
 *
 * **Why an apportioned share must be quantised, and why the invariant depends
 * on it.** `Money` carries 40 significant digits, and `dividedBy` fills all of
 * them for a repeating decimal: one third of R$ 1.000 is a 40-digit number.
 * Addition at a fixed significant-digit budget is **not associative** — adding
 * six hundred such values in one order truncates at different points from
 * adding them in another. So the same holdings, partitioned by wallet and
 * partitioned by asset class, summed to figures differing at the 35th
 * significant digit. Small enough to survive any review; large enough to fail
 * BR-011-08's exact-equality invariant, which is how this was found.
 *
 * Quantising each share to eight decimal places puts every figure a report
 * sums *decades* inside the 40-digit budget: six hundred holdings totalling
 * tens of thousands of reais occupy roughly fourteen significant digits, so no
 * addition truncates at all, and every grouping therefore sums to a bitwise
 * identical total. Exactness is restored by staying inside the precision, not
 * by hoping the rounding cancels.
 *
 * Two decisions carried over verbatim from `core/valuation/snapshot.ts`'s
 * `quantizeSnapshot`, which solved the same problem for the same reason:
 *
 *  1. **`ROUND_HALF_UP`**, because that is what Postgres does when it reduces
 *     a NUMERIC to scale. Any other mode would mean this quantisation and the
 *     column fought each other, reintroducing the discrepancy it removes.
 *  2. **The whole is never quantised — only the parts**, and the last part
 *     takes the residual. So "the total equals the sum of its parts" stays
 *     exactly true, rather than true up to half an ulp per part.
 *
 * This does not contradict AR-09's "rounding only at display". AR-09 forbids
 * rounding *intermediates in the domain*; an apportioned share is a finished
 * figure at the storage boundary, where the declared column precision applies.
 * The total above it is never rounded at all.
 */
export const STORED_SCALE = 8;

export function quantizeToStorageScale(value: Money): Money {
  return Money.fromString(value.toDecimal().toFixed(STORED_SCALE, Decimal.ROUND_HALF_UP));
}

// ---------------------------------------------------------------------------
// Building the canonical holding set
// ---------------------------------------------------------------------------

/** One wallet's claim on an asset, or the unallocated remainder. */
interface WalletSlice {
  readonly walletId: WalletId | null;
  readonly quantity: Quantity;
}

export interface HoldingSetInput {
  /** `(asset, institution)` grain, already valued on the report's as-of date. */
  readonly positions: readonly ReportPosition[];
  /** `(wallet, asset)` grain — SPEC-010 DM-2. */
  readonly allocations: readonly ReportAllocation[];
  readonly assets: readonly AssetDescriptor[];
}

/**
 * BR-011-09 — the canonical holding set: one slice per
 * `(asset, institution, wallet-or-Unassigned)`.
 *
 * **Why this grain, and why the cross product is unavoidable.** A position is
 * stored per `(asset, institution)` (SPEC-007 BR-007-08); an allocation is
 * stored per `(wallet, asset)` (SPEC-010 DM-2). Neither knows about the
 * other's dimension — an allocation carries no institution, and it never will,
 * because a user allocating 60 ITSA4 to "Aposentadoria" is not making a
 * statement about which broker holds them. But a report may be scoped to a
 * wallet *and* grouped by institution, so both dimensions have to be
 * answerable off the same rows.
 *
 * The only assumption that keeps both dimensions summing correctly is that a
 * wallet's claim on an asset is spread across that asset's institutions **in
 * proportion to the quantity held at each**. Worked through:
 *
 *   ITSA4: 100 held — 60 at XP, 40 at Rico
 *          allocated 50 to Wallet A, 30 to Wallet B, 20 unallocated
 *
 *   XP   (60% of the asset) → A 30, B 18, Unassigned 12   → 60 ✓
 *   Rico (40% of the asset) → A 20, B 12, Unassigned  8   → 40 ✓
 *
 *   grouped by wallet      → A 50, B 30, Unassigned 20    → 100 ✓
 *   grouped by institution → XP 60, Rico 40               → 100 ✓
 *   grouped by asset       → ITSA4 100                    → 100 ✓
 *
 * Every grouping sums to 100 because every grouping is folding the same six
 * slices. That is BR-011-08, obtained structurally rather than defended by a
 * reconciliation step.
 *
 * **The unallocated remainder is computed, never stored** (SPEC-010 BR-010-06,
 * DL-010-07), as `held − allocated`. It is included as a slice with a `null`
 * wallet, which is what makes the wallet groups plus Unassigned add up to the
 * portfolio by construction.
 */
export function buildHoldingSet(
  input: HoldingSetInput,
): Result<readonly ReportHolding[], DomainError<ReportingErrorCode>> {
  const descriptors = new Map<AssetId, AssetDescriptor>();
  for (const asset of input.assets) descriptors.set(asset.assetId, asset);

  const allocationsByAsset = new Map<AssetId, ReportAllocation[]>();
  for (const allocation of input.allocations) {
    const existing = allocationsByAsset.get(allocation.assetId);
    if (existing === undefined) allocationsByAsset.set(allocation.assetId, [allocation]);
    else existing.push(allocation);
  }

  const heldByAsset = new Map<AssetId, Quantity>();
  for (const position of input.positions) {
    heldByAsset.set(
      position.assetId,
      (heldByAsset.get(position.assetId) ?? Quantity.zero()).plus(position.quantity),
    );
  }

  const holdings: ReportHolding[] = [];
  for (const position of input.positions) {
    const descriptor = descriptors.get(position.assetId);
    if (descriptor === undefined) {
      // A foreign key makes this unreachable in production, which is exactly
      // why it is an error rather than a fallback: there is no honest class,
      // sector or name to group it under, and inventing one would put a
      // plausible number on a broken row.
      return err(
        domainError(ReportingErrorCode.ASSET_NOT_DESCRIBED, { assetId: position.assetId }),
      );
    }

    const slices = walletSlicesFor(
      // An asset with no allocation at all is the ordinary case — everything
      // it holds belongs to the Unassigned remainder.
      allocationsByAsset.get(position.assetId) ?? [],
      // Not `?? zero`: `heldByAsset` was built from this same array in the
      // loop immediately above, so every position's asset is a key and the
      // lookup cannot miss. A defensive fallback here would be a branch no
      // test could ever reach, which is worse than an assertion — it would sit
      // in the file looking like a handled case.
      heldByAsset.get(position.assetId) as Quantity,
    );

    const quantities = distributeExact(asMoney(position.quantity), sliceWeights(slices));
    if (!quantities.ok) return quantities;
    const values = distributeExact(position.value, sliceWeights(slices));
    if (!values.ok) return values;
    const costs = distributeExact(position.costBasis, sliceWeights(slices));
    if (!costs.ok) return costs;

    slices.forEach((slice, index) => {
      holdings.push({
        assetId: position.assetId,
        assetCode: descriptor.code,
        assetName: descriptor.name,
        assetClass: descriptor.assetClass,
        sector: descriptor.sector,
        institutionId: position.institutionId,
        walletId: slice.walletId,
        // Non-null: `distributeExact` returns exactly one share per weight.
        quantity: asQuantity(quantities.value[index] as Money),
        value: values.value[index] as Money,
        costBasis: costs.value[index] as Money,
        estimated: position.estimated,
        /**
         * Carried onto every slice, not split. Value and quantity divide
         * between wallets; *how the price was obtained* does not — a
         * carried-forward close is equally carried-forward for each wallet
         * holding a piece of it. Splitting these would be a category error.
         */
        carriedForward: position.carriedForward,
        priceDate: position.priceDate,
        needsAttention: position.needsAttention,
        basis: position.basis,
      });
    });
  }

  return ok(holdings);
}

/**
 * The wallet slices of one asset: every allocation, plus the unallocated
 * remainder.
 *
 * **Zero-quantity slices are dropped before any distribution happens**, and
 * the ordering matters. Dropping them afterwards would discard whichever slice
 * had received `distributeExact`'s residual, silently breaking the exactness
 * the residual exists to guarantee. Dropping them first means every remaining
 * weight is non-zero and the sum stays exact.
 *
 * A fully-allocated asset therefore contributes no Unassigned slice at all,
 * rather than a zero row — consistent with SPEC-010's `computeUnassigned`,
 * which returns only positive remainders. Adding zero to a total changes
 * nothing, so the invariant is untouched either way; this is the version that
 * does not render an empty "Unassigned" group on a fully-filed portfolio.
 *
 * A **negative** remainder is passed through rather than clamped. It means
 * allocations exceed the held quantity — a violation of SPEC-010 BR-010-05
 * that the locked write path makes unreachable, but which a bulk `UPDATE`
 * could still produce. Clamping it to zero would make the wallet groups sum
 * to *more* than the portfolio while looking perfectly normal; passing it
 * through keeps the arithmetic honest and puts the contradiction on screen,
 * which is the only way anyone finds out.
 */
function walletSlicesFor(
  allocations: readonly ReportAllocation[],
  heldQuantity: Quantity,
): readonly WalletSlice[] {
  const allocated = sumQuantity(allocations.map((allocation) => allocation.quantity));
  const slices: WalletSlice[] = allocations.map((allocation) => ({
    walletId: allocation.walletId,
    quantity: allocation.quantity,
  }));
  // BR-011-09 / SPEC-010 BR-010-06: held − allocated, computed and never stored.
  slices.push({ walletId: null, quantity: heldQuantity.minus(allocated) });
  return slices.filter((slice) => !slice.quantity.isZero());
}

function sliceWeights(slices: readonly WalletSlice[]): readonly Quantity[] {
  return slices.map((slice) => slice.quantity);
}

/**
 * `Quantity` and `Money` are distinct types so the compiler refuses
 * `price.plus(quantity)` — a protection worth keeping. Apportioning a quantity
 * is the one place the same exact-residual arithmetic is needed for both, so
 * they cross here, in two named one-line functions, through the decimal string
 * rather than through a JS `number` (AR-06). Never `parseFloat`, never
 * `valueOf`.
 */
function asMoney(quantity: Quantity): Money {
  return Money.fromString(quantity.toDecimal());
}

function asQuantity(value: Money): Quantity {
  return Quantity.fromString(value.toDecimal());
}

// ---------------------------------------------------------------------------
// Folding the set (BR-011-08)
// ---------------------------------------------------------------------------

export function totalsOf(holdings: readonly ReportHolding[]): ReportTotals {
  return {
    value: sumMoney(holdings.map((holding) => holding.value)),
    costBasis: sumMoney(holdings.map((holding) => holding.costBasis)),
    quantity: sumQuantity(holdings.map((holding) => holding.quantity)),
    // BR-011-15 / AC-15: one accrued component is enough to mark the figure.
    estimated: holdings.some((holding) => holding.estimated),
  };
}

/**
 * BR-011-03/07/08 — partition a holding set by one dimension.
 *
 * `total` is summed straight from `holdings`, **not** from the group
 * subtotals. That is what keeps `totals-invariant.test.ts` honest: derive the
 * total from the groups and the assertion "the groups sum to the total"
 * becomes a tautology that would pass over a dropped holding, a
 * double-counted slice, or a missing Unassigned bucket.
 *
 * BR-011-07: each group carries its constituent holdings, so expanding a row
 * shows the same numbers that were folded into it rather than a second query's
 * answer to a similar question.
 */
export function aggregate(holdings: readonly ReportHolding[], grouping: Grouping): GroupedReport {
  const resolve = groupKeyResolver(grouping);

  const buckets = new Map<string, ReportGroup>();
  for (const holding of holdings) {
    const key = resolve(holding);
    const existing = buckets.get(key.id);
    if (existing === undefined) {
      buckets.set(key.id, { key, totals: EMPTY_TOTALS, holdings: [holding] });
    } else {
      buckets.set(key.id, { ...existing, holdings: [...existing.holdings, holding] });
    }
  }

  const groups = [...buckets.values()]
    .map((group) => ({ ...group, totals: totalsOf(group.holdings) }))
    .sort((a, b) => compareGroupKeys(a.key, b.key));

  return { grouping, groups, total: totalsOf(holdings) };
}

const EMPTY_TOTALS: ReportTotals = {
  value: Money.zero(),
  costBasis: Money.zero(),
  quantity: Quantity.zero(),
  estimated: false,
};

// ---------------------------------------------------------------------------
// The shared query every report runs (BR-011-05, BR-011-13, BR-011-16)
// ---------------------------------------------------------------------------

export interface ReportQueryInput {
  readonly period: Period;
  readonly scope: Scope;
  readonly grouping: Grouping;
  /** `Clock.today()` — passed in, never read ambiently (AR-29, determinism). */
  readonly today: BusinessDate;
}

/**
 * Everything the four reports share: the resolved controls, the partitioned
 * holdings, and the persisted period series their charts read.
 */
export interface ReportQueryResult {
  readonly range: DateRange;
  readonly asOf: BusinessDate;
  readonly scope: ResolvedScope;
  readonly report: GroupedReport;
  /**
   * BR-011-06 / #63 — the tenant-data name behind each group key, for the UI
   * to render (AR-44). Empty for `asset_class`, whose labels are i18n keys.
   */
  readonly groupNames: GroupNames;
  /** BR-011-13 — the `DailyValuationSnapshot` rows covering the period. */
  readonly snapshots: readonly DailyValuationSnapshot[];
  /** BR-011-16 / AC-14 — render the explanatory empty state, not a zero. */
  readonly empty: boolean;
}

/**
 * BR-011-05 — the three controls composed, in the one order that is correct.
 *
 * **The sequence matters and is not interchangeable.** The scope is validated
 * first, so a bookmark naming a deleted wallet fails before any figure is
 * computed rather than after (`scope.ts` explains why widening to the
 * portfolio would be the dangerous alternative). The period is resolved next,
 * because the holding set is valued at a date derived from it. Only then is
 * the holding set built — **once** — and only then partitioned. Every report
 * calls this, which is what makes BR-011-06's "same control, same options,
 * same semantics" true across all four rather than aspirational.
 *
 * **BR-011-13 / TS-32: this reads caches, never the ledger.** Every figure
 * comes from `listValuedPositions` (the SPEC-007 position cache, priced) and
 * `listSnapshots` (SPEC-009's `daily_valuation_snapshots`). There is no method
 * on `ReportDataPort` that reaches a transaction, so a report physically
 * cannot replay five years of ledger — the constraint is enforced by the port's
 * shape, not by remembering to honour it.
 *
 * `earliest` is the anchor for the `all` period. It is read from the snapshot
 * table's first row rather than from the ledger's first trade for the same
 * reason: "all time" means "everything this report can show", and what it can
 * show is what has been snapshotted.
 */
export async function runReportQuery(
  port: ReportDataPort,
  input: ReportQueryInput,
  earliest: BusinessDate | null,
): Promise<Result<ReportQueryResult, DomainError<ReportingErrorCode>>> {
  const scope = await resolveScope(input.scope, (walletId) => port.findWallet(walletId));
  if (!scope.ok) return scope;

  const range = resolvePeriod(input.period, input.today, earliest);
  if (!range.ok) return range;

  const asOf = asOfFor(range.value, input.today);
  const positions = await port.listValuedPositions(asOf);
  const [allocations, assets, snapshots] = await Promise.all([
    port.listAllocations(),
    port.describeAssets([...new Set(positions.map((position) => position.assetId))]),
    port.listSnapshots(range.value.from, range.value.to),
  ]);

  const holdings = buildHoldingSet({ positions, allocations, assets });
  if (!holdings.ok) return holdings;

  const scoped = applyScope(holdings.value, input.scope);

  // Only the dimension actually grouped by is looked up. Fetching wallets and
  // institutions unconditionally would add two queries to every asset-class
  // render — the default at portfolio scope, and so the common case.
  const [wallets, institutions] = await Promise.all([
    input.grouping === 'wallet' ? port.listWallets() : Promise.resolve([]),
    input.grouping === 'institution' ? port.listInstitutions() : Promise.resolve([]),
  ]);

  return ok({
    range: range.value,
    asOf,
    scope: scope.value,
    report: aggregate(scoped, input.grouping),
    groupNames: resolveGroupNames(input.grouping, {
      holdings: scoped,
      wallets,
      institutions,
    }),
    snapshots,
    empty: isEmptyScope(scoped),
  });
}

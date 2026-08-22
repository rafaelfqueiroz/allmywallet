import type { AssetId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import { compareGroupKeys, groupKeyResolver } from '@/core/reporting/grouping';
import type {
  AllocationEvent,
  AssetDescriptor,
  EarningRecord,
  ReportHolding,
} from '@/core/reporting/ports';
import { attributeAll, type EarningSlice } from '@/core/reporting/earnings/attribution';
import {
  monthlySeries,
  totalReceived,
  totalsByType,
  yearOverYear,
} from '@/core/reporting/earnings/received';
import { assetIncomeRows, incomeByAsset, scopeYieldOnCost } from '@/core/reporting/earnings/yields';
import type { EarningsReport, IncomeSlice } from '@/core/reporting/earnings/ports';

/**
 * SPEC-014 — the Earnings report, assembled.
 *
 * **Everything is folded from records the port already returned.** Nothing
 * re-queries, and nothing reaches the ledger: `listEarnings` is a filtered
 * index scan over four transaction types in a date range, which is a
 * projection rather than the five-year replay DL-011-07 forbids.
 *
 * The one thing this report does that the other three do not is **attribute a
 * figure to a point in the past**. Every other report asks what is true now;
 * this one asks who owned an asset when a payment landed, which is why
 * `attribution.ts` exists and why the answer is folded per pay date rather
 * than once per period.
 */

export interface EarningsInput {
  readonly query: ReportQueryResult;
  /** BR-014-01 — proventos paid inside the resolved period. */
  readonly earnings: readonly EarningRecord[];
  /** BR-014-06 — the trailing twelve months, for current yield. */
  readonly trailing: readonly EarningRecord[];
  /** BR-014-07 — the equal-length period immediately before this one. */
  readonly previous: readonly EarningRecord[];
  /** BR-014-12 — the allocation history up to the period's end. */
  readonly allocationEvents: readonly AllocationEvent[];
  /**
   * Catalog entries for every asset that paid. Wider than the scope's
   * holdings on purpose: an asset sold during the period still paid income
   * inside it, and has no holding left to take a name or a class from.
   */
  readonly descriptors: readonly AssetDescriptor[];
}

export function buildEarningsReport(input: EarningsInput): EarningsReport {
  const { query } = input;
  const grouping = query.report.grouping;
  const scope = query.scope.scope;

  const attributed = attributeAll(input.earnings, input.allocationEvents);

  /**
   * BR-011-02 at wallet scope, and the reason attribution is not optional
   * here: "this wallet's income" is the sum of the slices that belonged to it
   * **at the time of each payment**. Filtering the whole payments by today's
   * allocation would answer a different question, and would change its answer
   * whenever a holding is reassigned.
   */
  const slices =
    scope.kind === 'wallet'
      ? attributed.filter((slice) => slice.walletId === scope.walletId)
      : attributed;

  const scopedEarnings = scopedRecords(slices);
  const total = totalReceived(scopedEarnings);

  const byAsset = new Map<AssetId, AssetDescriptor>(
    input.descriptors.map((descriptor) => [descriptor.assetId, descriptor]),
  );

  const breakdown = buildBreakdown(slices, byAsset, grouping, total);

  /**
   * The trailing and previous windows are scoped the same way, so a wallet's
   * current yield and its growth are its own. Both are attributed against the
   * same event log; the pay dates differ, and the fold handles that.
   */
  const trailingSlices = attributeAll(input.trailing, input.allocationEvents);
  const previousSlices = attributeAll(input.previous, input.allocationEvents);

  const forScope = (all: readonly EarningSlice[]): readonly EarningRecord[] =>
    scopedRecords(
      scope.kind === 'wallet' ? all.filter((slice) => slice.walletId === scope.walletId) : all,
    );

  const holdings = query.report.groups.flatMap((group) => group.holdings);

  return {
    grouping,
    total,
    byType: totalsByType(scopedEarnings),
    monthly: monthlySeries(scopedEarnings, query.range),
    breakdown,
    perAsset: assetIncomeRows({
      periodIncome: incomeByAsset(scopedEarnings),
      trailingIncome: incomeByAsset(forScope(trailingSlices)),
      holdings,
      names: new Map(
        input.descriptors.map((descriptor) => [
          descriptor.assetId,
          { code: descriptor.code, name: descriptor.name },
        ]),
      ),
    }),
    yieldOnCost: scopeYieldOnCost(total, holdings),
    growth: yearOverYear(total, totalReceived(forScope(previousSlices))),
    /**
     * BR-014-09/10 — always unavailable in v1, and stated as such rather than
     * rendered as an empty section. The free quote tier carries no dividend
     * data and B3's Eventos Provisionados API is B2B-only (PRD Q8), so "no
     * upcoming income" is a claim this product cannot make (DL-014-06).
     */
    upcoming: { kind: 'unavailable', reason: 'NO_FORWARD_LOOKING_SOURCE' },
    // AC-16: no income is an explanation, never a zero-filled chart.
    empty: scopedEarnings.length === 0,
  };
}

/**
 * A slice back into a record, so every downstream fold works on one shape.
 *
 * The amount is the slice's share, not the whole payment — which is the entire
 * point at wallet scope, and identical to the payment at portfolio scope where
 * the slices of one payment sum back to it.
 */
function scopedRecords(slices: readonly EarningSlice[]): readonly EarningRecord[] {
  return slices.map((slice) => ({ ...slice.earning, amount: slice.amount }));
}

/**
 * BR-014-04 — income by the selected grouping, ranked, with shares.
 *
 * **Grouped by the framework's own resolver**, applied to a holding-shaped
 * view of each slice. That is what makes BR-011-06 true here rather than
 * hoped for: "Not classified" appears for a null sector, Unassigned for
 * unattributed income, and the keys sort the way every other report's do,
 * because it is the same function doing it. A second implementation would
 * eventually disagree with the first about one dimension, and the report that
 * disagreed would be this one.
 */
function buildBreakdown(
  slices: readonly EarningSlice[],
  descriptors: ReadonlyMap<AssetId, AssetDescriptor>,
  grouping: EarningsReport['grouping'],
  total: Money,
): readonly IncomeSlice[] {
  const resolve = groupKeyResolver(grouping);
  const amounts = new Map<string, { key: ReturnType<typeof resolve>; amount: Money }>();

  for (const slice of slices) {
    const descriptor = descriptors.get(slice.earning.assetId);
    const key = resolve(asHolding(slice, descriptor));
    const existing = amounts.get(key.id);
    amounts.set(key.id, {
      key,
      amount: (existing?.amount ?? Money.zero()).plus(slice.amount),
    });
  }

  return [...amounts.values()]
    .sort((a, b) => compareGroupKeys(a.key, b.key))
    .map(({ key, amount }) => ({
      key,
      amount,
      // Never a fabricated 0 %: with no income there is no denominator, and a
      // table of zeroes would read as "every group paid nothing" rather than
      // "nothing was paid".
      share: total.isPositive() ? amount.dividedBy(total.toDecimal()) : null,
    }));
}

/**
 * The shape `groupKeyResolver` reads, filled from a payment rather than from a
 * position.
 *
 * The unused fields are zero rather than plausible: this object exists to be
 * asked which group it belongs to and for nothing else, and a quantity or a
 * cost basis invented here could only ever mislead a future reader into
 * summing it.
 */
function asHolding(slice: EarningSlice, descriptor: AssetDescriptor | undefined): ReportHolding {
  return {
    assetId: slice.earning.assetId,
    assetCode: descriptor?.code ?? slice.earning.assetId,
    assetName: descriptor?.name ?? slice.earning.assetId,
    // Defaulting to `stock` would file an unknown asset under a real class.
    // The catalog has a row for every asset a transaction references (a
    // foreign key makes it so), so `undefined` here means the caller did not
    // describe it, and `other` is not a class this product has — hence the
    // descriptor is required in practice and this is a type-level fallback.
    assetClass: descriptor?.assetClass ?? 'stock',
    sector: descriptor?.sector ?? null,
    institutionId: slice.earning.institutionId,
    walletId: slice.walletId as WalletId | null,
    quantity: Quantity.zero(),
    value: slice.amount,
    costBasis: Money.zero(),
    estimated: false,
    carriedForward: false,
    priceDate: null,
    needsAttention: null,
    basis: null,
  };
}

import { Money, sumMoney } from '@/core/shared/money';
import type { AssetId } from '@/core/shared/ids';
import type { EarningRecord, ReportHolding } from '@/core/reporting/ports';
import type { AssetIncome } from '@/core/reporting/earnings/ports';

/**
 * SPEC-014 BR-014-05/06 / DL-014-01 — **two yields, never conflated.**
 *
 * *Yield on cost* is income over what the position actually cost. It is the
 * headline because it answers the question an income investor is actually
 * asking: is the plan working? Someone who bought at R$ 10 and now receives
 * R$ 1,20 a year is earning 12 % on their money, and no amount of price
 * appreciation changes that.
 *
 * *Current yield* is trailing income over today's market value. It describes
 * what a **new buyer** would get, which is what a comparison against another
 * asset needs — and it is a different number about a different person. The
 * same asset above yields 3 % on a price of R$ 40. Presenting either as "the
 * yield" would be wrong half the time, so both are reported and both are
 * labelled.
 */

/** Income per asset over the period, from the (possibly wallet-scoped) records. */
export function incomeByAsset(earnings: readonly EarningRecord[]): ReadonlyMap<AssetId, Money> {
  const totals = new Map<AssetId, Money>();
  for (const earning of earnings) {
    totals.set(earning.assetId, (totals.get(earning.assetId) ?? Money.zero()).plus(earning.amount));
  }
  return totals;
}

/** Cost basis and market value per asset, folded across institutions. */
function holdingTotals(
  holdings: readonly ReportHolding[],
): ReadonlyMap<AssetId, { cost: Money; value: Money; code: string; name: string }> {
  const totals = new Map<AssetId, { cost: Money; value: Money; code: string; name: string }>();

  for (const holding of holdings) {
    const existing = totals.get(holding.assetId);
    totals.set(holding.assetId, {
      cost: (existing?.cost ?? Money.zero()).plus(holding.costBasis),
      value: (existing?.value ?? Money.zero()).plus(holding.value),
      code: holding.assetCode,
      name: holding.assetName,
    });
  }

  return totals;
}

export interface AssetIncomeInput {
  /** Income in the selected period, per asset. */
  readonly periodIncome: ReadonlyMap<AssetId, Money>;
  /** BR-014-06 — trailing twelve months, per asset, whatever the period is. */
  readonly trailingIncome: ReadonlyMap<AssetId, Money>;
  /** The scope's current holdings, for the two denominators. */
  readonly holdings: readonly ReportHolding[];
  /** Descriptors for assets that paid but are no longer held. */
  readonly names: ReadonlyMap<AssetId, { readonly code: string; readonly name: string }>;
}

/**
 * BR-014-05/06 — one row per asset that paid something in the period.
 *
 * **Assets no longer held are included, with no yields.** Selling a position in
 * March does not unmake the income it paid in February; dropping it would make
 * the rows fail to sum to the period total, which is the arithmetic the whole
 * framework is arranged to keep honest (BR-011-08's spirit). It has no cost
 * basis and no market value to divide by, so both yields are `null` rather
 * than zero — "we cannot compute this" and "this yields nothing" are different
 * statements.
 *
 * Ranked by income, because the question is which holdings are paying.
 */
export function assetIncomeRows(input: AssetIncomeInput): readonly AssetIncome[] {
  const totals = holdingTotals(input.holdings);

  const rows = [...input.periodIncome.entries()].map(([assetId, amount]): AssetIncome => {
    const held = totals.get(assetId);
    const trailing = input.trailingIncome.get(assetId) ?? Money.zero();
    const described = input.names.get(assetId);

    return {
      assetId,
      assetCode: held?.code ?? described?.code ?? assetId,
      assetName: held?.name ?? described?.name ?? assetId,
      amount,
      yieldOnCost:
        held !== undefined && held.cost.isPositive()
          ? amount.dividedBy(held.cost.toDecimal())
          : null,
      currentYield:
        held !== undefined && held.value.isPositive()
          ? trailing.dividedBy(held.value.toDecimal())
          : null,
    };
  });

  return rows.sort((a, b) => {
    const byAmount = b.amount.comparedTo(a.amount);
    // Ties broken by code so the order is total and stable — two assets paying
    // the same amount must not swap places between two renders of one report.
    return byAmount !== 0 ? byAmount : a.assetCode.localeCompare(b.assetCode);
  });
}

/**
 * BR-014-05 at scope level — the period's income over the scope's whole cost
 * basis.
 *
 * Over *all* holdings in scope, not only the ones that paid: a portfolio's
 * yield on cost is what the money as a whole produced, and excluding the
 * non-payers would report the yield of a portfolio the user does not own.
 */
export function scopeYieldOnCost(total: Money, holdings: readonly ReportHolding[]): Money | null {
  const cost = sumMoney(holdings.map((holding) => holding.costBasis));
  return cost.isPositive() ? total.dividedBy(cost.toDecimal()) : null;
}

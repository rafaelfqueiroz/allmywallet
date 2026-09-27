import type { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { makePosition, type PositionState } from '@/core/positions/position-state';
import type { PositionSnapshot } from '@/core/positions/replay';

/**
 * SPEC-007 BR-007-08: positions are tracked per `(user, asset, institution)`
 * and **aggregated across institutions** for portfolio-level views.
 */

export interface AssetPosition {
  readonly assetId: AssetId;
  readonly state: PositionState;
  /**
   * SPEC-007 BR-007-06 / DL-007-12: the aggregate average is cost-weighted
   * over every institution's lot, so one institution's estimated lot makes
   * the aggregate an estimate too. A closed institution position is never
   * marked (BR-007-07), so it cannot mark the aggregate.
   */
  readonly costEstimated: boolean;
}

/**
 * Aggregation sums the two *additive* figures — quantity and total cost — and
 * derives the average from the sum, rather than averaging the averages.
 *
 * Worked example (DV-17), and the reason this distinction is not pedantry:
 *
 *   Clear   100 PETR4, average 20,00  → total cost 2.000,00
 *   Rico    300 PETR4, average 40,00  → total cost 12.000,00
 *
 *   Correct (cost-weighted):  14.000,00 ÷ 400 = **35,00**
 *   Wrong   (mean of means):  (20 + 40) ÷ 2   =   30,00
 *
 * The wrong figure is 14% low and looks entirely reasonable, which is exactly
 * how it survives to a tax return. Deriving from the summed cost also makes
 * the aggregate agree with what a single-institution replay of the same trades
 * would produce, which keeps the Composition report's totals consistent with
 * the Portfolio Value endpoint (TS-12).
 *
 * Realized gain is additive across institutions and simply sums. Where every
 * institution's position is closed, the aggregate quantity is zero and
 * `makePosition` resets the average (BR-007-07) while keeping that realized
 * total.
 */
export function aggregateAcrossInstitutions(
  snapshots: readonly PositionSnapshot[],
): readonly AssetPosition[] {
  const byAsset = new Map<
    AssetId,
    { quantity: Quantity; totalCost: Money; realizedGain: Money; costEstimated: boolean }
  >();

  for (const snapshot of snapshots) {
    const running = byAsset.get(snapshot.assetId) ?? {
      quantity: Quantity.zero(),
      totalCost: Money.zero(),
      realizedGain: Money.zero(),
      costEstimated: false,
    };
    byAsset.set(snapshot.assetId, {
      quantity: running.quantity.plus(snapshot.state.quantity),
      totalCost: running.totalCost.plus(snapshot.state.totalCost),
      realizedGain: running.realizedGain.plus(snapshot.state.realizedGain),
      costEstimated: running.costEstimated || snapshot.costEstimated,
    });
  }

  return (
    [...byAsset.entries()]
      .map(([assetId, totals]) => ({
        assetId,
        state: makePosition(totals.quantity, totals.totalCost, totals.realizedGain),
        costEstimated: totals.costEstimated,
      }))
      // No "equal" arm: `byAsset` is a Map keyed on `assetId`, so two entries
      // are never equal here and that branch could never be exercised.
      .sort((a, b) => (a.assetId < b.assetId ? -1 : 1))
  );
}

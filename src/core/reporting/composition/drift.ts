import { Money, sumMoney } from '@/core/shared/money';
import type { DailyValuationSnapshot, GroupKey, Grouping, Scope } from '@/core/reporting/ports';
import {
  HistoryUnavailable,
  available,
  unavailable,
  type SnapshotDerived,
} from '@/core/reporting/snapshot-derived';
import { sharesOf } from '@/core/reporting/composition/breakdown';
import type { AllocationShift, CompositionSlice } from '@/core/reporting/composition/ports';

/**
 * SPEC-015 BR-015-04 — "composition drift over time: how allocation across the
 * selected grouping shifted during the period."
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REFUSES TO ANSWER, AND WHY THAT IS THE FEATURE
 *
 * Drift needs an allocation at **both ends** of the period. The closing end is
 * the report itself. The opening end can only come from
 * `daily_valuation_snapshots`, and that table constrains the answer twice:
 *
 *  - it decomposes by **asset class and nothing else** (`by_asset_class`), so
 *    drift by wallet, sector, institution or individual asset has no history
 *    to read — SPEC-013's stacked chart already refuses on exactly this
 *    ground, and this is the same refusal for the same table;
 *  - it holds **one row per user per day with no wallet column** (ADR-002), so
 *    at wallet scope there is no opening allocation at all.
 *
 * The tempting shortcut in the second case is to apply *today's* wallet split
 * to the portfolio's historical snapshot. It produces a chart that is
 * arithmetically perfect and entirely false, and — this is the part that
 * matters — nothing on screen would look wrong, because every number in it is
 * a real number about this user. SPEC-012 set the precedent by refusing TWR
 * and XIRR at wallet scope; SPEC-013 followed; this follows both.
 *
 * The user is owed the difference between the two absences, which is why
 * `HistoryUnavailable` has separate members rather than one "unavailable".
 * ---------------------------------------------------------------------------
 */

export interface DriftInput {
  /**
   * The snapshot immediately **preceding** the period — the baseline, which is
   * a different thing from the period's first observation.
   *
   * SPEC-009 values a date by replaying to and including it, so a snapshot
   * dated `from` is the *close* of `from`. Measuring drift from it would
   * silently discard whatever the first day did. `findSnapshotBefore` exists
   * on the shared port for this reason, and SPEC-013's growth decomposition
   * reads the same row.
   */
  readonly opening: DailyValuationSnapshot | null;
  /** The report's own closing breakdown — the same slices the chart draws. */
  readonly closing: readonly CompositionSlice[];
  readonly grouping: Grouping;
  readonly scope: Scope;
}

/**
 * BR-015-04 — the shift, or a named reason there is none.
 *
 * **The closing end is the report's own breakdown, not the last snapshot.**
 * The two can differ: a snapshot is written by a nightly job and the report is
 * valued live. Taking the closing shares from the snapshot would put a drift
 * table on screen whose "hoje" column disagreed with the chart directly above
 * it — the class of disagreement DL-015-06 and BR-015-10 exist to prevent.
 * SPEC-013 makes the same choice when it splices the live endpoint onto its
 * value line.
 */
export function allocationDrift(input: DriftInput): SnapshotDerived<readonly AllocationShift[]> {
  if (input.scope.kind === 'wallet') {
    return unavailable(HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED);
  }
  if (input.grouping !== 'asset_class') {
    return unavailable(HistoryUnavailable.NO_HISTORICAL_BREAKDOWN);
  }

  const openingShares = snapshotShares(input.opening);
  const closingShares = closingSharesOf(input.closing);
  if (openingShares === null || closingShares === null) {
    return unavailable(HistoryUnavailable.NO_ALLOCATION_TO_COMPARE);
  }

  /**
   * The union of both ends, so a class that was sold out of during the period
   * still appears — at 0 % today, against whatever it was worth at the
   * baseline. Listing only what is held now would hide the single most
   * informative drift there is: the position that left.
   */
  const classes = [...new Set([...openingShares.keys(), ...closingShares.keys()])].sort();

  return available(
    classes.map((assetClass) => {
      const opening = openingShares.get(assetClass) ?? Money.zero();
      const closing = closingShares.get(assetClass) ?? Money.zero();
      return {
        key: keyFor(assetClass),
        opening,
        closing,
        change: closing.minus(opening),
      };
    }),
  );
}

/**
 * The baseline allocation, or `null` when there is none to take.
 *
 * Two causes, one answer (see `HistoryUnavailable.NO_ALLOCATION_TO_COMPARE`):
 * no snapshot precedes the period — always true of the `all` period, whose
 * range opens on the tenant's first snapshot — or the one that does totals
 * zero, which is the account before it held anything. Assuming an empty
 * baseline instead would report every class as having gone from 0 % to its
 * current share, which reads as a dramatic reallocation and is actually just
 * the account opening.
 */
function snapshotShares(snapshot: DailyValuationSnapshot | null): Map<string, Money> | null {
  if (snapshot === null) return null;

  const entries = [...snapshot.byAssetClass.entries()];
  const shares = sharesOf(
    entries.map(([, value]) => value),
    sumMoney(entries.map(([, value]) => value)),
  );
  if (shares === null) return null;

  const byClass = new Map<string, Money>();
  entries.forEach(([assetClass], index) => {
    // Non-null: one share per entry.
    byClass.set(assetClass, shares[index] as Money);
  });
  return byClass;
}

/**
 * Deliberately **not** re-derived from the slices' values: `sliceBreakdown`
 * already computed these shares, residual and all, and recomputing them here
 * would be a second implementation of the same arithmetic that could round the
 * other way. The drift table's "hoje" column and the chart's slices are then
 * the same figures rather than two answers to the same question.
 */
function closingSharesOf(slices: readonly CompositionSlice[]): Map<string, Money> | null {
  const byClass = new Map<string, Money>();
  for (const slice of slices) {
    if (slice.share === null) return null;
    byClass.set(slice.key.id, slice.share);
  }
  return byClass;
}

/**
 * The snapshot's breakdown is keyed by `AssetClass`, and so is
 * `groupKeyResolver`'s `asset_class` dimension — the same closed enum, so the
 * two ends join on the id with no translation. `synthetic` is false because
 * every asset in the catalog carries a class; there is no "Not classified"
 * bucket on this dimension to reach.
 */
function keyFor(assetClass: string): GroupKey {
  return { dimension: 'asset_class', id: assetClass, synthetic: false };
}

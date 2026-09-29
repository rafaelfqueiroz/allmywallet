import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { type Result, ok } from '@/core/shared/result';
import type { PositionSnapshot } from '@/core/positions/replay';
import { loadAmortizationTerms } from '@/core/positions/amortization';
import { replayPositionWithEstimate } from '@/core/positions/replay';
import type { LedgerDependencies } from '@/core/ledger/dependencies';

/**
 * SPEC-006 BR-006-14 / BR-006-18, DL-006-03 — recalculation after a write.
 *
 * **Why the position is recomputed from the beginning, not "from the date".**
 * A moving weighted average is path-dependent from the very first acquisition:
 * to resume at a date you would need the state *at* that date, and obtaining
 * that state is the replay. There is nothing cheaper to resume from.
 *
 * DL-006-03's "forward from the transaction date, not from today" is a
 * statement about **which derived artefacts must be invalidated** — SPEC-009's
 * daily valuation snapshots from that date onwards, and the report figures
 * built on them — not about how a position is computed. Recalculating only
 * current state is the mistake it forbids, because it leaves historical charts
 * silently disagreeing with the transactions behind them.
 *
 * So `fromDate` is carried on the result rather than used here: it is the
 * boundary SPEC-009 BR-009-18 invalidates **daily valuation snapshots** from.
 * The app layer reads it through `earliestFromDate` and requests a
 * `valuation.snapshot` rebuild once the write's transaction has committed
 * (`src/lib/snapshot-rebuild.ts`) — `core/` only records the boundary, it
 * never enqueues (AR-01).
 */
export interface RecalculationScope {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  /** The earliest date whose derived figures are now stale (DL-006-03). */
  readonly fromDate: BusinessDate;
}

export interface RecalculationOutcome {
  readonly scope: RecalculationScope;
  /**
   * The recomputed position, or `null` when the last transaction for this
   * `(asset, institution)` has just been deleted and the cached row was
   * removed. A stored position with no ledger behind it would contradict a
   * rebuild (DM-4) the moment anyone checked.
   */
  readonly position: PositionSnapshot | null;
}

/**
 * SPEC-009 BR-009-18 / SPEC-006 DL-006-03 — the earliest date whose derived
 * figures any of a write's recalculations left stale, or `null` when the write
 * recalculated nothing. One write can touch several positions (an edit that
 * moves a row between assets, a bulk delete, a carried leg re-derived
 * downstream); the snapshots behind **all** of them are stale from the
 * earliest boundary among them.
 */
export function earliestFromDate(outcomes: readonly RecalculationOutcome[]): BusinessDate | null {
  let earliest: BusinessDate | null = null;
  for (const { scope } of outcomes) {
    if (earliest === null || BusinessDate.isBefore(scope.fromDate, earliest)) {
      earliest = scope.fromDate;
    }
  }
  return earliest;
}

/**
 * Replays one `(asset, institution)` position from the ledger and writes the
 * result into the position cache.
 *
 * The ledger is re-read here rather than reusing the candidate list the
 * calling use case already validated against. That costs one query and buys
 * the property that matters: what lands in the cache is a replay of what is
 * *actually stored*, not a replay of what the use case believed it was about
 * to store.
 */
export async function recalculatePositionFrom(
  deps: LedgerDependencies,
  scope: RecalculationScope,
): Promise<Result<RecalculationOutcome, DomainError>> {
  const transactions = await deps.transactions.listForPosition(scope.assetId, scope.institutionId);

  if (transactions.length === 0) {
    await deps.positions.deleteMany([
      { assetId: scope.assetId, institutionId: scope.institutionId },
    ]);
    return ok({ scope, position: null });
  }

  // SPEC-007 BR-007-06: the cost-estimate marker comes from the same fold as
  // the figures, so this cache row agrees with a rebuild on it (DM-4).
  const amortization = await loadAmortizationTerms(deps.transactions, [scope.assetId]);
  const replayed = replayPositionWithEstimate(transactions, { amortization });
  if (!replayed.ok) return replayed;

  const position: PositionSnapshot = {
    assetId: scope.assetId,
    institutionId: scope.institutionId,
    ...replayed.value,
  };
  await deps.positions.upsertMany([position]);
  return ok({ scope, position });
}

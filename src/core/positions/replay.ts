import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { type Result, ok } from '@/core/shared/result';
import { type Transaction, isActive } from '@/core/ledger/transaction';
import { applyTransaction } from '@/core/positions/apply-transaction';
import { EMPTY_POSITION, type PositionState } from '@/core/positions/position-state';
import { sortForReplay } from '@/core/positions/ordering';

/**
 * SPEC-007 BR-007-14: positions at any historical date are derivable from the
 * ledger alone. This file is that derivation — a deterministic fold, with no
 * clock, no database and no ambient state, so the same rows always produce the
 * same figures (DL-006-01).
 */

/** BR-007-08: positions are tracked per `(user, asset, institution)`. */
export interface PositionKey {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
}

/**
 * A stable string form of the key, for grouping. Both halves are UUIDs, so
 * neither can contain the separator and the encoding cannot collide; a null
 * institution encodes as the empty half, which is a real bucket of its own
 * (an asset held with no institution recorded) rather than a wildcard.
 */
export function positionKeyString(key: PositionKey): string {
  return `${key.assetId}|${key.institutionId ?? ''}`;
}

export interface ReplayOptions {
  /**
   * BR-007-14: replay up to and including this date, for a historical
   * position. Omitted means the whole ledger.
   */
  readonly asOf?: BusinessDate | undefined;
}

export interface PositionSnapshot extends PositionKey {
  readonly state: PositionState;
}

/**
 * SPEC-007 BR-007-16 / SPEC-006 BR-006-03: only `active` rows participate.
 * `unclassified` rows are stored so reconciliation stays honest and excluded
 * so the arithmetic stays correct (DL-006-06); `superseded` rows are what a
 * re-import replaced.
 */
export function selectForReplay(
  transactions: readonly Transaction[],
  options: ReplayOptions = {},
): readonly Transaction[] {
  const asOf = options.asOf;
  return transactions.filter(
    (transaction) =>
      isActive(transaction) &&
      // Inclusive of `asOf` itself: "the position on 2026-03-15" includes
      // everything that traded that day (AR-29 — these are dates, so there is
      // no intraday cut-off to respect).
      (asOf === undefined || !BusinessDate.isAfter(transaction.tradeDate, asOf)),
  );
}

/**
 * The fold, for one `(asset, institution)` position.
 *
 * It **sorts before folding** rather than trusting arrival order (BR-007-15).
 * That single line is what makes a backdated corporate event produce the same
 * answer as if it had always been there (BR-006-18, TS-07), and what makes
 * this function agree with an incrementally-maintained position (DM-4, TS-08).
 *
 * A ledger the fold cannot process — a sale of more than was held at that
 * date — returns an error rather than a clamped position. A wrong number that
 * looks plausible is the failure this engine exists to prevent; an
 * unprocessable ledger is a real condition the caller must see. The write path
 * (`core/ledger`) refuses such a row in the first place, so a consistent
 * ledger never reaches this branch.
 */
export function replayPosition(
  transactions: readonly Transaction[],
  options: ReplayOptions = {},
): Result<PositionState, DomainError> {
  let state = EMPTY_POSITION;
  for (const transaction of sortForReplay(selectForReplay(transactions, options))) {
    const next = applyTransaction(state, transaction);
    if (!next.ok) return next;
    state = next.value;
  }
  return ok(state);
}

/**
 * Every position implied by a set of transactions, one per
 * `(asset, institution)` pair (BR-007-08).
 *
 * Positions that have closed to zero are **kept**, not dropped: they still
 * carry realized gain, which the Performance and Earnings reports need, and
 * dropping them would make a rebuild disagree with incremental state about
 * whether a row exists at all.
 *
 * Output order is deterministic — by asset, then institution — so two runs
 * produce byte-identical results and DM-4's comparison is meaningful.
 */
export function replayPositions(
  transactions: readonly Transaction[],
  options: ReplayOptions = {},
): Result<readonly PositionSnapshot[], DomainError> {
  const groups = new Map<string, { key: PositionKey; transactions: Transaction[] }>();

  for (const transaction of selectForReplay(transactions, options)) {
    const key: PositionKey = {
      assetId: transaction.assetId,
      institutionId: transaction.institutionId,
    };
    const id = positionKeyString(key);
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, { key, transactions: [transaction] });
    } else {
      group.transactions.push(transaction);
    }
  }

  const snapshots: PositionSnapshot[] = [];
  for (const group of groups.values()) {
    // Already filtered above, so replay is handed the selected rows directly
    // rather than re-applying `asOf` to a subset it has already narrowed.
    const replayed = replayPosition(group.transactions);
    if (!replayed.ok) return replayed;
    snapshots.push({ ...group.key, state: replayed.value });
  }

  /**
   * Sorted on the composite key, which orders by asset and then by
   * institution — `assetId` is a fixed-width UUID followed by the separator,
   * so the string comparison and the field-by-field one agree.
   *
   * The comparator has no "equal" arm because two snapshots never *are* equal
   * on this key: `groups` is a Map keyed on exactly it. Writing one would be
   * unreachable code, and unreachable code in the calculation engine is worse
   * than absent code — it looks tested when it is only uncoverable.
   */
  return ok(snapshots.sort((a, b) => (positionKeyString(a) < positionKeyString(b) ? -1 : 1)));
}

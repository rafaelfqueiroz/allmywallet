import type { DomainError } from '@/core/shared/domain-error';
import { asStored } from '@/core/shared/money';
import { type Result, ok } from '@/core/shared/result';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { PositionRepository } from '@/core/positions/ports';
import {
  positionKeyString,
  type PositionKey,
  type PositionSnapshot,
  replayPositions,
} from '@/core/positions/replay';

/**
 * SPEC-007 BR-007-14 / DM-4 — the full rebuild, and DL-007-06's reason for it:
 * the incremental path is where subtle ordering bugs live, and they are
 * invisible until someone reconciles against a broker statement. Asserting
 * that a rebuild and the incrementally-maintained cache agree turns a class of
 * silent corruption into a failing test (TS-08).
 *
 * It is also the repair mechanism DL-006-01 buys: because positions are
 * derived and rebuildable, a calculation bug is fixed by correcting the logic
 * and replaying. There is no corrupted state to migrate.
 */

export interface RebuildDependencies {
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
}

/**
 * Replays the entire ledger and replaces the position cache with the result.
 *
 * Nothing is written when the replay fails. A ledger that cannot be replayed —
 * a sale of more than was held at that date — must not half-overwrite the
 * cache with the positions that happened to succeed, because the surviving
 * mixture would be neither the old figures nor the new ones and nothing would
 * say so.
 */
export async function rebuildPositions(
  deps: RebuildDependencies,
): Promise<Result<readonly PositionSnapshot[], DomainError>> {
  const transactions = await deps.transactions.listAll();
  const replayed = replayPositions(transactions);
  if (!replayed.ok) return replayed;

  await deps.positions.replaceAll(replayed.value);
  return ok(replayed.value);
}

/**
 * DM-4's other half: **what would a rebuild change?**
 *
 * "If a cache disagrees with a recomputation, the ledger wins" (DL-006-01) is
 * only a usable rule if the disagreement can be seen. `rebuildPositions`
 * replaces the cache and says nothing about what moved, which is the wrong
 * shape for the situation it exists for — an operator who suspects a figure is
 * wrong, in production, with no staging to try it on first.
 *
 * So the comparison is separated from the write. The rebuild command reports
 * this either way, and `--dry-run` is simply "report it and stop".
 *
 * Comparison is on the **stored** form of every figure — what `NUMERIC(20,8)`
 * would hold — not on the full-precision `toString()`.
 *
 * That distinction is the whole check. A replayed average cost carries forty
 * significant digits so an accrual chain does not drift; the column keeps
 * eight. Comparing the computed value against the value read back therefore
 * reported drift on *every* position whose replay produced a repeating
 * decimal, permanently and immediately after a successful rebuild — the check
 * was useless on exactly the positions worth checking. `asStored`
 * (`core/shared/money.ts`) is the form both sides are put in first.
 */
export type PositionDriftKind = 'changed' | 'missing_from_cache' | 'absent_from_ledger';

export interface PositionDrift {
  readonly key: PositionKey;
  readonly kind: PositionDriftKind;
  /** Null when the cache holds nothing for this position. */
  readonly cached: PositionFigures | null;
  /** Null when the ledger no longer produces this position at all. */
  readonly rebuilt: PositionFigures | null;
}

export interface PositionFigures {
  readonly quantity: string;
  readonly totalCost: string;
  readonly averageCost: string;
  readonly realizedGain: string;
}

export interface PositionVerification {
  readonly checked: number;
  readonly drift: readonly PositionDrift[];
}

function figuresOf(snapshot: PositionSnapshot): PositionFigures {
  return {
    quantity: asStored(snapshot.state.quantity),
    totalCost: asStored(snapshot.state.totalCost),
    averageCost: asStored(snapshot.state.averageCost),
    realizedGain: asStored(snapshot.state.realizedGain),
  };
}

function sameFigures(a: PositionFigures, b: PositionFigures): boolean {
  return (
    a.quantity === b.quantity &&
    a.totalCost === b.totalCost &&
    a.averageCost === b.averageCost &&
    a.realizedGain === b.realizedGain
  );
}

/**
 * Replays the ledger and compares the result against the stored cache,
 * **writing nothing**.
 *
 * A failed replay is returned as an error rather than as drift: a ledger that
 * cannot be replayed is a different and worse problem than a cache that has
 * drifted, and reporting it as "every position changed" would bury it.
 */
export async function verifyPositions(
  deps: RebuildDependencies,
): Promise<Result<PositionVerification, DomainError>> {
  const transactions = await deps.transactions.listAll();
  const replayed = replayPositions(transactions);
  if (!replayed.ok) return replayed;

  const cached = new Map(
    (await deps.positions.list()).map((snapshot) => [positionKeyString(snapshot), snapshot]),
  );

  const drift: PositionDrift[] = [];
  for (const snapshot of replayed.value) {
    const key = positionKeyString(snapshot);
    const stored = cached.get(key);
    cached.delete(key);

    if (stored === undefined) {
      drift.push({
        key: snapshot,
        kind: 'missing_from_cache',
        cached: null,
        rebuilt: figuresOf(snapshot),
      });
      continue;
    }
    const before = figuresOf(stored);
    const after = figuresOf(snapshot);
    if (!sameFigures(before, after)) {
      drift.push({ key: snapshot, kind: 'changed', cached: before, rebuilt: after });
    }
  }

  // Whatever is left in the cache has no ledger behind it — the failure mode
  // `deleteMany` exists to prevent, and the one a rebuild silently repairs
  // because `replaceAll` drops it. Worth naming rather than fixing quietly.
  for (const stranded of cached.values()) {
    drift.push({
      key: stranded,
      kind: 'absent_from_ledger',
      cached: figuresOf(stranded),
      rebuilt: null,
    });
  }

  return ok({ checked: replayed.value.length, drift });
}

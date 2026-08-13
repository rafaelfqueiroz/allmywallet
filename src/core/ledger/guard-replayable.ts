import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import { replayPosition } from '@/core/positions/replay';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import type { Transaction } from '@/core/ledger/transaction';

/**
 * SPEC-006 BR-006-15 — "validation prevents impossible states", expressed once.
 *
 * Replays the ledger **as it would be after the write** and refuses the write
 * if that ledger cannot be replayed. Create, edit and delete all ask the same
 * question — does the resulting history hold together? — so they all ask it
 * here. A second implementation would agree with the first right up until it
 * did not.
 *
 * Why a replay rather than a comparison against the cached position:
 *
 *   - the row may be **backdated** (BR-006-18), so "held today" is the wrong
 *     quantity to compare against;
 *   - a legal row can make a *later* row illegal. Deleting the buy that a
 *     subsequent sale drew on leaves a ledger that cannot be replayed at all,
 *     and only a full replay notices.
 *
 * The error carries `{ code: 'INSUFFICIENT_QUANTITY', held, requested, date }`
 * (AR-37), which is what lets the UI name the held quantity as BR-006-15
 * requires rather than rejecting silently.
 */
export interface PositionLookupKey {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
}

export async function guardReplayable(
  deps: LedgerDependencies,
  key: PositionLookupKey,
  project: (existing: readonly Transaction[]) => readonly Transaction[],
): Promise<Result<void, DomainError>> {
  const existing = await deps.transactions.listForPosition(key.assetId, key.institutionId);
  const replayed = replayPosition(project(existing));
  if (!replayed.ok) return err(replayed.error);
  return ok(undefined);
}

/** Removes rows by id — the projection every edit and delete starts from. */
export function without(
  transactions: readonly Transaction[],
  ids: ReadonlySet<string>,
): readonly Transaction[] {
  return transactions.filter((transaction) => !ids.has(transaction.id));
}

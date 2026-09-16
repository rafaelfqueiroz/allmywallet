import type { UserId } from '@/core/shared/ids';
import type { ImportBatchId } from '@/core/shared/ids';
import type { BusinessDate } from '@/core/shared/clock';
import type { Transaction } from '@/core/ledger/transaction';
import { positionKeyString } from '@/core/positions/replay';
import { corporateEventMovementOf } from '@/core/ingestion/movement-map';
import { buildCandidate } from '@/core/ingestion/commit-batch';
import {
  type CorporateEventOutcome,
  type CorporateEventRow,
  corporateEventMovementOfKey,
} from '@/core/ingestion/corporate-event-resolution';
import type { ImportRow } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-20b (#113 PR-B) — a **read-only** mirror of
 * `commit-batch.ts`'s `planCorporateEvents` row+ledger merge, kept here so
 * the batch page can show why a corporate-event row is still `unclassified`
 * without touching commit-batch.ts (frozen for PR-B — PR-A already owns it)
 * and without re-exporting its private planning function.
 *
 * Unlike `planCorporateEvents`, this builds no `mode`/`origin` write
 * bookkeeping — nothing here writes anything. It only reconstructs, for one
 * batch's rows and the ledger of every position they touch, the same
 * `CorporateEventRow[]` `resolveCorporateEvents` (unchanged, pure) needs to
 * explain a row: which rows are `open` (this call could resolve them — a
 * still-`unclassified` row of this batch) and which are context only (already
 * written, classified by hand, or unclassified from another import).
 */
export interface CorporateEventRowsInput {
  /** Every row of the batch that carries a corporate-event B3 type. */
  readonly rows: readonly ImportRow[];
  /** The stored ledger of every position touched, keyed by `positionKeyString`. */
  readonly ledgerByPosition: ReadonlyMap<string, readonly Transaction[]>;
  readonly batchId: ImportBatchId;
  readonly userId: UserId;
  readonly now: Date;
  readonly today: BusinessDate;
}

export function buildCorporateEventRows(
  input: CorporateEventRowsInput,
): readonly CorporateEventRow[] {
  const { rows, ledgerByPosition, batchId, userId, now, today } = input;
  const result: CorporateEventRow[] = [];
  // Stored transaction ids already represented by one of this batch's rows —
  // never duplicated by the ledger sweep below.
  const covered = new Set<string>();

  for (const row of rows) {
    if (row.record.kind !== 'transaction') continue;
    const movement = corporateEventMovementOf(row.record.b3Type);
    if (movement === null) continue;

    if (row.classification === 'unclassified') {
      // BR-005-20b: staged, untouched by a user — this call may resolve it.
      const transaction = buildCandidate(row, batchId, userId, 'unclassified', now, today);
      if (transaction === null) continue;
      result.push({ id: row.id, movement, ticker: row.record.assetCode, transaction, open: true });
      continue;
    }

    // Already written (`new`/`ignored`, resolved earlier this commit) or a
    // `duplicate` of a stored copy: found by its natural key, never rebuilt
    // from the staged record, so a sibling sees the *resolved* reality (a
    // grupamento already applied) rather than the pre-resolution figures.
    const ledger = ledgerByPosition.get(positionKeyString(row)) ?? [];
    const copy = ledger.find(
      (t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence,
    );
    if (copy === undefined) continue;
    covered.add(copy.id);
    // `ticker` is read only for an `open` row (`issuerCodeOf` in the ratio
    // walk) — never modified here, so an empty string is safe context.
    result.push({ id: copy.id, movement, ticker: '', transaction: copy, open: false });
  }

  // Every other corporate-event transaction already on these positions —
  // history, a prior import's still-unclassified row, or an already-active
  // split/grupamento/sale — context for pairing and same-day conflicts.
  for (const ledger of ledgerByPosition.values()) {
    for (const t of ledger) {
      if (covered.has(t.id) || result.some((r) => r.transaction.id === t.id)) continue;
      const movement = corporateEventMovementOfKey(t.naturalKey);
      if (movement === null) continue;
      result.push({ id: t.id, movement, ticker: '', transaction: t, open: false });
    }
  }

  return result;
}

/**
 * SPEC-005 BR-005-20b / SPEC-007 BR-007-04a (#113 PR-B) — the ClassifyForm's
 * ratio field is pre-filled **only** with B3's published multiplier, and
 * only when the window holds exactly one factor. A derived ratio is never
 * offered, even where it agrees (agreement is exactly what `resolved` means)
 * — DL-007-08's "the ratio applied is B3's m, never the derived one" holds
 * for the suggestion shown to a human as much as for what commit writes. Zero
 * or several candidate factors (`no_factor`, `ambiguous_factor`, or any other
 * movement) leave the field empty rather than guess.
 */
export function ratioPrefillFor(outcome: CorporateEventOutcome): string | null {
  if (outcome.movement !== 'desdobro' && outcome.movement !== 'grupamento') return null;
  const [only, ...others] = outcome.evidence.factors;
  return only !== undefined && others.length === 0 ? only.multiplier.toString() : null;
}

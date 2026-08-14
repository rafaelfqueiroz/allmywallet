import { naturalKeyFor, type NaturalKeyParts } from '@/core/ledger/natural-key';
import { normalizeMovementType } from '@/core/ingestion/movement-map';

/**
 * SPEC-005 BR-005-14..17 — the occurrence counter over the existing
 * `naturalKeyFor` (`core/ledger/natural-key.ts`, SPEC-006). This file answers
 * the one question idempotent re-import turns on: **for this row, is this
 * natural key's Nth occurrence already in the ledger, or is it new?**
 *
 * The trick (DL-005-04): occurrence assignment is always sequential from 1,
 * by *file order*, both for a fresh import and for whatever produced the
 * rows already committed. So replaying the same file in the same order
 * reproduces the same per-key ordinal for the same row, every time. That
 * ordinal — not `existingCount + ordinal` — *is* the candidate occurrence
 * number; comparing it against how many already exist for that key is what
 * tells duplicate from genuinely new apart.
 *
 * Worked example (DV-17): a full-history import contains natural key `K`
 * twice — two genuine identical same-day buys (BR-005-16). Local ordinals
 * within the file are 1 and 2; nothing exists yet, so both are new, occurrence
 * 1 and 2. A later re-import of an overlapping export that still contains
 * both rows of `K` computes local ordinals 1 and 2 again; this time the
 * existing count is 2, so `1 <= 2` and `2 <= 2` — both are duplicates, zero
 * new rows (BR-005-17). If that same re-export also contained a genuinely new
 * third `K` (a purchase made since), its local ordinal is 3, `3 <= 2` is
 * false, and it inserts as occurrence 3.
 */
export interface OccurrenceCandidate {
  readonly naturalKey: string;
}

export interface OccurrencePlan {
  readonly occurrence: number;
  readonly isDuplicate: boolean;
}

/**
 * `existingCounts` maps a natural key to how many occurrences of it already
 * exist in the ledger (0 or absent — treated the same — for a key never seen
 * before). `rows` must be in the order they appeared in the source file: that
 * order is what the ordinal is computed from, and it is the only thing that
 * has to be stable across a re-import for BR-005-17 to hold.
 */
export function planOccurrences<T extends OccurrenceCandidate>(
  rows: readonly T[],
  existingCounts: ReadonlyMap<string, number>,
): readonly (T & OccurrencePlan)[] {
  const seenInThisBatch = new Map<string, number>();

  return rows.map((row) => {
    const ordinal = (seenInThisBatch.get(row.naturalKey) ?? 0) + 1;
    seenInThisBatch.set(row.naturalKey, ordinal);

    const existing = existingCounts.get(row.naturalKey) ?? 0;
    return { ...row, occurrence: ordinal, isDuplicate: ordinal <= existing };
  });
}

/**
 * `transactions.type` is `NOT NULL` with a 13-member CHECK (SPEC-006
 * BR-006-05), and BR-006-05 forbids a 14th value — so an unmapped B3 row still
 * needs *some* concrete `TransactionType` to satisfy the column. `rendimento`
 * is picked as the placeholder because it is the widest of the thirteen: its
 * quantity validation only forbids negative (`core/ledger/validate.ts`), it
 * carries no ratio, and — the property that matters here — the row is
 * excluded from every calculation by its `status` (`unclassified`), never by
 * its `type`, so the placeholder never reaches an average-cost or valuation
 * figure. It is corrected the moment BR-005-20 classification sets a real
 * type. The spec does not name a value for this column, so this choice is a
 * documented assumption, not a rule it states.
 */
export const UNCLASSIFIED_PLACEHOLDER_TYPE = 'rendimento';

/**
 * BR-005-14's "movement type" component of the natural key. For a row the
 * movement map *did* classify, this is exactly `naturalKeyFor` — reusing
 * SPEC-006's key unmodified, as directed.
 *
 * For a row it did **not** classify, every unmapped row would otherwise share
 * the same `UNCLASSIFIED_PLACEHOLDER_TYPE`, which collapses `naturalKeyFor`'s
 * `type` component to a constant and lets two genuinely different unmapped
 * B3 movements (say an IOF debit and an unrecognised event fee, same date,
 * same asset, coincidentally same quantity and price) collide into one
 * key — a false duplicate, silently dropping one of them (exactly what
 * BR-005-19 exists to prevent). The raw, normalised B3 type string is
 * appended as a disambiguating suffix in that one case; `naturalKeyFor`
 * itself is still the base and is not reimplemented.
 */
export function importNaturalKeyFor(
  parts: NaturalKeyParts,
  unclassifiedB3Type: string | null,
): string {
  const base = naturalKeyFor(parts);
  return unclassifiedB3Type === null
    ? base
    : `${base}|${normalizeMovementType(unclassifiedB3Type)}`;
}

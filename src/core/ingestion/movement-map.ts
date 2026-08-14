import type { TransactionType } from '@/core/ledger/transaction';

/**
 * SPEC-005 BR-005-18 — the versioned B3 `Movimentação` → internal
 * `TransactionType` map.
 *
 * "Versioned" here means what BR-005-18 needs it to mean, not a plugin
 * system: `MOVEMENT_MAP_VERSION` is stamped onto every row this map
 * classifies (`stage-batch.ts`), so a support investigation can tell which
 * table version produced a given classification, and growing the map (a new
 * B3 string observed in the wild) is reviewable as a diff to one object
 * rather than a schema change. BR-005-19/21: a string with no entry is never
 * dropped — `classifyMovement` returns `null` and the caller stores the row
 * as `unclassified`, logging the raw string alone (BR-004-04 — no values).
 *
 * Keys are normalised (case/accent/whitespace-folded) with the same function
 * `adapters/ingestion/xlsx/detect.ts` uses for header matching, because B3's
 * own casing and accenting of these strings is not perfectly consistent
 * across extracts.
 */
export const MOVEMENT_MAP_VERSION = 1;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * B3's `Entrada/Saída` (credit/debit) column disambiguates a handful of
 * `Movimentação` strings that mean opposite things depending on direction —
 * "Transferência" alone does not say in or out.
 */
export type MovementDirection = 'credit' | 'debit' | null;

interface MappedEntry {
  readonly type: TransactionType;
  /** `null` — the string alone determines the type, direction is irrelevant or absent. */
  readonly direction: MovementDirection;
}

/**
 * One raw string can map to different types depending on direction, so the
 * value is a list of candidates tried in order; the first whose `direction`
 * matches (or is `null`, meaning "any") wins.
 */
const MOVEMENT_MAP: ReadonlyMap<string, readonly MappedEntry[]> = new Map(
  (
    [
      ['compra', [{ type: 'buy', direction: null }]],
      ['venda', [{ type: 'sell', direction: null }]],
      ['dividendo', [{ type: 'dividend', direction: null }]],
      ['juros sobre capital proprio', [{ type: 'jcp', direction: null }]],
      ['rendimento', [{ type: 'rendimento', direction: null }]],
      ['amortizacao', [{ type: 'amortization', direction: null }]],
      // BR-007-04: split/grupamento are deliberately absent. Their ratio is
      // not something a single Movimentação row states — B3 shows only the
      // quantity delta the event produced, and turning that into a ratio
      // needs the position *before* the event, which this parser does not
      // have. Left unmapped so they surface as `unclassified` for BR-005-20
      // manual classification, where the user supplies the ratio directly
      // (the same path `core/ledger/edit-transaction.ts` already exposes).
      ['bonificacao em ativos', [{ type: 'bonificacao', direction: null }]],
      ['direitos de subscricao - exercido', [{ type: 'subscription', direction: null }]],
      ['subscricao', [{ type: 'subscription', direction: null }]],
      [
        'transferencia - liquidacao',
        [
          { type: 'transfer_in', direction: 'credit' },
          { type: 'transfer_out', direction: 'debit' },
        ],
      ],
      [
        'transferencia',
        [
          { type: 'transfer_in', direction: 'credit' },
          { type: 'transfer_out', direction: 'debit' },
        ],
      ],
    ] as const
  ).map(([key, entries]) => [key, entries]),
);

/**
 * BR-005-18: returns `null` for anything not in the table — the caller must
 * store the row as `unclassified` (BR-005-19), never guess.
 */
export function classifyMovement(
  b3Type: string,
  direction: MovementDirection = null,
): TransactionType | null {
  const entries = MOVEMENT_MAP.get(normalize(b3Type));
  if (entries === undefined) return null;
  // Prefer an exact direction match, then a direction-agnostic entry, then —
  // for a direction-dependent string parsed with no direction supplied at
  // all (a defensive fallback; every real Movimentação row carries
  // Entrada/Saída) — the first candidate, rather than returning null for a
  // string the table plainly does recognise.
  const match =
    entries.find((entry) => entry.direction === direction) ??
    entries.find((entry) => entry.direction === null) ??
    entries[0];
  return match?.type ?? null;
}

/** Exposed for `stage-batch.ts`'s Needs Attention log line and for tests. */
export { normalize as normalizeMovementType };

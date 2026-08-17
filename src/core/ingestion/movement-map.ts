import type { TransactionType } from '@/core/ledger/transaction';

/**
 * SPEC-005 BR-005-18 — the versioned B3 `Movimentação` → internal
 * `TransactionType` map.
 *
 * "Versioned" here means what BR-005-18 needs it to mean, not a plugin
 * system: growing the map (a new B3 string observed in the wild) is
 * reviewable as a diff to one object rather than a schema change.
 * BR-005-19/21: a string with no entry is never dropped —
 * `classifyMovement` returns `null` and the caller stores the row as
 * `unclassified`, logging the raw string alone (BR-004-04 — no values).
 *
 * **`MOVEMENT_MAP_VERSION` is not yet stamped on anything.** This comment
 * previously claimed `stage-batch.ts` wrote it onto every row it classified;
 * it does not, and never has. Until it does, a support investigation cannot
 * tell which table version produced a given classification — which matters
 * now that version 2 classifies `Transferência - Liquidação` differently
 * from version 1. Tracked on #8.
 *
 * Keys are normalised (case/accent/whitespace-folded) with the same function
 * `adapters/ingestion/xlsx/detect.ts` uses for header matching, because B3's
 * own casing and accenting of these strings is not perfectly consistent
 * across extracts.
 */
export const MOVEMENT_MAP_VERSION = 2;

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
      /**
       * BR-005-01 — **`Transferência - Liquidação` is deliberately unmapped.**
       *
       * It is how a *trade settles* in Movimentação, not a custody transfer.
       * Mapping it to `transfer_in`/`transfer_out` made Movimentação a second
       * source of acquisitions, and `core/positions/apply-transaction.ts`
       * treats `transfer_in` as one — so a user following the onboarding
       * guide, which asks for all three extracts, imported every purchase
       * twice: once as Negociação's `Compra`, once as this. The two carry
       * different movement types and different institutions, so BR-005-14's
       * natural key sees two unrelated rows and BR-005-15 never fires. The
       * result is a silently doubled *patrimônio*.
       *
       * BR-005-01 assigns the extracts distinct roles, and trades are not
       * among Movimentação's: it is the source for earnings, splits,
       * subscriptions, transfers and amortisations, while **Negociação is
       * "the authoritative trade record"**. Honouring that division is what
       * makes the overlap impossible rather than merely deduplicated.
       *
       * Left unmapped rather than dropped, so BR-005-19 still applies: the
       * row is stored, surfaces as `unclassified` in Needs attention, and a
       * user who exported only Movimentação can classify it themselves
       * (BR-005-20). Nothing is silently discarded.
       */
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

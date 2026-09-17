import { BusinessDate } from '@/core/shared/clock';
import type { Money } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { compareForReplay } from '@/core/positions/ordering';
import { type PositionKey, positionKeyString, replayPosition } from '@/core/positions/replay';
import type { CorporateEventFactor } from '@/core/quotes/corporate-event-factors';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import {
  type CorporateEventMovement,
  corporateEventMovementOf,
} from '@/core/ingestion/movement-map';
import {
  auctionTransaction,
  type FractionRefusal,
  fractionTransaction,
  isShareBaseType,
  type OriginCandidate,
  originOf,
  pairFractionAuctions,
  pairingRefusalOf,
  partnerAgrees,
} from '@/core/ingestion/fraction-auction';
import {
  calendarDaysBetween,
  evaluateShareRatio,
  type RatioEvidence,
  type RatioMovement,
  type RatioRefusal,
  ratioTransaction,
} from '@/core/ingestion/share-ratio';

/**
 * SPEC-005 BR-005-20b (#113) — **corporate-event rows resolved at commit**, in
 * replay order: `Desdobro` and `Grupamento` against B3's published factor
 * (SPEC-007 BR-007-04a), `Fração em Ativos` by origin and paired `Leilão de
 * Fração` (BR-007-04b, BR-007-05a).
 *
 * **One source of truth.** Commit settlement calls this every settling round
 * with what is live that round; the batch page calls it at read time for one
 * unclassified row's position, to show why the row is still unclassified and
 * every figure behind that — as `refusal.ts` does for `invalid` rows. No column
 * records a verdict that could go stale.
 *
 * **Why one walk and not two passes.** The two kinds feed each other. A
 * resolved ratio event is the origin a later fraction is measured against, and
 * a split fraction resolved as a `sell` changes P for a ratio event after it
 * (a 2020 desdobro, its fraction sold, then a 2024 grupamento). So each
 * position is walked once in replay order — by date, ratio events before the
 * day's fractions (they rank 0; a fraction's type ranks 2 or 4), then
 * `compareForReplay` — and every row sees exactly what precedes it.
 */

/** `import.corporate_event_factor_window_days`, `import.fraction_origin_window_days`, `import.fraction_auction_window_days` (SPEC-002 — never a default here). */
export interface CorporateEventWindows {
  /** How many calendar days before the row B3's *última data com* may be. */
  readonly factorDays: number;
  /** How many calendar days before a fraction its origin event may be. */
  readonly originDays: number;
  /** How many calendar days after a fraction its auction may be. */
  readonly auctionDays: number;
}

/** One corporate-event row, from this batch or from the ledger. */
export interface CorporateEventRow {
  /** The caller's handle for the outcome — an import row id or a transaction id. Unique within one call. */
  readonly id: string;
  readonly movement: CorporateEventMovement;
  /** B3's ticker for the asset (`MGLU3`) — ratio rows find their issuer's factors through it. */
  readonly ticker: string;
  /**
   * The row as the ledger holds it, or as this commit would write it
   * `unclassified`. Asset, institution, date, quantity, price and the replay
   * tiebreaks (`createdAt`, `id`) are read from here; what a resolution writes
   * is this with its type, status, ratio and price set.
   */
  readonly transaction: Transaction;
  /**
   * `true` — `unclassified` and untouched by a user (BR-006-16): this call may
   * resolve it. `false` — resolved by an earlier import or classified by hand:
   * a partner and a part of history only, **never modified** (BR-005-20b).
   */
  readonly open: boolean;
}

export interface CorporateEventResolutionInput {
  readonly rows: readonly CorporateEventRow[];
  /**
   * Everything that precedes or follows the events on a position, active or
   * about to be: the stored ledger, this commit's live rows, carried transfers
   * and activations. Open rows' own copies may be included — they are left out
   * by id — and so may settled rows, which are history like any other.
   */
  readonly history: (key: PositionKey) => readonly Transaction[];
  /** Stored factors by issuer code (`CorporateEventFactorReader.listByIssuers`). */
  readonly factors: ReadonlyMap<string, readonly CorporateEventFactor[]>;
  readonly windows: CorporateEventWindows;
  /**
   * Open rows (by `id`) a caller gave up after applying their resolution left
   * a later row of the position unreplayable — commit settlement's `declined`
   * set (BR-006-15). Each is refused `conflicts_with_ledger`, and so is
   * whatever depends on it: a later ratio event is `blocked`, a fraction's
   * auction shares the refusal. Omitted at read time, where nothing was tried.
   */
  readonly declined?: ReadonlySet<string> | undefined;
}

/** Every figure the batch page shows for a fraction or auction, resolved or not. */
export interface FractionEvidence {
  /** Share-base events in the (paired) fraction's origin window, each with the fraction it left. */
  readonly origins: readonly OriginCandidate[];
  /** The unique origin, when there is one. */
  readonly origin: OriginCandidate | null;
  /** The other side's matching row ids (auctions for a fraction, fractions for an auction). */
  readonly candidates: readonly string[];
  /** The paired row's id, when paired. */
  readonly partnerId: string | null;
  /** The auction's unit price, when known. */
  readonly auctionPrice: Money | null;
}

export type CorporateEventRefusal = RatioRefusal | FractionRefusal;

/**
 * What an **open** row becomes. Settled rows get no outcome — nothing about
 * them may change.
 *
 * - `resolved` — write `transaction`: activate the stored copy in place (key
 *   kept, not a user edit — BR-005-20) or insert it active.
 * - `consumed` — a Leilão de Fração whose cash is a split fraction's sale:
 *   `transaction` is the stored copy `superseded`; its row becomes `ignored`
 *   (BR-005-19 amended).
 * - `refused` — stays `unclassified`; `refusal` and `evidence` say why.
 */
export type CorporateEventOutcome =
  | {
      readonly movement: RatioMovement;
      readonly status: 'resolved';
      readonly transaction: Transaction;
      readonly evidence: RatioEvidence;
    }
  | {
      readonly movement: RatioMovement;
      readonly status: 'refused';
      readonly refusal: RatioRefusal;
      readonly evidence: RatioEvidence;
    }
  | {
      readonly movement: 'fracao_em_ativos' | 'leilao_de_fracao';
      readonly status: 'resolved' | 'consumed';
      readonly transaction: Transaction;
      readonly evidence: FractionEvidence;
    }
  | {
      readonly movement: 'fracao_em_ativos' | 'leilao_de_fracao';
      readonly status: 'refused';
      readonly refusal: FractionRefusal;
      readonly evidence: FractionEvidence;
    };

/**
 * Which corporate-event row a **stored** transaction is, from the suffix its
 * unmapped key carries (`importNaturalKeyFor`) — the only place a stored row
 * keeps its B3 type. A row resolved or classified by hand keeps that key
 * (BR-005-17, `preserveNaturalKey`), so it is found the same way. `null` for a
 * mapped key: its last component is a price.
 */
export function corporateEventMovementOfKey(naturalKey: string): CorporateEventMovement | null {
  return corporateEventMovementOf(naturalKey.slice(naturalKey.lastIndexOf('|') + 1));
}

/** BR-005-20b — the outcome of every open row, keyed by `CorporateEventRow.id`. */
export function resolveCorporateEvents(
  input: CorporateEventResolutionInput,
): ReadonlyMap<string, CorporateEventOutcome> {
  const byPosition = new Map<string, CorporateEventRow[]>();
  for (const row of input.rows) {
    const id = positionKeyString(row.transaction);
    byPosition.set(id, [...(byPosition.get(id) ?? []), row]);
  }

  const outcomes = new Map<string, CorporateEventOutcome>();
  for (const rows of byPosition.values()) {
    if (!rows.some((row) => row.open)) continue;
    // One event leaves one fraction. When two fractions claim the same origin,
    // both are refused and the position walked again without them — a fraction
    // resolved earlier in the first walk may have moved P for what follows.
    // The forced set only grows, so this ends.
    let forced = new Set<string>();
    for (;;) {
      const walk = walkPosition(rows, input, forced);
      if (walk.conflicts.every((id) => forced.has(id))) {
        for (const [id, outcome] of walk.outcomes) outcomes.set(id, outcome);
        break;
      }
      forced = new Set([...forced, ...walk.conflicts]);
    }
  }
  return outcomes;
}

const isRatioMovement = (movement: CorporateEventMovement): movement is RatioMovement =>
  movement === 'desdobro' || movement === 'grupamento';

/** The order a position is walked in: date, ratio events first, then replay order. */
function walkOrder(a: CorporateEventRow, b: CorporateEventRow): number {
  const byDate = BusinessDate.compare(a.transaction.tradeDate, b.transaction.tradeDate);
  if (byDate !== 0) return byDate;
  const byKind = Number(!isRatioMovement(a.movement)) - Number(!isRatioMovement(b.movement));
  if (byKind !== 0) return byKind;
  return compareForReplay(a.transaction, b.transaction);
}

interface Walk {
  readonly outcomes: ReadonlyMap<string, CorporateEventOutcome>;
  /** Fractions whose unique origin another fraction also matched. */
  readonly conflicts: readonly string[];
}

function walkPosition(
  rows: readonly CorporateEventRow[],
  input: CorporateEventResolutionInput,
  forced: ReadonlySet<string>,
): Walk {
  const { windows } = input;
  const declined = input.declined ?? new Set<string>();
  const first = rows[0] as CorporateEventRow;
  const openIds = new Set(rows.filter((row) => row.open).map((row) => row.transaction.id));
  const base = input
    .history(first.transaction)
    .filter((t) => !openIds.has(t.id) && t.status === 'active');

  const outcomes = new Map<string, CorporateEventOutcome>();
  /** This walk's resolved rows that move the position: ratio events and fractions. */
  const resolved: Transaction[] = [];
  /** Ratio events this walk refused, or that sit unclassified in the ledger, as they would sort. */
  const unresolvedRatios: Transaction[] = [];
  const claims = new Map<string, string[]>();

  // BR-005-20b: two ratio events on one position and date — open, unclassified
  // or already active in the ledger — and neither applies.
  const ratioEventsOn = new Map<string, number>();
  const countRatioEvent = (date: BusinessDate) =>
    ratioEventsOn.set(date, (ratioEventsOn.get(date) ?? 0) + 1);
  for (const t of base)
    if (t.type === 'split' || t.type === 'grupamento') countRatioEvent(t.tradeDate);
  const unresolvedRatioRow = (row: CorporateEventRow) =>
    isRatioMovement(row.movement) && (row.open || row.transaction.status === 'unclassified');
  for (const row of rows) if (unresolvedRatioRow(row)) countRatioEvent(row.transaction.tradeDate);

  const fractions = rows.filter((row) => row.movement === 'fracao_em_ativos');
  const auctions = rows.filter((row) => row.movement === 'leilao_de_fracao');
  const auctionById = new Map(auctions.map((row) => [row.id, row]));
  const legOf = (row: CorporateEventRow) => ({
    id: row.id,
    assetId: row.transaction.assetId,
    institutionId: row.transaction.institutionId,
    tradeDate: row.transaction.tradeDate,
    quantity: row.transaction.quantity,
  });
  const pairing = pairFractionAuctions(
    fractions.map(legOf),
    auctions.map(legOf),
    windows.auctionDays,
  );

  /** What the position holds at `until`, inclusive or not, with this walk's resolutions in. */
  const replayUpTo = (until: Transaction, inclusive: boolean, extra: readonly Transaction[] = []) =>
    replayPosition(
      [...base, ...resolved, ...extra].filter((t) => {
        const order = compareForReplay(t, until);
        return inclusive ? order <= 0 : order < 0;
      }),
    );

  const walk = rows
    .filter((row) => unresolvedRatioRow(row) || row.movement === 'fracao_em_ativos')
    .sort(walkOrder);

  for (const row of walk) {
    if (isRatioMovement(row.movement)) {
      const movement = row.movement;
      // Sorted as the event it would become: rank 0, before the day's trades.
      const shape: Transaction = {
        ...row.transaction,
        type: movement === 'desdobro' ? 'split' : 'grupamento',
        status: 'active',
      };
      // A ratio row this call may not resolve — unclassified in the ledger, not
      // part of this import — is still an unresolved event: later ones wait.
      if (!row.open) {
        unresolvedRatios.push(shape);
        continue;
      }
      const combined = (ratioEventsOn.get(shape.tradeDate) as number) > 1;
      // Only an earlier date blocks: every other open ratio row on this date is
      // refused `combined_same_day` with this one, and P before the day's
      // share-base events is still sound to show beside it.
      const blocked = unresolvedRatios.some((t) =>
        BusinessDate.isBefore(t.tradeDate, shape.tradeDate),
      );
      const before = blocked ? null : replayUpTo(shape, false);
      const issuerCode = issuerCodeOf(row.ticker);
      const verdict = evaluateShareRatio({
        movement,
        basis: before !== null && before.ok ? before.value.quantity : null,
        stated: row.transaction.quantity,
        issuerCode,
        issuerFactors: issuerCode === null ? [] : (input.factors.get(issuerCode) ?? []),
        tradeDate: shape.tradeDate,
        factorDays: windows.factorDays,
        structural: combined
          ? 'combined_same_day'
          : blocked
            ? 'blocked'
            : declined.has(row.id)
              ? 'conflicts_with_ledger'
              : null,
      });
      if (verdict.ok) {
        // BR-007-04a: B3's multiplier is the ratio applied.
        const transaction = ratioTransaction(row.transaction, movement, verdict.ratio);
        resolved.push(transaction);
        outcomes.set(row.id, {
          movement,
          status: 'resolved',
          transaction,
          evidence: verdict.evidence,
        });
      } else {
        unresolvedRatios.push(shape);
        outcomes.set(row.id, {
          movement,
          status: 'refused',
          refusal: verdict.refusal,
          evidence: verdict.evidence,
        });
      }
      continue;
    }

    // --- Fração em Ativos (open or settled) ---
    const fraction = row.transaction;
    const inOriginWindow = (t: Transaction) => {
      const days = calendarDaysBetween(t.tradeDate, fraction.tradeDate);
      return days >= 0 && days <= windows.originDays;
    };
    const origins: OriginCandidate[] = [...base, ...resolved]
      .filter((t) => isShareBaseType(t.type) && inOriginWindow(t))
      .sort(compareForReplay)
      .map((event) => {
        const after = replayUpTo(event, true);
        return {
          id: event.id,
          type: event.type as OriginCandidate['type'],
          tradeDate: event.tradeDate,
          quantityAfter: after.ok ? after.value.quantity : null,
          fractionalPart: after.ok ? after.value.quantity.fractionalPart() : null,
        };
      });
    const originVerdict = originOf(
      fraction.quantity,
      origins,
      unresolvedRatios.some(inOriginWindow),
    );
    if (originVerdict.ok) {
      claims.set(originVerdict.origin.id, [...(claims.get(originVerdict.origin.id) ?? []), row.id]);
    }

    const auctionId = pairing.pairs.get(row.id);
    const auction =
      auctionId === undefined ? undefined : (auctionById.get(auctionId) as CorporateEventRow);
    // A settled fraction matters only as an open auction's partner.
    if (!row.open && (auction === undefined || !auction.open)) continue;

    const evidenceFor = (side: 'fraction' | 'auction'): FractionEvidence => ({
      origins,
      origin: originVerdict.ok ? originVerdict.origin : null,
      candidates:
        side === 'fraction'
          ? (pairing.auctionsOf.get(row.id) as readonly string[])
          : (pairing.fractionsOf.get((auction as CorporateEventRow).id) as readonly string[]),
      partnerId: side === 'fraction' ? (auction?.id ?? null) : row.id,
      auctionPrice: auction?.transaction.unitPrice ?? null,
    });

    let refusal: FractionRefusal | null = null;
    let written: Transaction | null = null;
    if (!originVerdict.ok) refusal = originVerdict.refusal;
    else if (forced.has(row.id)) refusal = 'ambiguous_origin';
    else if (auction === undefined) refusal = pairingRefusalOf(pairing.auctionsOf.get(row.id));
    else if (!auction.transaction.unitPrice.isPositive()) refusal = 'no_price';
    else {
      const origin = originVerdict.origin.type;
      const partner = row.open ? auction : row;
      if (!partner.open && partner.transaction.status === 'unclassified') {
        // Unclassified in the ledger and not in this import: never modified here.
        refusal = 'partner_unresolved';
      } else if (
        !partner.open &&
        !partnerAgrees(partner.transaction, row.open ? 'auction' : 'fraction', origin)
      ) {
        refusal = 'partner_conflict';
      } else if (declined.has(row.id)) {
        refusal = 'conflicts_with_ledger';
      } else if (row.open) {
        written = fractionTransaction(fraction, origin, auction.transaction);
        // BR-006-15: the position must be able to give the fraction up.
        if (!replayUpTo(written, true, [written]).ok) refusal = 'no_basis';
      }
    }

    if (refusal !== null) {
      if (row.open) {
        outcomes.set(row.id, {
          movement: 'fracao_em_ativos',
          status: 'refused',
          refusal,
          evidence: evidenceFor('fraction'),
        });
      }
      if (auction?.open === true) {
        outcomes.set(auction.id, {
          movement: 'leilao_de_fracao',
          status: 'refused',
          refusal,
          evidence: evidenceFor('auction'),
        });
      }
      continue;
    }

    const origin = (originVerdict as { readonly origin: OriginCandidate }).origin.type;
    if (written !== null) {
      resolved.push(written);
      outcomes.set(row.id, {
        movement: 'fracao_em_ativos',
        status: 'resolved',
        transaction: written,
        evidence: evidenceFor('fraction'),
      });
    }
    const paired = auction as CorporateEventRow;
    if (paired.open) {
      const result = auctionTransaction(paired.transaction, origin);
      outcomes.set(paired.id, {
        movement: 'leilao_de_fracao',
        status: result.status,
        transaction: result.transaction,
        evidence: evidenceFor('auction'),
      });
    }
  }

  // Auctions no fraction paired with.
  for (const auction of auctions) {
    if (!auction.open || outcomes.has(auction.id)) continue;
    outcomes.set(auction.id, {
      movement: 'leilao_de_fracao',
      status: 'refused',
      refusal: pairingRefusalOf(pairing.fractionsOf.get(auction.id)),
      evidence: {
        origins: [],
        origin: null,
        candidates: pairing.fractionsOf.get(auction.id) as readonly string[],
        partnerId: null,
        auctionPrice: auction.transaction.unitPrice,
      },
    });
  }

  return {
    outcomes,
    conflicts: [...claims.values()].filter((ids) => ids.length > 1).flat(),
  };
}

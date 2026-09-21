import { BusinessDate } from '@/core/shared/clock';
import type { ConversionGroupId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
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
  type ConversionOutTrace,
  type FractionRefusal,
  fractionTransaction,
  isShareBaseType,
  type OriginCandidate,
  originOf,
  pairFractionAuctions,
  pairingRefusalOf,
  partnerAgrees,
  scaledFractionSale,
  tracedConversionOrigin,
} from '@/core/ingestion/fraction-auction';
import {
  calendarDaysBetween,
  corroborateRatio,
  corroborationCandidate,
  evaluateRatioPair,
  evaluateShareRatio,
  type RatioCorroboration,
  type RatioEvidence,
  type RatioMovement,
  type RatioRefusal,
  type RatioVerdict,
  ratioTransaction,
  sequenceRatioPair,
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
 * **Why the cross-position view lives here (#120).** `share-ratio.ts` decides
 * one row against one issuer's factors and has no sight of any other position.
 * This file is what settles rows in replay order across every position in a
 * call, so it is the only place that can see the same asset's `Desdobro` on
 * two of them — which is what BR-005-20b's corroboration amendment needs.
 * `evaluateShareRatio` is left refusing `no_factor` on its own evidence, and
 * the corroborated ratio is applied here, on top of that refusal.
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
  /**
   * BR-005-20b (#129 D1) — every leg of a conversion group, by group id: this
   * commit's planned legs and the stored ones together. It is how a fraction on
   * a **conversion target** reaches the share-base event behind the group's
   * `conversion_out` (`tracedConversionOrigin`), one asset upstream.
   *
   * `history` is called with the outgoing leg's own position key, so a caller
   * supplying this must be able to answer for the source position too.
   * Omitted where no conversion is in scope — nothing is refused for its
   * absence, the candidate list is simply the position's own events.
   */
  readonly conversionLegs?: ((groupId: ConversionGroupId) => readonly Transaction[]) | undefined;
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

  /**
   * SPEC-005 BR-005-20b (#120) — ratios several positions corroborated, by
   * `corroborationGroupKey`. Empty on the first round: every position is
   * walked on its own evidence exactly as before, and only then is what
   * different positions derived compared.
   *
   * A further round exists for a **second generation**. A ratio event behind
   * an unresolved one is `blocked`, never `no_factor`, so it cannot
   * corroborate anything until the one before it settles — two splits of the
   * same fund in one import need two rounds. The map only grows and a round
   * that adds no group is the answer, so this ends.
   */
  let corroborated: ReadonlyMap<string, RatioCorroboration> = new Map();
  for (;;) {
    const outcomes = walkAllPositions(byPosition, input, corroborated);
    const merged = mergeCorroborations(outcomes, input, corroborated);
    if (merged.size === corroborated.size) return outcomes;
    corroborated = merged;
  }
}

function walkAllPositions(
  byPosition: ReadonlyMap<string, readonly CorporateEventRow[]>,
  input: CorporateEventResolutionInput,
  corroborated: ReadonlyMap<string, RatioCorroboration>,
): ReadonlyMap<string, CorporateEventOutcome> {
  const outcomes = new Map<string, CorporateEventOutcome>();
  for (const rows of byPosition.values()) {
    if (!rows.some((row) => row.open)) continue;
    // One event leaves one fraction. When two fractions claim the same origin,
    // both are refused and the position walked again without them — a fraction
    // resolved earlier in the first walk may have moved P for what follows.
    // The forced set only grows, so this ends.
    let forced = new Set<string>();
    for (;;) {
      const walk = walkPosition(rows, input, forced, corroborated);
      if (walk.conflicts.every((id) => forced.has(id))) {
        for (const [id, outcome] of walk.outcomes) outcomes.set(id, outcome);
        break;
      }
      forced = new Set([...forced, ...walk.conflicts]);
    }
  }
  return outcomes;
}

/** The issuer's **unfiltered** published factors — `null` issuer, or none stored, is none. */
function issuerFactorsOf(
  input: CorporateEventResolutionInput,
  issuerCode: string | null,
): readonly CorporateEventFactor[] {
  return issuerCode === null ? [] : (input.factors.get(issuerCode) ?? []);
}

/**
 * SPEC-005 BR-005-20b (#120) — one corroboration set: **the same asset, the
 * same trade date and the same movement**, across positions.
 *
 * Institution is deliberately not in the key — spanning institutions is the
 * whole point. Two rows of one set are therefore always on two different
 * positions: a second ratio row on the same position and date is counted by
 * `ratioEventsOn` below and refused `combined_same_day`, which is not
 * `no_factor`, so it never reaches a set at all. A same-date pair (#139) can
 * refuse `no_factor`, but only for an issuer with published factors —
 * `evaluateRatioPair` refuses `combined_same_day` for one with none — so
 * `corroborationCandidate` turns it away too.
 */
function corroborationGroupKey(transaction: Transaction, movement: RatioMovement): string {
  return `${transaction.assetId}|${transaction.tradeDate}|${movement}`;
}

/**
 * SPEC-005 BR-005-20b (#120) — the corroborations this round's outcomes add to
 * the ones already decided.
 *
 * Only rows `corroborationCandidate` accepts take part: refused exactly
 * `no_factor`, for an issuer B3 publishes **no** factor of any kind for. A
 * `no_factor` verdict is reached only after the structural refusals and
 * `no_basis`, so each one brings a replayable, positive, trusted basis and the
 * ratio derived from it.
 *
 * A group already decided keeps its decision: the merge puts `corroborated`
 * last. Deciding it again from a later round's membership would let one
 * position that unblocked after the fact redefine what the set agreed on,
 * rather than being measured against it (`corroboratedVerdict`).
 */
function mergeCorroborations(
  outcomes: ReadonlyMap<string, CorporateEventOutcome>,
  input: CorporateEventResolutionInput,
  corroborated: ReadonlyMap<string, RatioCorroboration>,
): ReadonlyMap<string, RatioCorroboration> {
  const rowsById = new Map(input.rows.map((row) => [row.id, row]));
  const groups = new Map<string, Quantity[]>();
  for (const [id, outcome] of outcomes) {
    if (outcome.status !== 'refused') continue;
    if (outcome.movement !== 'desdobro' && outcome.movement !== 'grupamento') continue;
    const derived = corroborationCandidate({
      refusal: outcome.refusal,
      issuerFactors: issuerFactorsOf(input, outcome.evidence.issuerCode),
      derivedRatio: outcome.evidence.derivedRatio,
    });
    if (derived === null) continue;
    const row = rowsById.get(id) as CorporateEventRow;
    const key = corroborationGroupKey(row.transaction, outcome.movement);
    groups.set(key, [...(groups.get(key) ?? []), derived]);
  }

  const fresh = new Map<string, RatioCorroboration>();
  for (const [key, derived] of groups) {
    const decision = corroborateRatio(derived);
    // A lone derivation is not a decision, it is the absence of one: a sibling
    // position `blocked` this round may unblock in the next and corroborate it
    // then. Recording `no_factor` here would freeze the set before it could.
    if (!decision.ok && decision.refusal === 'no_factor') continue;
    fresh.set(key, decision);
  }
  return new Map([...fresh, ...corroborated]);
}

/**
 * SPEC-005 BR-005-20b (#120) — `verdict` with its set's corroborated ratio
 * applied, where this row may be corroborated at all and a set was decided
 * for it. Otherwise the verdict `evaluateShareRatio` reached on its own
 * evidence stands, unchanged — including the `no_factor` a caller with
 * nothing to corroborate against still gets.
 *
 * A published factor therefore always wins: an issuer with any factor at all
 * is not a candidate, so an `ambiguous_factor`, a `disagrees` against B3's
 * figure, or a resolution at B3's multiplier is never displaced by what other
 * positions derived.
 *
 * The set's ratio is applied only to a position that **still derives it**. A
 * position that unblocked after the set was decided joins it like any other
 * member and is measured against it; carrying it along on the set's figure
 * would be applying a ratio nothing on that position supports.
 */
function corroboratedVerdict(
  verdict: RatioVerdict,
  context: {
    readonly issuerFactors: readonly CorporateEventFactor[];
    readonly corroboration: RatioCorroboration | undefined;
  },
): RatioVerdict {
  if (verdict.ok) return verdict;
  const derived = corroborationCandidate({
    refusal: verdict.refusal,
    issuerFactors: context.issuerFactors,
    derivedRatio: verdict.evidence.derivedRatio,
  });
  const { corroboration } = context;
  if (derived === null || corroboration === undefined) return verdict;
  if (!corroboration.ok) {
    return { ok: false, refusal: corroboration.refusal, evidence: verdict.evidence };
  }
  return corroboration.ratio.equals(derived)
    ? { ok: true, ratio: corroboration.ratio, evidence: verdict.evidence }
    : { ok: false, refusal: 'disagrees', evidence: verdict.evidence };
}

const isRatioMovement = (movement: CorporateEventMovement): movement is RatioMovement =>
  movement === 'desdobro' || movement === 'grupamento';

type PairFigures = Pick<OriginCandidate, 'quantityAfter' | 'fractionalPart'> & {
  readonly saleScale: Quantity | null;
};

/**
 * SPEC-005 BR-005-20b (#139) — the origin figures of **active** ratio events
 * that share a date with another, by transaction id.
 *
 * Replay cannot say what a same-date pair left: both rank alike and apply
 * before any of the day's sales, so VIVT3's day replays 150 → 12.000 → 300 and
 * neither event leaves the 0,75 B3 removed between them. The pair's own
 * sequence does (`sequenceRatioPair`), from P and each event's stated quantity
 * and stored ratio:
 *
 * - the first event: its result, the fraction removed **between** the two as
 *   its fractional part, and the second event's multiplier as `saleScale`;
 * - the second: its result, and that result's own fractional part.
 *
 * Read from the ledger rather than carried from `settlePair`, so a fraction a
 * later import resolves against a pair an earlier one settled finds the same
 * origin. Any date that is not exactly one pair of one sequence — three ratio
 * events, two of a kind, a ratio missing, an unreplayable P, no order or two —
 * gets unknown figures, and a fraction in its window refuses
 * `origin_unresolved` rather than meeting a replay artefact.
 */
function sameDateRatioFigures(active: readonly Transaction[]): ReadonlyMap<string, PairFigures> {
  const byDate = new Map<BusinessDate, Transaction[]>();
  for (const t of active) {
    if (t.type !== 'split' && t.type !== 'grupamento') continue;
    byDate.set(t.tradeDate, [...(byDate.get(t.tradeDate) ?? []), t]);
  }
  const figures = new Map<string, PairFigures>();
  const unknown: PairFigures = { quantityAfter: null, fractionalPart: null, saleScale: null };
  for (const events of byDate.values()) {
    if (events.length < 2) continue;
    for (const event of events) figures.set(event.id, unknown);
    const [a, b, ...rest] = [...events].sort(compareForReplay) as [Transaction, Transaction];
    if (rest.length > 0 || a.type === b.type || a.ratio === null || b.ratio === null) continue;
    const before = replayPosition(active.filter((t) => compareForReplay(t, a) < 0));
    if (!before.ok) continue;
    const movementOf = (t: Transaction): RatioMovement =>
      t.type === 'split' ? 'desdobro' : 'grupamento';
    const [sequence, ...others] = sequenceRatioPair(
      before.value.quantity,
      [
        { movement: movementOf(a), stated: a.quantity },
        { movement: movementOf(b), stated: b.quantity },
      ],
      [a.ratio, b.ratio],
    );
    if (sequence === undefined || others.length > 0) continue;
    const pair = [a, b] as const;
    const second = pair[sequence.second];
    figures.set(pair[sequence.first].id, {
      quantityAfter: sequence.afterFirst,
      fractionalPart: sequence.intermediateFraction,
      saleScale: second.ratio,
    });
    figures.set(second.id, {
      quantityAfter: sequence.afterSecond,
      fractionalPart: sequence.afterSecond.fractionalPart(),
      saleScale: null,
    });
  }
  return figures;
}

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
  corroborated: ReadonlyMap<string, RatioCorroboration>,
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

  // BR-005-20b: ratio events on one position and date — open, unclassified or
  // already active in the ledger. More than one refuses `combined_same_day`,
  // except the open `Desdobro` + `Grupamento` pair below (#139).
  const ratioEventsOn = new Map<string, number>();
  const countRatioEvent = (date: BusinessDate) =>
    ratioEventsOn.set(date, (ratioEventsOn.get(date) ?? 0) + 1);
  for (const t of base)
    if (t.type === 'split' || t.type === 'grupamento') countRatioEvent(t.tradeDate);
  const unresolvedRatioRow = (row: CorporateEventRow) =>
    isRatioMovement(row.movement) && (row.open || row.transaction.status === 'unclassified');
  for (const row of rows) if (unresolvedRatioRow(row)) countRatioEvent(row.transaction.tradeDate);

  // BR-005-20b (#139): the one same-date shape that may still resolve — exactly
  // two ratio events on the date, both open here, one `Desdobro` and one
  // `Grupamento`. They are decided together (`evaluateRatioPair`); every other
  // same-date shape keeps refusing `combined_same_day`.
  const pairOf = new Map<string, readonly [CorporateEventRow, CorporateEventRow]>();
  const openRatioRowsOn = new Map<BusinessDate, CorporateEventRow[]>();
  for (const row of rows) {
    if (!isRatioMovement(row.movement) || !row.open) continue;
    const date = row.transaction.tradeDate;
    openRatioRowsOn.set(date, [...(openRatioRowsOn.get(date) ?? []), row]);
  }
  for (const [date, onDate] of openRatioRowsOn) {
    if (onDate.length !== 2 || ratioEventsOn.get(date) !== 2) continue;
    const [a, b] = [...onDate].sort(walkOrder) as [CorporateEventRow, CorporateEventRow];
    if (a.movement === b.movement) continue;
    pairOf.set(a.id, [a, b]);
    pairOf.set(b.id, [a, b]);
  }

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

  /**
   * BR-005-20b (#129 D1) — the outgoing legs of the group a `conversion_in`
   * belongs to, each with the share-base events on **its own source position**
   * and the fraction each left there.
   *
   * `inWindow` is the fraction's origin window, so a source event too far
   * before the fraction is no candidate — the window is measured from the
   * underlying event, never from the conversion that carried its shares
   * across. An unresolved ratio event on the source is the same uncertainty
   * `originOf` refuses on a position's own events: it might be the real origin,
   * so nothing is traced through it.
   */
  const outgoingTraces = (
    leg: Transaction,
    inWindow: (t: Transaction) => boolean,
  ): readonly ConversionOutTrace[] => {
    const groupId = leg.conversionGroupId;
    if (input.conversionLegs === undefined || groupId === null) return [];
    const outLegs = input
      .conversionLegs(groupId)
      .filter((l) => l.type === 'conversion_out' && l.status === 'active');
    return outLegs.map((out) => {
      const sourceHistory = input.history(out);
      const active = sourceHistory.filter((t) => t.status === 'active');
      const pairFiguresById = sameDateRatioFigures(active);
      const candidates: OriginCandidate[] = active
        .filter((t) => isShareBaseType(t.type) && inWindow(t))
        .sort(compareForReplay)
        .map((event) => {
          // #139: a same-date pair on the source is read as the pair it is.
          // What crossed the conversion is the source's own quantity, so a
          // fraction removed between the pair (`saleScale`) is not traced.
          const pairFigures = pairFiguresById.get(event.id);
          if (pairFigures !== undefined) {
            return {
              id: event.id,
              type: event.type as OriginCandidate['type'],
              tradeDate: event.tradeDate,
              quantityAfter: pairFigures.quantityAfter,
              fractionalPart: pairFigures.saleScale === null ? pairFigures.fractionalPart : null,
            };
          }
          const upTo = replayPosition(active.filter((t) => compareForReplay(t, event) <= 0));
          return {
            id: event.id,
            type: event.type as OriginCandidate['type'],
            tradeDate: event.tradeDate,
            quantityAfter: upTo.ok ? upTo.value.quantity : null,
            fractionalPart: upTo.ok ? upTo.value.quantity.fractionalPart() : null,
          };
        });
      /**
       * An unresolved ratio event on the source, from **either** place it can
       * hide. `history` carries the stored ledger and this batch's `new`
       * candidates, but a `Desdobro` or `Grupamento` stages `unclassified`
       * and so lives only in `rows` until it is committed — on a first import
       * it is in no history at all. Reading only `history` left this guard
       * dead on exactly the import that needs it, and a fraction traced past
       * an in-flight ratio event is an exempt provento where a realised sale
       * may have been right.
       *
       * `rows` spans the whole batch, so it is filtered to the source's own
       * position. A row that is open here is still unresolved: whether it
       * settles is decided in that position's own walk, which this one cannot
       * see. Refusing is the safe direction — the next import, with the event
       * settled in the ledger, resolves the fraction in place (BR-005-20b).
       */
      const sourceKey = positionKeyString(out);
      const pendingRatioRow = input.rows.some(
        (r) =>
          isRatioMovement(r.movement) &&
          (r.open || r.transaction.status === 'unclassified') &&
          positionKeyString(r.transaction) === sourceKey &&
          inWindow(r.transaction),
      );
      const unresolved =
        pendingRatioRow ||
        sourceHistory.some((t) => {
          if (t.status !== 'unclassified' || !inWindow(t)) return false;
          const movement = corporateEventMovementOfKey(t.naturalKey);
          return movement !== null && isRatioMovement(movement);
        });
      return { id: out.id, quantity: out.quantity, candidates, unresolved };
    });
  };

  const ratioShape = (row: CorporateEventRow): Transaction => ({
    ...row.transaction,
    type: row.movement === 'desdobro' ? 'split' : 'grupamento',
    status: 'active',
  });

  /**
   * BR-005-20b (#139) — a same-date `Desdobro` + `Grupamento` pair, decided as
   * one: both resolve at B3's multipliers in the order their stated quantities
   * prove, or both refuse with the same reason. P is the position before
   * either — both rank as ratio events, so the earlier shape's prefix excludes
   * the other. The fraction B3 removed between them is not written here: it
   * is its own `Fração em Ativos` row, whose origin `sameDateRatioFigures`
   * finds on the first event of the pair.
   */
  const settlePair = (pair: readonly [CorporateEventRow, CorporateEventRow]) => {
    const [a, b] = pair;
    const movements = [a.movement as RatioMovement, b.movement as RatioMovement] as const;
    const shapes = [ratioShape(a), ratioShape(b)] as const;
    const tradeDate = a.transaction.tradeDate;
    const blocked = unresolvedRatios.some((t) => BusinessDate.isBefore(t.tradeDate, tradeDate));
    const before = blocked ? null : replayUpTo(shapes[0], false);
    const issuerCode = issuerCodeOf(a.ticker);
    const verdict = evaluateRatioPair({
      legs: [
        { movement: movements[0], stated: a.transaction.quantity },
        { movement: movements[1], stated: b.transaction.quantity },
      ],
      basis: before !== null && before.ok ? before.value.quantity : null,
      issuerCode,
      issuerFactors: issuerFactorsOf(input, issuerCode),
      tradeDate,
      factorDays: windows.factorDays,
      structural: blocked
        ? 'blocked'
        : declined.has(a.id) || declined.has(b.id)
          ? 'conflicts_with_ledger'
          : null,
    });
    pair.forEach((row, index) => {
      const movement = movements[index] as RatioMovement;
      const evidence = verdict.evidence[index] as RatioEvidence;
      if (verdict.ok) {
        // BR-007-04a: each event at its own published multiplier.
        const transaction = ratioTransaction(
          row.transaction,
          movement,
          verdict.ratios[index] as Quantity,
        );
        resolved.push(transaction);
        outcomes.set(row.id, { movement, status: 'resolved', transaction, evidence });
      } else {
        unresolvedRatios.push(shapes[index] as Transaction);
        outcomes.set(row.id, { movement, status: 'refused', refusal: verdict.refusal, evidence });
      }
    });
  };

  const walk = rows
    .filter((row) => unresolvedRatioRow(row) || row.movement === 'fracao_em_ativos')
    .sort(walkOrder);

  for (const row of walk) {
    if (isRatioMovement(row.movement)) {
      const movement = row.movement;
      // Sorted as the event it would become: rank 0, before the day's trades.
      const shape = ratioShape(row);
      // A ratio row this call may not resolve — unclassified in the ledger, not
      // part of this import — is still an unresolved event: later ones wait.
      if (!row.open) {
        unresolvedRatios.push(shape);
        continue;
      }
      const pair = pairOf.get(row.id);
      if (pair !== undefined) {
        // The pair's first row settled both; its partner has nothing left to do.
        if (!outcomes.has(row.id)) settlePair(pair);
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
      const issuerFactors = issuerFactorsOf(input, issuerCode);
      const own = evaluateShareRatio({
        movement,
        basis: before !== null && before.ok ? before.value.quantity : null,
        stated: row.transaction.quantity,
        issuerCode,
        issuerFactors,
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
      // BR-005-20b (#120): what other positions derived, where B3 published
      // nothing at all for this issuer and this row's own evidence refused.
      const verdict = corroboratedVerdict(own, {
        issuerFactors,
        corroboration: corroborated.get(corroborationGroupKey(shape, movement)),
      });
      if (verdict.ok) {
        // BR-007-04a: B3's multiplier is the ratio applied, or — where B3
        // published none at all — the one the positions corroborated.
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
    const pairFiguresById = sameDateRatioFigures([...base, ...resolved]);
    const ownOrigins: OriginCandidate[] = [...base, ...resolved]
      .filter((t) => isShareBaseType(t.type) && inOriginWindow(t))
      .sort(compareForReplay)
      .map((event) => {
        const pairFigures = pairFiguresById.get(event.id);
        if (pairFigures !== undefined) {
          return {
            id: event.id,
            type: event.type as OriginCandidate['type'],
            tradeDate: event.tradeDate,
            ...pairFigures,
          };
        }
        const after = replayUpTo(event, true);
        return {
          id: event.id,
          type: event.type as OriginCandidate['type'],
          tradeDate: event.tradeDate,
          quantityAfter: after.ok ? after.value.quantity : null,
          fractionalPart: after.ok ? after.value.quantity.fractionalPart() : null,
        };
      });

    /**
     * BR-005-20b (#129 D1) — candidates this position inherited through a
     * conversion. A `conversion_in` is not itself a share-base event, so it
     * carries the type of the one the group's outgoing leg traces back to on
     * the **source** position, and the origin window is measured from that
     * event's date rather than the conversion's. The fractional part is still
     * this position's own, immediately after the leg: KLBN4 holds 2,4 there,
     * leaving 0,4 — the fraction B3 auctioned.
     */
    const incomingByGroup = new Map<string, Transaction[]>();
    for (const t of [...base, ...resolved]) {
      const groupId = t.conversionGroupId;
      if (t.type !== 'conversion_in' || groupId === null) continue;
      if (BusinessDate.isBefore(fraction.tradeDate, t.tradeDate)) continue;
      incomingByGroup.set(groupId, [...(incomingByGroup.get(groupId) ?? []), t]);
    }
    /** A group that could be traced but could not be read (`TracedOriginVerdict`). */
    let tracedUnresolved = false;
    const tracedOrigins: OriginCandidate[] = [...incomingByGroup]
      .map(([groupId, legs]) => ({ groupId, legs: [...legs].sort(compareForReplay) }))
      .sort((a, b) => compareForReplay(a.legs[0] as Transaction, b.legs[0] as Transaction))
      .flatMap(({ groupId, legs }) => {
        const last = legs[legs.length - 1] as Transaction;
        const verdict = tracedConversionOrigin(outgoingTraces(last, inOriginWindow));
        if (!verdict.ok) {
          tracedUnresolved = tracedUnresolved || verdict.unresolved;
          return [];
        }
        const trace = verdict.origin;
        // A group is atomic (BR-005-20c), so the fraction it left this position
        // is the one after **all** its incoming legs, not after each. KLBN4
        // receives 2 and 0,4 on one date; taken singly their replay order is a
        // UUID tiebreak, and one ordering leaves 0,4 twice — `ambiguous_origin`
        // by coin flip. Taken as the group it is 2,4, leaving 0,4, once.
        const after = replayUpTo(last, true);
        return [
          {
            id: groupId,
            type: trace.event.type,
            tradeDate: trace.event.tradeDate,
            quantityAfter: after.ok ? after.value.quantity : null,
            fractionalPart: after.ok ? after.value.quantity.fractionalPart() : null,
            tracedFrom: trace,
          },
        ];
      });

    const origins: OriginCandidate[] = [...ownOrigins, ...tracedOrigins];
    const originVerdict = originOf(
      fraction.quantity,
      origins,
      unresolvedRatios.some(inOriginWindow) || tracedUnresolved,
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
      } else if (declined.has(row.id) || declined.has(auction.id)) {
        refusal = 'conflicts_with_ledger';
      } else if (row.open) {
        // #139: a fraction removed between a same-date pair sells at the
        // second event's scale, because replay meets it after both.
        const scale = originVerdict.origin.saleScale ?? null;
        written =
          scale === null
            ? fractionTransaction(fraction, origin, auction.transaction)
            : scaledFractionSale(fraction, auction.transaction, scale);
        if (written === null) refusal = 'scale_not_representable';
        // BR-006-15: the position must be able to give the fraction up.
        else if (!replayUpTo(written, true, [written]).ok) refusal = 'no_basis';
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

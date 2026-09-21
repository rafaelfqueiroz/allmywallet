import type { BusinessDate } from '@/core/shared/clock';
import { asStored, Quantity } from '@/core/shared/money';
import { computeTotalValue, type Transaction } from '@/core/ledger/transaction';
import type {
  CorporateEventFactor,
  CorporateEventFactorKind,
} from '@/core/quotes/corporate-event-factors';

/**
 * SPEC-005 BR-005-20b / SPEC-007 BR-007-04a (#113) — whether a B3 `Desdobro`
 * or `Grupamento` row can be applied, and with which ratio.
 *
 * B3's Movimentação never states a ratio. A `Desdobro` credit states the
 * shares **added** (Δ) and a `Grupamento` credit the **resulting** balance (R).
 * The ratio is derived from the position immediately before the event in
 * replay order (P) and applied only when it **agrees exactly** with B3's
 * published factor (SPEC-008 BR-008-29):
 *
 * - Desdobro agrees iff `P × (m − 1) = Δ`;
 * - Grupamento agrees iff `P × m = R`;
 *
 * where m is B3's multiplier (`factorMultiplier`). Exact decimal equality, no
 * tolerance: a tolerance is how a wrong P that happens to be close passes.
 *
 * **The ratio applied is B3's m, never the derived one** (DL-007-08). Where the
 * two agree they are the same number; where the derived one is a repeating
 * decimal (P = 300, R = 100 → 0,333…) it could not be stored anyway.
 *
 * **The amendment (#120).** B3 publishes factors only for **listed companies**,
 * so an FII (`BCFF11`) and a delisted issuer (`BIDI`) have no factor of any
 * kind, ever, and every split or reverse split of theirs refused `no_factor`
 * permanently. Where the issuer's factor list is empty **outright**, the row
 * may instead be confirmed by corroboration across positions —
 * `corroborationCandidate` and `corroborateRatio` below. `evaluateShareRatio`
 * itself is unchanged: it still refuses `no_factor` on its own evidence, so a
 * caller with no cross-position view behaves exactly as it did before.
 *
 * Everything here is pure (AR-01). What P is — which history precedes the
 * event — is decided by `corporate-event-resolution.ts`, which walks each
 * position in replay order and is the only place with a view across them.
 */

/** The two corporate-event rows whose effect is a ratio. */
export type RatioMovement = 'desdobro' | 'grupamento';

/**
 * Why a ratio row stays `unclassified` (BR-005-20b). Shown on the batch page,
 * so each names one condition the owner can act on:
 *
 * - `no_basis` — the position before the event is empty or cannot be replayed;
 * - `no_factor` — no published factor of the event's kind, for the issuer,
 *   dated on or within the window before the row (or no issuer at all);
 * - `ambiguous_factor` — more than one such factor;
 * - `disagrees` — P and the stated quantity do not give B3's multiplier;
 * - `not_representable` — B3's multiplier is not exact at `NUMERIC(20,8)`, so
 *   the ratio the ledger would store is not the one B3 published;
 * - `combined_same_day` — ratio events on one position and date whose order
 *   cannot be identified: more than two, two of one kind, one already settled,
 *   an issuer with no published factor, or a `Desdobro` + `Grupamento` pair
 *   whose stated quantities fit more than one order (#139,
 *   `evaluateRatioPair`) — so none applies;
 * - `blocked` — an earlier ratio event on the position is unresolved, so P
 *   cannot be trusted;
 * - `conflicts_with_ledger` — it agrees, but applied it leaves a later row of
 *   the position unreplayable (BR-006-15), so commit gave it up.
 */
export type RatioRefusal =
  | 'no_basis'
  | 'no_factor'
  | 'ambiguous_factor'
  | 'disagrees'
  | 'not_representable'
  | 'combined_same_day'
  | 'blocked'
  | 'conflicts_with_ledger';

/** Every figure the batch page shows for a ratio row, resolved or not. */
export interface RatioEvidence {
  /** `issuerCodeOf(ticker)`; `null` for a ticker with no B3 issuer. */
  readonly issuerCode: string | null;
  /** P — the quantity before the event. `null` when it could not be replayed or is not trusted (`blocked`). */
  readonly basis: Quantity | null;
  /** Δ for a desdobro, R for a grupamento — the row's quantity. */
  readonly stated: Quantity;
  /** (P + Δ) ÷ P or R ÷ P, for display only. `null` unless P > 0. */
  readonly derivedRatio: Quantity | null;
  /** The published factors in the window, oldest first — zero, one, or the ambiguous several. */
  readonly factors: readonly CorporateEventFactor[];
}

export type RatioVerdict =
  | { readonly ok: true; readonly ratio: Quantity; readonly evidence: RatioEvidence }
  | { readonly ok: false; readonly refusal: RatioRefusal; readonly evidence: RatioEvidence };

const FACTOR_KIND: Readonly<Record<RatioMovement, CorporateEventFactorKind>> = {
  desdobro: 'desdobramento',
  grupamento: 'grupamento',
};

const MS_PER_DAY = 86_400_000;

/**
 * Calendar days from `from` to `to`, negative when `to` is earlier. Both parse
 * to UTC midnight, so the difference is an exact multiple of a day (the same
 * arithmetic as `staleness.ts`). A day count, not money: a `number` is right.
 */
export function calendarDaysBetween(from: BusinessDate, to: BusinessDate): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_DAY;
}

/**
 * BR-005-20b — the issuer's published factors that can confirm this row: of
 * the event's kind (`desdobro` ↔ `desdobramento`, `grupamento` ↔
 * `grupamento`), with B3's *última data com* on or before the row's date and
 * no more than `factorDays` calendar days before it.
 *
 * Worked example (DV-17): MGLU's grupamento has `lastDatePrior` 2024-05-24 and
 * the Movimentação row is dated 2024-05-28 — 4 days, inside a 7-day window. A
 * factor dated 8 days before the row is outside it.
 */
export function factorsInWindow(
  factors: readonly CorporateEventFactor[],
  movement: RatioMovement,
  tradeDate: BusinessDate,
  factorDays: number,
): readonly CorporateEventFactor[] {
  return factors
    .filter((factor) => {
      if (factor.kind !== FACTOR_KIND[movement]) return false;
      const days = calendarDaysBetween(factor.lastDatePrior, tradeDate);
      return days >= 0 && days <= factorDays;
    })
    .sort((a, b) =>
      a.lastDatePrior < b.lastDatePrior ? -1 : a.lastDatePrior > b.lastDatePrior ? 1 : 0,
    );
}

/**
 * The ratio P and the stated quantity imply, for display: (P + Δ) ÷ P for a
 * desdobro, R ÷ P for a grupamento. `basis` must be positive.
 *
 * Worked examples (DV-17): P = 70, Δ = 630 → 700 ÷ 70 = **10**; P = 80, R = 40
 * → 40 ÷ 80 = **0,5**; P = 300, R = 100 → 100 ÷ 300 = 0,333… (truncated at
 * `money.ts`'s precision — it is never stored).
 */
export function derivedRatioOf(
  movement: RatioMovement,
  basis: Quantity,
  stated: Quantity,
): Quantity {
  return movement === 'desdobro' ? basis.plus(stated).dividedBy(basis) : stated.dividedBy(basis);
}

/**
 * SPEC-007 BR-007-04a — the verdict for one ratio row, given P (`basis`,
 * already `null` when unreplayable or untrusted), the issuer's factors and any
 * refusal the position walk decided before arithmetic could (`structural`:
 * `combined_same_day`, `blocked`).
 *
 * Checked in this order, so the refusal names the first thing to fix:
 * structural → `no_basis` → `no_factor` / `ambiguous_factor` →
 * `not_representable` → `disagrees`. Representability comes before agreement
 * because a multiplier past eight places cannot be the ratio stored even when
 * the arithmetic happens to agree.
 *
 * Worked examples (DV-17):
 *
 * - Desdobro, P = 80, Δ = 80, factor `100` (percent added) → m = 1 + 100 ÷ 100
 *   = 2; 80 × (2 − 1) = 80 = Δ → **applied, ratio 2**.
 * - Grupamento, P = 220, R = 110, factor `0.5` → m = 0,5; 220 × 0,5 = 110 = R
 *   → **applied, ratio 0,5**.
 * - Grupamento, P = 80, R = 40, factor `0.1` → 80 × 0,1 = 8 ≠ 40 →
 *   **`disagrees`**, derived 0,5 shown beside the published 0,1.
 * - Grupamento 3:1 published as `0.333333333333` → stored it would be
 *   0,33333333, not B3's figure → **`not_representable`**.
 */
export function evaluateShareRatio(input: {
  readonly movement: RatioMovement;
  readonly basis: Quantity | null;
  readonly stated: Quantity;
  readonly issuerCode: string | null;
  readonly issuerFactors: readonly CorporateEventFactor[];
  readonly tradeDate: BusinessDate;
  readonly factorDays: number;
  readonly structural: 'combined_same_day' | 'blocked' | 'conflicts_with_ledger' | null;
}): RatioVerdict {
  const { movement, basis, stated } = input;
  const factors =
    input.issuerCode === null
      ? []
      : factorsInWindow(input.issuerFactors, movement, input.tradeDate, input.factorDays);
  const evidence: RatioEvidence = {
    issuerCode: input.issuerCode,
    basis,
    stated,
    derivedRatio:
      basis !== null && basis.isPositive() ? derivedRatioOf(movement, basis, stated) : null,
    factors,
  };
  const refuse = (refusal: RatioRefusal): RatioVerdict => ({ ok: false, refusal, evidence });

  if (input.structural !== null) return refuse(input.structural);
  if (basis === null || !basis.isPositive()) return refuse('no_basis');
  const [factor, ...others] = factors;
  if (factor === undefined) return refuse('no_factor');
  if (others.length > 0) return refuse('ambiguous_factor');

  const m = factor.multiplier;
  if (!Quantity.fromString(asStored(m)).equals(m)) return refuse('not_representable');

  return ratioAgrees(movement, basis, m, stated)
    ? { ok: true, ratio: m, evidence }
    : refuse('disagrees');
}

/** Whether `m` reproduces B3's stated quantity from `basis` — the two equalities above. */
function ratioAgrees(movement: RatioMovement, basis: Quantity, m: Quantity, stated: Quantity) {
  return movement === 'desdobro'
    ? basis.times(m.minus(Quantity.fromString('1'))).equals(stated)
    : basis.times(m).equals(stated);
}

/** The quantity after a ratio event B3 stated as `stated`: P + Δ, or R. */
function quantityAfterRatio(movement: RatioMovement, basis: Quantity, stated: Quantity): Quantity {
  return movement === 'desdobro' ? basis.plus(stated) : stated;
}

/** One side of a same-date `Desdobro` + `Grupamento` pair: its movement and B3's stated quantity. */
export interface RatioPairLeg {
  readonly movement: RatioMovement;
  readonly stated: Quantity;
}

/**
 * SPEC-005 BR-005-20b (#139) — the one order a same-date pair can have been
 * applied in, as B3's stated quantities prove it. Indices are into the `legs`
 * the caller passed.
 */
export interface RatioPairSequence {
  /** The leg applied first, then the other. */
  readonly first: 0 | 1;
  readonly second: 0 | 1;
  /** P — the position before either. */
  readonly basis: Quantity;
  /** After the first event. */
  readonly afterFirst: Quantity;
  /**
   * The fraction B3 removed **between** the two events — `afterFirst` less its
   * floor — or zero, where the second event applied to `afterFirst` whole.
   */
  readonly intermediateFraction: Quantity;
  /** The basis the second event applied to: `afterFirst − intermediateFraction`. */
  readonly secondBasis: Quantity;
  /** After the second event — B3's post-event count, before any fraction it leaves. */
  readonly afterSecond: Quantity;
}

/**
 * SPEC-005 BR-005-20b (#139) — **every** sequence in which the pair reproduces
 * both of B3's stated quantities exactly, given each leg's multiplier.
 *
 * B3 does not say which of the two applied first, and the two factors it
 * publishes share one *última data com*, so the date cannot say either. The
 * quantities can: each order, and for the second event each of the two bases
 * it may have met — the whole first result, or its floor where B3 removed the
 * first event's fraction before applying the second — is tried against the
 * same exact equalities `evaluateShareRatio` runs. The caller applies the pair
 * only where exactly one sequence survives.
 *
 * Worked example (DV-17), VIVT3 at Inter, April 2025: P = 150, `Desdobro`
 * Δ = 237 at m = 80 (factor `7900`, percent added), `Grupamento` R = 3,75 at
 * m = 0,025.
 *
 * - Desdobro first: 150 × 79 = 11.850 ≠ 237 — no.
 * - Grupamento first: 150 × 0,025 = 3,75 = R. Then the desdobro on 3,75 whole:
 *   3,75 × 79 = 296,25 ≠ 237 — no; on its floor 3 (0,75 removed between):
 *   3 × 79 = **237** = Δ — yes, ending at 3 + 237 = **240**, B3's count.
 *
 * One sequence: grupamento, fraction of 0,75 removed, desdobro.
 */
export function sequenceRatioPair(
  basis: Quantity,
  legs: readonly [RatioPairLeg, RatioPairLeg],
  ratios: readonly [Quantity, Quantity],
): readonly RatioPairSequence[] {
  const sequences: RatioPairSequence[] = [];
  for (const [first, second] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const a = legs[first];
    const b = legs[second];
    if (!ratioAgrees(a.movement, basis, ratios[first], a.stated)) continue;
    const afterFirst = quantityAfterRatio(a.movement, basis, a.stated);
    const fraction = afterFirst.fractionalPart();
    const bases = fraction.isZero() ? [afterFirst] : [afterFirst, afterFirst.minus(fraction)];
    for (const secondBasis of bases) {
      if (!secondBasis.isPositive()) continue;
      if (!ratioAgrees(b.movement, secondBasis, ratios[second], b.stated)) continue;
      sequences.push({
        first,
        second,
        basis,
        afterFirst,
        intermediateFraction: afterFirst.minus(secondBasis),
        secondBasis,
        afterSecond: quantityAfterRatio(b.movement, secondBasis, b.stated),
      });
    }
  }
  return sequences;
}

export type RatioPairVerdict =
  | {
      readonly ok: true;
      readonly sequence: RatioPairSequence;
      /** B3's multiplier for each leg, by the caller's index. */
      readonly ratios: readonly [Quantity, Quantity];
      readonly evidence: readonly [RatioEvidence, RatioEvidence];
    }
  | {
      readonly ok: false;
      readonly refusal: RatioRefusal;
      readonly evidence: readonly [RatioEvidence, RatioEvidence];
    };

/**
 * SPEC-005 BR-005-20b (#139) / SPEC-007 BR-007-04a — the verdict for a
 * same-date `Desdobro` + `Grupamento` pair on one position, **as a pair**:
 * both apply or neither does, and both carry the same refusal.
 *
 * Checked in `evaluateShareRatio`'s order, over both legs, so the refusal
 * names the first thing to fix:
 *
 * - structural (`blocked`, `conflicts_with_ledger`) → `no_basis`;
 * - **the issuer publishes no factor of any kind** → `combined_same_day`, as
 *   before #139: corroboration across positions confirms one ratio, it cannot
 *   order two, so a pair without B3's factors is never reached by it;
 * - each leg's own factor — `no_factor` / `ambiguous_factor` — then
 *   `not_representable`;
 * - `sequenceRatioPair`: no sequence → `disagrees`; more than one →
 *   `combined_same_day`, the order still not identified. Never a majority.
 *
 * Each leg's evidence shows the basis it was measured against where the pair
 * resolved (P for the first, the second's basis for the other); refused, both
 * show P, the only basis known without an order.
 */
export function evaluateRatioPair(input: {
  readonly legs: readonly [RatioPairLeg, RatioPairLeg];
  readonly basis: Quantity | null;
  readonly issuerCode: string | null;
  readonly issuerFactors: readonly CorporateEventFactor[];
  readonly tradeDate: BusinessDate;
  readonly factorDays: number;
  readonly structural: 'blocked' | 'conflicts_with_ledger' | null;
}): RatioPairVerdict {
  const { legs, basis } = input;
  const evidenceAt = (leg: RatioPairLeg, legBasis: Quantity | null): RatioEvidence => ({
    issuerCode: input.issuerCode,
    basis: legBasis,
    stated: leg.stated,
    derivedRatio:
      legBasis !== null && legBasis.isPositive()
        ? derivedRatioOf(leg.movement, legBasis, leg.stated)
        : null,
    factors:
      input.issuerCode === null
        ? []
        : factorsInWindow(input.issuerFactors, leg.movement, input.tradeDate, input.factorDays),
  });
  const evidence = [evidenceAt(legs[0], basis), evidenceAt(legs[1], basis)] as const;
  const refuse = (refusal: RatioRefusal): RatioPairVerdict => ({ ok: false, refusal, evidence });

  if (input.structural !== null) return refuse(input.structural);
  if (basis === null || !basis.isPositive()) return refuse('no_basis');
  if (input.issuerCode === null || input.issuerFactors.length === 0) {
    return refuse('combined_same_day');
  }
  for (const leg of evidence) if (leg.factors.length === 0) return refuse('no_factor');
  for (const leg of evidence) if (leg.factors.length > 1) return refuse('ambiguous_factor');
  // Exactly one factor per leg, checked just above.
  const ratios = [
    (evidence[0].factors[0] as CorporateEventFactor).multiplier,
    (evidence[1].factors[0] as CorporateEventFactor).multiplier,
  ] as const;
  if (ratios.some((m) => !Quantity.fromString(asStored(m)).equals(m))) {
    return refuse('not_representable');
  }

  const [sequence, ...others] = sequenceRatioPair(basis, legs, ratios);
  if (sequence === undefined) return refuse('disagrees');
  if (others.length > 0) return refuse('combined_same_day');
  const legBasis = (index: 0 | 1) =>
    index === sequence.first ? sequence.basis : sequence.secondBasis;
  return {
    ok: true,
    sequence,
    ratios,
    evidence: [evidenceAt(legs[0], legBasis(0)), evidenceAt(legs[1], legBasis(1))],
  };
}

/**
 * SPEC-005 BR-005-20b (#120) — the outcome of corroborating a ratio across
 * positions. `no_factor` is the unchanged refusal: nothing corroborated it.
 */
export type RatioCorroboration =
  | { readonly ok: true; readonly ratio: Quantity }
  | { readonly ok: false; readonly refusal: 'no_factor' | 'disagrees' | 'not_representable' };

/**
 * SPEC-005 BR-005-20b (#120) — whether a **refused** row may be confirmed by
 * corroboration rather than by a published factor, and with which derivation.
 * `null` means it may not; otherwise the row's own derived ratio, for the
 * caller to compare against what its sibling positions derived.
 *
 * Two conditions, both load-bearing:
 *
 * - the refusal is exactly `no_factor`. Every other one names something
 *   corroboration cannot answer: `no_basis` has nothing to derive from,
 *   `disagrees` already has B3's figure and lost to it, `blocked` and
 *   `combined_same_day` distrust P itself, `conflicts_with_ledger` was given
 *   up by the caller. `no_factor` also *implies* a replayable, positive,
 *   trusted P — it is checked after `no_basis` and after the structural
 *   refusals — so the derived ratio reaching a caller here is never absent.
 * - **the issuer's whole factor list is empty**, not merely empty within the
 *   window. This is the distinction that keeps the guard: an issuer B3 does
 *   publish for keeps refusing `no_factor` when nothing is near the row, so a
 *   2014 desdobramento does not license a 2025 event, and the real grupamento
 *   that derived 0,5 against a published 0,1 is still caught. Corroboration is
 *   reached only where there is no published factor to be had at all.
 */
export function corroborationCandidate(input: {
  readonly refusal: RatioRefusal;
  /** The **unfiltered** list for the issuer — `factorsInWindow` is deliberately not consulted. */
  readonly issuerFactors: readonly CorporateEventFactor[];
  readonly derivedRatio: Quantity | null;
}): Quantity | null {
  if (input.refusal !== 'no_factor') return null;
  if (input.issuerFactors.length > 0) return null;
  return input.derivedRatio;
}

/**
 * SPEC-005 BR-005-20b (#120) — the ratio a set of positions corroborates,
 * given what each of them derived for the same asset, date and movement.
 *
 * Worked example (DV-17), the shape that prompted the amendment: an FII
 * desdobro credits +112 shares to a position holding 16 and +343 to one
 * holding 49, and B3 publishes nothing at all for the issuer.
 * (16 + 112) ÷ 16 = 128 ÷ 16 = **8**; (49 + 343) ÷ 49 = 392 ÷ 49 = **8**.
 * Two positions, one figure, exact at eight places → ratio 8 for both.
 *
 * The rules, each a refusal the caller shows:
 *
 * - **One position never confirms itself.** A single derivation is the row
 *   restating its own arithmetic, which is not evidence — `no_factor` stands.
 *   Two is structural, not a threshold to tune.
 * - **Any disagreement refuses the whole set**, never a majority. 16 → 8 and
 *   56 → 7 means one of the two bases is wrong and nothing says which, so
 *   both refuse `disagrees` with their figures shown.
 * - A ratio the ledger cannot hold exactly refuses `not_representable`, as a
 *   published one does: positions deriving 100 ÷ 300 agree on 0,333…, and
 *   stored at `NUMERIC(20,8)` that is 0,33333333 — a different number.
 *
 * Agreement is tested before representability because until the set agrees
 * there is no single ratio whose storability could be asked about.
 */
export function corroborateRatio(derived: readonly Quantity[]): RatioCorroboration {
  const [first, ...rest] = derived;
  if (first === undefined || rest.length === 0) return { ok: false, refusal: 'no_factor' };
  if (rest.some((other) => !other.equals(first))) return { ok: false, refusal: 'disagrees' };
  if (!Quantity.fromString(asStored(first)).equals(first)) {
    return { ok: false, refusal: 'not_representable' };
  }
  return { ok: true, ratio: first };
}

/**
 * The stored `unclassified` copy of a ratio row as it enters the ledger: an
 * active `split` (Desdobro) or `grupamento` carrying B3's multiplier. Quantity,
 * price, key and ids are kept — the quantity is informational for these types
 * (`core/ledger/validate.ts`) and the engine reads only the ratio
 * (`applyShareRatioEvent`, BR-007-04: quantity × ratio, total cost unchanged).
 */
export function ratioTransaction(
  row: Transaction,
  movement: RatioMovement,
  ratio: Quantity,
): Transaction {
  const type = movement === 'desdobro' ? 'split' : 'grupamento';
  return {
    ...row,
    type,
    status: 'active',
    ratio,
    totalValue: computeTotalValue(type, row.quantity, row.unitPrice, row.fees),
  };
}

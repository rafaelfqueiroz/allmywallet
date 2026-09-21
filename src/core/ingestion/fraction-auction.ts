import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { asStored, Money, Quantity } from '@/core/shared/money';
import {
  computeTotalValue,
  type Transaction,
  type TransactionType,
} from '@/core/ledger/transaction';
import { calendarDaysBetween } from '@/core/ingestion/share-ratio';

/**
 * SPEC-005 BR-005-20b / SPEC-007 BR-007-04b, BR-007-05a (#113) — B3's
 * `Fração em Ativos` (debit, no price) and `Leilão de Fração` (credit, price
 * and value): the fractional quantity a share-base event left, removed from
 * custody and sold at auction.
 *
 * What the pair becomes depends on the **origin** — the event that left the
 * fraction (DL-007-09):
 *
 * - after a **bonificação**, the fraction is a `fracao_bonificacao` (total cost
 *   unchanged, no realised gain) and the auction a `leilao_fracoes` provento;
 * - after a **split or grupamento** — or, #143, a **conversion** whose ratio
 *   created the fraction (`conversionCreatedFraction`) — the fraction is a
 *   `sell` dated at the Fração em Ativos date and priced at the auction's unit
 *   price, and the auction is **consumed** — its stored copy `superseded`, its
 *   row `ignored` (BR-005-19 amended) — because its cash is the sale's
 *   proceeds.
 *
 * Pure (AR-01): which rows exist and what the position held come from
 * `corporate-event-resolution.ts`.
 */

/** Why a fraction or its auction stays `unclassified` (BR-005-20b). */
export type FractionRefusal =
  /** No share-base event in the window leaves exactly this fractional quantity. */
  | 'no_origin'
  /** More than one does — or one event is claimed by more than one fraction. */
  | 'ambiguous_origin'
  /** An unresolved ratio event, or a position that cannot be replayed, lies in the window: the origin cannot be decided. */
  | 'origin_unresolved'
  /** No auction (or fraction) matches on asset, institution, quantity and window. */
  | 'no_pair'
  /** More than one does, on either side. */
  | 'ambiguous_pair'
  /** The auction states no positive price, so the sale or the provento would be worth nothing. */
  | 'no_price'
  /** The partner was classified by hand (or resolved earlier) as something this origin contradicts; it is never modified. */
  | 'partner_conflict'
  /** The partner is `unclassified` in the ledger and not part of this import, so it cannot be resolved with it. */
  | 'partner_unresolved'
  /** Applied, the fraction leaves a later row of the position unreplayable (BR-006-15): commit gave it up. */
  | 'conflicts_with_ledger'
  /** The position before the fraction cannot give it up. */
  | 'no_basis'
  /**
   * #139 — the fraction was removed between a same-date grupamento and
   * desdobramento, so its sale is written at the later event's scale
   * (`scaledFractionSale`), and that quantity or price is not exact at eight
   * places.
   */
  | 'scale_not_representable';

/** The share-base types a fraction can come from (SPEC-007 BR-007-04/05). */
export type ShareBaseType = 'bonificacao' | 'split' | 'grupamento';

/**
 * What left a fraction: a share-base event, or — #143 — a BR-005-20c
 * conversion whose own ratio created it (`conversionCreatedFraction`). A
 * conversion origin reads as a split's does (BR-007-04b): the fraction carries
 * cost, so it is sold at the auction's price and the auction is consumed.
 *
 * #143 D10 — `liquidation`: the target shares a BR-005-20c liquidation
 * acquired (`acquisitionCreatedFraction`). Read the same way: bought at the
 * administrator's unit cost, the fraction carries that cost and is sold.
 */
export type OriginType = ShareBaseType | 'conversion' | 'liquidation';

export function isShareBaseType(type: TransactionType): type is ShareBaseType {
  return type === 'bonificacao' || type === 'split' || type === 'grupamento';
}

/**
 * SPEC-005 BR-005-20b (#143) — **a conversion is itself the origin of a
 * fraction its own ratio created.**
 *
 * B3 incorporated 90 BPFF11 and 70 HGFF11 into RVBI11 at 0,9321 and 1,0766:
 * 83,89 + 75,36 = 159,25, and auctioned the 0,25 off RVBI11 two weeks later.
 * Neither source held a fraction, so the #129 D1 trail through the outgoing
 * legs finds nothing (`no_origin`) — correctly, because no share-base event
 * left it. The conversion did.
 *
 * The test is exact, not inferred: **every outgoing quantity is whole** — the
 * sources brought no fraction across, so none can have come from an event
 * upstream — and **the incoming quantity is not**, so the group put a
 * fraction on the target that was not there before it. Anything else stays as
 * it was: a whole-quantity rename adds no fraction and is no candidate (a
 * target's own bonificação fraction keeps its one origin), and a fractional
 * outgoing leg with no trail — the KLBN11 whole-position shape — still
 * refuses `no_origin`, because there the fraction pre-dates the conversion.
 *
 * Worked example (DV-17): outgoing 90 and 70, whole; incoming 83,89 + 75,36 =
 * 159,25, whose fractional part is 0,25 — a conversion origin. Outgoing 180,
 * incoming 180: no. Outgoing 0,6, incoming 0,6: no.
 */
export function conversionCreatedFraction(
  outgoing: readonly Quantity[],
  incoming: readonly Quantity[],
): boolean {
  return (
    outgoing.length > 0 &&
    outgoing.every((quantity) => quantity.fractionalPart().isZero()) &&
    acquisitionCreatedFraction(incoming)
  );
}

/**
 * SPEC-005 BR-005-20b (#143 D10) — **the acquisitions of one liquidation are
 * the origin of a fraction their total left.** The half of
 * `conversionCreatedFraction` a liquidation needs.
 *
 * The outgoing test is not needed here, because nothing crosses: the sources
 * are **sold** at their liquidation value, so no fraction of theirs can reach
 * the target, and whatever the target holds fractionally right after the
 * acquisitions is the liquidation's own. The fraction must still be exactly
 * what the position holds right after all of them (`originOf`), and within the
 * same origin window.
 *
 * Worked example (DV-17): subscriptions 83,89 + 75,36 = 159,25, fractional
 * part 0,25 — an origin for a 0,25 `Fração em Ativos`. Subscriptions of 80 and
 * 79: none.
 */
export function acquisitionCreatedFraction(incoming: readonly Quantity[]): boolean {
  const received = incoming.reduce((sum, quantity) => sum.plus(quantity), Quantity.zero());
  return !received.fractionalPart().isZero();
}

/** A share-base event in a fraction's window, with the fraction it left. */
export interface OriginCandidate {
  readonly id: string;
  readonly type: OriginType;
  readonly tradeDate: BusinessDate;
  /** The quantity immediately after the event, in replay order; `null` when that prefix cannot be replayed. */
  readonly quantityAfter: Quantity | null;
  /** `quantityAfter − ⌊quantityAfter⌋`; `null` with it. */
  readonly fractionalPart: Quantity | null;
  /**
   * #129 D1 — the share-base event this candidate stands in for, when the
   * candidate is itself a `conversion_in` (`tracedConversionOrigin`). `null`
   * for an ordinary share-base event on the position, which is its own origin.
   */
  readonly tracedFrom?: TracedOrigin | null | undefined;
  /**
   * #139 — the multiplier of a **second** ratio event on the same date, where
   * this candidate is the first of a same-date pair and B3 removed the fraction
   * between the two. Replay applies both ratio events before any sale that
   * day (`ordering.ts`), so the sale is written at the second event's scale
   * (`scaledFractionSale`). Absent or `null` for every other candidate.
   */
  readonly saleScale?: Quantity | null | undefined;
}

/**
 * #129 D1 — the share-base event behind a `conversion_in`, reached through the
 * group's outgoing leg.
 */
export interface TracedOrigin {
  /** The `conversion_out` leg's id. */
  readonly conversionOutId: string;
  /** The share-base event on the **source** position. */
  readonly event: OriginCandidate;
}

/** One outgoing leg of a conversion group, with the source position's share-base events. */
export interface ConversionOutTrace {
  readonly id: string;
  /** How much the group removed from this source position. */
  readonly quantity: Quantity;
  /** Share-base events on the source position, each with the fraction it left there. */
  readonly candidates: readonly OriginCandidate[];
  /** An unresolved ratio event sits on the source position too: nothing may be traced through it. */
  readonly unresolved: boolean;
}

/**
 * BR-005-20b (#129 D1) — **a fraction on a conversion target takes its origin
 * from the group's source.**
 *
 * KLBN11's bonificação of 2025-12-19 left a fractional unit; B3 decomposed
 * that unit into its component shares (0,6 KLBN11 → 0,6 KLBN3 and 2,4 KLBN4)
 * and auctioned the fractions off the **targets**. KLBN3 and KLBN4 have no
 * share-base event of their own — their only prior row is a `conversion_in` —
 * so every candidate list was empty and both fractions refused `no_origin`.
 *
 * The trail is exact rather than inferred: the group's outgoing quantity must
 * itself be **precisely the fractional part a unique share-base event left on
 * the source position** — the same arithmetic `originOf` runs on a fraction,
 * applied one asset upstream. KLBN11 after its bonificação holds X,6; the
 * `conversion_out` is 0,6; they agree, so the origin is that bonificação and
 * the target's fraction is a `fracao_bonificacao` whose auction is a
 * `leilao_fracoes` provento (BR-007-05a) — exactly what it would have been had
 * the units never crossed assets.
 *
 * Every other shape refuses. A group with several outgoing legs traces only
 * where **all** of them reach the same origin type; a conversion of a whole
 * position (outgoing 100,6, no event leaving 100,6) traces to nothing and the
 * fraction stays `unclassified`. Guessing here would decide a fraction's tax
 * treatment — exempt income or a realised disposal — without evidence.
 */
export type TracedOriginVerdict =
  | { readonly ok: true; readonly origin: TracedOrigin }
  | {
      /**
       * `unresolved` separates *we cannot decide* from *there is no trail*. A
       * source whose outgoing quantity is no event's fraction has no trail, and
       * the fraction refuses `no_origin`; a source with two matching events, an
       * unsettled ratio event, or outgoing legs that disagree could be traced
       * but cannot be read, and the fraction must refuse `origin_unresolved`
       * instead — `no_origin` reads as "classify this by hand", which is the
       * wrong instruction when the answer is unknowable rather than absent.
       */
      readonly ok: false;
      readonly unresolved: boolean;
    };

export function tracedConversionOrigin(
  outLegs: readonly ConversionOutTrace[],
): TracedOriginVerdict {
  const traced: TracedOrigin[] = [];
  for (const leg of outLegs) {
    const verdict = originOf(leg.quantity, leg.candidates, leg.unresolved);
    if (!verdict.ok) {
      return { ok: false, unresolved: verdict.refusal !== 'no_origin' };
    }
    traced.push({ conversionOutId: leg.id, event: verdict.origin });
  }
  const [only] = traced;
  if (only === undefined) return { ok: false, unresolved: false };
  return traced.every((t) => t.event.type === only.event.type)
    ? { ok: true, origin: only }
    : { ok: false, unresolved: true };
}

export type OriginVerdict =
  | { readonly ok: true; readonly origin: OriginCandidate }
  | {
      readonly ok: false;
      readonly refusal: 'no_origin' | 'ambiguous_origin' | 'origin_unresolved';
    };

/**
 * BR-005-20b — the unique origin of a fraction of `quantity`.
 *
 * `candidates` are the share-base events on the position within the origin
 * window; `unresolvedInWindow` says whether an unresolved ratio event is too.
 * Any uncertainty refuses, even beside a unique match: the unresolved event, or
 * the prefix that could not be replayed, might be the real origin, and a
 * fraction applied against the wrong one is a sale that should have been
 * income (or the reverse).
 *
 * Worked example (DV-17): 100 shares and a bonificação of 5,2 → 105,2, whose
 * fractional part is 105,2 − 105 = **0,2** — the origin of a 0,2 Fração em
 * Ativos. A second bonificação of 1 inside the window → 106,2 leaves 0,2 as
 * well: two matches, `ambiguous_origin`.
 */
export function originOf(
  quantity: Quantity,
  candidates: readonly OriginCandidate[],
  unresolvedInWindow: boolean,
): OriginVerdict {
  if (unresolvedInWindow || candidates.some((c) => c.fractionalPart === null)) {
    return { ok: false, refusal: 'origin_unresolved' };
  }
  const matches = quantity.isPositive()
    ? // Every fractional part is known here: an unknown one refused above.
      candidates.filter((c) => (c.fractionalPart as Quantity).equals(quantity))
    : [];
  const [only, ...others] = matches;
  if (only === undefined) return { ok: false, refusal: 'no_origin' };
  if (others.length > 0) return { ok: false, refusal: 'ambiguous_origin' };
  return { ok: true, origin: only };
}

/** One side of a fraction ↔ auction pair. */
export interface FractionLeg {
  readonly id: string;
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
}

export interface FractionPairing {
  /** Fraction id → auction id, where each is the other's only match. */
  readonly pairs: ReadonlyMap<string, string>;
  /** Every auction matching each fraction. */
  readonly auctionsOf: ReadonlyMap<string, readonly string[]>;
  /** Every fraction matching each auction. */
  readonly fractionsOf: ReadonlyMap<string, readonly string[]>;
}

/**
 * BR-005-20b — which auction sold which fraction.
 *
 * A fraction and an auction match on the same asset and institution (a `null`
 * institution is its own bucket, as in `positionKeyString`) and the same
 * quantity, the auction dated **on or after** the fraction and no more than
 * `auctionDays` calendar days later. A pair forms only where the relation is
 * one-to-one on **both** sides, computed over the whole relation — the same
 * approach as `pairTransfers` (`transfer-cost.ts`) — so file order never
 * chooses a partner.
 *
 * Pass every row of both B3 types for the position, from the batch **and the
 * ledger**, resolved or not: a partner a user classified by hand still takes
 * part, so a second auction of the same fraction is seen as ambiguous rather
 * than paired with a fraction that already has one.
 *
 * Worked example (DV-17): a 0,2 fraction on 2025-12-15 and a 0,2 auction on
 * 2026-01-20 (36 days) pair. A second 0,2 auction on 2026-02-01 pairs neither
 * (`ambiguous_pair`); an auction on 2025-12-14 or 181 days later is no match.
 */
export function pairFractionAuctions(
  fractions: readonly FractionLeg[],
  auctions: readonly FractionLeg[],
  auctionDays: number,
): FractionPairing {
  const auctionsOf = new Map<string, readonly string[]>();
  const fractionsOf = new Map<string, string[]>(auctions.map((a) => [a.id, []]));
  for (const fraction of fractions) {
    const matching = auctions.filter((auction) => {
      const days = calendarDaysBetween(fraction.tradeDate, auction.tradeDate);
      return (
        auction.assetId === fraction.assetId &&
        auction.institutionId === fraction.institutionId &&
        auction.quantity.equals(fraction.quantity) &&
        days >= 0 &&
        days <= auctionDays
      );
    });
    auctionsOf.set(
      fraction.id,
      matching.map((a) => a.id),
    );
    // Every auction was seeded above, so the lookup always finds its list.
    for (const auction of matching) (fractionsOf.get(auction.id) as string[]).push(fraction.id);
  }

  const pairs = new Map<string, string>();
  for (const [fractionId, matching] of auctionsOf) {
    const [only, ...others] = matching;
    if (
      only !== undefined &&
      others.length === 0 &&
      (fractionsOf.get(only) as string[]).length === 1
    ) {
      pairs.set(fractionId, only);
    }
  }
  return { pairs, auctionsOf, fractionsOf };
}

/**
 * Why `id` has no pair: none of its candidates, or one of several (on its side
 * or its only candidate's). Meaningful only for an id `pairs` does not pair.
 */
export function pairingRefusalOf(
  candidates: readonly string[] | undefined,
): 'no_pair' | 'ambiguous_pair' {
  return candidates === undefined || candidates.length === 0 ? 'no_pair' : 'ambiguous_pair';
}

/**
 * The stored `unclassified` Fração em Ativos as it enters the ledger, given its
 * origin and paired auction.
 *
 * - Bonificação origin → `fracao_bonificacao`, price as stated (B3 gives none)
 *   and a zero `total_value` (`computeTotalValue`, #113 Decision log row 17).
 * - Split, grupamento, conversion (#143) or liquidation (#143 D10) origin →
 *   `sell` of the fraction at the auction's unit price, on the fraction's own
 *   date (Decision log row 8).
 *
 * Worked example (DV-17), BR-007-04b: 105 shares at 10,00 (cost 1.050,00);
 * grupamento ×0,1 → 10,5 shares, cost 1.050,00, average 100,00; Fração em
 * Ativos 0,5 and Leilão 0,5 @ 98,00 → `sell` 0,5 @ 98,00: proceeds 49,00, cost
 * out 0,5 × 100,00 = 50,00, **realised −1,00**; 10 shares remain at 100,00.
 */
export function fractionTransaction(
  fraction: Transaction,
  origin: OriginType,
  auction: Transaction,
): Transaction {
  if (origin === 'bonificacao') {
    return {
      ...fraction,
      type: 'fracao_bonificacao',
      status: 'active',
      ratio: null,
      totalValue: computeTotalValue(
        'fracao_bonificacao',
        fraction.quantity,
        fraction.unitPrice,
        fraction.fees,
      ),
    };
  }
  const unitPrice: Money = auction.unitPrice;
  return {
    ...fraction,
    type: 'sell',
    status: 'active',
    unitPrice,
    ratio: null,
    totalValue: computeTotalValue('sell', fraction.quantity, unitPrice, fraction.fees),
  };
}

/**
 * SPEC-005 BR-005-20b / SPEC-007 BR-007-04b (#139) — the sale of a fraction B3
 * removed **between** a same-date grupamento and desdobramento, written at the
 * second event's scale: quantity × `scale`, unit price ÷ `scale`. `null` when
 * either is not exact at `NUMERIC(20,8)` or the proceeds would move — the
 * caller refuses `scale_not_representable`.
 *
 * Why the scale and not B3's own figures: replay has dates, not times, and
 * ranks every ratio event of a date before its sales (`ordering.ts`,
 * BR-007-15). So the day's sale meets the position **after both** events. At
 * that scale the fraction is `f × m₂` shares, and every figure the engine
 * derives from it is the one the real sequence gives: the proceeds are
 * unchanged, and the cost removed is the same share of the position's cost
 * (f ÷ Q₁ = f·m₂ ÷ Q₁·m₂), so the realised gain is too.
 *
 * Worked example (DV-17), VIVT3: 150 shares, grupamento × 0,025 → 3,75;
 * Fração em Ativos 0,75 removed; desdobro × 80 → 240. Replayed, the day is
 * 150 → 3,75 → 300 and then the sale: 0,75 × 80 = **60** shares at
 * 2.131,357 ÷ 80 = **26,6419625**, proceeds 60 × 26,6419625 = 1.598,51775 =
 * 0,75 × 2.131,357; 300 − 60 = **240**, B3's count. The cost removed is
 * 60 ÷ 300 = 0,75 ÷ 3,75 = 20 % of it, as in the real sequence.
 */
export function scaledFractionSale(
  fraction: Transaction,
  auction: Transaction,
  scale: Quantity,
): Transaction | null {
  const quantity = fraction.quantity.times(scale);
  const unitPrice = auction.unitPrice.dividedBy(scale);
  if (!Quantity.fromString(asStored(quantity)).equals(quantity)) return null;
  if (!Money.fromString(asStored(unitPrice)).equals(unitPrice)) return null;
  const proceeds = auction.unitPrice.times(fraction.quantity);
  if (!unitPrice.times(quantity).equals(proceeds)) return null;
  return {
    ...fraction,
    type: 'sell',
    status: 'active',
    quantity,
    unitPrice,
    ratio: null,
    totalValue: computeTotalValue('sell', quantity, unitPrice, fraction.fees),
  };
}

/**
 * The stored `unclassified` Leilão de Fração, given its fraction's origin:
 * a `leilao_fracoes` provento after a bonificação (SPEC-014 BR-014-01) —
 * worked example: 0,2 @ 12,50 → total 2,50 — or, after a split or grupamento,
 * **consumed**: `superseded`, its cash already the fraction sale's proceeds.
 */
export function auctionTransaction(
  auction: Transaction,
  origin: OriginType,
): { readonly status: 'resolved' | 'consumed'; readonly transaction: Transaction } {
  if (origin !== 'bonificacao') {
    return { status: 'consumed', transaction: { ...auction, status: 'superseded' } };
  }
  return {
    status: 'resolved',
    transaction: {
      ...auction,
      type: 'leilao_fracoes',
      status: 'active',
      ratio: null,
      totalValue: computeTotalValue(
        'leilao_fracoes',
        auction.quantity,
        auction.unitPrice,
        auction.fees,
      ),
    },
  };
}

/**
 * A partner this resolution may not modify (classified by hand, or resolved by
 * an earlier import) agrees with the origin when it already is what the
 * origin would make it: a fraction `fracao_bonificacao` (bonificação) or `sell`
 * (split/grupamento), active; an auction `leilao_fracoes`, active
 * (bonificação), or `superseded` (split/grupamento — consumed). Anything else
 * would count the fraction's cash or quantity twice, so the open side is
 * refused `partner_conflict`.
 */
export function partnerAgrees(
  partner: Transaction,
  role: 'fraction' | 'auction',
  origin: OriginType,
): boolean {
  const bonus = origin === 'bonificacao';
  if (role === 'fraction') {
    return partner.status === 'active' && partner.type === (bonus ? 'fracao_bonificacao' : 'sell');
  }
  return bonus
    ? partner.status === 'active' && partner.type === 'leilao_fracoes'
    : partner.status === 'superseded';
}

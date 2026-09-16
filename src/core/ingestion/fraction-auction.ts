import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
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
 * - after a **split or grupamento**, the fraction is a `sell` dated at the
 *   Fração em Ativos date and priced at the auction's unit price, and the
 *   auction is **consumed** — its stored copy `superseded`, its row `ignored`
 *   (BR-005-19 amended) — because its cash is the sale's proceeds.
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
  /** The position before the fraction cannot give it up. */
  | 'no_basis';

/** The share-base types a fraction can come from (SPEC-007 BR-007-04/05). */
export type OriginType = 'bonificacao' | 'split' | 'grupamento';

export function isShareBaseType(type: TransactionType): type is OriginType {
  return type === 'bonificacao' || type === 'split' || type === 'grupamento';
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
 * - Split or grupamento origin → `sell` of the fraction at the auction's unit
 *   price, on the fraction's own date (Decision log row 8).
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

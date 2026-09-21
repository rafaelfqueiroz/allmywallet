import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
} from '@/core/ledger/test-support/transaction-builder';
import {
  acquisitionCreatedFraction,
  auctionTransaction,
  conversionCreatedFraction,
  type FractionLeg,
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

const q = (value: string) => Quantity.fromString(value);

describe('#113 BR-005-20b — isShareBaseType', () => {
  it('is a bonificação, split or grupamento', () => {
    expect(['bonificacao', 'split', 'grupamento'].every((t) => isShareBaseType(t as never))).toBe(
      true,
    );
    expect(isShareBaseType('buy')).toBe(false);
    expect(isShareBaseType('fracao_bonificacao')).toBe(false);
  });
});

describe('#129 BR-005-20b — tracedConversionOrigin', () => {
  function event(id: string, type: OriginCandidate['type'], after: string): OriginCandidate {
    return {
      id,
      type,
      tradeDate: BusinessDate.of('2025-12-19'),
      quantityAfter: q(after),
      fractionalPart: q(after).fractionalPart(),
    };
  }

  it("is the source's share-base event when the outgoing quantity is exactly the fraction it left", () => {
    // KLBN11 holds 106,6 after its bonificação, leaving 0,6 — precisely the
    // quantity the group moved out. The trail is exact, not inferred.
    const bonus = event('bonus', 'bonificacao', '106.6');
    expect(
      tracedConversionOrigin([
        { id: 'out', quantity: q('0.6'), candidates: [bonus], unresolved: false },
      ]),
    ).toEqual({ ok: true, origin: { conversionOutId: 'out', event: bonus } });
  });

  it('traces nothing when the outgoing quantity is not a fraction any event left', () => {
    // A whole position converted: 100,6 out, and no event leaves 100,6. There
    // is no trail rather than an unreadable one, so the fraction goes on to
    // refuse `no_origin` and not `origin_unresolved`.
    expect(
      tracedConversionOrigin([
        {
          id: 'out',
          quantity: q('100.6'),
          candidates: [event('bonus', 'bonificacao', '106.6')],
          unresolved: false,
        },
      ]),
    ).toEqual({ ok: false, unresolved: false });
  });

  it('reports an unreadable trail separately from an absent one', () => {
    // An unsettled ratio event on the source: traceable in principle, not
    // readable now, so the fraction must wait rather than be classified.
    expect(
      tracedConversionOrigin([
        {
          id: 'out',
          quantity: q('0.6'),
          candidates: [event('bonus', 'bonificacao', '106.6')],
          unresolved: true,
        },
      ]),
    ).toEqual({ ok: false, unresolved: true });
    // Two source events leaving the same fraction: also undecidable.
    expect(
      tracedConversionOrigin([
        {
          id: 'out',
          quantity: q('0.6'),
          candidates: [event('a', 'bonificacao', '106.6'), event('b', 'bonificacao', '40.6')],
          unresolved: false,
        },
      ]),
    ).toEqual({ ok: false, unresolved: true });
    // No conversion at all on the position: nothing to trace, nothing unknown.
    expect(tracedConversionOrigin([])).toEqual({ ok: false, unresolved: false });
  });

  it('traces only where every outgoing leg reaches the same origin type', () => {
    const legs = (secondType: OriginCandidate['type']) => [
      {
        id: 'out-a',
        quantity: q('0.6'),
        candidates: [event('a', 'bonificacao', '106.6')],
        unresolved: false,
      },
      {
        id: 'out-b',
        quantity: q('0.25'),
        candidates: [event('b', secondType, '40.25')],
        unresolved: false,
      },
    ];
    const agreed = tracedConversionOrigin(legs('bonificacao'));
    expect(agreed.ok && agreed.origin.conversionOutId).toBe('out-a');
    // One bonificação and one grupamento: exempt income or a realised
    // disposal, and nothing says which. Undecidable, not absent.
    expect(tracedConversionOrigin(legs('grupamento'))).toEqual({ ok: false, unresolved: true });
  });
});

describe('#143 BR-005-20b — conversionCreatedFraction', () => {
  it('is the conversion when whole sources arrive as a fractional target', () => {
    // 90 and 70 whole out; 83,89 + 75,36 = 159,25 in, fractional part 0,25.
    expect(conversionCreatedFraction([q('90'), q('70')], [q('83.89'), q('75.36')])).toBe(true);
  });

  it('is not the conversion when the target receives a whole quantity', () => {
    // A rename: 180 out, 180 in. And two fractional credits summing whole:
    // 0,6 + 0,4 = 1.
    expect(conversionCreatedFraction([q('180')], [q('180')])).toBe(false);
    expect(conversionCreatedFraction([q('1')], [q('0.6'), q('0.4')])).toBe(false);
  });

  it('is not the conversion when a source brought a fraction across', () => {
    // KLBN11's 0,6 out → 0,6 in: the fraction pre-dates the group.
    expect(conversionCreatedFraction([q('0.6')], [q('0.6')])).toBe(false);
    expect(conversionCreatedFraction([q('90'), q('0.5')], [q('90.5')])).toBe(false);
  });

  it('is never the conversion without an outgoing leg to read', () => {
    expect(conversionCreatedFraction([], [q('159.25')])).toBe(false);
  });
});

describe('#143 D10 BR-005-20b — acquisitionCreatedFraction', () => {
  it('is the liquidation when its acquisitions total a fractional quantity', () => {
    // 83,89 + 75,36 = 159,25, fractional part 0,25.
    expect(acquisitionCreatedFraction([q('83.89'), q('75.36')])).toBe(true);
    expect(acquisitionCreatedFraction([q('0.5')])).toBe(true);
  });

  it('is not when they total a whole quantity, or there are none', () => {
    // 0,6 + 0,4 = 1; 80 + 79 = 159.
    expect(acquisitionCreatedFraction([q('0.6'), q('0.4')])).toBe(false);
    expect(acquisitionCreatedFraction([q('80'), q('79')])).toBe(false);
    expect(acquisitionCreatedFraction([])).toBe(false);
  });
});

describe('#113 BR-005-20b — originOf', () => {
  function candidate(id: string, after: string | null): OriginCandidate {
    return {
      id,
      type: 'bonificacao',
      tradeDate: BusinessDate.of('2025-12-10'),
      quantityAfter: after === null ? null : q(after),
      fractionalPart: after === null ? null : q(after).fractionalPart(),
    };
  }

  it('is the one event whose resulting fractional part equals the fraction', () => {
    // 100 + 5,2 = 105,2 → 0,2; the other event left 110 → 0.
    const bonus = candidate('bonus', '105.2');
    expect(originOf(q('0.2'), [candidate('whole', '110'), bonus], false)).toEqual({
      ok: true,
      origin: bonus,
    });
  });

  it('is ambiguous when two events leave the same fraction', () => {
    // 105,2 → 0,2 and 106,2 → 0,2.
    expect(originOf(q('0.2'), [candidate('a', '105.2'), candidate('b', '106.2')], false)).toEqual({
      ok: false,
      refusal: 'ambiguous_origin',
    });
  });

  it('has no origin when no fractional part matches, or the fraction is not positive', () => {
    expect(originOf(q('0.3'), [candidate('a', '105.2')], false)).toEqual({
      ok: false,
      refusal: 'no_origin',
    });
    // 110 → 0: a zero "fraction" would match every whole result.
    expect(originOf(q('0'), [candidate('a', '110')], false)).toEqual({
      ok: false,
      refusal: 'no_origin',
    });
    expect(originOf(q('0.2'), [], false)).toEqual({ ok: false, refusal: 'no_origin' });
  });

  it('is unresolved beside an unresolved ratio event or an unreplayable prefix, even with a match', () => {
    expect(originOf(q('0.2'), [candidate('a', '105.2')], true)).toEqual({
      ok: false,
      refusal: 'origin_unresolved',
    });
    expect(originOf(q('0.2'), [candidate('a', '105.2'), candidate('b', null)], false)).toEqual({
      ok: false,
      refusal: 'origin_unresolved',
    });
  });
});

describe('#113 BR-005-20b — pairFractionAuctions', () => {
  const asset = assetIdFor('ITSA4');
  const xp = institutionIdFor('XP');

  function leg(id: string, date: string, overrides: Partial<FractionLeg> = {}): FractionLeg {
    return {
      id,
      assetId: asset,
      institutionId: xp,
      tradeDate: BusinessDate.of(date),
      quantity: q('0.2'),
      ...overrides,
    };
  }

  it('pairs a fraction with the one auction on or after it, within the window', () => {
    // 2025-12-15 → 2026-01-20: 16 + 20 = 36 days.
    const pairing = pairFractionAuctions([leg('f', '2025-12-15')], [leg('a', '2026-01-20')], 180);
    expect([...pairing.pairs]).toEqual([['f', 'a']]);
    expect(pairing.auctionsOf.get('f')).toEqual(['a']);
    expect(pairing.fractionsOf.get('a')).toEqual(['f']);
  });

  it('pairs a same-day auction, and one exactly at the window’s end but not a day later', () => {
    expect(
      pairFractionAuctions([leg('f', '2025-12-15')], [leg('a', '2025-12-15')], 180).pairs.size,
    ).toBe(1);
    // 2026-01-01 + 180 days = 2026-06-30 (31 + 28 + 31 + 30 + 31 + 29 = 180).
    expect(
      pairFractionAuctions([leg('f', '2026-01-01')], [leg('a', '2026-06-30')], 180).pairs.size,
    ).toBe(1);
    expect(
      pairFractionAuctions([leg('f', '2026-01-01')], [leg('a', '2026-07-01')], 180).pairs.size,
    ).toBe(0);
  });

  it('does not pair an auction before the fraction', () => {
    const pairing = pairFractionAuctions([leg('f', '2025-12-15')], [leg('a', '2025-12-14')], 180);
    expect(pairing.pairs.size).toBe(0);
    expect(pairing.auctionsOf.get('f')).toEqual([]);
    expect(pairing.fractionsOf.get('a')).toEqual([]);
  });

  it('does not pair across asset, institution or quantity; a null institution pairs only with null', () => {
    const f = leg('f', '2025-12-15');
    const auctions = [
      leg('other-asset', '2025-12-20', { assetId: assetIdFor('KLBN4') }),
      leg('other-broker', '2025-12-20', { institutionId: institutionIdFor('Rico') }),
      leg('no-broker', '2025-12-20', { institutionId: null }),
      leg('other-quantity', '2025-12-20', { quantity: q('0.20000001') }),
    ];
    expect(pairFractionAuctions([f], auctions, 180).pairs.size).toBe(0);
    expect([
      ...pairFractionAuctions(
        [leg('f', '2025-12-15', { institutionId: null })],
        [leg('a', '2025-12-20', { institutionId: null })],
        180,
      ).pairs,
    ]).toEqual([['f', 'a']]);
  });

  it('pairs nothing with two auctions for one fraction, or two fractions for one auction, in any order', () => {
    const f = leg('f', '2025-12-15');
    const a1 = leg('a1', '2026-01-20');
    const a2 = leg('a2', '2026-02-01');
    expect(pairFractionAuctions([f], [a1, a2], 180).pairs.size).toBe(0);
    expect(pairFractionAuctions([f], [a2, a1], 180).pairs.size).toBe(0);
    const f2 = leg('f2', '2025-12-16');
    const two = pairFractionAuctions([f, f2], [a1], 180);
    expect(two.pairs.size).toBe(0);
    expect(two.fractionsOf.get('a1')).toEqual(['f', 'f2']);
  });
});

describe('#113 BR-005-20b — pairingRefusalOf', () => {
  it('is no_pair without candidates and ambiguous_pair with any', () => {
    expect(pairingRefusalOf(undefined)).toBe('no_pair');
    expect(pairingRefusalOf([])).toBe('no_pair');
    // One candidate that is not a pair: that candidate has another match.
    expect(pairingRefusalOf(['a'])).toBe('ambiguous_pair');
    expect(pairingRefusalOf(['a', 'b'])).toBe('ambiguous_pair');
  });
});

describe('#113 BR-007-04b / BR-007-05a — what the pair becomes', () => {
  const fraction = aTransaction()
    .rendimento()
    .status('unclassified')
    .of('ITSA4')
    .on('2025-12-15')
    .quantity('0.2')
    .price('0')
    .imported()
    .build();
  const auction = aTransaction()
    .rendimento()
    .status('unclassified')
    .of('ITSA4')
    .on('2026-01-20')
    .quantity('0.2')
    .price('12.50')
    .imported()
    .build();

  it('after a bonificação: fracao_bonificacao at zero total, and a leilao_fracoes provento of 2,50', () => {
    const removal = fractionTransaction(fraction, 'bonificacao', auction);
    expect(removal).toMatchObject({
      id: fraction.id,
      naturalKey: fraction.naturalKey,
      type: 'fracao_bonificacao',
      status: 'active',
      ratio: null,
    });
    // Decision log row 17: no cash on the removal.
    expect(removal.totalValue.isZero()).toBe(true);
    expect(removal.tradeDate).toBe('2025-12-15');

    const income = auctionTransaction(auction, 'bonificacao');
    expect(income.status).toBe('resolved');
    expect(income.transaction).toMatchObject({ type: 'leilao_fracoes', status: 'active' });
    // 0,2 × 12,50 = 2,50.
    expect(income.transaction.totalValue.toString()).toBe('2.5');
  });

  it('after a split or grupamento: a sell at the auction price on the fraction’s date, the auction consumed', () => {
    // #143: a conversion that created the fraction reads the same way.
    for (const origin of ['split', 'grupamento', 'conversion'] as const) {
      const sale = fractionTransaction(fraction, origin, auction);
      expect(sale).toMatchObject({ type: 'sell', status: 'active', ratio: null });
      expect(sale.tradeDate).toBe('2025-12-15');
      expect(sale.unitPrice.toString()).toBe('12.5');
      // 0,2 × 12,50 − 0 fees = 2,50.
      expect(sale.totalValue.toString()).toBe('2.5');

      const consumed = auctionTransaction(auction, origin);
      expect(consumed.status).toBe('consumed');
      expect(consumed.transaction).toMatchObject({
        id: auction.id,
        status: 'superseded',
        type: auction.type,
      });
    }
  });

  it('accepts a settled partner only when it already is what the origin makes it', () => {
    const as = (
      type: 'fracao_bonificacao' | 'sell' | 'leilao_fracoes' | 'dividend',
      status: 'active' | 'superseded' = 'active',
    ) => ({
      ...fraction,
      type,
      status,
    });
    expect(partnerAgrees(as('fracao_bonificacao'), 'fraction', 'bonificacao')).toBe(true);
    expect(partnerAgrees(as('sell'), 'fraction', 'bonificacao')).toBe(false);
    expect(partnerAgrees(as('sell'), 'fraction', 'grupamento')).toBe(true);
    expect(partnerAgrees(as('sell', 'superseded'), 'fraction', 'split')).toBe(false);
    expect(partnerAgrees(as('leilao_fracoes'), 'auction', 'bonificacao')).toBe(true);
    expect(partnerAgrees(as('leilao_fracoes', 'superseded'), 'auction', 'bonificacao')).toBe(false);
    expect(partnerAgrees(as('dividend'), 'auction', 'bonificacao')).toBe(false);
    expect(partnerAgrees(as('leilao_fracoes', 'superseded'), 'auction', 'split')).toBe(true);
    expect(partnerAgrees(as('leilao_fracoes'), 'auction', 'split')).toBe(false);
    // #143: a conversion origin agrees with what a split does.
    expect(partnerAgrees(as('sell'), 'fraction', 'conversion')).toBe(true);
    expect(partnerAgrees(as('leilao_fracoes', 'superseded'), 'auction', 'conversion')).toBe(true);
    expect(partnerAgrees(as('leilao_fracoes'), 'auction', 'conversion')).toBe(false);
  });
});

describe('#139 BR-007-04b — scaledFractionSale', () => {
  const fraction = aTransaction()
    .rendimento()
    .status('unclassified')
    .of('VIVT3')
    .on('2025-04-16')
    .quantity('0.75')
    .price('0')
    .imported()
    .build();
  const auction = aTransaction()
    .rendimento()
    .status('unclassified')
    .of('VIVT3')
    .on('2025-05-28')
    .quantity('0.75')
    .price('2131.357')
    .imported()
    .build();

  it('sells 0,75 at ×80 as 60 @ 26,6419625 — proceeds 1.598,51775 either way — key and date kept', () => {
    const sale = scaledFractionSale(fraction, auction, Quantity.fromString('80'));
    expect(sale).toMatchObject({
      id: fraction.id,
      naturalKey: fraction.naturalKey,
      type: 'sell',
      status: 'active',
      ratio: null,
    });
    expect(sale?.tradeDate).toBe('2025-04-16');
    expect(sale?.quantity.toString()).toBe('60');
    expect(sale?.unitPrice.toString()).toBe('26.6419625');
    expect(sale?.totalValue.toString()).toBe('1598.51775');
  });

  it('is null where the scaled price is not exact at eight places: 2.131,357 ÷ 3', () => {
    expect(scaledFractionSale(fraction, auction, Quantity.fromString('3'))).toBeNull();
  });

  it('is null where the scaled quantity is not exact at eight places', () => {
    // 0,75 × 0,000000001 = 0,00000000075 — past the column's scale.
    expect(scaledFractionSale(fraction, auction, Quantity.fromString('0.000000001'))).toBeNull();
  });
});

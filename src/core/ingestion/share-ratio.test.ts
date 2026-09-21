import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { asStored, Quantity } from '@/core/shared/money';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';
import {
  type CorporateEventFactor,
  type CorporateEventFactorKind,
  factorMultiplier,
} from '@/core/quotes/corporate-event-factors';
import {
  calendarDaysBetween,
  corroborateRatio,
  corroborationCandidate,
  derivedRatioOf,
  evaluateRatioPair,
  evaluateShareRatio,
  factorsInWindow,
  ratioTransaction,
  sequenceRatioPair,
} from '@/core/ingestion/share-ratio';

const q = (value: string) => Quantity.fromString(value);

function factor(
  kind: CorporateEventFactorKind,
  published: string,
  lastDatePrior: string,
  issuerCode = 'MGLU',
): CorporateEventFactor {
  return {
    issuerCode,
    kind,
    factorPublished: published,
    multiplier: factorMultiplier(kind, published),
    lastDatePrior: BusinessDate.of(lastDatePrior),
    approvedOn: null,
  };
}

describe('#113 BR-005-20b — calendarDaysBetween', () => {
  it('counts calendar days, signed', () => {
    // 24 → 28 May: 4 days; the other way, −4.
    expect(calendarDaysBetween(BusinessDate.of('2024-05-24'), BusinessDate.of('2024-05-28'))).toBe(
      4,
    );
    expect(calendarDaysBetween(BusinessDate.of('2024-05-28'), BusinessDate.of('2024-05-24'))).toBe(
      -4,
    );
    // 2024 is a leap year: 28 Feb → 29 Feb → 1 Mar is 2 days.
    expect(calendarDaysBetween(BusinessDate.of('2024-02-28'), BusinessDate.of('2024-03-01'))).toBe(
      2,
    );
  });
});

describe('#113 BR-005-20b — factorsInWindow', () => {
  const row = BusinessDate.of('2024-05-28');

  it('keeps factors of the event kind dated on or up to the window before the row, oldest first', () => {
    const sevenBefore = factor('grupamento', '0.1', '2024-05-21'); // 28 − 21 = 7: the boundary is in
    const sameDay = factor('grupamento', '0.5', '2024-05-28'); // 0 days
    expect(factorsInWindow([sameDay, sevenBefore], 'grupamento', row, 7)).toEqual([
      sevenBefore,
      sameDay,
    ]);
  });

  it('leaves out a factor 8 days before with a 7-day window, one dated after the row, and another kind', () => {
    const eightBefore = factor('grupamento', '0.1', '2024-05-20'); // 28 − 20 = 8 > 7
    const after = factor('grupamento', '0.1', '2024-05-29'); // −1
    const desdobramento = factor('desdobramento', '100', '2024-05-27');
    expect(factorsInWindow([eightBefore, after, desdobramento], 'grupamento', row, 7)).toEqual([]);
    // Desdobro ↔ desdobramento.
    expect(factorsInWindow([eightBefore, after, desdobramento], 'desdobro', row, 7)).toEqual([
      desdobramento,
    ]);
  });

  it('orders two factors on one date stably', () => {
    const a = factor('grupamento', '0.1', '2024-05-24');
    const b = factor('grupamento', '0.5', '2024-05-24');
    expect(factorsInWindow([a, b], 'grupamento', row, 7)).toEqual([a, b]);
  });
});

describe('#113 BR-007-04a — derivedRatioOf', () => {
  it('is (P + Δ) ÷ P for a desdobro and R ÷ P for a grupamento', () => {
    // 70 + 630 = 700; 700 ÷ 70 = 10.
    expect(derivedRatioOf('desdobro', q('70'), q('630')).toString()).toBe('10');
    // 40 ÷ 80 = 0,5.
    expect(derivedRatioOf('grupamento', q('80'), q('40')).toString()).toBe('0.5');
  });
});

describe('#113 BR-007-04a — evaluateShareRatio', () => {
  const base = {
    issuerCode: 'MGLU',
    tradeDate: BusinessDate.of('2024-05-28'),
    factorDays: 7,
    structural: null,
  } as const;

  it('applies a desdobro whose P × (m − 1) equals Δ: P = 70, Δ = 630, factor 900 → ratio 10', () => {
    // m = 1 + 900 ÷ 100 = 10; 70 × (10 − 1) = 630 = Δ.
    const verdict = evaluateShareRatio({
      ...base,
      movement: 'desdobro',
      basis: q('70'),
      stated: q('630'),
      issuerFactors: [factor('desdobramento', '900', '2024-05-24')],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.ratio.toString()).toBe('10');
    // Derived (70 + 630) ÷ 70 = 10, the same figure.
    expect(verdict.evidence.derivedRatio?.toString()).toBe('10');
    expect(verdict.evidence.basis?.toString()).toBe('70');
    expect(verdict.evidence.stated.toString()).toBe('630');
  });

  it('applies P = 80, Δ = 80 with factor 100 → ratio 2', () => {
    // m = 1 + 100 ÷ 100 = 2; 80 × (2 − 1) = 80 = Δ.
    const verdict = evaluateShareRatio({
      ...base,
      movement: 'desdobro',
      basis: q('80'),
      stated: q('80'),
      issuerFactors: [factor('desdobramento', '100', '2024-05-24')],
    });
    expect(verdict.ok && verdict.ratio.toString()).toBe('2');
  });

  it('applies a grupamento whose P × m equals R: P = 220, R = 110, factor 0.5 → ratio 0,5', () => {
    // 220 × 0,5 = 110 = R.
    const verdict = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: q('220'),
      stated: q('110'),
      issuerFactors: [factor('grupamento', '0.5', '2024-05-24')],
    });
    expect(verdict.ok && verdict.ratio.toString()).toBe('0.5');
  });

  it('refuses P = 80, R = 40 against factor 0.1 as disagrees, showing derived 0,5', () => {
    // 80 × 0,1 = 8 ≠ 40; derived 40 ÷ 80 = 0,5.
    const published = factor('grupamento', '0.1', '2024-05-24');
    const verdict = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: q('80'),
      stated: q('40'),
      issuerFactors: [published],
    });
    expect(verdict).toMatchObject({ ok: false, refusal: 'disagrees' });
    expect(verdict.evidence.derivedRatio?.toString()).toBe('0.5');
    expect(verdict.evidence.factors).toEqual([published]);
  });

  it('refuses a desdobro that disagrees', () => {
    // m = 2; 80 × (2 − 1) = 80 ≠ 240.
    const verdict = evaluateShareRatio({
      ...base,
      movement: 'desdobro',
      basis: q('80'),
      stated: q('240'),
      issuerFactors: [factor('desdobramento', '100', '2024-05-24')],
    });
    expect(verdict).toMatchObject({ ok: false, refusal: 'disagrees' });
  });

  it('refuses a 3:1 grupamento published past eight places as not_representable', () => {
    // m = 0,333333333333; stored at NUMERIC(20,8) it would be 0,33333333 ≠ m.
    // P = 300, R = 100: derived 100 ÷ 300 = 0,333… — 0,33333333 at eight places.
    const verdict = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: q('300'),
      stated: q('100'),
      issuerFactors: [factor('grupamento', '0.333333333333', '2024-05-24')],
    });
    expect(verdict).toMatchObject({ ok: false, refusal: 'not_representable' });
    expect(asStored(verdict.evidence.derivedRatio as Quantity)).toBe('0.33333333');
  });

  it('refuses with no factor, and with two in the window', () => {
    const noFactor = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: q('80'),
      stated: q('8'),
      issuerFactors: [],
    });
    expect(noFactor).toMatchObject({ ok: false, refusal: 'no_factor' });
    // Two grupamentos, 4 and 2 days before the row: which one this row is cannot be told.
    const ambiguous = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: q('80'),
      stated: q('8'),
      issuerFactors: [
        factor('grupamento', '0.1', '2024-05-24'),
        factor('grupamento', '0.1', '2024-05-26'),
      ],
    });
    expect(ambiguous).toMatchObject({ ok: false, refusal: 'ambiguous_factor' });
    expect(ambiguous.evidence.factors).toHaveLength(2);
  });

  it('refuses no issuer as no_factor, even with factors supplied', () => {
    const verdict = evaluateShareRatio({
      ...base,
      issuerCode: null,
      movement: 'grupamento',
      basis: q('80'),
      stated: q('8'),
      issuerFactors: [factor('grupamento', '0.1', '2024-05-24')],
    });
    expect(verdict).toMatchObject({ ok: false, refusal: 'no_factor' });
    expect(verdict.evidence.factors).toEqual([]);
  });

  it('refuses no basis — P unreplayable, or P = 0 — with no derived ratio', () => {
    const issuerFactors = [factor('grupamento', '0.1', '2024-05-24')];
    const unreplayable = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: null,
      stated: q('8'),
      issuerFactors,
    });
    expect(unreplayable).toMatchObject({ ok: false, refusal: 'no_basis' });
    expect(unreplayable.evidence.derivedRatio).toBeNull();
    const empty = evaluateShareRatio({
      ...base,
      movement: 'grupamento',
      basis: q('0'),
      stated: q('8'),
      issuerFactors,
    });
    expect(empty).toMatchObject({ ok: false, refusal: 'no_basis' });
    expect(empty.evidence.basis?.toString()).toBe('0');
    expect(empty.evidence.derivedRatio).toBeNull();
  });

  it('refuses a structural refusal first, still showing the figures', () => {
    // An agreeing row (80 × 0,1 = 8) is still refused when the walk says so.
    for (const structural of ['combined_same_day', 'blocked'] as const) {
      const verdict = evaluateShareRatio({
        ...base,
        structural,
        movement: 'grupamento',
        basis: q('80'),
        stated: q('8'),
        issuerFactors: [factor('grupamento', '0.1', '2024-05-24')],
      });
      expect(verdict).toMatchObject({ ok: false, refusal: structural });
      expect(verdict.evidence.derivedRatio?.toString()).toBe('0.1');
    }
  });
});

describe('#120 BR-005-20b — corroborationCandidate', () => {
  it('accepts a no_factor refusal for an issuer with no factor of any kind, returning the derivation', () => {
    // The FII shape: P = 16, Δ = 112 → (16 + 112) ÷ 16 = 128 ÷ 16 = 8.
    const derivedRatio = derivedRatioOf('desdobro', q('16'), q('112'));
    expect(derivedRatio.toString()).toBe('8');
    expect(
      corroborationCandidate({ refusal: 'no_factor', issuerFactors: [], derivedRatio })?.toString(),
    ).toBe('8');
  });

  it('refuses an issuer B3 publishes for, even when nothing is near the row', () => {
    // The guard: a 2014 desdobramento is outside any window the row could use,
    // but its existence means B3 does publish for this issuer — so the row
    // keeps refusing `no_factor` and no set of positions may override that.
    const stale = factor('desdobramento', '700', '2014-05-02');
    expect(
      corroborationCandidate({
        refusal: 'no_factor',
        issuerFactors: [stale],
        derivedRatio: q('8'),
      }),
    ).toBeNull();
  });

  it('refuses every other refusal, which names something corroboration cannot answer', () => {
    for (const refusal of [
      'no_basis',
      'ambiguous_factor',
      'disagrees',
      'not_representable',
      'combined_same_day',
      'blocked',
      'conflicts_with_ledger',
    ] as const) {
      expect(
        corroborationCandidate({ refusal, issuerFactors: [], derivedRatio: q('8') }),
      ).toBeNull();
    }
  });
});

describe('#120 BR-005-20b — corroborateRatio', () => {
  it('confirms two positions that derive the same exactly storable ratio', () => {
    // (16 + 112) ÷ 16 = 128 ÷ 16 = 8; (49 + 343) ÷ 49 = 392 ÷ 49 = 8.
    const first = derivedRatioOf('desdobro', q('16'), q('112'));
    const second = derivedRatioOf('desdobro', q('49'), q('343'));
    expect([first.toString(), second.toString()]).toEqual(['8', '8']);
    const verdict = corroborateRatio([first, second]);
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.ok && verdict.ratio.toString()).toBe('8');
  });

  it('confirms a grupamento the same way: 22 ÷ 220 and 50 ÷ 500 are both 0,1', () => {
    const verdict = corroborateRatio([
      derivedRatioOf('grupamento', q('220'), q('22')),
      derivedRatioOf('grupamento', q('500'), q('50')),
    ]);
    expect(verdict.ok && verdict.ratio.toString()).toBe('0.1');
  });

  it('refuses one derivation, and none at all, as no_factor: a position never confirms itself', () => {
    expect(corroborateRatio([q('8')])).toEqual({ ok: false, refusal: 'no_factor' });
    expect(corroborateRatio([])).toEqual({ ok: false, refusal: 'no_factor' });
  });

  it('refuses the whole set on any disagreement, never a majority', () => {
    // (16 + 112) ÷ 16 = 8, (56 + 336) ÷ 56 = 392 ÷ 56 = 7: one of the two
    // bases is wrong and nothing says which, so two 8s do not outvote the 7.
    const eight = derivedRatioOf('desdobro', q('16'), q('112'));
    const seven = derivedRatioOf('desdobro', q('56'), q('336'));
    expect(seven.toString()).toBe('7');
    expect(corroborateRatio([eight, seven])).toEqual({ ok: false, refusal: 'disagrees' });
    expect(corroborateRatio([eight, eight, seven])).toEqual({ ok: false, refusal: 'disagrees' });
  });

  it('refuses an agreed ratio the ledger cannot hold exactly as not_representable', () => {
    // 100 ÷ 300 and 200 ÷ 600 are the same repeating 0,333…; stored at
    // NUMERIC(20,8) that is 0,33333333, which is a different number.
    const first = derivedRatioOf('grupamento', q('300'), q('100'));
    const second = derivedRatioOf('grupamento', q('600'), q('200'));
    expect(first.equals(second)).toBe(true);
    expect(asStored(first)).toBe('0.33333333');
    expect(corroborateRatio([first, second])).toEqual({
      ok: false,
      refusal: 'not_representable',
    });
  });
});

describe('#113 BR-007-04 — ratioTransaction', () => {
  it('activates a Desdobro as a split and a Grupamento as a grupamento, carrying B3’s multiplier', () => {
    const stored = aTransaction()
      .rendimento()
      .status('unclassified')
      .of('MGLU3')
      .quantity('630')
      .price('0')
      .imported()
      .build();
    const split = ratioTransaction(stored, 'desdobro', q('10'));
    expect(split).toMatchObject({
      id: stored.id,
      naturalKey: stored.naturalKey,
      type: 'split',
      status: 'active',
    });
    expect(split.ratio?.toString()).toBe('10');
    // 630 × 0 = 0: no cash moves.
    expect(split.totalValue.isZero()).toBe(true);
    expect(ratioTransaction(stored, 'grupamento', q('0.1')).type).toBe('grupamento');
  });
});

describe('#139 BR-005-20b — sequenceRatioPair', () => {
  const desdobro = (stated: string) => ({ movement: 'desdobro' as const, stated: q(stated) });
  const grupamento = (stated: string) => ({ movement: 'grupamento' as const, stated: q(stated) });

  it('finds grupamento, fraction removed, desdobro for VIVT3: 150 → 3,75 → 3 → 240', () => {
    // 150 × 0,025 = 3,75 = R; on 3 (0,75 removed) 3 × 79 = 237 = Δ.
    const sequences = sequenceRatioPair(
      q('150'),
      [desdobro('237'), grupamento('3.75')],
      [q('80'), q('0.025')],
    );
    expect(sequences).toHaveLength(1);
    const [only] = sequences;
    expect(only).toMatchObject({ first: 1, second: 0 });
    expect(only?.afterFirst.toString()).toBe('3.75');
    expect(only?.intermediateFraction.toString()).toBe('0.75');
    expect(only?.secondBasis.toString()).toBe('3');
    expect(only?.afterSecond.toString()).toBe('240');
  });

  it('finds desdobro then grupamento with nothing removed between: 100 → 200 → 2,5', () => {
    const [only, ...others] = sequenceRatioPair(
      q('100'),
      [desdobro('100'), grupamento('2.5')],
      [q('2'), q('0.0125')],
    );
    expect(others).toHaveLength(0);
    expect(only).toMatchObject({ first: 0, second: 1 });
    expect(only?.intermediateFraction.isZero()).toBe(true);
    expect(only?.afterSecond.toString()).toBe('2.5');
  });

  it('finds nothing where neither order reproduces both quantities', () => {
    expect(
      sequenceRatioPair(q('150'), [desdobro('236'), grupamento('3.75')], [q('80'), q('0.025')]),
    ).toHaveLength(0);
  });

  it('never tries a zero second basis: 0,5 grouped leaves nothing whole to split', () => {
    // 10 × 0,05 = 0,5 = R; its floor is 0, so only 0,5 whole is tried: 0,5 × 1 = 0,5 ≠ 0.
    expect(
      sequenceRatioPair(q('10'), [desdobro('0'), grupamento('0.5')], [q('2'), q('0.05')]),
    ).toHaveLength(0);
  });

  it('finds two sequences where a 0 % desdobramento cannot be ordered', () => {
    expect(
      sequenceRatioPair(q('100'), [desdobro('0'), grupamento('50')], [q('1'), q('0.5')]),
    ).toHaveLength(2);
  });
});

describe('#139 BR-005-20b / BR-007-04a — evaluateRatioPair', () => {
  const legs = [
    { movement: 'desdobro' as const, stated: q('237') },
    { movement: 'grupamento' as const, stated: q('3.75') },
  ] as const;
  const factors = [
    factor('desdobramento', '7900', '2025-04-14', 'VIVT'),
    factor('grupamento', '0.025', '2025-04-14', 'VIVT'),
  ];
  const base: Parameters<typeof evaluateRatioPair>[0] = {
    legs,
    basis: q('150'),
    issuerCode: 'VIVT',
    issuerFactors: factors,
    tradeDate: BusinessDate.of('2025-04-16'),
    factorDays: 7,
    structural: null,
  };

  it('resolves both at B3’s multipliers, each leg showing the basis it met', () => {
    const verdict = evaluateRatioPair(base);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.ratios.map(String)).toEqual(['80', '0.025']);
    expect(verdict.evidence[0].basis?.toString()).toBe('3');
    expect(verdict.evidence[1].basis?.toString()).toBe('150');
  });

  it('refuses in order: structural, no_basis, no issuer or no factor at all, per-leg factor, representability', () => {
    const refusal = (input: Partial<typeof base>) => {
      const verdict = evaluateRatioPair({ ...base, ...input });
      return verdict.ok ? 'ok' : verdict.refusal;
    };
    expect(refusal({ structural: 'blocked' })).toBe('blocked');
    expect(refusal({ basis: null })).toBe('no_basis');
    expect(refusal({ basis: q('0') })).toBe('no_basis');
    expect(refusal({ issuerCode: null })).toBe('combined_same_day');
    expect(refusal({ issuerFactors: [] })).toBe('combined_same_day');
    expect(refusal({ issuerFactors: [factors[0] as CorporateEventFactor] })).toBe('no_factor');
    expect(
      refusal({
        issuerFactors: [...factors, factor('grupamento', '0.05', '2025-04-15', 'VIVT')],
      }),
    ).toBe('ambiguous_factor');
    expect(
      refusal({
        issuerFactors: [
          factors[0] as CorporateEventFactor,
          factor('grupamento', '0.333333333333', '2025-04-14', 'VIVT'),
        ],
      }),
    ).toBe('not_representable');
    expect(refusal({ basis: q('151') })).toBe('disagrees');
  });

  it('shows P on both legs when refused', () => {
    const verdict = evaluateRatioPair({ ...base, basis: q('151') });
    expect(verdict.evidence.map((e) => e.basis?.toString())).toEqual(['151', '151']);
  });
});

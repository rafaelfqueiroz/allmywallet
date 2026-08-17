import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { aggregate, buildHoldingSet, distributeExact, totalsOf } from '@/core/reporting/base-query';
import { ReportingErrorCode, UNASSIGNED_GROUP_ID } from '@/core/reporting/ports';
import {
  aHolding,
  anAsset,
  aPosition,
  assetIdOf,
  day,
  institutionIdOf,
  money,
  qty,
  walletIdOf,
} from '@/core/reporting/test-support';

/**
 * SPEC-011 BR-011-08/09/10 — the holding set and the fold over it.
 *
 * TS-04/TS-05: every expected figure below is computed by hand and the
 * arithmetic written into the test. Asserting that the code returns what the
 * code computes would prove only self-consistency, which is worth nothing on
 * a module whose entire job is to make two different views agree.
 */

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

describe('distributeExact — the parts must sum to exactly the whole', () => {
  it('splits proportionally when the division is exact', () => {
    // R$ 1000,00 across weights 60 and 40 (sum 100):
    //   share[0] = 1000 × 60 ÷ 100 = 600
    //   share[1] = 1000 − 600      = 400   (residual)
    const shares = unwrap(distributeExact(money('1000'), [qty('60'), qty('40')]));
    expect(shares.map((s) => s.toString())).toEqual(['600', '400']);
  });

  it('gives the residual to the last share so a repeating decimal loses nothing', () => {
    // R$ 100,00 across three equal weights, by hand:
    //   share[0] = quantize(100 × 1 ÷ 3) = quantize(33.3333…) = 33.33333333
    //   share[1] = the same                                    = 33.33333333
    //   allocated                                              = 66.66666666
    //   share[2] = 100 − 66.66666666                           = 33.33333334
    //   Σ = 100.00000000 exactly
    const shares = unwrap(distributeExact(money('100'), [qty('1'), qty('1'), qty('1')]));
    expect(shares.map((s) => s.toString())).toEqual(['33.33333333', '33.33333333', '33.33333334']);

    const total = shares.reduce((acc, s) => acc.plus(s), Money.zero());
    expect(total.toString()).toBe('100');
    expect(total.equals(money('100'))).toBe(true);

    // The residual carries the whole remainder — exactly one unit in the last
    // stored decimal place, never a 40-digit tail.
    expect(shares[2]!.minus(shares[0]!).toString()).toBe('0.00000001');
  });

  it('quantises every share to the persisted scale so nothing carries a 40-digit tail', () => {
    // The property that makes addition associative again, and therefore makes
    // BR-011-08 exactly true rather than true to 35 significant digits.
    const shares = unwrap(distributeExact(money('100'), [qty('1'), qty('1'), qty('1')]));
    for (const share of shares) {
      const decimals = share.toString().split('.')[1] ?? '';
      expect(decimals.length).toBeLessThanOrEqual(8);
    }
  });

  it('is exact for a seven-way split of an awkward amount', () => {
    // 1000 ÷ 7 = 142.857142857142857…
    //   eight decimals, HALF_UP: 142.85714285|71… → 9th digit 7 → 142.85714286
    //   six such shares            = 857.14285716
    //   residual = 1000 − 857.14285716 = 142.85714284
    const shares = unwrap(
      distributeExact(
        money('1000'),
        Array.from({ length: 7 }, () => qty('1')),
      ),
    );
    expect(shares.slice(0, 6).map((s) => s.toString())).toEqual(
      Array.from({ length: 6 }, () => '142.85714286'),
    );
    expect(shares[6]!.toString()).toBe('142.85714284');
    const total = shares.reduce((acc, s) => acc.plus(s), Money.zero());
    expect(total.toString()).toBe('1000');
  });

  it('returns a single share equal to the whole when there is one weight', () => {
    // The loop body never runs; the residual line alone produces the answer.
    const shares = unwrap(distributeExact(money('123.45'), [qty('10')]));
    expect(shares.map((s) => s.toString())).toEqual(['123.45']);
  });

  it('handles unequal weights with a non-terminating ratio', () => {
    // R$ 10,00 across weights 1 and 2 (sum 3):
    //   share[0] = quantize(10 × 1 ÷ 3) = quantize(3.3333…) = 3.33333333
    //   share[1] = 10 − 3.33333333                          = 6.66666667
    const shares = unwrap(distributeExact(money('10'), [qty('1'), qty('2')]));
    expect(shares.map((s) => s.toString())).toEqual(['3.33333333', '6.66666667']);
    expect(shares[0]!.plus(shares[1]!).toString()).toBe('10');
  });

  it('distributes zero as zero everywhere', () => {
    const shares = unwrap(distributeExact(Money.zero(), [qty('3'), qty('7')]));
    expect(shares.map((s) => s.toString())).toEqual(['0', '0']);
  });

  it('returns an empty array for no weights and no value', () => {
    expect(unwrap(distributeExact(Money.zero(), []))).toEqual([]);
  });

  it('refuses to distribute value across no weights at all', () => {
    // Never return zero, never drop it — the value would simply vanish from
    // the report with nothing to show it had been there.
    const result = distributeExact(money('50'), []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INDIVISIBLE_VALUE);
    expect(result.error.context.total).toBe('50');
  });

  it('refuses to distribute value across weights that sum to zero', () => {
    const result = distributeExact(money('50'), [qty('0'), qty('0')]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INDIVISIBLE_VALUE);
    expect(result.error.context).toEqual({ total: '50', weights: 2 });
  });

  it('returns zeros when both the total and the weights are zero', () => {
    const shares = unwrap(distributeExact(Money.zero(), [qty('0'), qty('0')]));
    expect(shares.map((s) => s.toString())).toEqual(['0', '0']);
  });
});

describe('buildHoldingSet — BR-011-09, the canonical slices', () => {
  const itsa = assetIdOf('1');
  const xp = institutionIdOf('1');
  const rico = institutionIdOf('2');
  const walletA = walletIdOf('1');
  const walletB = walletIdOf('2');

  const descriptor = anAsset({ assetId: itsa, code: 'ITSA4', sector: 'Bancos' });

  it('spreads each wallet claim across the asset institutions pro rata', () => {
    // The worked example from base-query.ts, asserted:
    //   ITSA4 100 held — 60 at XP (value 600), 40 at Rico (value 400)
    //   allocated 50 to A, 30 to B, 20 unallocated
    //
    //   XP   quantity 60 → A 60×50/100 = 30, B 60×30/100 = 18, Un = 60−48 = 12
    //   Rico quantity 40 → A 40×50/100 = 20, B 40×30/100 = 12, Un = 40−32 =  8
    const holdings = unwrap(
      buildHoldingSet({
        positions: [
          aPosition({
            assetId: itsa,
            institutionId: xp,
            quantity: qty('60'),
            value: money('600'),
            costBasis: money('480'),
          }),
          aPosition({
            assetId: itsa,
            institutionId: rico,
            quantity: qty('40'),
            value: money('400'),
            costBasis: money('320'),
          }),
        ],
        allocations: [
          { walletId: walletA, assetId: itsa, quantity: qty('50') },
          { walletId: walletB, assetId: itsa, quantity: qty('30') },
        ],
        assets: [descriptor],
      }),
    );

    expect(holdings).toHaveLength(6);

    const at = (institutionId: string, walletId: string | null) =>
      holdings.find((h) => h.institutionId === institutionId && h.walletId === walletId)!;

    expect(at(xp, walletA).quantity.toString()).toBe('30');
    expect(at(xp, walletB).quantity.toString()).toBe('18');
    expect(at(xp, null).quantity.toString()).toBe('12');
    expect(at(rico, walletA).quantity.toString()).toBe('20');
    expect(at(rico, walletB).quantity.toString()).toBe('12');
    expect(at(rico, null).quantity.toString()).toBe('8');

    // Value follows quantity: XP's 600 splits 300 / 180 / 120.
    expect(at(xp, walletA).value.toString()).toBe('300');
    expect(at(xp, walletB).value.toString()).toBe('180');
    expect(at(xp, null).value.toString()).toBe('120');
    // Rico's 400 splits 200 / 120 / 80.
    expect(at(rico, walletA).value.toString()).toBe('200');
    expect(at(rico, walletB).value.toString()).toBe('120');
    expect(at(rico, null).value.toString()).toBe('80');

    // Cost basis likewise: XP's 480 → 240 / 144 / 96.
    expect(at(xp, walletA).costBasis.toString()).toBe('240');
    expect(at(xp, walletB).costBasis.toString()).toBe('144');
    expect(at(xp, null).costBasis.toString()).toBe('96');
  });

  it('carries the asset descriptor onto every slice', () => {
    const holdings = unwrap(
      buildHoldingSet({
        positions: [aPosition({ assetId: itsa, quantity: qty('10'), value: money('100') })],
        allocations: [],
        assets: [descriptor],
      }),
    );
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.assetCode).toBe('ITSA4');
    expect(holdings[0]!.sector).toBe('Bancos');
    expect(holdings[0]!.assetClass).toBe('stock');
    // Nothing allocated → the whole position is the Unassigned slice.
    expect(holdings[0]!.walletId).toBeNull();
    expect(holdings[0]!.quantity.toString()).toBe('10');
  });

  it('emits no Unassigned slice when an asset is fully allocated', () => {
    // held 100 − allocated 100 = 0, and a zero slice is dropped BEFORE any
    // distribution, so it cannot swallow the residual.
    const holdings = unwrap(
      buildHoldingSet({
        positions: [aPosition({ assetId: itsa, quantity: qty('100'), value: money('1000') })],
        allocations: [{ walletId: walletA, assetId: itsa, quantity: qty('100') }],
        assets: [descriptor],
      }),
    );
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.walletId).toBe(walletA);
    expect(holdings[0]!.value.toString()).toBe('1000');
  });

  it('keeps a negative remainder visible rather than clamping it to zero', () => {
    // allocations (120) exceed the held quantity (100) — a SPEC-010 BR-010-05
    // violation the locked write path makes unreachable, but a bulk UPDATE
    // could still produce. Clamping would make the wallet groups sum to MORE
    // than the portfolio while looking entirely normal.
    const holdings = unwrap(
      buildHoldingSet({
        positions: [aPosition({ assetId: itsa, quantity: qty('100'), value: money('1000') })],
        allocations: [{ walletId: walletA, assetId: itsa, quantity: qty('120') }],
        assets: [descriptor],
      }),
    );
    const unassigned = holdings.find((h) => h.walletId === null)!;
    expect(unassigned.quantity.toString()).toBe('-20');
    // ...and the slices still sum to exactly the position.
    expect(totalsOf(holdings).value.toString()).toBe('1000');
    expect(totalsOf(holdings).quantity.toString()).toBe('100');
  });

  it('marks every slice of an estimated position as estimated (BR-011-15)', () => {
    const holdings = unwrap(
      buildHoldingSet({
        positions: [
          aPosition({
            assetId: itsa,
            quantity: qty('100'),
            value: money('1000'),
            estimated: true,
          }),
        ],
        allocations: [{ walletId: walletA, assetId: itsa, quantity: qty('60') }],
        assets: [descriptor],
      }),
    );
    expect(holdings.every((h) => h.estimated)).toBe(true);
  });

  it('preserves a null institution rather than inventing one', () => {
    const holdings = unwrap(
      buildHoldingSet({
        positions: [aPosition({ assetId: itsa, institutionId: null, quantity: qty('5') })],
        allocations: [],
        assets: [descriptor],
      }),
    );
    expect(holdings[0]!.institutionId).toBeNull();
  });

  it('returns an empty set for a tenant with no positions', () => {
    expect(unwrap(buildHoldingSet({ positions: [], allocations: [], assets: [] }))).toEqual([]);
  });

  it('ignores allocations for assets that are not held', () => {
    // A stale allocation row for a position closed to zero must not conjure a
    // holding out of nothing.
    const holdings = unwrap(
      buildHoldingSet({
        positions: [aPosition({ assetId: itsa, quantity: qty('10'), value: money('100') })],
        allocations: [{ walletId: walletA, assetId: assetIdOf('9'), quantity: qty('99') }],
        assets: [descriptor],
      }),
    );
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.assetId).toBe(itsa);
  });

  it('fails when the position cache references an asset the catalog cannot describe', () => {
    const result = buildHoldingSet({
      positions: [aPosition({ assetId: assetIdOf('9'), quantity: qty('1') })],
      allocations: [],
      assets: [descriptor],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.ASSET_NOT_DESCRIBED);
  });

  it('propagates an indivisible position rather than reporting zero', () => {
    // A position with no quantity anywhere to apportion by, but a value to
    // apportion. There is no honest split, so it is reported as unavailable.
    const result = buildHoldingSet({
      positions: [aPosition({ assetId: itsa, quantity: qty('0'), value: money('42') })],
      allocations: [],
      assets: [descriptor],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INDIVISIBLE_VALUE);
  });

  it('propagates an indivisible cost basis when quantity and value are both zero', () => {
    // quantity 0 and value 0 distribute fine (empty slices, zero total), but a
    // non-zero cost basis still has nowhere to go — the third distribute call.
    const result = buildHoldingSet({
      positions: [
        aPosition({ assetId: itsa, quantity: qty('0'), value: money('0'), costBasis: money('7') }),
      ],
      allocations: [],
      assets: [descriptor],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INDIVISIBLE_VALUE);
  });

  it('propagates an indivisible quantity when the slices are empty', () => {
    // A held quantity that nets to zero across allocations leaves no slices,
    // yet the position still reports quantity — the FIRST distribute call.
    const result = buildHoldingSet({
      positions: [
        aPosition({
          assetId: itsa,
          quantity: qty('5'),
          value: money('0'),
          costBasis: money('0'),
        }),
        aPosition({
          assetId: itsa,
          institutionId: institutionIdOf('2'),
          quantity: qty('-5'),
          value: money('0'),
          costBasis: money('0'),
        }),
      ],
      allocations: [],
      assets: [descriptor],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INDIVISIBLE_VALUE);
  });
});

describe('totalsOf', () => {
  it('sums value, cost and quantity and is zero for an empty set', () => {
    expect(totalsOf([])).toEqual({
      value: Money.zero(),
      costBasis: Money.zero(),
      quantity: Quantity.zero(),
      estimated: false,
    });
  });

  it('marks the total estimated when any single holding is', () => {
    const totals = totalsOf([
      aHolding({ value: money('10'), costBasis: money('8'), quantity: qty('1') }),
      aHolding({ value: money('20'), costBasis: money('15'), quantity: qty('2'), estimated: true }),
    ]);
    expect(totals.value.toString()).toBe('30'); // 10 + 20
    expect(totals.costBasis.toString()).toBe('23'); // 8 + 15
    expect(totals.quantity.toString()).toBe('3'); // 1 + 2
    expect(totals.estimated).toBe(true);
  });
});

describe('aggregate — BR-011-07/08', () => {
  const holdings = [
    aHolding({
      assetId: assetIdOf('1'),
      assetClass: 'stock',
      sector: 'Bancos',
      walletId: walletIdOf('1'),
      value: money('100'),
      quantity: qty('10'),
    }),
    aHolding({
      assetId: assetIdOf('2'),
      assetClass: 'fii',
      sector: null,
      walletId: null,
      value: money('250'),
      quantity: qty('25'),
    }),
    aHolding({
      assetId: assetIdOf('3'),
      assetClass: 'stock',
      sector: 'Bancos',
      walletId: walletIdOf('1'),
      value: money('150'),
      quantity: qty('15'),
    }),
  ];

  it('folds holdings into groups and totals each one', () => {
    // stock: 100 + 150 = 250; fii: 250. Scope total 100 + 250 + 150 = 500.
    const report = aggregate(holdings, 'asset_class');
    expect(report.grouping).toBe('asset_class');
    expect(report.groups.map((g) => g.key.id)).toEqual(['fii', 'stock']);
    expect(report.groups.find((g) => g.key.id === 'stock')!.totals.value.toString()).toBe('250');
    expect(report.groups.find((g) => g.key.id === 'fii')!.totals.value.toString()).toBe('250');
    expect(report.total.value.toString()).toBe('500');
  });

  it('carries constituent holdings on each group for BR-011-07 drill-down', () => {
    const report = aggregate(holdings, 'asset_class');
    const stock = report.groups.find((g) => g.key.id === 'stock')!;
    expect(stock.holdings).toHaveLength(2);
    expect(stock.holdings.map((h) => h.value.toString())).toEqual(['100', '150']);
  });

  it('places Unassigned last and still inside the total', () => {
    const report = aggregate(holdings, 'wallet');
    expect(report.groups.map((g) => g.key.id)).toEqual([walletIdOf('1'), UNASSIGNED_GROUP_ID]);
    expect(report.groups.at(-1)!.key.synthetic).toBe(true);
    expect(report.groups.at(-1)!.totals.value.toString()).toBe('250');
    expect(report.total.value.toString()).toBe('500');
  });

  it('places Not classified last under sector grouping', () => {
    const report = aggregate(holdings, 'sector');
    expect(report.groups.map((g) => g.key.id)).toEqual(['Bancos', '__not_classified__']);
    expect(report.groups.at(-1)!.totals.value.toString()).toBe('250');
    expect(report.total.value.toString()).toBe('500');
  });

  it('returns no groups but a zero total for an empty holding set', () => {
    const report = aggregate([], 'asset_class');
    expect(report.groups).toEqual([]);
    expect(report.total.value.toString()).toBe('0');
  });

  it('derives the scope total from holdings, not from the group subtotals', () => {
    // If the total were summed from the groups, a dimension that dropped a
    // holding would drop it from the total too and the invariant test would
    // pass over the bug. Grouping by asset splits these three into three
    // groups; the total must still be the sum of all three holdings.
    const byAsset = aggregate(holdings, 'asset');
    expect(byAsset.groups).toHaveLength(3);
    expect(byAsset.total.value.toString()).toBe('500');
    expect(aggregate(holdings, 'asset_class').total.value.toString()).toBe('500');
  });
});

describe('SPEC-009 AC-3/9/11 — valuation metadata survives the reporting boundary', () => {
  /**
   * The regression these exist for: `ReportPosition` carried only
   * `estimated: boolean`, so `carriedForward`, `priceDate`, `needsAttention`
   * and `basis` were computed by the valuation engine and discarded here.
   * Three acceptance criteria had nothing to render from, and a stale price
   * was indistinguishable on screen from a live one.
   */
  const descriptor = {
    assetId: assetIdOf('1'),
    code: 'PETR4',
    name: 'Petrobras PN',
    assetClass: 'stock' as const,
    sector: null,
  };

  it('carries a carried-forward close and its price date onto the holding', () => {
    const built = buildHoldingSet({
      positions: [
        aPosition({
          assetId: assetIdOf('1'),
          carriedForward: true,
          priceDate: day('2026-03-10'),
        }),
      ],
      allocations: [],
      assets: [descriptor],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value[0]?.carriedForward).toBe(true);
    expect(built.value[0]?.priceDate).toBe('2026-03-10');
  });

  it('carries a needs-attention reason, so AC-11 has something to list', () => {
    const built = buildHoldingSet({
      positions: [aPosition({ assetId: assetIdOf('1'), needsAttention: 'PRICE_UNAVAILABLE' })],
      allocations: [],
      assets: [descriptor],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value[0]?.needsAttention).toBe('PRICE_UNAVAILABLE');
  });

  it('carries the estimate basis, so AC-9 can show what a figure was computed from', () => {
    const built = buildHoldingSet({
      positions: [
        aPosition({
          assetId: assetIdOf('1'),
          estimated: true,
          basis: {
            indexer: 'cdi_percent',
            ratePercent: '110',
            businessDays: 42,
            throughDate: day('2026-03-20'),
            matured: false,
            missingIndexDays: 0,
          },
        }),
      ],
      allocations: [],
      assets: [descriptor],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value[0]?.basis?.indexer).toBe('cdi_percent');
    expect(built.value[0]?.basis?.businessDays).toBe(42);
  });

  it('repeats the markers on every wallet slice rather than splitting them', () => {
    // Value and quantity divide between wallets; how the price was obtained
    // does not. A carried-forward close is equally carried-forward for each
    // wallet holding a piece of it.
    const built = buildHoldingSet({
      positions: [
        aPosition({
          assetId: assetIdOf('1'),
          quantity: qty('100'),
          carriedForward: true,
          priceDate: day('2026-03-10'),
        }),
      ],
      allocations: [
        { walletId: walletIdOf('1'), assetId: assetIdOf('1'), quantity: qty('60') },
        { walletId: walletIdOf('2'), assetId: assetIdOf('1'), quantity: qty('40') },
      ],
      assets: [descriptor],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toHaveLength(2);
    expect(built.value.every((holding) => holding.carriedForward)).toBe(true);
    expect(built.value.every((holding) => holding.priceDate === '2026-03-10')).toBe(true);
  });
});

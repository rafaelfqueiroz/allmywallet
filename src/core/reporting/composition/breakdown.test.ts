import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import { aggregate } from '@/core/reporting/base-query';
import {
  aHolding,
  assetIdOf,
  day,
  institutionIdOf,
  money,
  qty,
} from '@/core/reporting/test-support';
import { assetRows, sharesOf, sliceBreakdown } from '@/core/reporting/composition/breakdown';

/**
 * SPEC-015 BR-015-02/07/08/10 — the two folds, and the share arithmetic under
 * both.
 *
 * TS-04: every figure below is hand-computed and asserted as **exact** `Money`
 * equality. An approximate comparison would pass straight over the rounding
 * drift these functions exist to prevent, which is the whole class of bug
 * BR-015-10 is about.
 */

describe('sharesOf — BR-015-10: shares sum to exactly 100 %', () => {
  it('gives the last share the residual, so three equal thirds still sum to one', () => {
    /**
     * By hand, and this is the case a naive implementation gets wrong:
     *
     *   share[0] = 100 ÷ 300 = 0,33333333  (quantised, 8 dp)
     *   share[1] = 100 ÷ 300 = 0,33333333
     *   share[2] = 1 − 0,66666666          = 0,33333334   ← the residual
     *   Σ                                  = 1,00000000
     *
     * Dividing all three would give 0,99999999 — a report whose slices add up
     * to 99,999999 %, with the missing sliver looking exactly like a lost
     * holding.
     */
    const shares = sharesOf([money('100'), money('100'), money('100')], money('300'));

    expect(shares).not.toBeNull();
    expect(shares?.map((share) => share.toString())).toEqual([
      '0.33333333',
      '0.33333333',
      '0.33333334',
    ]);
    expect(sum(shares ?? []).equals(Money.fromString('1'))).toBe(true);
  });

  it('sums to exactly one across seventy non-terminating parts', () => {
    /**
     * 1 ÷ 70 = 0,0142857142… — a denominator with a factor of 7 in it, so no
     * finite decimal represents the share and every one of the seventy is
     * truncated. Seventy parts of `money('7')` over `money('700')` would *not*
     * test this: that share is exactly 0,01, and the assertion would hold with
     * the residual deleted.
     */
    const values = Array.from({ length: 70 }, () => money('1'));
    const shares = sharesOf(values, money('70'));

    expect(shares).not.toBeNull();
    expect(sum(shares ?? []).toString()).toBe('1');
  });

  it('BR-015-10: a share of a zero total is undefined, not zero', () => {
    // The alternative — rendering 0,00 % — is a figure the reader cannot tell
    // from a real one.
    expect(sharesOf([money('0'), money('0')], money('0'))).toBeNull();
  });

  it('returns no shares when there are no parts', () => {
    expect(sharesOf([], money('100'))).toEqual([]);
  });

  it('gives a single part the whole, exactly', () => {
    const shares = sharesOf([money('123.45')], money('123.45'));
    expect(shares?.[0]?.toString()).toBe('1');
  });
});

describe('sliceBreakdown — BR-015-01/07: the chart, largest first', () => {
  const holdings = [
    aHolding({
      assetId: assetIdOf('1'),
      assetCode: 'PETR4',
      assetClass: 'stock',
      value: money('600'),
      quantity: qty('10'),
      costBasis: money('400'),
    }),
    aHolding({
      assetId: assetIdOf('2'),
      assetCode: 'HGLG11',
      assetClass: 'fii',
      value: money('300'),
      quantity: qty('3'),
      costBasis: money('300'),
    }),
    aHolding({
      assetId: assetIdOf('3'),
      assetCode: 'IVVB11',
      assetClass: 'etf',
      value: money('100'),
      quantity: qty('1'),
      costBasis: money('90'),
    }),
  ];

  it('orders by value descending and shares sum to one', () => {
    const slices = sliceBreakdown(aggregate(holdings, 'asset_class'));

    expect(slices.map((slice) => slice.key.id)).toEqual(['stock', 'fii', 'etf']);
    // 600/1000, 300/1000, then the residual.
    expect(slices.map((slice) => slice.share?.toString())).toEqual(['0.6', '0.3', '0.1']);
    expect(sum(slices.map((slice) => slice.share as Money)).toString()).toBe('1');
  });

  it('BR-015-07: the share is of market value, not of cost', () => {
    /**
     * DL-015-02, and the reason it is not a detail. On cost the three weigh
     * 400 / 300 / 90 of 790 — the stock is 50,6 % of the money invested and
     * 60 % of the money exposed. Composition answers the second question, and
     * a cost basis would understate exactly the concentration the user needs
     * to see.
     */
    const slices = sliceBreakdown(aggregate(holdings, 'asset_class'));
    const stock = slices.find((slice) => slice.key.id === 'stock');

    expect(stock?.share?.toString()).toBe('0.6');
    expect(stock?.totals.costBasis.toString()).toBe('400');
  });

  it('breaks ties on the framework order, so equal groups render the same way twice', () => {
    const equal = [
      aHolding({
        assetId: assetIdOf('1'),
        assetClass: 'fii',
        value: money('500'),
        quantity: qty('1'),
      }),
      aHolding({
        assetId: assetIdOf('2'),
        assetClass: 'stock',
        value: money('500'),
        quantity: qty('1'),
      }),
    ];
    const once = sliceBreakdown(aggregate(equal, 'asset_class')).map((slice) => slice.key.id);
    const twice = sliceBreakdown(aggregate(equal, 'asset_class')).map((slice) => slice.key.id);

    expect(once).toEqual(twice);
    // `compareGroupKeys` sorts by id, so `fii` precedes `stock` on a tie.
    expect(once).toEqual(['fii', 'stock']);
  });

  it('reports every share as absent when the scope totals zero', () => {
    const worthless = [aHolding({ value: money('0'), quantity: qty('1'), costBasis: money('0') })];
    const slices = sliceBreakdown(aggregate(worthless, 'asset_class'));

    expect(slices).toHaveLength(1);
    expect(slices[0]?.share).toBeNull();
  });
});

describe('assetRows — BR-015-02/08: the table, one row per asset', () => {
  /**
   * One asset held at two institutions — the fold the table has to do and the
   * chart does not. By hand:
   *
   *   quantity      = 60 + 40      = 100
   *   value         = 900 + 600    = 1.500
   *   costBasis     = 600 + 500    = 1.100
   *   averagePrice  = 1.100 ÷ 100  = 11        ← the weighted preço médio
   *   currentPrice  = 1.500 ÷ 100  = 15
   *   unrealizedGain= 1.500 − 1.100= 400
   *
   * Note that 11 is neither institution's own average (10 and 12,5): a row
   * that took one slice's price would be wrong by a fifth here.
   */
  const twoInstitutions = [
    aHolding({
      assetId: assetIdOf('1'),
      assetCode: 'PETR4',
      institutionId: institutionIdOf('1'),
      quantity: qty('60'),
      value: money('900'),
      costBasis: money('600'),
    }),
    aHolding({
      assetId: assetIdOf('1'),
      assetCode: 'PETR4',
      institutionId: institutionIdOf('2'),
      quantity: qty('40'),
      value: money('600'),
      costBasis: money('500'),
    }),
  ];

  it('folds the slices and derives both prices and the gain', () => {
    const rows = assetRows(twoInstitutions, money('1500'));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.quantity.toString()).toBe('100');
    expect(row?.value.toString()).toBe('1500');
    expect(row?.costBasis.toString()).toBe('1100');
    expect(row?.averagePrice?.toString()).toBe('11');
    expect(row?.currentPrice?.toString()).toBe('15');
    expect(row?.unrealizedGain.toString()).toBe('400');
  });

  it('BR-015-08: the gain reconciles to value − quantity × average price', () => {
    const rows = assetRows(twoInstitutions, money('1500'));
    const row = rows[0];
    if (row === undefined || row.averagePrice === null) throw new Error('row missing');

    // The spec's literal form, recomputed from the two columns the screen
    // shows, so a reader checking the arithmetic by hand gets the same answer.
    const recomputed = row.value.minus(row.averagePrice.times(row.quantity));
    expect(recomputed.equals(row.unrealizedGain)).toBe(true);
  });

  it('reports no price for a row that nets to zero quantity', () => {
    /**
     * Reachable, and not by a fixture stunt: `walletSlicesFor` passes a
     * **negative** Unassigned remainder through rather than clamping it, so
     * allocations exceeding the held quantity can cancel a positive slice
     * exactly. A price per zero units is undefined, not infinite.
     */
    const cancelling = [
      aHolding({
        assetId: assetIdOf('1'),
        quantity: qty('50'),
        value: money('0'),
        costBasis: money('0'),
      }),
      aHolding({
        assetId: assetIdOf('1'),
        quantity: qty('-50'),
        value: money('0'),
        costBasis: money('0'),
      }),
    ];
    const rows = assetRows(cancelling, money('0'));

    expect(rows[0]?.quantity.isZero()).toBe(true);
    expect(rows[0]?.averagePrice).toBeNull();
    expect(rows[0]?.currentPrice).toBeNull();
  });

  it('BR-015-09: one accrued or carried-forward slice marks the whole row', () => {
    const mixed = [
      aHolding({
        assetId: assetIdOf('1'),
        quantity: qty('1'),
        value: money('10'),
        estimated: false,
        carriedForward: false,
        priceDate: day('2026-03-18'),
      }),
      aHolding({
        assetId: assetIdOf('1'),
        quantity: qty('1'),
        value: money('10'),
        estimated: true,
        carriedForward: true,
        priceDate: day('2026-03-20'),
      }),
    ];
    const row = assetRows(mixed, money('20'))[0];

    expect(row?.estimated).toBe(true);
    expect(row?.carriedForward).toBe(true);
    // The *latest* date, not the first slice's: the row states how fresh the
    // freshest thing behind it is.
    expect(row?.priceDate).toBe('2026-03-20');
  });

  it('SPEC-009 AC-11: carries the needs-attention reason and the estimate basis onto the row', () => {
    const basis = {
      indexer: 'cdi_percent',
      ratePercent: '110',
      businessDays: 21,
      throughDate: day('2026-03-20'),
      matured: false,
      missingIndexDays: 0,
    } as const;
    const withMarkers = [
      aHolding({
        assetId: assetIdOf('1'),
        quantity: qty('1'),
        value: money('10'),
        needsAttention: null,
        basis: null,
        priceDate: null,
      }),
      aHolding({
        assetId: assetIdOf('1'),
        quantity: qty('1'),
        value: money('10'),
        needsAttention: 'PRICE_UNAVAILABLE',
        basis,
        priceDate: null,
      }),
    ];
    const row = assetRows(withMarkers, money('20'))[0];

    expect(row?.needsAttention).toBe('PRICE_UNAVAILABLE');
    expect(row?.basis).toEqual(basis);
    // Nothing was priced, so there is no date to state.
    expect(row?.priceDate).toBeNull();
  });

  it('leaves needs-attention and the basis null when nothing was wrong', () => {
    const row = assetRows(twoInstitutions, money('1500'))[0];
    expect(row?.needsAttention).toBeNull();
    expect(row?.basis).toBeNull();
  });

  it('orders largest first, breaking ties on the asset code', () => {
    const rows = assetRows(
      [
        aHolding({
          assetId: assetIdOf('1'),
          assetCode: 'VALE3',
          quantity: qty('1'),
          value: money('100'),
        }),
        aHolding({
          assetId: assetIdOf('2'),
          assetCode: 'BBAS3',
          quantity: qty('1'),
          value: money('100'),
        }),
        aHolding({
          assetId: assetIdOf('3'),
          assetCode: 'ITSA4',
          quantity: qty('1'),
          value: money('300'),
        }),
      ],
      money('500'),
    );

    expect(rows.map((row) => row.assetCode)).toEqual(['ITSA4', 'BBAS3', 'VALE3']);
    expect(sum(rows.map((row) => row.share as Money)).toString()).toBe('1');
  });

  it('reports every row share as absent when the scope totals zero', () => {
    const rows = assetRows(
      [aHolding({ assetId: assetIdOf('1'), quantity: qty('1'), value: money('0') })],
      money('0'),
    );
    expect(rows[0]?.share).toBeNull();
  });
});

function sum(values: readonly Money[]): Money {
  return values.reduce((acc, value) => acc.plus(value), Money.zero());
}

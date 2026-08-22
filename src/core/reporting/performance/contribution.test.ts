import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import { NOT_CLASSIFIED_GROUP_ID, type GroupKey } from '@/core/reporting/ports';
import { decomposeContributions } from '@/core/reporting/performance/contribution';
import { Rate, type GroupPeriodFigures } from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-15/16, DL-012-07 — per-group return and contribution.
 *
 * TS-04/TS-05: every figure hand-computed. The last test is the one that
 * matters most — DL-012-07 keeps the summation requirement precisely because it
 * catches aggregation bugs, and it can only catch them if it is exact.
 */

const money = (value: string): Money => Money.fromString(value);

const key = (id: string, synthetic = false): GroupKey => ({
  dimension: 'asset_class',
  id,
  synthetic,
});

function group(
  id: string,
  beginValue: string,
  endValue: string,
  flow = '0',
  estimated = false,
): GroupPeriodFigures {
  return {
    key: key(id),
    beginValue: money(beginValue),
    endValue: money(endValue),
    flow: money(flow),
    estimated,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected a value, got ${result.error.code}`);
  return result.value;
}

function errorCode(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) throw new Error('expected an unavailable result');
  return result.error.code;
}

describe('SPEC-012 BR-012-15/16 — group return and contribution (AC-13)', () => {
  /**
   * Hand-computed, three asset classes:
   *
   *   stock  base 10.000  end 12.000  gain 2.000
   *   fii    base  5.000  end  5.500  gain   500
   *   cdb    base  5.000  end  5.100  gain   100
   *   Σ      base 20.000              gain 2.600
   *
   *   total return = 2.600 ÷ 20.000 = **0,13**
   *
   *   own returns  stock 2.000 ÷ 10.000 = 0,20
   *                fii     500 ÷  5.000 = 0,10
   *                cdb     100 ÷  5.000 = 0,02
   *   weights      0,50 · 0,25 · 0,25
   *   contributions 0,50 × 0,20 = 0,100
   *                 0,25 × 0,10 = 0,025
   *                 0,25 × 0,02 = 0,005
   *   Σ contributions = 0,100 + 0,025 + 0,005 = **0,13**  ✓ the total return
   */
  it('computes each group’s own return and its contribution to the total', () => {
    const report = unwrap(
      decomposeContributions('asset_class', [
        group('stock', '10000', '12000'),
        group('fii', '5000', '5500'),
        group('cdb', '5000', '5100'),
      ]),
    );

    expect(report.totalReturn.toString()).toBe('0.13');
    expect(report.totalGain.toString()).toBe('2600');
    expect(report.totalBase.toString()).toBe('20000');

    // SPEC-011 `compareGroupKeys` orders by id: cdb, fii, stock.
    expect(report.groups.map((entry) => entry.key.id)).toEqual(['cdb', 'fii', 'stock']);

    const byId = new Map(report.groups.map((entry) => [entry.key.id, entry]));
    expect(byId.get('stock')?.ownReturn?.toString()).toBe('0.2');
    expect(byId.get('fii')?.ownReturn?.toString()).toBe('0.1');
    expect(byId.get('cdb')?.ownReturn?.toString()).toBe('0.02');

    expect(byId.get('stock')?.contribution.toString()).toBe('0.1');
    expect(byId.get('fii')?.contribution.toString()).toBe('0.025');
    expect(byId.get('cdb')?.contribution.toString()).toBe('0.005');

    expect(byId.get('stock')?.weight.toString()).toBe('0.5');
    expect(byId.get('fii')?.weight.toString()).toBe('0.25');
    expect(byId.get('cdb')?.weight.toString()).toBe('0.25');
  });

  /**
   * DL-012-07's actual argument, asserted: **a group can outperform while
   * contributing almost nothing.**
   *
   *   tiny  base    100  gain   200 → own return 2,00 (200 %)
   *   big   base  9.900  gain 1.980 → own return 0,20 ( 20 %)
   *   Σ     base 10.000  gain 2.180 → total 0,218
   *
   *   contributions  tiny   200 ÷ 10.000 = 0,020
   *                  big  1.980 ÷ 10.000 = 0,198
   *
   * The tiny position returned ten times what the big one did and moved the
   * *patrimônio* by a tenth as much. Reporting only the first would be true and
   * useless.
   */
  it('separates a spectacular return from a meaningful contribution', () => {
    const report = unwrap(
      decomposeContributions('asset_class', [
        group('big', '9900', '11880'),
        group('tiny', '100', '300'),
      ]),
    );

    const byId = new Map(report.groups.map((entry) => [entry.key.id, entry]));
    expect(byId.get('tiny')?.ownReturn?.toString()).toBe('2');
    expect(byId.get('big')?.ownReturn?.toString()).toBe('0.2');
    expect(byId.get('tiny')?.contribution.toString()).toBe('0.02');
    expect(byId.get('big')?.contribution.toString()).toBe('0.198');
    expect(report.totalReturn.toString()).toBe('0.218');
  });

  /**
   * External flows belong to the base, not to the gain.
   *
   *   base = 1.000 + 500 = 1.500
   *   gain = 1.700 − 1.000 − 500 = 200
   *   own  = 200 ÷ 1.500 = 0,133333333333…  → **0,133333333333** at RATE_SCALE
   *          (the 13th digit is a 3, so the 12th stays put)
   */
  it('counts a group’s external flow as capital, never as return', () => {
    const report = unwrap(
      decomposeContributions('asset_class', [group('stock', '1000', '1700', '500')]),
    );
    expect(report.totalBase.toString()).toBe('1500');
    expect(report.totalGain.toString()).toBe('200');
    expect(report.groups[0]?.ownReturn?.toString()).toBe('0.133333333333');
  });

  /**
   * A group with no capital of its own — opened and closed inside the period,
   * so its flows net against nothing.
   *
   *   opened  base 0      gain 50   → own return **null**, weight 0
   *   held    base 1.000  gain 100
   *   Σ       base 1.000  gain 150  → total 0,15
   *   contributions  opened 50 ÷ 1.000 = 0,05
   *                  held  100 ÷ 1.000 = 0,10
   */
  it('reports no own return for a group with no capital, never a zero', () => {
    const report = unwrap(
      decomposeContributions('asset_class', [
        group('a-opened', '0', '50'),
        group('b-held', '1000', '1100'),
      ]),
    );

    const byId = new Map(report.groups.map((entry) => [entry.key.id, entry]));
    expect(byId.get('a-opened')?.ownReturn).toBeNull();
    expect(byId.get('a-opened')?.weight.toString()).toBe('0');
    // It still contributed: the money it made is real and belongs in the total.
    expect(byId.get('a-opened')?.contribution.toString()).toBe('0.05');
    expect(byId.get('b-held')?.contribution.toString()).toBe('0.1');
    expect(report.totalReturn.toString()).toBe('0.15');
  });

  it('puts the synthetic bucket last and still reconciles', () => {
    // BR-011-10: "Not classified" is a group, never a filter. It carries the
    // residual here, which is the strictest place for it to sit.
    //   classified base 8.000 gain 800; not-classified base 2.000 gain 100
    //   total = 900 ÷ 10.000 = 0,09; contributions 0,08 and 0,01
    const report = unwrap(
      decomposeContributions('sector', [
        {
          key: { dimension: 'sector', id: NOT_CLASSIFIED_GROUP_ID, synthetic: true },
          beginValue: money('2000'),
          endValue: money('2100'),
          flow: Money.zero(),
          estimated: false,
        },
        {
          key: { dimension: 'sector', id: 'Petróleo e Gás', synthetic: false },
          beginValue: money('8000'),
          endValue: money('8800'),
          flow: Money.zero(),
          estimated: false,
        },
      ]),
    );

    expect(report.groups.map((entry) => entry.key.id)).toEqual([
      'Petróleo e Gás',
      NOT_CLASSIFIED_GROUP_ID,
    ]);
    expect(report.groups[0]?.contribution.toString()).toBe('0.08');
    expect(report.groups[1]?.contribution.toString()).toBe('0.01');
    expect(report.totalReturn.toString()).toBe('0.09');
  });

  it('BR-012-18 — refuses a scope with no capital rather than tabulating zeroes', () => {
    expect(errorCode(decomposeContributions('asset_class', []))).toBe(
      'PERFORMANCE_NO_CAPITAL_BASE',
    );
    expect(errorCode(decomposeContributions('asset_class', [group('empty', '0', '0')]))).toBe(
      'PERFORMANCE_NO_CAPITAL_BASE',
    );
  });
});

/**
 * **TS-11 / BR-012-16 — the invariant, under adversarial precision.**
 *
 * Three hundred groups whose bases are 1, 2, 3 … 300 and whose gains are all 1.
 * Every contribution is `1 ÷ 45.150`, a repeating decimal that fills all forty
 * of `dividedBy`'s significant digits — which is precisely the shape that broke
 * PR #34's totals invariant at the 35th digit.
 *
 * Hand-computed:
 *   Σ base = 300 × 301 ÷ 2 = **45.150**
 *   Σ gain = 300 × 1       = **300**
 *   total return = 300 ÷ 45.150 = 0,006644518272… (repeating)
 *
 * The assertion is **exact equality**, not a tolerance. Quantising each share
 * as it is realised and letting the last group take the residual is what makes
 * that possible; summing forty-digit quotients would not.
 */
describe('TS-11 — contributions sum to the total exactly, not nearly', () => {
  it('reconciles across 300 groups of repeating decimals', () => {
    const figures = Array.from({ length: 300 }, (_, index) =>
      // Ids are zero-padded so the sort order is stable and the residual always
      // lands on the same group.
      group(`g${String(index).padStart(3, '0')}`, String(index + 1), String(index + 2)),
    );

    const report = unwrap(decomposeContributions('asset', figures));

    expect(report.totalBase.toString()).toBe('45150');
    expect(report.totalGain.toString()).toBe('300');

    const summed = report.groups.reduce((acc, entry) => acc.plus(entry.contribution), Rate.zero());
    expect(summed.equals(report.totalReturn)).toBe(true);
    // ...and the total is the hand-computed quotient, quantised.
    expect(report.totalReturn.toString()).toBe('0.006644518272');

    // The residual is confined to the last group and is at most (n−1) units of
    // the twelfth decimal place: 299e-12 < 1e-9.
    const last = report.groups[report.groups.length - 1]!;
    const even = report.groups[0]!.contribution;
    expect(last.contribution.minus(even).toDecimal().abs().lessThan('0.000000001')).toBe(true);
  });
});

/**
 * SPEC-011 BR-011-15 / AC-15 — "estimated values are visually distinguished on
 * every report that shows them", and Rentabilidade shows them.
 *
 * SPEC-012 never mentions estimates, which is exactly why this belongs to the
 * framework rather than to the report: accrued fixed income is a large share
 * of a Brazilian portfolio, and a contribution table that presents a computed
 * gain in the same ink as an observed one overstates the precision the product
 * actually has (SPEC-009 BR-009-11). The flag has to travel with the figures —
 * the page holds performance, not the holdings behind it.
 */
describe('BR-011-15 — an accrued group is marked as one', () => {
  it('carries the estimate flag onto the group it belongs to, and only that one', () => {
    const report = unwrap(
      decomposeContributions('asset_class', [
        group('cdb', '2000', '2100', '0', true),
        group('stock', '8000', '8800'),
      ]),
    );

    const byId = new Map(report.groups.map((entry) => [entry.key.id, entry.estimated]));
    expect(byId.get('cdb')).toBe(true);
    expect(byId.get('stock')).toBe(false);
  });

  it('marks the whole table estimated when any single group is', () => {
    const mixed = unwrap(
      decomposeContributions('asset_class', [
        group('cdb', '2000', '2100', '0', true),
        group('stock', '8000', '8800'),
      ]),
    );
    expect(mixed.estimated).toBe(true);
  });

  it('leaves a wholly observed table unmarked', () => {
    const observed = unwrap(
      decomposeContributions('asset_class', [
        group('stock', '8000', '8800'),
        group('fii', '2000', '2100'),
      ]),
    );
    expect(observed.estimated).toBe(false);
  });
});

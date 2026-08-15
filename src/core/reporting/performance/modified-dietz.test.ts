import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import { modifiedDietz } from '@/core/reporting/performance/modified-dietz';
import { computeTwr } from '@/core/reporting/performance/twr';
import type { DatedFlow } from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-02 / DL-012-06 — Modified Dietz, the documented fallback.
 *
 * TS-04/TS-05: every expectation is hand-computed and the arithmetic is in the
 * comment above it.
 */

const day = (value: string): BusinessDate => BusinessDate.of(value);
const money = (value: string): Money => Money.fromString(value);

function flows(entries: readonly [string, string][]): readonly DatedFlow[] {
  return entries.map(([date, amount]) => ({ date: day(date), amount: money(amount) }));
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected a value, got ${result.error.code}`);
  return result.value;
}

function errorCode(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) throw new Error('expected an unavailable result');
  return result.error.code;
}

describe('SPEC-012 BR-012-02 — Modified Dietz', () => {
  /**
   * The worked example the module documents.
   *
   *   D    = 31 Jan − 1 Jan             = 30 calendar days
   *   d    = 11 Jan − 1 Jan             = 10
   *   w    = (30 − 10) ÷ 30             = 2/3
   *   num  = 112.000 − 100.000 − 10.000 = 2.000
   *   den  = 100.000 + 10.000 × 2/3     = 320.000/3 = 106.666,66…
   *   R    = 2.000 ÷ (320.000/3) = 6.000 ÷ 320.000 = **0,01875**
   */
  it('weights a mid-period flow by the fraction of the period it was invested', () => {
    const rate = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-31'),
        beginValue: money('100000'),
        endValue: money('112000'),
        flows: flows([['2026-01-11', '10000']]),
      }),
    );
    expect(rate.toString()).toBe('0.01875');
  });

  /**
   * The weighting is what distinguishes it from the two naive answers, and both
   * of them are wrong in a direction worth naming.
   *
   * Same period, same 2.000 of gain, the deposit moved to the 21st:
   *   w   = (30 − 20) ÷ 30 = 1/3
   *   den = 100.000 + 10.000/3 = 310.000/3 = 103.333,33…
   *   R   = 2.000 ÷ (310.000/3) = 6.000 ÷ 310.000 = 0,019354838709677419…
   *       → **0,019354838710** at RATE_SCALE (the 13th digit is a 6, so the
   *         12th rounds up from …709677 to …70968 — 0,019354838709|677 →
   *         0,019354838710)
   *
   * Later money means less time invested, so the same gain on less average
   * capital is a *higher* return. A flow-blind calculation would report the
   * same figure for both dates.
   */
  it('gives a higher return for the same gain on money that arrived later', () => {
    const early = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-31'),
        beginValue: money('100000'),
        endValue: money('112000'),
        flows: flows([['2026-01-11', '10000']]),
      }),
    );
    const late = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-31'),
        beginValue: money('100000'),
        endValue: money('112000'),
        flows: flows([['2026-01-21', '10000']]),
      }),
    );

    expect(late.toString()).toBe('0.01935483871');
    expect(late.comparedTo(early)).toBe(1);
  });

  it('ignores flows outside the period, including one dated on the opening day', () => {
    // A flow dated `from` is already inside `beginValue` — the snapshot for a
    // date includes every trade made on it — so counting it here would double
    // it. With it correctly ignored this is a plain 12 % on 100.000.
    const rate = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-31'),
        beginValue: money('100000'),
        endValue: money('112000'),
        flows: flows([
          ['2026-01-01', '50000'],
          ['2026-02-15', '90000'],
        ]),
      }),
    );
    // 112.000 − 100.000 − 0 = 12.000; 12.000 ÷ 100.000 = 0,12
    expect(rate.toString()).toBe('0.12');
  });

  /**
   * **The agreement that makes BR-012-02 an honest fallback rather than a
   * different measure.**
   *
   * Over a single day the only flow date inside `(from, to]` is `to` itself, so
   * `w = (1 − 1)/1 = 0` and the denominator collapses to the opening value —
   * which is exactly `twr.ts`'s daily formula. The two are implemented
   * separately, in different files, from different starting formulas; this
   * asserts they land on the same number.
   *
   * Hand-computed: (120.000 − 100.000 − 10.000) ÷ 100.000 = **0,10**.
   */
  it('matches the daily TWR formula exactly where daily data exists', () => {
    const dietz = unwrap(
      modifiedDietz({
        from: day('2026-03-02'),
        to: day('2026-03-03'),
        beginValue: money('100000'),
        endValue: money('120000'),
        flows: flows([['2026-03-03', '10000']]),
      }),
    );
    const twr = unwrap(
      computeTwr({
        points: [
          { date: day('2026-03-02'), value: money('100000') },
          { date: day('2026-03-03'), value: money('120000') },
        ],
        flows: flows([['2026-03-03', '10000']]),
      }),
    );

    expect(dietz.toString()).toBe('0.1');
    expect(dietz.equals(twr.returnRate)).toBe(true);
  });

  it('falls back to the unweighted base when the period opens at zero', () => {
    // Nothing on 1 January; 1.000 arrives on the 31st and is worth 1.010 that
    // evening. The weighted base is 0 + 1.000 × 0 = 0, so the fallback treats
    // the flow as the period's capital:
    //   (1.010 − 0 − 1.000) ÷ 1.000 = **0,01**
    const rate = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-31'),
        beginValue: money('0'),
        endValue: money('1010'),
        flows: flows([['2026-01-31', '1000']]),
      }),
    );
    expect(rate.toString()).toBe('0.01');
  });

  it('returns zero for a period in which nothing happened at all', () => {
    const rate = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-31'),
        beginValue: money('0'),
        endValue: money('0'),
        flows: [],
      }),
    );
    expect(rate.toString()).toBe('0');
  });

  it('refuses a period whose value appeared with no capital behind it', () => {
    // Nothing at the start, nothing paid in, and yet 900 at the end. That is an
    // infinite return arithmetically and a hole in the snapshot series in fact.
    const result = modifiedDietz({
      from: day('2026-01-01'),
      to: day('2026-01-31'),
      beginValue: money('0'),
      endValue: money('900'),
      flows: [],
    });
    expect(errorCode(result)).toBe('PERFORMANCE_UNDEFINED_SUBPERIOD_RETURN');
  });

  it('refuses a liquidation inside a gap, where the measure is genuinely undefined', () => {
    // 1.000 at the start, 1.050 withdrawn on the 2nd, nothing at the end.
    //   weighted base = 1.000 − 1.050 × 29/30 = 1.000 − 1.015 = −15
    //   unweighted    = 1.000 − 1.050          = −50
    // Both negative, so there is no capital to divide by. `twr.ts` sub-divides
    // at every snapshot date it has precisely so this only arises inside a gap.
    const result = modifiedDietz({
      from: day('2026-01-01'),
      to: day('2026-01-31'),
      beginValue: money('1000'),
      endValue: money('0'),
      flows: flows([['2026-01-02', '-1050']]),
    });
    expect(errorCode(result)).toBe('PERFORMANCE_UNDEFINED_SUBPERIOD_RETURN');
  });

  it('handles a zero-length period with no elapsed time to weight across', () => {
    // `from === to`: there is no span, so the only base is the opening capital.
    //   (1.100 − 1.000 − 0) ÷ 1.000 = **0,10**
    const rate = unwrap(
      modifiedDietz({
        from: day('2026-01-01'),
        to: day('2026-01-01'),
        beginValue: money('1000'),
        endValue: money('1100'),
        flows: [],
      }),
    );
    expect(rate.toString()).toBe('0.1');
  });

  it('handles a reversed period the same way, without inventing a span', () => {
    const rate = unwrap(
      modifiedDietz({
        from: day('2026-01-31'),
        to: day('2026-01-01'),
        beginValue: money('1000'),
        endValue: money('1000'),
        flows: [],
      }),
    );
    expect(rate.toString()).toBe('0');
  });
});

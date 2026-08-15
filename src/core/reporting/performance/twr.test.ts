import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import { listCalendarDays } from '@/core/valuation/business-days';
import { computeTwr } from '@/core/reporting/performance/twr';
import { computeXirr } from '@/core/reporting/performance/xirr';
import type { CashFlow, DatedFlow, SeriesPoint } from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-01/02/18 — Time-Weighted Return.
 *
 * TS-04/TS-05: **every expected value below is hand-computed and the arithmetic
 * is written into the test.** Nothing here asserts that the implementation
 * returns what the implementation computes — that proves self-consistency and
 * nothing else, and self-consistency is exactly what a subtly wrong average
 * has.
 */

const day = (value: string): BusinessDate => BusinessDate.of(value);
const money = (value: string): Money => Money.fromString(value);

function series(entries: readonly [string, string][]): readonly SeriesPoint[] {
  return entries.map(([date, value]) => ({ date: day(date), value: money(value) }));
}

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

describe('SPEC-012 BR-012-01 — daily-linked TWR', () => {
  /**
   * AC-1 — "TWR for a portfolio with **no** cash flows equals the simple value
   * change over the period."
   *
   * Hand-computed:
   *   02→03  r = (110.000 − 100.000) ÷ 100.000 = 10.000/100.000 = 0,10
   *   03→04  r = (115.500 − 110.000) ÷ 110.000 =  5.500/110.000 = 0,05
   *   TWR    = 1,10 × 1,05 − 1 = 1,155 − 1     = **0,155**
   *
   * and the simple value change is 115.500 ÷ 100.000 − 1 = 0,155 — the same
   * number, which is the property: with no flows the daily factors telescope.
   */
  it('AC-1 — with no cash flows, equals the simple value change', () => {
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '100000'],
          ['2026-03-03', '110000'],
          ['2026-03-04', '115500'],
        ]),
        flows: [],
      }),
    );

    expect(result.returnRate.toString()).toBe('0.155');
    expect(result.factor.toString()).toBe('1.155');
    // 115.500 ÷ 100.000 − 1, computed independently of the linking above.
    expect(result.returnRate.toString()).toBe(
      money('115500').dividedBy('100000').minus(money('1')).toString(),
    );
    expect(result.subPeriods.map((sub) => sub.rate.toString())).toEqual(['0.1', '0.05']);
    expect(result.dietzPeriods).toEqual([]);
  });

  /**
   * BR-012-01 — the flow is neutralised in the numerator and absent from the
   * denominator.
   *
   * Hand-computed, the day a R$ 10.000,00 buy settles:
   *   gain = 120.000 − 100.000 − 10.000 = 10.000
   *   r    = 10.000 ÷ 100.000           = **0,10**
   *
   * The same day without the buy would have closed at 110.000,00 and returned
   * the identical 0,10. That is the measure working.
   */
  it('neutralises a mid-series external flow', () => {
    const withFlow = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '100000'],
          ['2026-03-03', '120000'],
        ]),
        flows: flows([['2026-03-03', '10000']]),
      }),
    );
    const withoutFlow = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '100000'],
          ['2026-03-03', '110000'],
        ]),
        flows: [],
      }),
    );

    expect(withFlow.returnRate.toString()).toBe('0.1');
    expect(withFlow.returnRate.equals(withoutFlow.returnRate)).toBe(true);
  });

  /**
   * BR-012-01 — a **sell** is an external flow too, and the end-of-day
   * convention is what makes a full liquidation come out right.
   *
   * Hand-computed: a portfolio worth 100 sells everything for 105 during the
   * day and ends holding nothing.
   *   gain = 0 − 100 − (−105) = 5
   *   r    = 5 ÷ 100          = **0,05**
   *
   * Under a start-of-day convention the denominator would be 100 − 105 = −5 and
   * the day would report −100 %. This test is the reason the convention is not
   * interchangeable.
   */
  it('reports a same-day full liquidation as the gain it was', () => {
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '100'],
          ['2026-03-03', '0'],
        ]),
        flows: flows([['2026-03-03', '-105']]),
      }),
    );
    expect(result.returnRate.toString()).toBe('0.05');
  });

  /**
   * The opening-day fallback: a portfolio that did not exist yesterday.
   *
   * Hand-computed: nothing on the 2nd, a R$ 1.000,00 buy on the 3rd that closed
   * at 1.010,00.
   *   gain = 1.010 − 0 − 1.000 = 10
   *   base = 0 is not capital, so the day's own flow is: 1.000
   *   r    = 10 ÷ 1.000        = **0,01**
   */
  it('uses the day’s own flow as the base when the period opens at zero', () => {
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '0'],
          ['2026-03-03', '1010'],
        ]),
        flows: flows([['2026-03-03', '1000']]),
      }),
    );
    expect(result.returnRate.toString()).toBe('0.01');
  });

  it('links several flows landing on one date as a single day’s flow', () => {
    // Three buys on the 3rd totalling 10.000, against the single-flow case
    // above: 40.000 + 35.000 − 65.000 = 10.000, so the day must read 0,10.
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '100000'],
          ['2026-03-03', '120000'],
        ]),
        flows: flows([
          ['2026-03-03', '40000'],
          ['2026-03-03', '35000'],
          ['2026-03-03', '-65000'],
        ]),
      }),
    );
    expect(result.returnRate.toString()).toBe('0.1');
  });

  it('carries a zero-value opening day through as a factor of one', () => {
    // 2026-03-02 holds nothing and nothing happens: gain 0 on base 0 is a
    // legitimate 0 %, not an unavailable. Every "all time" period that starts
    // before the user's first trade depends on this.
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '0'],
          ['2026-03-03', '0'],
          ['2026-03-04', '1000'],
        ]),
        flows: flows([['2026-03-04', '1000']]),
      }),
    );
    expect(result.subPeriods.map((sub) => sub.rate.toString())).toEqual(['0', '0']);
    expect(result.returnRate.toString()).toBe('0');
  });
});

describe('SPEC-012 BR-012-02 — the Modified Dietz fallback is disclosed', () => {
  /**
   * BR-012-02 / DL-012-06 — a hole in the daily series is approximated **and
   * named**, never silently substituted.
   *
   * Hand-computed for the gap 1 Jan → 31 Jan with R$ 10.000,00 deposited on the
   * 11th (the same worked example `modified-dietz.ts` documents):
   *   D = 30, d = 10, w = 20/30 = 2/3
   *   num = 112.000 − 100.000 − 10.000 = 2.000
   *   den = 100.000 + 10.000 × 2/3     = 320.000/3
   *   r   = 6.000 ÷ 320.000            = **0,01875**
   */
  it('uses Modified Dietz across a gap and reports which period it covered', () => {
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-01-01', '100000'],
          ['2026-01-31', '112000'],
        ]),
        flows: flows([['2026-01-11', '10000']]),
      }),
    );

    expect(result.returnRate.toString()).toBe('0.01875');
    expect(result.subPeriods[0]?.dietz).toBe(true);
    expect(result.dietzPeriods).toEqual([
      { range: { from: '2026-01-01', to: '2026-01-31' }, spanDays: 30 },
    ]);
  });

  it('reports no fallback at all when every day is present', () => {
    const result = unwrap(
      computeTwr({
        points: series([
          ['2026-03-02', '100000'],
          ['2026-03-03', '110000'],
        ]),
        flows: [],
      }),
    );
    expect(result.dietzPeriods).toEqual([]);
    expect(result.subPeriods.every((sub) => !sub.dietz)).toBe(true);
  });

  it('propagates an undefined sub-period rather than linking a guess', () => {
    // A gap that opens at zero, receives nothing and yet ends with value: the
    // snapshot series has a hole, and there is no honest rate for it.
    const result = computeTwr({
      points: series([
        ['2026-01-01', '1000'],
        ['2026-01-05', '0'],
        ['2026-01-20', '900'],
      ]),
      flows: flows([['2026-01-05', '-1000']]),
    });
    expect(errorCode(result)).toBe('PERFORMANCE_UNDEFINED_SUBPERIOD_RETURN');
  });
});

describe('SPEC-012 BR-012-18 — an empty period is an empty state, not a zero', () => {
  it('AC-15 — refuses a period with no series at all', () => {
    expect(errorCode(computeTwr({ points: [], flows: [] }))).toBe('PERFORMANCE_NO_SERIES');
  });

  it('AC-15 — refuses a period in which the scope held nothing on any date', () => {
    const result = computeTwr({
      points: series([
        ['2026-03-02', '0'],
        ['2026-03-03', '0'],
      ]),
      flows: [],
    });
    // A confident "0 %" here would read as "you earned nothing", which is a
    // different claim from "you held nothing".
    expect(errorCode(result)).toBe('PERFORMANCE_NO_SERIES');
  });

  it('returns a factor of one for a single-observation period', () => {
    // One snapshot is a period with no elapsed time. Zero is the honest answer
    // — there is a portfolio, and it has not had time to do anything.
    const result = unwrap(computeTwr({ points: series([['2026-03-02', '1000']]), flows: [] }));
    expect(result.returnRate.toString()).toBe('0');
    expect(result.subPeriods).toEqual([]);
  });
});

/**
 * **TS-09 — the highest-value test in this suite**, and the one the spec calls
 * the defining property of the measure (AC-2, AC-3, DL-012-01).
 *
 * ## The scenario, stated in full
 *
 * A portfolio of R$ 100.000,00 held from 1 January 2026 to 1 January 2027. It
 * rises 10 % on a single day — 1 July — and is otherwise flat. The user then
 * deposits R$ 500.000,00 on 1 October and it sits there, uninvested, earning
 * nothing for the rest of the year.
 *
 * ## TWR must not move (AC-2)
 *
 *   1 Jul  r = (110.000 − 100.000 − 0) ÷ 100.000 = **0,10**
 *   1 Oct  r = (610.000 − 110.000 − 500.000) ÷ 110.000 = 0 ÷ 110.000 = **0**
 *   every other day: value unchanged, no flow → r = 0
 *   TWR = 1,10 × 1 × … × 1 − 1 = **0,10**, with the deposit and without it.
 *
 * The deposit day's numerator cancels its own flow exactly, and the denominator
 * never sees it. That cancellation is the whole measure.
 *
 * ## XIRR must move (AC-3)
 *
 * Without the deposit the cash flows are −100.000 on 1 January and +110.000 on
 * 1 January 2027 — exactly one year apart, so
 *
 *   (1 + r)^(365/365) = 110.000 ÷ 100.000 → r = **0,10** exactly.
 *
 * With it they are −100.000 at t=0, −500.000 at t=273/365 and +610.000 at t=1.
 * Bracketed by hand, evaluating `f(r) = Σ CF (1+r)^(−t)`:
 *
 *   f(0,05) = −100.000 − 500.000 × 1,05^(−0,747945) + 610.000 ÷ 1,05
 *           = −100.000 − 482.085 + 580.952  = **−1.133**  → root is below 0,05
 *   f(0,04) = −100.000 − 500.000 × 1,04^(−0,747945) + 610.000 ÷ 1,04
 *           = −100.000 − 485.545 + 586.538  = **+994**    → root is above 0,04
 *
 * so the money-weighted return falls from 10 % to somewhere between 4 % and
 * 5 %: half a million reais earned nothing for a quarter of the year, and XIRR
 * is the measure that says so.
 *
 * A suite that proved only one of these two would not have tested the
 * distinction the entire report exists to make.
 */
describe('TS-09 — an uninvested mid-period deposit moves XIRR and not TWR', () => {
  const START = day('2026-01-01');
  const END = day('2027-01-01');
  const RISE = '2026-07-01';
  const DEPOSIT = '2026-10-01';

  /** A daily point for every calendar day, valued by the rule stated above. */
  function dailySeries(withDeposit: boolean): readonly SeriesPoint[] {
    return listCalendarDays(START, END).map((date) => {
      const base = date < RISE ? '100000' : '110000';
      const extra = withDeposit && date >= DEPOSIT ? 500000 : 0;
      return { date, value: money(String(Number(base) + extra)) };
    });
  }

  const depositFlow = flows([[DEPOSIT, '500000']]);

  it('AC-2 — TWR is bit-for-bit unchanged by the deposit', () => {
    const without = unwrap(computeTwr({ points: dailySeries(false), flows: [] }));
    const with_ = unwrap(computeTwr({ points: dailySeries(true), flows: depositFlow }));

    expect(without.returnRate.toString()).toBe('0.1');
    expect(with_.returnRate.toString()).toBe('0.1');
    expect(with_.returnRate.equals(without.returnRate)).toBe(true);

    // The deposit day itself contributes a factor of exactly one — the
    // cancellation, asserted directly rather than inferred from the total.
    const depositDay = with_.subPeriods.find((sub) => sub.range.to === DEPOSIT);
    expect(depositDay?.rate.toString()).toBe('0');
  });

  it('AC-3 — XIRR does change, and falls, because the deposit earned nothing', () => {
    const without: readonly CashFlow[] = [
      { date: START, amount: money('-100000') },
      { date: END, amount: money('110000') },
    ];
    const with_: readonly CashFlow[] = [
      { date: START, amount: money('-100000') },
      { date: day(DEPOSIT), amount: money('-500000') },
      { date: END, amount: money('610000') },
    ];

    const baseline = unwrap(computeXirr({ flows: without }));
    const diluted = unwrap(computeXirr({ flows: with_ }));

    // Exactly one year, exactly 10 %: (1 + r)^1 = 110.000 ÷ 100.000.
    expect(baseline.rate.toString()).toBe('0.1');
    // Hand-bracketed above: f(0,04) > 0 > f(0,05).
    expect(diluted.rate.equals(baseline.rate)).toBe(false);
    expect(diluted.rate.toDecimal().greaterThan('0.04')).toBe(true);
    expect(diluted.rate.toDecimal().lessThan('0.05')).toBe(true);
  });
});

/**
 * TS-11 — adversarial precision.
 *
 * Three hundred sub-periods whose daily returns are all repeating decimals
 * (3/10, 3/13, 3/16 … — every one of them fills `dividedBy`'s forty significant
 * digits). With no flows the daily factors telescope, so the linked result must
 * equal `V_last ÷ V_first − 1`.
 *
 * The tolerance is **hand-derived, not tuned**: each sub-period return is
 * quantised to twelve decimal places, so each factor moves by at most 5e-13,
 * and three hundred of them accumulate to at most 1,5e-10 relative. Asserting
 * within 1e-9 therefore passes on correct arithmetic and fails on drift an
 * order of magnitude larger — which is what a `number` leaking into the money
 * path would produce over a series this long.
 */
describe('TS-11 — no drift over hundreds of repeating-decimal sub-periods', () => {
  it('links 300 repeating-decimal returns without drifting from the telescoped value', () => {
    const dates = listCalendarDays(day('2026-01-01'), day('2026-10-28'));
    expect(dates.length).toBe(301);

    // 1.000, 1.300, 1.600 … — every ratio a repeating decimal.
    const points = dates.map((date, index) => ({
      date,
      value: money(String(1000 + index * 300)),
    }));

    const result = unwrap(computeTwr({ points, flows: [] }));

    // Non-null: the array was just proven to be 301 long.
    const first = points[0]!.value;
    const last = points[points.length - 1]!.value;
    const telescoped = last.dividedBy(first.toDecimal()).minus(money('1'));

    const drift = result.returnRate.toDecimal().minus(telescoped.toDecimal()).abs();
    expect(drift.lessThan('0.000000001')).toBe(true);
    // And the figure is genuinely large, so the tolerance is not passing by
    // comparing two near-zeros. Hand-computed: 301 dates means 300 steps, so
    // the last value is 1.000 + 300 × 300 = 91.000, and 91.000 ÷ 1.000 − 1 = 90.
    expect(telescoped.toString()).toBe('90');
  });
});

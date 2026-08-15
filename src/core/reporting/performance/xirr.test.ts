import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import {
  DEFAULT_DIVERGENCE_POINTS,
  computeXirr,
  divergesMaterially,
} from '@/core/reporting/performance/xirr';
import { Rate, type CashFlow } from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-03/05 — XIRR.
 *
 * TS-04/TS-05: every root below is **solved by hand** before it is asserted.
 * Three of the four worked examples are exact tenths because their discounted
 * cash flow reduces to a quadratic in `x = 1/(1+r)` with a whole-number
 * discriminant — so the expectation is arithmetic, not the implementation's own
 * output.
 */

const day = (value: string): BusinessDate => BusinessDate.of(value);

/** 2026-01-01, +365 days, +730 days. Neither 2026 nor 2027 is a leap year. */
const T0 = day('2026-01-01');
const T1 = day('2027-01-01');
const T2 = day('2028-01-01');

function flows(entries: readonly [BusinessDate, string][]): readonly CashFlow[] {
  return entries.map(([date, amount]) => ({ date, amount: Money.fromString(amount) }));
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected a value, got ${result.error.code}`);
  return result.value;
}

describe('SPEC-012 BR-012-03 — hand-computed worked examples (AC-4)', () => {
  /**
   * Pattern 1 — one contribution, one terminal value, exactly one year apart.
   *
   *   −1.000 + 1.100 ÷ (1+r)^1 = 0
   *   (1+r) = 1.100 ÷ 1.000 = 1,1
   *   r     = **0,10**
   */
  it('a single contribution held for exactly one year', () => {
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-1000'],
          [T1, '1100'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('0.1');
    expect(result.method).toBe('newton');
  });

  /**
   * Pattern 2 — two equal annual contributions, solved as a quadratic.
   *
   * With `x = 1/(1+r)`:   −1.000 − 1.000x + 2.310x² = 0
   *                        2.310x² − 1.000x − 1.000 = 0
   *   disc = 1.000² + 4 × 2.310 × 1.000 = 1.000.000 + 9.240.000 = 10.240.000
   *   √disc = 3.200                       (3.200² = 10.240.000, exactly)
   *   x = (1.000 + 3.200) ÷ 4.620 = 4.200 ÷ 4.620 = 10/11
   *   1+r = 11/10 → r = **0,10**
   *
   * Verified by substitution: −1.000 − 909,0909… + 1.909,0909… = 0.
   */
  it('two equal annual contributions', () => {
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-1000'],
          [T1, '-1000'],
          [T2, '2310'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('0.1');
  });

  /**
   * Pattern 3 — **a large late deposit**, the case AC-4 names explicitly.
   *
   * Ten times the original contribution arrives after a year and is held for
   * one more. With `x = 1/(1+r)`:
   *
   *   −1.000 − 10.000x + 12.210x² = 0
   *   disc  = 10.000² + 4 × 12.210 × 1.000 = 100.000.000 + 48.840.000 = 148.840.000
   *   √disc = 12.200                        (12.200² = 148.840.000, exactly)
   *   x = (10.000 + 12.200) ÷ 24.420 = 22.200 ÷ 24.420 = 10/11
   *   r = **0,10**
   *
   * Verified: −1.000 − 9.090,9090… + 10.090,9090… = 0.
   *
   * The figure is the same 10 % as pattern 1 by construction, which is the
   * point worth seeing: XIRR is unmoved *here* because the late money earned
   * the same rate. It moves the moment the late money earns a different one —
   * TS-09 in `twr.test.ts` is that case.
   */
  it('a large late deposit', () => {
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-1000'],
          [T1, '-10000'],
          [T2, '12210'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('0.1');
  });

  /**
   * Pattern 4 — a loss.
   *
   *   −1.000 + 900 ÷ (1+r) = 0 → 1+r = 0,9 → r = **−0,10**
   */
  it('a losing year returns a negative rate', () => {
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-1000'],
          [T1, '900'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('-0.1');
  });

  /**
   * A root far outside the bisection bracket, found by Newton.
   *
   *   −1 + 10.000 ÷ (1+r) = 0 → 1+r = 10.000 → r = **9.999** (999.900 % a year)
   *
   * Worth keeping: it is why Newton runs first. Bisection over [−0,9999, 10]
   * could never have found this, and reporting it unavailable would have been
   * wrong — the root is real, exact, and the flows are perfectly ordinary for a
   * tiny position that multiplied.
   */
  it('finds a root far above the bisection bracket', () => {
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-1'],
          [T1, '10000'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('9999');
    expect(result.method).toBe('newton');
  });
});

describe('SPEC-012 BR-012-05 — non-convergence is unavailable, never zero (AC-6)', () => {
  /**
   * **No real root exists at all.** With `x = 1/(1+r)`:
   *
   *   −100 + 250x − 160x² = 0  →  160x² − 250x + 100 = 0
   *   disc = 250² − 4 × 160 × 100 = 62.500 − 64.000 = **−1.500**
   *
   * A negative discriminant: the parabola never touches zero, so `f(r) < 0` for
   * every rate. Newton oscillates around the maximum forever and the bracket
   * has the same sign at both ends.
   */
  it('reports unavailable when the cash flows have no real root', () => {
    const result = computeXirr({
      flows: flows([
        [T0, '-100'],
        [T1, '250'],
        [T2, '-160'],
      ]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_NOT_CONVERGED');
    // The point of the rule, asserted rather than assumed: there is no rate on
    // the result at all. A zero here would be indistinguishable from a
    // portfolio that broke exactly even, and the user could not tell.
    expect(result).not.toHaveProperty('value');
  });

  /**
   * **Newton's first step lands on a flat point**, which is a division by zero
   * it must decline rather than perform.
   *
   * At the starting guess `r = 0,1`, with `t` in whole years:
   *
   *   f'(0,1) = −[1 × 200 × 1,1^−2] − [2 × (−110) × 1,1^−3]
   *           = −200/1,21 + 220/1,331
   *           = −20.000/121 + 220.000/1.331
   *           = −20.000/121 + 20.000/121          (1.331 = 11³, 121 = 11²)
   *           = **0**
   *
   * The flows are also chosen to have no real root (`110x² − 200x + 100 = 0`,
   * disc = 40.000 − 44.000 = −4.000), so bisection cannot rescue it either and
   * the honest answer is that the figure is unavailable.
   */
  it('declines a flat Newton step and still refuses to invent a root', () => {
    const result = computeXirr({
      flows: flows([
        [T0, '-100'],
        [T1, '200'],
        [T2, '-110'],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_NOT_CONVERGED');
  });

  /**
   * **Newton overshoots below −100 %, and bisection recovers the root.**
   *
   * A near-total loss: 100 in, 1 back a year later.
   *   −100 + 1 ÷ (1+r) = 0 → 1+r = 0,01 → r = **−0,99**
   *
   * Newton's first step from +0,1 is
   *   f(0,1)  = −100 + 1/1,1        = −99,0909…
   *   f'(0,1) = −1 × 1 × 1,1^−2     = −0,826446…
   *   next    = 0,1 − (−99,0909)/(−0,826446) = 0,1 − 119,9 = **−119,8**
   *
   * which is outside the domain where `(1+r)^t` is defined for fractional `t`.
   * Bisection brackets it — `f(−0,9999) = +9.900` and `f(10) = −99,9` — and
   * converges to the exact −0,99.
   */
  it('falls back to bisection when Newton leaves the domain', () => {
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-100'],
          [T1, '1'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('-0.99');
    expect(result.method).toBe('bisection');
    expect(result.iterations).toBe(60);
  });

  /**
   * **A root so far away that the iteration budget runs out**, which is a third
   * and distinct failure from "no root" and "left the domain".
   *
   * One centavo's worth of capital returning 1e20 in a year has a real root at
   * `r = 1e20 − 1`. Newton's iterates roughly double each step from 0,1, so it
   * needs about sixty-six of them and the budget is fifty — and bisection
   * cannot help, because `[−0,9999, 10]` is positive at both ends.
   *
   * What makes this worth a test is not the scenario, which is absurd, but the
   * refusal: after fifty steps the solver is sitting on an iterate around 1e15,
   * a perfectly plausible-looking number that is wrong by five orders of
   * magnitude. Returning it would be exactly the "wrong root" BR-012-05 forbids.
   */
  it('refuses a root beyond its iteration budget rather than returning the last iterate', () => {
    const result = computeXirr({
      flows: flows([
        [T0, '-1'],
        [T1, '100000000000000000000'],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_NOT_CONVERGED');
  });

  it('still converges on a root the budget can reach', () => {
    // The same shape one budget-width smaller: 1e10 back on 1 in a year is a
    // root of exactly 9.999.999.999, and Newton reaches it in forty steps.
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T0, '-1'],
          [T1, '10000000000'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('9999999999');
    expect(result.iterations).toBe(40);
  });

  it('refuses cash flows that never change sign', () => {
    // Money in and more money in, with nothing ever coming back. `Σ CF/(1+r)^t`
    // is negative for every rate above −100 %, so there is nothing to solve.
    const result = computeXirr({
      flows: flows([
        [T0, '-100'],
        [T1, '-200'],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_NO_SIGN_CHANGE');
  });

  it('refuses cash flows that are all inflows', () => {
    const result = computeXirr({
      flows: flows([
        [T0, '100'],
        [T1, '200'],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_NO_SIGN_CHANGE');
  });

  it('refuses fewer than two cash flows', () => {
    const result = computeXirr({ flows: flows([[T0, '-100']]) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_INSUFFICIENT_FLOWS');
  });

  it('refuses cash flows that all fall on one date', () => {
    // Every exponent is zero, so the equation collapses to `Σ CF = 0` — true
    // for every rate or false for every rate, and neither is a return.
    const result = computeXirr({
      flows: flows([
        [T0, '-100'],
        [T0, '150'],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('PERFORMANCE_XIRR_INSUFFICIENT_FLOWS');
  });

  it('orders unsorted cash flows before solving', () => {
    // The same one-year 10 % as pattern 1, handed over backwards. Anchoring the
    // discount on whichever flow happened to be first in the array would put
    // every exponent negative and produce a confident, wrong root.
    const result = unwrap(
      computeXirr({
        flows: flows([
          [T1, '1100'],
          [T0, '-1000'],
        ]),
      }),
    );
    expect(result.rate.toString()).toBe('0.1');
  });
});

/**
 * BR-012-04 / DL-012-02 — the inline explanation of a material gap.
 *
 * Compared in percentage points, so the rule reads the way a person would say
 * it: "the two figures are more than two points apart".
 */
describe('SPEC-012 BR-012-04 — material divergence (AC-5)', () => {
  it('is material at or beyond the threshold, in percentage points', () => {
    // 12 % against 19 % is 7 points apart — the case that needs a sentence.
    expect(divergesMaterially(Rate.of('0.12'), Rate.of('0.19'), DEFAULT_DIVERGENCE_POINTS)).toBe(
      true,
    );
    // Exactly 2 points, the boundary: 2 % against 4 %.
    expect(divergesMaterially(Rate.of('0.02'), Rate.of('0.04'), DEFAULT_DIVERGENCE_POINTS)).toBe(
      true,
    );
    // 1,99 points is under it, even though it is proportionally enormous.
    expect(
      divergesMaterially(Rate.of('0.0001'), Rate.of('0.0200'), DEFAULT_DIVERGENCE_POINTS),
    ).toBe(false);
  });

  it('is symmetric — the sign of the gap does not decide whether to explain it', () => {
    const threshold = Quantity.fromString('3');
    expect(divergesMaterially(Rate.of('0.20'), Rate.of('0.10'), threshold)).toBe(true);
    expect(divergesMaterially(Rate.of('0.10'), Rate.of('0.20'), threshold)).toBe(true);
  });
});

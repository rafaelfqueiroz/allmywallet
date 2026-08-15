import { BusinessDate } from '@/core/shared/clock';
import { domainError } from '@/core/shared/domain-error';
import type { Money } from '@/core/shared/money';
import { Quantity, sumMoney } from '@/core/shared/money';
import { err, ok } from '@/core/shared/result';
import { listCalendarDays } from '@/core/valuation/business-days';
import type { Rate } from '@/core/reporting/performance/ports';
import {
  PerformanceErrorCode,
  XirrMethod,
  quantizeRate,
  ratio,
  type CashFlow,
  type PerformanceResult,
  type XirrResult,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-03/05 — **XIRR**, the user's own money-weighted return.
 *
 * Solves `Σ CF_i / (1+r)^(d_i/365) = 0` for `r`: the annualised rate at which
 * every cash flow, discounted from its own date, nets to zero.
 *
 * **Why it is shown alongside TWR rather than instead of it** (DL-012-01). XIRR
 * accounts for the timing and size of every flow, so it answers "what did *I*
 * earn on my money" — which is what the user actually wants to know, and is
 * useless for comparing against an index, because a well-timed large deposit
 * would make a mediocre portfolio look brilliant. The two legitimately differ,
 * sometimes substantially, and BR-012-04 explains the gap when it is material.
 *
 * ---
 *
 * ## BR-012-05: non-convergence is *unavailable*, never zero and never a root
 *
 * The discounted-cash-flow polynomial has no guaranteed real root, and where it
 * has several none of them is more "correct" than the others. Descartes' rule
 * bounds the positive roots by the number of sign changes in the flow sequence,
 * so an ordinary portfolio — money in, money in, money in, value out — has
 * exactly one and is well behaved. A portfolio that was fully liquidated and
 * re-entered can have three.
 *
 * Every path that cannot produce **the** root returns an error instead:
 *
 *  - fewer than two flows, or every flow on one date — nothing to solve;
 *  - no sign change at all — `Σ CF/(1+r)^t` never crosses zero anywhere;
 *  - Newton fails *and* the fallback bracket does not contain a root.
 *
 * A zero here would be indistinguishable, to the user, from a portfolio that
 * broke exactly even. That is the one outcome worse than showing nothing.
 *
 * ---
 *
 * ## Where rounding happens inside an iterative solver
 *
 * AR-09 says rounding happens once, at display, and an iterative method is in
 * real tension with that: every Newton step compounds its intermediates, so
 * rounding *inside* the iteration would change where the method converges, not
 * merely how the answer is printed.
 *
 * The resolution, stated so it is not rediscovered later:
 *
 *  - **Nothing inside the loop is rounded.** `f`, `f'`, the step and each
 *    iterate stay at `decimal.js`'s full forty significant digits. The solver's
 *    accuracy is governed by `TOLERANCE`, an explicit stopping rule, not by a
 *    quantisation that would silently become one.
 *  - **The root is quantised exactly once, on the way out**, to `RATE_SCALE`.
 *    A root is not an intermediate — it is a terminated approximation, and
 *    publishing forty digits of a figure whose last twenty-eight are an
 *    artefact of where the iteration stopped is its own kind of dishonesty.
 *    Quantising also makes the answer **reproducible**: two runs that stop one
 *    iteration apart publish the same number.
 *
 * `TOLERANCE` is 1e-14 against `RATE_SCALE`'s 1e-12 on purpose — the stopping
 * rule is two orders tighter than the published precision, so the last
 * published digit is settled rather than still moving.
 */

/** Newton's starting point, per the spec's algorithm note: 10 % a year. */
const INITIAL_GUESS = '0.1';

/** BR-012-05: the bisection bracket. Just above total loss, up to +1000 % a year. */
const SEARCH_LOW = '-0.9999';
const SEARCH_HIGH = '10';

/** Step size below which the root is settled. Two orders tighter than `RATE_SCALE`. */
const TOLERANCE = '0.00000000000001';

const MAX_NEWTON_ITERATIONS = 50;

/**
 * A **fixed** count, not a budget with an exhaustion path.
 *
 * Once the bracket is known to contain a sign change, the intermediate value
 * theorem guarantees a root inside it, and each halving is guaranteed progress:
 * sixty halvings reduce the 10,9999-wide search range to about 1e-17, which is
 * three orders below `TOLERANCE`. So bisection cannot fail *after* it starts —
 * it can only fail to start, which is the bracket check. Writing it as a fixed
 * loop rather than a budget with a "gave up" branch is deliberate: that branch
 * would be unreachable, and an unreachable branch in a solver reads like a
 * handled case while being dead code the coverage gate would have to be lied to
 * about.
 */
const BISECTION_ITERATIONS = 60;

/** DL-009-08's cousin: XIRR is annualised on **calendar** days, over 365. */
const DAYS_PER_YEAR = '365';

const ONE = Quantity.fromString('1');

export interface XirrInput {
  /** Investor sign convention — negative in, positive out. See `CashFlow`. */
  readonly flows: readonly CashFlow[];
}

export function computeXirr(input: XirrInput): PerformanceResult<XirrResult> {
  const flows = input.flows;
  if (flows.length < 2) {
    return err(domainError(PerformanceErrorCode.XIRR_INSUFFICIENT_FLOWS, { flows: flows.length }));
  }

  const ordered = [...flows].sort((a, b) => BusinessDate.compare(a.date, b.date));
  // Non-null: the length check above guarantees both ends exist.
  const first = (ordered[0] as CashFlow).date;
  const last = (ordered[ordered.length - 1] as CashFlow).date;
  if (first === last) {
    // Every flow on one date. `(1+r)^0 = 1` for all of them, so the equation
    // collapses to `Σ CF = 0` — either trivially true for every rate or false
    // for every rate. Neither is a return.
    return err(domainError(PerformanceErrorCode.XIRR_INSUFFICIENT_FLOWS, { dates: 1 }));
  }

  const hasInflow = ordered.some((flow) => flow.amount.isPositive());
  const hasOutflow = ordered.some((flow) => flow.amount.isNegative());
  if (!hasInflow || !hasOutflow) {
    // Descartes: with no sign change the discounted sum keeps the sign of its
    // terms for every `r > −1`, so there is no root to find anywhere.
    return err(
      domainError(PerformanceErrorCode.XIRR_NO_SIGN_CHANGE, {
        hasInflow,
        hasOutflow,
      }),
    );
  }

  const terms = discountTerms(ordered, first);

  const newton = solveByNewton(terms);
  if (newton !== null) return ok(newton);
  return solveByBisection(terms);
}

/**
 * One flow, reduced to what the solver needs: its amount and its age in years.
 *
 * Computed once rather than per iteration — a fifty-iteration Newton solve over
 * a thousand flows would otherwise recount the same calendar fifty thousand
 * times.
 */
interface DiscountTerm {
  readonly amount: Money;
  /** `d_i / 365`, where `d_i` is calendar days since the first flow. */
  readonly years: Quantity;
}

function discountTerms(flows: readonly CashFlow[], first: BusinessDate): readonly DiscountTerm[] {
  return flows.map((flow) => ({
    amount: flow.amount,
    // `listCalendarDays` is inclusive of both ends, so the elapsed days are one
    // fewer than the dates it returns.
    years: Quantity.fromString(String(listCalendarDays(first, flow.date).length - 1)).dividedBy(
      DAYS_PER_YEAR,
    ),
  }));
}

/** `f(r) = Σ CF_i (1+r)^(−t_i)` — the net present value at rate `r`. */
function presentValue(terms: readonly DiscountTerm[], rate: Rate): Money {
  const base = ONE.plus(rate);
  return sumMoney(terms.map((term) => term.amount.times(powerOf(base, term.years.negated()))));
}

/**
 * `f'(r) = Σ −t_i · CF_i · (1+r)^(−t_i−1)` — the analytic derivative.
 *
 * Analytic rather than a finite difference on purpose: a numerical derivative
 * would introduce a step size, and a step size is a second tolerance to get
 * wrong. The `t_i = 0` term contributes nothing, which is correct — a flow on
 * day zero is not discounted, so moving the rate does not move it.
 */
function derivative(terms: readonly DiscountTerm[], rate: Rate): Money {
  const base = ONE.plus(rate);
  return sumMoney(
    terms.map((term) =>
      term.amount
        .times(powerOf(base, term.years.plus(ONE).negated()))
        .times(term.years)
        .negated(),
    ),
  );
}

/**
 * `base ^ exponent` with a fractional exponent.
 *
 * The one place `Decimal` is touched directly in this file, for the reason
 * `core/valuation/accrual.ts` gives for its own `powFactor`: `Money` and
 * `Quantity` deliberately expose no `pow`, because money is never raised to a
 * power — a *discount factor* legitimately is. The value crosses back through a
 * plain decimal string, so no JS `number` can enter (AR-06), and `decimal.js`
 * is configured once in `core/shared/money.ts`, so this inherits the same
 * forty-digit determinism as every other figure in the system.
 *
 * `base` is `1 + r` and every caller has established `r > −1`, so it is
 * strictly positive and the power is always real.
 */
function powerOf(base: Quantity, exponent: Quantity): Quantity {
  return Quantity.fromString(base.toDecimal().pow(exponent.toDecimal()).toFixed());
}

/**
 * Newton–Raphson from `r = 0,1`. Returns `null` when it cannot finish, which
 * sends the caller to bisection rather than to an answer.
 *
 * Three ways it declines, all of them real:
 *
 *  1. **A flat point.** `f'(r) = 0` leaves the tangent with nowhere to cross,
 *     and the next iterate would be a division by zero.
 *  2. **A step out of the domain.** `(1+r)^t` for fractional `t` is undefined
 *     at or below `r = −1`, and Newton overshoots there readily: a portfolio
 *     that lost almost everything has a root near −0,99, and the first step
 *     from +0,1 can land near −120.
 *  3. **The iteration budget.** Where no real root exists, Newton oscillates
 *     around the curve's maximum indefinitely; it does not diverge to something
 *     obviously wrong, it simply never settles.
 */
function solveByNewton(terms: readonly DiscountTerm[]): XirrResult | null {
  const tolerance = Quantity.fromString(TOLERANCE);
  let rate: Rate = Quantity.fromString(INITIAL_GUESS);

  for (let iteration = 1; iteration <= MAX_NEWTON_ITERATIONS; iteration += 1) {
    const slope = derivative(terms, rate);
    if (slope.isZero()) return null;

    const next = rate.minus(ratio(presentValue(terms, rate), slope));
    if (!ONE.plus(next).isPositive()) return null;

    const settled = next.minus(rate).toDecimal().abs().lessThan(tolerance.toDecimal());
    rate = next;
    if (settled) {
      return { rate: quantizeRate(rate), method: XirrMethod.NEWTON, iterations: iteration };
    }
  }
  return null;
}

/**
 * BR-012-05's documented fallback: bisection over `[−0,9999, 10]`.
 *
 * The bracket check is the whole of the failure mode. `f` is continuous on
 * `(−1, ∞)`, so opposite signs at the ends guarantee a root between them and
 * every halving keeps it there. Equal signs mean the range holds no root — the
 * cash flows are pathological (no real root at all), or the true rate is
 * outside a range that already runs from near-total-loss to +1000 % a year.
 * Either way the honest answer is that the figure is unavailable.
 */
function solveByBisection(terms: readonly DiscountTerm[]): PerformanceResult<XirrResult> {
  let low: Rate = Quantity.fromString(SEARCH_LOW);
  let high: Rate = Quantity.fromString(SEARCH_HIGH);
  const atLow = presentValue(terms, low);

  if (atLow.isNegative() === presentValue(terms, high).isNegative()) {
    return err(
      domainError(PerformanceErrorCode.XIRR_NOT_CONVERGED, {
        low: SEARCH_LOW,
        high: SEARCH_HIGH,
        atLow: atLow.toString(),
      }),
    );
  }

  const lowIsNegative = atLow.isNegative();
  let middle = low;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    middle = low.plus(high).dividedBy('2');
    if (presentValue(terms, middle).isNegative() === lowIsNegative) low = middle;
    else high = middle;
  }

  return ok({
    rate: quantizeRate(middle),
    method: XirrMethod.BISECTION,
    iterations: BISECTION_ITERATIONS,
  });
}

/**
 * BR-012-04 / DL-012-02 — is the gap between the two measures worth explaining?
 *
 * Two different "returns" for one portfolio reads as a bug unless something on
 * the screen says why, and the explanation is the feature: it teaches the
 * distinction at the moment the user is looking at an example of it. The
 * threshold is an argument rather than a constant because SPEC-002 makes
 * thresholds configuration, not code.
 *
 * Compared in **percentage points**, not proportionally: TWR 2 % against XIRR
 * 4 % is a doubling but nobody needs it explained, while 12 % against 19 % is
 * the same ratio and is exactly the case that needs a sentence next to it.
 */
export function divergesMaterially(twr: Rate, xirr: Rate, thresholdPoints: Quantity): boolean {
  const gap = twr.minus(xirr).toDecimal().abs();
  return gap.greaterThanOrEqualTo(thresholdPoints.dividedBy('100').toDecimal());
}

/** Exported for the report use case's default, and for tests to state it once. */
export const DEFAULT_DIVERGENCE_POINTS = Quantity.fromString('2');

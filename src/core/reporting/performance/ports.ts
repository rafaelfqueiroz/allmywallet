import Decimal from 'decimal.js';
import type { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import type { Money } from '@/core/shared/money';
import { Quantity } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import type { DateRange, GroupKey, Grouping } from '@/core/reporting/ports';
import type { IndexSeriesPoint, IndexSeriesReaderPort } from '@/core/valuation/ports';
import type { IndexSeriesCode } from '@/core/quotes/ports';

/**
 * SPEC-012 — the Performance Report's domain types.
 *
 * AR-01/AR-02: declared here, next to the use cases in this directory that need
 * them. Nothing under `core/reporting/` imports a framework, a driver or an
 * adapter, which is what lets every rule below be exercised with no database.
 *
 * BR-011-13 / TS-32: every figure this report produces derives from
 * `daily_valuation_snapshots` and the shared index series. Nothing here reaches
 * the append-only ledger — a five-year replay per request is exactly what the
 * snapshot cache exists to prevent (SPEC-011 DL-011-07).
 */

// ---------------------------------------------------------------------------
// A rate is not money (AR-06)
// ---------------------------------------------------------------------------

/**
 * **A return is a dimensionless ratio, not an amount of reais**, and the
 * distinction is load-bearing: `Money` carries a currency meaning, and a TWR of
 * `0.21` is not twenty-one centavos. Typing returns as `Money` would let
 * `portfolioValue.plus(twr)` compile, which is a sentence with no meaning.
 *
 * It is nonetheless a **decimal**, never a JS `number` (AR-06). `0.1 + 0.2`
 * being wrong by 5.5e-17 matters more in an iterative solver than anywhere
 * else in this codebase, because XIRR compounds every intermediate.
 *
 * `Quantity` is the carrier, following the precedent already set by
 * `core/valuation/accrual.ts`, which represents contracted rates and 252-day
 * compounding factors the same way. Introducing a third numeric class for the
 * same underlying `Decimal` would buy a nominal type at the cost of converting
 * at every boundary with `core/valuation/`, where rates already live as
 * `Quantity`. The alias is what carries the meaning at a call site.
 *
 * Convention throughout this directory: a `Rate` is a **fraction**, never a
 * percentage. `0.21` is 21%. The one place percentages appear is the published
 * BCB series (SGS 12 is % per day), and it is converted on the way in.
 */
export type Rate = Quantity;

export const Rate = {
  of(value: string): Rate {
    return Quantity.fromString(value);
  },
  zero(): Rate {
    return Quantity.zero();
  },
  one(): Rate {
    return Quantity.fromString('1');
  },
};

const ONE = Quantity.fromString('1');
const HUNDRED = Quantity.fromString('100');

/**
 * The scale every **published** rate is quantised to — and the reason it exists
 * at all is the defect PR #34 found in the reporting framework's totals
 * invariant: `dividedBy` fills all forty significant digits for a repeating
 * decimal, and addition at a fixed significant-digit budget is **not
 * associative**, so two partition orders truncated at different points and the
 * totals disagreed at the 35th digit.
 *
 * Contributions (BR-012-16) must sum to the scope's total return *exactly*, and
 * they are sums of quotients — precisely the shape that broke. Quantising each
 * published figure to twelve decimal places puts every addend decades inside
 * the 40-digit budget, so no addition truncates and the sum is exact.
 *
 * **Why twelve and not eight.** `NUMERIC(20,8)` is the storage scale, and a
 * return is never stored — it is computed per request from stored values. As a
 * fraction, 1e-12 is 1e-10 **percentage points**, ten orders of magnitude below
 * BR-012-17's two-decimal display. Eight would be 1e-6 percentage points, still
 * invisible, but a "% do CDI" figure divides one return by another and a
 * quantised divisor propagates its error into the quotient; the extra four
 * digits cost nothing and keep that quotient honest.
 *
 * `ROUND_HALF_UP` for the same reason `core/valuation/snapshot.ts` chose it:
 * it is what Postgres does when it reduces a NUMERIC to scale, so nothing in
 * the system ever has to reconcile two different rounding modes.
 */
export const RATE_SCALE = 12;

export function quantizeRate(rate: Rate): Rate {
  return Quantity.fromString(rate.toDecimal().toFixed(RATE_SCALE, Decimal.ROUND_HALF_UP));
}

/**
 * `gain ÷ base`, as a rate.
 *
 * The one place in this directory `Decimal` is touched directly, for the same
 * reason `accrual.ts`'s `powFactor` is: dividing money by money yields a
 * *ratio*, and `Money.dividedBy` — correctly — returns `Money`. The value
 * crosses back through a plain decimal string, so no JS `number` can enter
 * (AR-06).
 *
 * **The caller must have proven `base` is non-zero.** There is no fallback here
 * on purpose: every call site has a different honest answer to "what is a
 * return on no capital", and burying one of them in a shared helper would put a
 * plausible number where an unavailable belongs.
 */
export function ratio(gain: Money, base: Money): Rate {
  return Quantity.fromString(gain.toDecimal().dividedBy(base.toDecimal()).toFixed());
}

/** `percent` as published (SGS 12 is % per day) → a fraction. */
export function percentToRate(percent: Quantity): Rate {
  return percent.dividedBy(HUNDRED);
}

/** A growth factor `1 + r`. */
export function growthFactor(rate: Rate): Rate {
  return ONE.plus(rate);
}

/** A growth factor back to the return it represents. */
export function factorToReturn(factor: Rate): Rate {
  return factor.minus(ONE);
}

// ---------------------------------------------------------------------------
// Unavailability (BR-012-05, BR-012-18) — declared below, used by `resolveRate`
// ---------------------------------------------------------------------------

/**
 * **Every one of these is a refusal to publish a number, never a zero.**
 *
 * BR-012-05 says it for XIRR — "non-convergence is reported as unavailable,
 * never as zero or as a wrong root" — and BR-012-18 says it for an empty
 * period. The reason generalises to every measure here: a user cannot detect a
 * wrong return, so a plausible-looking figure is worse than a blank one with a
 * reason next to it.
 */
export const PerformanceErrorCode = {
  /** BR-012-18: no snapshot in the period — an empty state, not a 0% return. */
  NO_SERIES: 'PERFORMANCE_NO_SERIES',
  /**
   * A sub-period whose capital base is zero while its value changed: money
   * appeared with no flow behind it. Arithmetically an infinite return, and in
   * practice a gap in the snapshot series — reported, never linked into a
   * product as if it were a fact.
   */
  UNDEFINED_SUBPERIOD_RETURN: 'PERFORMANCE_UNDEFINED_SUBPERIOD_RETURN',
  /** Fewer than two cash flows, or every flow on one date — no root to solve for. */
  XIRR_INSUFFICIENT_FLOWS: 'PERFORMANCE_XIRR_INSUFFICIENT_FLOWS',
  /** All cash flows share a sign: `Σ CF/(1+r)^t` has no zero anywhere. */
  XIRR_NO_SIGN_CHANGE: 'PERFORMANCE_XIRR_NO_SIGN_CHANGE',
  /** Newton diverged and bisection did not bracket a root within the search range. */
  XIRR_NOT_CONVERGED: 'PERFORMANCE_XIRR_NOT_CONVERGED',
  /** The benchmark series has no published point covering the period. */
  BENCHMARK_SERIES_EMPTY: 'PERFORMANCE_BENCHMARK_SERIES_EMPTY',
  /**
   * BR-012-11: "% do CDI" against a CDI accumulation of zero or less. There is
   * no such percentage — 118% of nothing is nothing, and of a negative number
   * it inverts the sign of the comparison.
   */
  BENCHMARK_NOT_POSITIVE: 'PERFORMANCE_BENCHMARK_NOT_POSITIVE',
  /** A real-return deflator of −100%: `(1+n)/(1+i)` with `i = −1`. */
  DEFLATOR_DEGENERATE: 'PERFORMANCE_DEFLATOR_DEGENERATE',
  /**
   * AC-16 / BR-011-02: the daily series is persisted at **portfolio** grain
   * only, so a wallet-scoped time-weighted return has no series behind it.
   * Reported rather than approximated from portfolio figures, which would
   * attach one wallet's name to the whole *patrimônio*'s return.
   */
  SCOPE_SERIES_UNAVAILABLE: 'PERFORMANCE_SCOPE_SERIES_UNAVAILABLE',
  /** A contribution decomposition whose scope base is zero — no weights exist. */
  NO_CAPITAL_BASE: 'PERFORMANCE_NO_CAPITAL_BASE',
} as const;
export type PerformanceErrorCode = (typeof PerformanceErrorCode)[keyof typeof PerformanceErrorCode];

/** Every measure in this directory returns one of these (AR-36). */
export type PerformanceResult<T> = Result<T, DomainError<PerformanceErrorCode>>;

/**
 * `gain ÷ base`, or the reason there is no such rate — **the one refusal policy
 * both return measures share.**
 *
 * `twr.ts` and `modified-dietz.ts` differ in exactly one thing: how they weight
 * the denominator. That difference is the whole algorithmic distinction between
 * a daily link and a period approximation, and it stays in the two files. What
 * must *not* differ is what either of them does when the denominator turns out
 * to be no capital at all, so that decision is made once, here.
 *
 * Two genuinely different situations arrive with a non-positive base, and the
 * numerator separates them:
 *
 *  - **Nothing happened.** A period that began empty, received nothing and
 *    ended empty returned exactly zero, and linking a factor of 1 for it is
 *    correct. Every report over a period starting before the user's first trade
 *    depends on this — refusing here would make "all time" unavailable for
 *    everyone.
 *  - **Something happened with nothing behind it.** Value appeared where there
 *    was no capital and no flow to explain it: arithmetically an infinite
 *    return, in practice a hole in the snapshot series. BR-012-18 is explicit
 *    that this is reported rather than rendered — a 0 % here would be a lie the
 *    user has no way to detect.
 *
 * AR-09 and the quantisation decision: see `RATE_SCALE` above. A sub-period
 * return is a **finished** figure — it is displayed, and it is linked — so it
 * is quantised once, here, at the point it is realised, rather than carried at
 * forty significant digits into a product of a thousand terms.
 */
export function resolveRate(
  gain: Money,
  base: Money,
  context: Readonly<Record<string, string>>,
): PerformanceResult<Rate> {
  if (!base.isPositive()) {
    return gain.isZero()
      ? ok(Rate.zero())
      : err(domainError(PerformanceErrorCode.UNDEFINED_SUBPERIOD_RETURN, context));
  }
  return ok(quantizeRate(ratio(gain, base)));
}

// ---------------------------------------------------------------------------
// The series a return is measured over
// ---------------------------------------------------------------------------

/**
 * One observation of portfolio value on one date (AR-29 — a date, never a
 * timestamp).
 *
 * These come from `daily_valuation_snapshots` and nowhere else. A gap between
 * consecutive dates is not an error: early history predates the snapshot job,
 * and a provider outage leaves holes. BR-012-02 governs what happens then.
 */
export interface SeriesPoint {
  readonly date: BusinessDate;
  readonly value: Money;
}

/**
 * An **external** cash flow, signed from the portfolio's point of view:
 * positive is money in (a buy, a transfer in), negative is money out (a sell, a
 * transfer out).
 *
 * BR-012-01 / SPEC-009: price change is not a flow, and **earnings are not a
 * flow**. Getting that set wrong is precisely what makes a TWR stop being a
 * TWR, because TWR neutralises exactly these and nothing else.
 */
export interface DatedFlow {
  readonly date: BusinessDate;
  readonly amount: Money;
}

/**
 * BR-012-03 — a cash flow in the **investor's** sign convention, which is the
 * *opposite* of `DatedFlow`'s: negative is money the user put in, positive is
 * money that came back to them, and the closing portfolio value is the final
 * positive flow.
 *
 * **A distinct name, deliberately — though not a distinct shape.** XIRR is the
 * one measure in this directory whose sign convention is inverted, and a sign
 * error in it produces a number that is plausible, precise and completely
 * wrong, which is the exact failure this codebase exists to avoid. TypeScript
 * is structural, so this does **not** stop a `DatedFlow[]` reaching the solver
 * — only `cashFlowsFrom` in `report.ts` performing the inversion in one place,
 * and a test asserting the sign of a known-direction flow, actually do that.
 * The separate name is what makes a call site read wrong when it is wrong.
 */
export interface CashFlow {
  readonly date: BusinessDate;
  readonly amount: Money;
}

/**
 * BR-012-02 / DL-012-06 — a sub-period whose return came from Modified Dietz
 * rather than from a daily link, carried out with the result so the UI can name
 * it. **Disclosed, never silently substituted.**
 */
export interface DietzDisclosure {
  readonly range: DateRange;
  /** Calendar days the fallback spanned — 2 means one missing day. */
  readonly spanDays: number;
}

export interface SubPeriodReturn {
  readonly range: DateRange;
  readonly rate: Rate;
  /** True when this sub-period used the Modified Dietz fallback (BR-012-02). */
  readonly dietz: boolean;
}

export interface TwrResult {
  /** BR-012-01: `Π(1 + r_d) − 1` over the period. */
  readonly returnRate: Rate;
  /** The same figure as a growth factor, for chart series and benchmark ratios. */
  readonly factor: Rate;
  readonly subPeriods: readonly SubPeriodReturn[];
  /** BR-012-02: empty when every sub-period had daily data. */
  readonly dietzPeriods: readonly DietzDisclosure[];
}

export const XirrMethod = {
  NEWTON: 'newton',
  BISECTION: 'bisection',
} as const;
export type XirrMethod = (typeof XirrMethod)[keyof typeof XirrMethod];

export interface XirrResult {
  readonly rate: Rate;
  /** Which solver produced the root — Newton, or the bisection fallback. */
  readonly method: XirrMethod;
  readonly iterations: number;
}

// ---------------------------------------------------------------------------
// With and without earnings (BR-012-06..09)
// ---------------------------------------------------------------------------

export const EarningsTreatment = {
  /** BR-012-06: total return — proventos counted as income at pay date. */
  WITH_EARNINGS: 'with_earnings',
  /** BR-012-07: price return only. */
  WITHOUT_EARNINGS: 'without_earnings',
} as const;
export type EarningsTreatment = (typeof EarningsTreatment)[keyof typeof EarningsTreatment];

// ---------------------------------------------------------------------------
// Benchmarks (BR-012-10..14)
// ---------------------------------------------------------------------------

/** BR-012-10 — the three, and only these (`reports.benchmarks`, SPEC-002). */
export const BENCHMARKS = ['CDI', 'IPCA', 'IBOV'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

/**
 * BR-012-12 / DL-012-04 — the two presentations, both offered.
 *
 * The **pure index line** is the correct basis for the headline TWR comparison:
 * it is what the index did, independent of what the user did. The **shadow
 * portfolio** receives the user's actual cash flows on their actual dates at
 * the benchmark's rate, which is what makes "what if I had just left it in
 * CDI?" intuitive. Each is misleading as the sole view.
 */
export interface BenchmarkLine {
  readonly benchmark: Benchmark;
  /** Cumulative growth factor per date, starting at 1 on the period's first date. */
  readonly points: readonly BenchmarkPoint[];
  /** The period's return: last factor − 1. */
  readonly returnRate: Rate;
}

export interface BenchmarkPoint {
  readonly date: BusinessDate;
  readonly factor: Rate;
}

export interface ShadowPortfolioPoint {
  readonly date: BusinessDate;
  readonly value: Money;
}

export interface ShadowPortfolio {
  readonly benchmark: Benchmark;
  readonly points: readonly ShadowPortfolioPoint[];
  /** What the same contributions would be worth today at the benchmark's rate. */
  readonly finalValue: Money;
}

/**
 * AR-03 — a real seam, not one port per entity. The index series arrives
 * through `IndexSeriesReaderPort`, which `core/valuation/` already declares and
 * `DrizzleIndexSeriesRepository` already implements against the shared
 * `index_series` table (AR-15: reference data, no tenant context).
 *
 * Re-exported rather than redeclared: a second interface with the same shape
 * would be a second thing to keep in step for no gain, and the adapter would
 * have to claim both.
 */
/**
 * `IndexSeriesCode` travels with the port because it is the argument
 * `listPoints` takes — an implementer of this contract needs both, and making
 * the second reachable only through `core/quotes/` would be a seam that exists
 * for no reason other than where the type happens to be declared.
 */
export type { IndexSeriesPoint, IndexSeriesReaderPort, IndexSeriesCode };

// ---------------------------------------------------------------------------
// Contribution (BR-012-15, BR-012-16)
// ---------------------------------------------------------------------------

/**
 * One group's figures over the period, as the contribution decomposition needs
 * them.
 *
 * `beginValue` is the group's capital at the period's start and `flow` its net
 * external flow across the period. Both are required rather than derived,
 * because "what did this group start with" is a different question from "what
 * is it worth now" and only the caller knows which series it has.
 */
export interface GroupPeriodFigures {
  readonly key: GroupKey;
  readonly beginValue: Money;
  readonly endValue: Money;
  readonly flow: Money;
}

export interface GroupPerformance {
  readonly key: GroupKey;
  /** BR-012-15: the group's **own** return — `gain ÷ its own base`. */
  readonly ownReturn: Rate | null;
  /** BR-012-15/16: its share of the scope's total return. These sum to the total. */
  readonly contribution: Rate;
  readonly gain: Money;
  readonly base: Money;
  /**
   * `base ÷ scope base` — the weight that makes `contribution = weight ×
   * ownReturn`. Never null: the scope's base is proven positive before any
   * group is described, so every group has a weight even when it has no return.
   */
  readonly weight: Rate;
}

export interface ContributionReport {
  readonly grouping: Grouping;
  readonly groups: readonly GroupPerformance[];
  /** BR-012-16: `Σ groups.contribution`, exactly. */
  readonly totalReturn: Rate;
  readonly totalGain: Money;
  readonly totalBase: Money;
}

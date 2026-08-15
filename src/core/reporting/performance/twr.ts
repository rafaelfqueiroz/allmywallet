import type { BusinessDate } from '@/core/shared/clock';
import { domainError } from '@/core/shared/domain-error';
import { Money, sumMoney } from '@/core/shared/money';
import { err, ok } from '@/core/shared/result';
import { listCalendarDays } from '@/core/valuation/business-days';
import { modifiedDietz } from '@/core/reporting/performance/modified-dietz';
import {
  PerformanceErrorCode,
  Rate,
  factorToReturn,
  growthFactor,
  quantizeRate,
  resolveRate,
  type DatedFlow,
  type DietzDisclosure,
  type PerformanceResult,
  type SeriesPoint,
  type SubPeriodReturn,
  type TwrResult,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-01 — **Time-Weighted Return**, the headline measure.
 *
 * `r_d = (V_end − V_start − F_d) / (V_start + F_d·w)`, linked geometrically:
 * `TWR = Π(1 + r_d) − 1`.
 *
 * **What it is for** (DL-012-01). TWR neutralises deposits and withdrawals, so
 * it measures how the *investments* performed independent of when money went
 * in. That is the only fair basis for comparing against an index: judged by
 * XIRR, a well-timed large deposit makes a mediocre portfolio look brilliant.
 * XIRR answers the other question — what the user actually earned — and
 * `xirr.ts` answers it separately, alongside.
 *
 * **External flows are buys, sells and transfers, and nothing else.** Not price
 * change, and **not earnings** (BR-012-08; SPEC-009's `externalFlow` draws the
 * same line for `net_contributions`). Getting that set wrong is exactly what
 * makes a TWR stop being a TWR — it neutralises these and only these. Earnings
 * enter, when they enter at all, through the *value* series (`report.ts`):
 * they are income received, not capital the user contributed.
 *
 * ---
 *
 * ## The flow-timing convention, and why it is not interchangeable
 *
 * `w` decides where inside the day a flow is assumed to have landed. **This
 * implementation uses `w = 0` — flows at the end of the day, so the denominator
 * is the opening value.** Both alternatives were worked through and the choice
 * is forced rather than stylistic:
 *
 *  - With `w = 1` (flows at the start of the day, denominator `V_start + F_d`),
 *    a full liquidation breaks. A portfolio worth 100 that sells everything for
 *    105 during the day ends at 0 with a flow of −105, so the denominator is
 *    100 − 105 = −5 and the day reports −100 % — a catastrophically wrong
 *    number on an entirely ordinary event.
 *  - With `w = 0` that same day reads `(0 − 100 + 105) / 100 = +5 %`, which is
 *    what actually happened.
 *
 * `w = 0` is also what makes the **defining property exact rather than
 * approximate** (TS-09, AC-2). A deposit `F` on a day adds `F` to `V_end` and
 * subtracts `F` in the numerator — they cancel — and leaves the denominator
 * untouched, so the day's return with the deposit is *bit-for-bit* the day's
 * return without it. Under `w = 1` it would merely be close, and a test
 * asserting the invariant would have to assert an approximation instead, which
 * is no test of an invariant at all.
 *
 * The one case `w = 0` cannot answer alone is a period that opens at zero:
 * dividing by the opening value is dividing by nothing. There, and only there,
 * the base falls back to `V_start + F_d` — for a portfolio that held nothing
 * before, the flow *is* the capital at work, which is not an approximation
 * either. `modified-dietz.ts` makes the same fallback for the same reason, so
 * the two measures agree on the degenerate cases as well as the ordinary ones.
 *
 * ---
 *
 * ## Where rounding happens, and why it is not "once, at display"
 *
 * AR-09 says rounding happens once, at display. Geometric linking is in genuine
 * tension with that, and the tension is resolved deliberately rather than by
 * accident:
 *
 *  - **Each sub-period return is quantised to `RATE_SCALE` as it is realised**
 *    (in `resolveRate`), and the quantised value is what gets linked.
 *  - The linked factor is quantised **once more** on publication, and the
 *    reported return is `factor − 1` taken from that same quantised factor, so
 *    the two published figures can never disagree with each other.
 *
 * The alternative — link at full precision, round only the answer — is worse
 * here, for a reason that has already bitten this codebase once (see
 * `base-query.ts`): `dividedBy` fills all forty significant digits for a
 * repeating decimal, so a product of a thousand such terms carries forty digits
 * of which perhaps fifteen mean anything. It would also make the published
 * figure **unreconcilable** — a user, or a support conversation, linking the
 * sub-period returns the report shows would not reproduce the headline.
 * Quantising where each figure is realised means the published parts multiply
 * to the published whole.
 *
 * The cost is bounded and tiny: each quantisation moves a factor by at most
 * 5e-13, so over 1.826 days (five years) the accumulated relative error stays
 * under 1e-9 — that is 1e-7 **percentage points**, five orders of magnitude
 * below BR-012-17's two-decimal display.
 */
export interface TwrInput {
  /** Ascending by date, one point per observation — `daily_valuation_snapshots`. */
  readonly points: readonly SeriesPoint[];
  /** BR-012-01: external flows only, signed positive into the portfolio. */
  readonly flows: readonly DatedFlow[];
}

export function computeTwr(input: TwrInput): PerformanceResult<TwrResult> {
  const points = input.points;
  if (points.length === 0) {
    // BR-012-18 / AC-15: no series at all is an explanatory empty state. A 0 %
    // return would claim the portfolio was flat, which is a different fact from
    // "there was no portfolio".
    return err(domainError(PerformanceErrorCode.NO_SERIES, { points: 0 }));
  }
  if (points.every((point) => point.value.isZero())) {
    // BR-012-18, the other empty case: the scope held nothing on any date in
    // the period. Every sub-period would resolve to a legitimate zero and link
    // to a confident 0 %, which is precisely the misleading zero the rule
    // forbids — "you earned nothing" reads very differently from "you held
    // nothing".
    return err(domainError(PerformanceErrorCode.NO_SERIES, { points: points.length }));
  }

  const flowsByDate = totalFlowByDate(input.flows);

  let factor = Rate.one();
  const subPeriods: SubPeriodReturn[] = [];
  const dietzPeriods: DietzDisclosure[] = [];

  for (let index = 1; index < points.length; index += 1) {
    // Non-null: `index` runs strictly inside the array's bounds.
    const start = points[index - 1] as SeriesPoint;
    const end = points[index] as SeriesPoint;
    const range = { from: start.date, to: end.date };
    const spanDays = calendarSpan(start.date, end.date);
    const dietz = spanDays !== 1;

    const rate = dietz
      ? // BR-012-02 / DL-012-06: a hole in the daily series — early history, or
        // a provider outage. Approximated by Modified Dietz **and disclosed**,
        // never silently substituted.
        modifiedDietz({
          from: start.date,
          to: end.date,
          beginValue: start.value,
          endValue: end.value,
          flows: input.flows,
        })
      : dailyReturn(start, end, flowsByDate.get(end.date) ?? Money.zero());
    if (!rate.ok) return rate;

    if (dietz) dietzPeriods.push({ range, spanDays });
    subPeriods.push({ range, rate: rate.value, dietz });
    factor = factor.times(growthFactor(rate.value));
  }

  const published = quantizeRate(factor);
  return ok({
    returnRate: factorToReturn(published),
    factor: published,
    subPeriods,
    dietzPeriods,
  });
}

/**
 * BR-012-01 — one day's return, on the end-of-day flow convention argued for
 * above: `(V_end − V_start − F) / V_start`.
 *
 * The base falls back to `V_start + F` only when the day opened at zero, which
 * is the day a portfolio comes into existence — or comes back, after having
 * been closed out entirely. `resolveRate` decides what a base that is *still*
 * empty means.
 *
 * Worked example (DV-17), hand-computed — the day a deposit lands:
 *
 *   V_start = 100.000,00   V_end = 120.000,00   F = +10.000,00 (a buy)
 *   gain    = 120.000 − 100.000 − 10.000 = 10.000
 *   r_d     = 10.000 ÷ 100.000 = **0,10** → 10 %
 *
 * The same day *without* the deposit would have closed at 110.000,00, giving
 * `10.000 ÷ 100.000` — the identical figure. That is the whole point of the
 * measure, and it is why the denominator must not see `F`.
 */
function dailyReturn(start: SeriesPoint, end: SeriesPoint, flow: Money): PerformanceResult<Rate> {
  const gain = end.value.minus(start.value).minus(flow);
  const base = start.value.isPositive() ? start.value : start.value.plus(flow);
  return resolveRate(gain, base, {
    from: start.date,
    to: end.date,
    beginValue: start.value.toString(),
    endValue: end.value.toString(),
    flow: flow.toString(),
  });
}

/**
 * Flows summed per date. Three buys on one day are one day's flow — the series
 * carries one observation for that date, so the arithmetic gets one number.
 */
function totalFlowByDate(flows: readonly DatedFlow[]): ReadonlyMap<BusinessDate, Money> {
  const byDate = new Map<BusinessDate, Money[]>();
  for (const flow of flows) {
    const existing = byDate.get(flow.date);
    if (existing === undefined) byDate.set(flow.date, [flow.amount]);
    else existing.push(flow.amount);
  }
  return new Map([...byDate].map(([date, amounts]) => [date, sumMoney(amounts)]));
}

/** Calendar days between two dates — 1 for consecutive days, more across a gap. */
function calendarSpan(from: BusinessDate, to: BusinessDate): number {
  // `listCalendarDays` is inclusive of both ends, so the number of *steps* is
  // one less than the number of dates it returns.
  return listCalendarDays(from, to).length - 1;
}

import { BusinessDate } from '@/core/shared/clock';
import type { Money } from '@/core/shared/money';
import { Quantity, sumMoney } from '@/core/shared/money';
import { listCalendarDays } from '@/core/valuation/business-days';
import {
  resolveRate,
  type DatedFlow,
  type PerformanceResult,
  type Rate,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-02 / DL-012-06 — **Modified Dietz, the disclosed fallback.**
 *
 * `R = (V_end − V_begin − F) / (V_begin + Σ F_i·w_i)`, with
 * `w_i = (D − d_i) / D`: the share of the period each flow was actually
 * invested for, where `D` is the period's length in calendar days and `d_i` is
 * the flow's day offset from the start.
 *
 * **Why it exists at all.** A daily-linked TWR needs a portfolio value on every
 * date. Gaps happen — early history predates the snapshot job, and a provider
 * outage leaves holes — and DL-012-06 rejects both of the easy answers:
 * refusing leaves the user with nothing, and substituting silently
 * misrepresents the precision of a figure they cannot check. So it is computed
 * *and* labelled, and `twr.ts` carries the labelled sub-periods out with the
 * result for the UI to name.
 *
 * **The interval is half-open: `(from, to]`.** `from` is the baseline date, and
 * a snapshot's value on a date already includes every trade made on that date
 * (SPEC-009's `valuePortfolioAt` replays to and including `asOf`). So a flow
 * dated `from` is already inside `V_begin` and belongs to the *previous*
 * sub-period; counting it again here would double it. Flows outside the
 * interval are dropped rather than rejected — a caller passing the whole
 * period's flow list to each sub-period is the ordinary use, not an error.
 *
 * **Worked example (DV-17), hand-computed.** January 2026, R$ 100.000,00 at the
 * start, R$ 112.000,00 at the end, with R$ 10.000,00 deposited on the 11th:
 *
 *   D    = 31 Jan − 1 Jan            = 30 calendar days
 *   d    = 11 Jan − 1 Jan            = 10
 *   w    = (30 − 10) / 30            = 2/3
 *   num  = 112.000 − 100.000 − 10.000 = 2.000
 *   den  = 100.000 + 10.000 × 2/3     = 106.666,66…  (= 320.000/3)
 *   R    = 2.000 ÷ (320.000/3) = 6.000 / 320.000 = **0,01875** → 1,875 %
 *
 * Note what the weighting buys: the naive `2.000 ÷ 100.000 = 2 %` overstates
 * the return by crediting the whole gain to the opening capital, and
 * `2.000 ÷ 110.000 = 1,818 %` understates it by pretending the deposit was
 * there from 1 January. The money was present for two thirds of the month, and
 * that is what the denominator says.
 */
export interface ModifiedDietzInput {
  readonly from: BusinessDate;
  readonly to: BusinessDate;
  readonly beginValue: Money;
  readonly endValue: Money;
  /** BR-012-01: external flows only — never price change, never earnings. */
  readonly flows: readonly DatedFlow[];
}

export function modifiedDietz(input: ModifiedDietzInput): PerformanceResult<Rate> {
  const applicable = input.flows.filter(
    (flow) =>
      BusinessDate.isAfter(flow.date, input.from) && !BusinessDate.isAfter(flow.date, input.to),
  );
  const totalFlow = sumMoney(applicable.map((flow) => flow.amount));

  // The gain the period actually produced: what it ended at, less what it
  // started with, less the money that was put in rather than earned. This is
  // the numerator of every return measure in this directory, and it is the same
  // whichever weighting the denominator uses.
  const gain = input.endValue.minus(input.beginValue).minus(totalFlow);

  // The refusal policy is shared with `twr.ts`'s daily formula deliberately
  // (`resolveRate`): the two measures differ in how they weight the
  // denominator, which is the whole algorithmic distinction between them, and
  // agree exactly on what to do when there is no denominator to speak of.
  return resolveRate(gain, weightedBase(input, applicable, totalFlow), {
    from: input.from,
    to: input.to,
    beginValue: input.beginValue.toString(),
    endValue: input.endValue.toString(),
    flow: totalFlow.toString(),
  });
}

/**
 * `V_begin + Σ F_i·w_i` — the average capital the period had at work.
 *
 * May come back zero or negative, which `resolveRate` turns into a zero return
 * or an unavailable depending on whether anything actually happened.
 *
 * **The fallback at the end is the only interesting decision here.** A
 * period that opens at zero and is funded by a flow on its closing date gets
 * `w = 0` for that flow, so the weighted base is zero — and yet the money
 * plainly was invested, because the closing value proves it. Falling back to
 * `V_begin + ΣF` treats the flow as having been present for the whole period,
 * which for a portfolio that had nothing before it is not an approximation but
 * the literal truth: the flow *is* the capital. The alternative — refusing —
 * would make every portfolio's first period unavailable, which is the period
 * every new user looks at first.
 *
 * A base that is still not positive after the fallback is a full liquidation
 * inside the period (withdrawals exceeding the opening capital), where Modified
 * Dietz is genuinely undefined. That case is why `twr.ts` sub-divides at every
 * snapshot date it has: a liquidation *day* is handled exactly by the daily
 * formula, and only a liquidation inside a snapshot *gap* is unanswerable.
 */
function weightedBase(
  input: ModifiedDietzInput,
  applicable: readonly DatedFlow[],
  totalFlow: Money,
): Money {
  const days = listCalendarDays(input.from, input.to);
  // `listCalendarDays` is inclusive of both ends, so a 30-day period yields 31
  // entries; `D` is the number of *steps* between them.
  const span = days.length - 1;
  if (span <= 0) {
    // A zero-length or reversed period. There is no elapsed time to weight a
    // flow across, so the only base available is the opening capital plus
    // whatever arrived — and if that is nothing, `resolveRate`'s numerator check
    // decides between "nothing happened" and "unavailable".
    return input.beginValue.plus(totalFlow);
  }

  const offsets = new Map<BusinessDate, number>();
  days.forEach((date, index) => offsets.set(date, index));
  const total = Quantity.fromString(String(span));

  let base = input.beginValue;
  for (const flow of applicable) {
    // Non-null: `applicable` holds only flows inside `(from, to]`, and every
    // date in that interval is a key of the map built from the same bounds.
    const offset = offsets.get(flow.date) as number;
    const weight = Quantity.fromString(String(span - offset)).dividedBy(total);
    base = base.plus(flow.amount.times(weight));
  }
  return base.isPositive() ? base : input.beginValue.plus(totalFlow);
}

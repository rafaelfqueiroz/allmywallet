import { domainError } from '@/core/shared/domain-error';
import type { Money } from '@/core/shared/money';
import { sumMoney } from '@/core/shared/money';
import { err, ok } from '@/core/shared/result';
import { compareGroupKeys } from '@/core/reporting/grouping';
import type { Grouping } from '@/core/reporting/ports';
import {
  PerformanceErrorCode,
  Rate,
  quantizeRate,
  ratio,
  type ContributionReport,
  type GroupPerformance,
  type GroupPeriodFigures,
  type PerformanceResult,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-15/16, DL-012-07 — **each group's own return, and its
 * contribution to the scope's.**
 *
 * These are two different facts and the spec insists on both, because a group
 * can outperform while contributing almost nothing: a 200 % gain on 1 % of the
 * *patrimônio* moves it by 2 points, while a 20 % gain on half of it moves it
 * by 10. "Which of my holdings did best" and "which of my holdings actually
 * moved my portfolio" have different answers, and only the second one is
 * actionable.
 *
 * ## The decomposition, and why the sum is exact rather than close
 *
 * For each group, over the period:
 *
 *   `base_g   = beginValue_g + flow_g`   — the capital committed to it
 *   `gain_g   = endValue_g − beginValue_g − flow_g`  — what it actually earned
 *   `own_g    = gain_g ÷ base_g`         — BR-012-15's "own return"
 *   `weight_g = base_g ÷ Σ base`
 *   `contrib_g = gain_g ÷ Σ base = weight_g × own_g`
 *
 * and therefore `Σ contrib_g = Σ gain_g ÷ Σ base = the scope's total return`.
 * That identity is the whole point of BR-012-16: DL-012-07 keeps it as a
 * requirement precisely because it *catches aggregation bugs* — a
 * double-counted allocation or a dropped "Not classified" group shows up as a
 * breakdown that no longer adds up.
 *
 * **Which is why the identity must hold exactly, not nearly.** Each
 * contribution is a quotient, `dividedBy` fills all forty significant digits
 * for a repeating decimal, and addition at a fixed digit budget is not
 * associative — that is precisely how PR #34's totals invariant failed, at the
 * 35th significant digit. So this uses the same construction `base-query.ts`'s
 * `distributeExact` does: quantise each share as it is realised, and give the
 * **last group the residual** `totalReturn − Σ(others)`. The sum is then exact
 * by construction rather than by luck, and the residual is at most (n−1) units
 * of the twelfth decimal place — nine orders of magnitude below the two
 * decimals BR-012-17 displays.
 *
 * ## What `beginValue` should be, and the honest limit of it
 *
 * The decomposition is stated over whatever base the caller supplies, because
 * only the caller knows which series it has. Two are meaningful:
 *
 *  - **period figures** — the group's value on the period's first date, with
 *    its external flows across the period. This is a true period return.
 *  - **cost basis** — the group's *preço médio* × quantity, with zero flow.
 *    This is return on invested capital, which is what the position cache can
 *    answer today, and what `report.ts` supplies.
 *
 * What this is **not** is a decomposition of the geometrically-linked TWR.
 * Attributing a multi-period linked return to its parts requires a smoothing
 * algorithm (Cariño, Menchero) *and* a per-group daily value series with flows
 * — and `daily_valuation_snapshots` is persisted at portfolio grain only.
 * Producing a plausible number without that series would be inventing the very
 * thing this report exists not to invent, so the contribution figures are
 * reported on their own stated basis and `report.ts` labels which one.
 */
export function decomposeContributions(
  grouping: Grouping,
  figures: readonly GroupPeriodFigures[],
): PerformanceResult<ContributionReport> {
  // Deterministic order, and the same order every other report uses (SPEC-011
  // `compareGroupKeys`: synthetic buckets last, everything else by id). It
  // matters twice — the report is reproducible, and the residual below always
  // lands on the same group rather than wherever the caller happened to put it.
  const groups = [...figures].sort((a, b) => compareGroupKeys(a.key, b.key));

  const bases = groups.map(baseOf);
  const gains = groups.map(gainOf);
  const totalBase = sumMoney(bases);
  const totalGain = sumMoney(gains);

  if (!totalBase.isPositive()) {
    // BR-012-18 / DL-012-07: with no capital in the scope there are no weights,
    // so there is nothing to apportion a return across. Reported rather than
    // rendered as a table of zeroes, which would read as "every group returned
    // nothing" instead of "there was nothing here".
    return err(
      domainError(PerformanceErrorCode.NO_CAPITAL_BASE, {
        groups: groups.length,
        totalBase: totalBase.toString(),
      }),
    );
  }

  const totalReturn = quantizeRate(ratio(totalGain, totalBase));

  const performances: GroupPerformance[] = [];
  let apportioned = Rate.zero();
  groups.forEach((group, index) => {
    // Non-null: `bases` and `gains` were mapped from this same array.
    const base = bases[index] as Money;
    const gain = gains[index] as Money;
    const last = index === groups.length - 1;
    // The residual. This line is what makes BR-012-16 exact.
    const contribution = last
      ? totalReturn.minus(apportioned)
      : quantizeRate(ratio(gain, totalBase));
    apportioned = apportioned.plus(contribution);

    performances.push({
      key: group.key,
      // A group with no capital of its own has no return of its own — it was
      // opened and closed inside the period, or its flows net to nothing
      // against its opening value. `null`, never a zero: "this group returned
      // 0 %" is a claim, and it would be an unfounded one.
      ownReturn: base.isPositive() ? quantizeRate(ratio(gain, base)) : null,
      contribution,
      gain,
      base,
      weight: quantizeRate(ratio(base, totalBase)),
      estimated: group.estimated,
    });
  });

  return ok({
    grouping,
    groups: performances,
    totalReturn,
    totalGain,
    totalBase,
    estimated: performances.some((group) => group.estimated),
  });
}

/** The capital committed to a group over the period. */
function baseOf(group: GroupPeriodFigures): Money {
  return group.beginValue.plus(group.flow);
}

/**
 * What the group earned: what it ended at, less what it started with, less the
 * money that was put in rather than made. The same numerator every return
 * measure in this directory uses.
 */
function gainOf(group: GroupPeriodFigures): Money {
  return group.endValue.minus(group.beginValue).minus(group.flow);
}

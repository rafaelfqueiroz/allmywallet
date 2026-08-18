import { Money } from '@/core/shared/money';
import type {
  CompositionRow,
  Concentration,
  UnflaggedRow,
} from '@/core/reporting/composition/ports';

/**
 * SPEC-015 BR-015-05/06 — the concentration flag.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE PLACE THE PRODUCT COMES CLOSEST TO AN OPINION
 *
 * And it must not cross. DL-015-03 and PRD risk R7: AllMyWallet is not a
 * licensed advisor, and a flag that said "consider reducing this position"
 * would make it one. So this module decides exactly one thing — *does this
 * asset's share exceed the number the user set* — and it decides nothing at
 * all about what that means.
 *
 * Three consequences follow, and all three are load-bearing:
 *
 *  1. **The threshold is the user's**, resolved from
 *     `reports.concentration_threshold_pct` (SPEC-002, default 20). A fixed
 *     threshold would be the product's judgement about what is too much;
 *     a configurable one is an alarm the user sets themselves.
 *  2. **The threshold travels with the result** (`Concentration.thresholdPct`),
 *     so the screen can name it. "Acima de 20 %" is a statement of fact about
 *     a setting. "Concentrado" alone is a verdict.
 *  3. **Wording lives in the message catalogue, reviewed by a human.** BR-015-06
 *     and the spec's own acceptance criterion are explicit that it is "verified
 *     by review, not just by test", because no assertion can tell advice from
 *     description. Nothing in this file renders a word.
 * ---------------------------------------------------------------------------
 */

/**
 * BR-015-05 — the configured percent as the fraction shares are expressed in.
 *
 * The registry stores an **integer percent** (`20`) so the key can be
 * range-checked as `1..100` and typed by a human in settings; shares are
 * fractions (`0,2`). The ÷100 happens here, once, at the boundary between the
 * two — the same arrangement SPEC-012's basis-point divergence key uses, for
 * the same reason: a conversion duplicated at two call sites is a conversion
 * that will eventually be done once at one of them.
 */
export function concentrationThreshold(thresholdPct: number): Money {
  return Money.fromString(String(thresholdPct)).dividedBy('100');
}

/**
 * BR-015-05 — "flags when a single asset **exceeds** a user-configurable share".
 *
 * **Strictly exceeds.** An asset sitting at exactly the threshold is not
 * flagged, which is what the word "exceeds" means and what a user setting 20
 * expects of a position at 20,00 %. The boundary is asserted rather than
 * assumed, because `>` and `>=` are one character apart and the difference is
 * invisible on every portfolio except the one it is wrong for.
 *
 * A `null` share — the scope totals zero — is never flagged. Nothing can
 * exceed a share of a portfolio that holds nothing, and the alternative would
 * be to flag every row of an empty report.
 */
export function flagConcentration(
  rows: readonly UnflaggedRow[],
  thresholdPct: number,
): { readonly rows: readonly CompositionRow[]; readonly concentration: Concentration } {
  const threshold = concentrationThreshold(thresholdPct);

  const flagged = rows.map((row) => ({
    ...row,
    concentrated: row.share !== null && row.share.comparedTo(threshold) > 0,
  }));

  return {
    rows: flagged,
    concentration: {
      thresholdPct,
      // `rows` arrives sorted largest-first (`assetRows`), so the flagged ids
      // are already in the order the screen lists them.
      flagged: flagged.filter((row) => row.concentrated).map((row) => row.assetId),
    },
  };
}

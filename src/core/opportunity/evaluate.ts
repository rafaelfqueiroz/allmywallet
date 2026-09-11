import { isQuoteStale } from '@/core/quotes/staleness';
import { BusinessDate, businessDateInSaoPaulo } from '@/core/shared/clock';
import type { Money } from '@/core/shared/money';
import type { OpportunityRule, OpportunityState, StoredQuote } from '@/core/opportunity/ports';

/**
 * SPEC-018 BR-018-11..16 — turning one stored quote into the state one rule
 * currently reads.
 *
 * Reuses `isQuoteStale` from `core/quotes` rather than a second staleness
 * rule (SPEC-008 DL-008-03): that function reports a stored quote as **not**
 * stale outside the trading session, which is exactly the behaviour this
 * feature wants too — Friday's close on a Saturday is the price the whole
 * product still shows, and marking every rule `unknown` all weekend would
 * disagree with every other screen for no reason. `core/opportunity`
 * importing `core/quotes` is fine: both are `core/` (AR-01 forbids reaching
 * into `adapters/`/`next`/`drizzle`, not a sibling domain module).
 */

export interface EvaluationTiming {
  readonly sessionOpen: boolean;
  readonly cadenceMinutes: number;
  readonly now: Date;
  /**
   * BR-018-16, the daily tier's half of "stale beyond its tier": the oldest
   * business date a published close may carry and still be read as current —
   * the most recent trading day strictly before today
   * (`previousTradingDay`, `core/quotes/staleness.ts`).
   *
   * A daily price has no cadence to be late against, but it can still be
   * genuinely old: a `tesouro.sync` dead-lettering for three weeks leaves a
   * three-week-old close in `price_quotes`, and a state computed from it
   * would be confident and wrong. Calendar-derived rather than a tolerance in
   * days, so weekends and B3 holidays need no special case.
   */
  readonly dailyQuoteFloor: BusinessDate;
}

/**
 * A discriminated union rather than `{ state, matched, threshold }` with
 * `matched`/`quote` nullable: when the state is known, `run-evaluation.ts`
 * needs the exact quote that produced it (its price, `quotedAt`, `source`) to
 * build an `OpportunityAlert`. Carrying the quote inside the non-`unknown`
 * branch lets that read happen through a type-narrowed field instead of a
 * defensive null check on a `quote` variable that — once this function has
 * run — the caller can prove is never null.
 */
export type EvaluatedResult =
  | { readonly state: 'unknown' }
  | {
      readonly state: OpportunityState;
      readonly matched: 'lower' | 'upper' | 'default';
      /** `null` when the default band matched — there is no single threshold to name. */
      readonly threshold: Money | null;
      readonly quote: StoredQuote;
    };

/**
 * BR-018-12/16 — the pure comparison. No port, no clock read: `timing.now` is
 * handed in by the caller, which is what makes this testable without
 * mocking a clock and is also what SPEC-008's own `pollHeldAsset` does with
 * the identical staleness check.
 *
 * BR-018-12/BR-018-08: **a price exactly on a bound matches that bound.**
 * "Below R$ 30 = buy" fires at exactly R$ 30,00 — a threshold the price has
 * reached is a threshold that has been reached, not one still pending. The
 * comparisons below are therefore `<=`/`>=`, not `<`/`>`. Because BR-018-08
 * forbids `lower.price >= upper.price` at write time, a price can satisfy at
 * most one of the two conditions, so checking `lower` before `upper` is an
 * arbitrary evaluation order, never a precedence rule standing in for one.
 */
export function evaluateRule(
  rule: OpportunityRule,
  quote: StoredQuote | null,
  timing: EvaluationTiming,
): EvaluatedResult {
  if (quote === null) return { state: 'unknown' };
  /*
   * BR-018-16 — "stale beyond **its tier**". The cadence test belongs to the
   * intraday tier and only to it: a `daily` quote is a published close, which
   * is republished once a day and is the price every other screen shows for
   * that asset until the next one lands (`core/valuation/tesouro.ts`). Timing
   * it against `quotes.cadence_minutes` would report a Tesouro Direto holding
   * as `unknown` within half an hour of every session opening, while
   * Patrimônio priced the very same position from the very same row without
   * qualification — two screens disagreeing about one asset, which is the
   * outcome BR-018-14 exists to rule out.
   */
  if (quote.tier === 'intraday') {
    if (isQuoteStale(timing.sessionOpen, timing.cadenceMinutes, timing.now, quote.fetchedAt)) {
      return { state: 'unknown' };
    }
  } else if (
    /*
     * The daily tier's own test. Without it this branch was an escape hatch
     * from BR-018-16 rather than a second reading of it: any quote tagged
     * `daily` was structurally incapable of reading `unknown`, however old.
     *
     * The close's business date is read from `quotedAt` in São Paulo, which
     * is exact because the adapter builds that instant at noon UTC precisely
     * so it names one calendar day in both zones
     * (`adapters/db/opportunity-read-adapters.ts`).
     */
    BusinessDate.isBefore(businessDateInSaoPaulo(quote.quotedAt), timing.dailyQuoteFloor)
  ) {
    return { state: 'unknown' };
  }

  if (rule.lower !== null && quote.price.comparedTo(rule.lower.price) <= 0) {
    return { state: rule.lower.state, matched: 'lower', threshold: rule.lower.price, quote };
  }
  if (rule.upper !== null && quote.price.comparedTo(rule.upper.price) >= 0) {
    return { state: rule.upper.state, matched: 'upper', threshold: rule.upper.price, quote };
  }
  return { state: rule.defaultState, matched: 'default', threshold: null, quote };
}

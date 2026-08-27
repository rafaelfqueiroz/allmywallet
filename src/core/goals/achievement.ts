import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { UserId, WalletGoalId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { GoalDependencies } from '@/core/goals/dependencies';
import { GoalErrorCode, goalError } from '@/core/goals/errors';

/**
 * SPEC-019 BR-019-23..26 — reaching a goal, recording that it happened, and
 * saying so exactly once.
 */

/**
 * BR-019-23 — **reaches or exceeds.** The boundary is inclusive, and it is the
 * boundary the rule names, so it is the one the tests assert at: a goal of
 * R$ 500,00 met by a month paying exactly R$ 500,00 is achieved.
 *
 * One definition, used by both progress modules. Two comparisons written
 * independently is how a growth goal and an earnings goal end up disagreeing
 * about what "reached" means at the only value where the difference shows.
 */
export function reachedAmount(progress: Money, amount: Money): boolean {
  return progress.comparedTo(amount) >= 0;
}

/**
 * What one evaluation did. `newlyAchieved` is the **transition**, and it is
 * the only thing that may cause an email.
 */
export interface AchievementOutcome {
  readonly goalId: WalletGoalId;
  /** BR-019-24/26 — the original date, on every later evaluation too. */
  readonly achievedOn: BusinessDate | null;
  readonly newlyAchieved: boolean;
  /** BR-019-25 — false when the user has not opted in, which is not a failure. */
  readonly notified: boolean;
}

/**
 * BR-019-24/25/26 — record the achievement, once.
 *
 * `reached` is computed by whichever progress module owns the goal's kind
 * (`growthProgress().achieved`, `earningsProgress().achieved`) and handed in,
 * so this function has one job and both kinds get identical write and
 * notification behaviour.
 *
 * **Three properties, in the order they matter:**
 *
 *  1. *Set once.* A goal already carrying `achievedOn` returns that date and
 *     writes nothing — so re-evaluation is free, and BR-019-26's dip case
 *     (`reached` false, marker present) needs no special branch: it falls out
 *     of never clearing.
 *  2. *One email.* The send is gated on the same transition as the write, and
 *     happens **after** it — a failed write must not produce an email about an
 *     achievement the database does not record. The set-once `WHERE
 *     achieved_on IS NULL` on `markAchieved` is what makes this hold under
 *     concurrency; this re-read is what makes it hold in a single caller.
 *  3. *Consent gates the send, not the marker.* A user who has not opted in
 *     still gets the marker and the date on screen (BR-019-24); they simply do
 *     not get mail.
 */
export async function recordAchievement(
  deps: GoalDependencies,
  userId: UserId,
  goalId: WalletGoalId,
  reached: boolean,
  /**
   * BR-019-24 — **the date the goal was reached**, computed by whichever
   * progress module owns the goal's kind: the first sampled date the burn-up
   * crossed the amount, or the pay date of the provento that carried an
   * earnings goal over it.
   *
   * `null` only when `reached` is false, or when progress says the goal is met
   * but cannot name a date for it. The clock is the fallback and nothing more —
   * see the note at the assignment below for why it must not be the default.
   */
  achievedOn: BusinessDate | null,
): Promise<Result<AchievementOutcome, DomainError<GoalErrorCode>>> {
  // Re-read rather than trust the caller's copy: the caller computed `reached`
  // from a chart it may have been holding for a while, and the marker is the
  // one field where acting on a stale read sends a duplicate email.
  const goal = await deps.goals.findById(goalId);
  if (goal === null || goal.userId !== userId) {
    return err(goalError(GoalErrorCode.GOAL_NOT_FOUND, { goalId }));
  }

  if (goal.achievedOn !== null) {
    return ok({ goalId, achievedOn: goal.achievedOn, newlyAchieved: false, notified: false });
  }

  if (!reached) {
    return ok({ goalId, achievedOn: null, newlyAchieved: false, notified: false });
  }

  /**
   * **The date it happened, not the date it was noticed.**
   *
   * This product's onboarding is importing years of B3 extracts, so the first
   * render of this page routinely evaluates goals the user crossed years ago.
   * Stamping `clock.today()` would date every one of them to that afternoon —
   * and BR-019-26 means the wrong date is permanent. The clock survives only
   * as the fallback for a goal that is genuinely met right now and whose
   * progress could not name a crossing point.
   */
  const recordedOn = achievedOn ?? deps.clock.today();

  /**
   * **The send is gated on the write having happened, not on having attempted
   * it.** `markAchieved` is `WHERE achieved_on IS NULL` and reports whether it
   * matched; under two overlapping renders of this page — two tabs, or a
   * prefetch racing a navigation — both callers reach here with the row still
   * unmarked, one UPDATE wins and the other matches nothing. Sending on the
   * attempt would put two emails on one achievement, which is precisely what
   * BR-019-25 forbids.
   */
  const marked = await deps.goals.markAchieved(goalId, recordedOn);
  if (!marked) {
    // Somebody else marked it between the read above and this write. Re-read
    // so the caller renders *their* date rather than the one this call would
    // have written and did not (BR-019-26: the first date stands).
    const current = await deps.goals.findById(goalId);
    return ok({
      goalId,
      achievedOn: current?.achievedOn ?? null,
      newlyAchieved: false,
      notified: false,
    });
  }

  const notified = await notifyIfConsented(deps, userId, goalId, recordedOn);
  return ok({ goalId, achievedOn: recordedOn, newlyAchieved: true, notified });
}

/**
 * BR-019-25 — SPEC-004's `email_reminders` purpose decides.
 *
 * The three-part test (`a row exists`, `it was granted`, `it was not revoked`)
 * is the same one `listConsents` applies in `core/privacy/consent.ts`; it is
 * written out rather than reached through `listConsents` because that function
 * needs the whole `PrivacyDependencies` bundle — including the audit port —
 * to answer a question this module asks about one purpose.
 */
async function notifyIfConsented(
  deps: GoalDependencies,
  userId: UserId,
  goalId: WalletGoalId,
  achievedOn: BusinessDate,
): Promise<boolean> {
  const consent = await deps.consents.findByPurpose(userId, 'email_reminders');
  if (consent === null || consent.grantedAt === null || consent.revokedAt !== null) return false;

  await deps.notifications.sendGoalAchieved(userId, goalId, achievedOn);
  return true;
}

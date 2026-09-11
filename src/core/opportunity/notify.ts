import { SAO_PAULO_TIME_ZONE } from '@/core/shared/clock';
import type { EvaluatedState, OpportunityState } from '@/core/opportunity/ports';

/**
 * SPEC-018 BR-018-21..27 — whether a state change earns an email, and why.
 *
 * `decideNotification` is pure: every input it needs — consent, mute, the
 * last send, the clock — is read by the caller (`run-evaluation.ts`) and
 * handed in, so this file has no ports, no `async`, and TS-01's "no test
 * touches a database" is true of it by construction, not by care.
 */

/** BR-018-27 — `{ start, end } | null`, São Paulo wall-clock, `start > end` wraps midnight. */
export interface QuietHoursWindow {
  readonly start: string;
  readonly end: string;
}

export type NotificationSuppressedReason =
  | 'unchanged'
  | 'unknown_state'
  | 'first_observation'
  | 'inactive'
  | 'muted'
  | 'not_consented'
  | 'cooldown'
  | 'quiet_hours';

export type NotificationDecision =
  | { readonly send: true; readonly reason: 'state_changed' }
  | { readonly send: false; readonly reason: NotificationSuppressedReason };

export interface DecideNotificationInput {
  readonly active: boolean;
  readonly muted: boolean;
  /** BR-018-25 — the `email_reminders` purpose, resolved by the caller against SPEC-004's ConsentRepository. */
  readonly consented: boolean;
  /** BR-018-13 — `null` only before this rule has ever been evaluated. */
  readonly lastState: OpportunityState | null;
  readonly evaluatedState: EvaluatedState;
  /** BR-018-22 — the last time an email actually went out for this rule, or `null`. */
  readonly lastSentAt: Date | null;
  readonly now: Date;
  readonly cooldownHours: number;
  readonly quietHours: QuietHoursWindow | null;
}

/**
 * **What a first observation does, and why.**
 *
 * BR-018-21 sends an email "when the evaluated state differs from the last
 * observed state" — a comparison between two known states. A rule that has
 * never been evaluated has no "last observed state" to differ from; `null`
 * here means *no observation yet*, not a fourth state a real reading could be
 * compared against. Treating "differs from null" as true would mean every
 * newly created rule emails on its very next quote, including the ordinary
 * case where the asset simply sits in whatever band the user's own bounds
 * put it in the moment they finished setting the rule up — not a crossing
 * anybody watched happen, just the rule's own starting position. That is not
 * the "a crossing happened" signal BR-018-21 is for, it is noise on every
 * rule creation, and it is completely invisible in-app anyway (BR-018-20
 * shows the current state immediately, opt-in or not). So the first
 * evaluation only establishes the baseline silently; email starts on the
 * first evaluation *after* that one shows a different state.
 */
export function decideNotification(input: DecideNotificationInput): NotificationDecision {
  if (!input.active) return { send: false, reason: 'inactive' };
  if (input.evaluatedState === 'unknown') return { send: false, reason: 'unknown_state' };
  if (input.lastState === null) return { send: false, reason: 'first_observation' };
  if (input.evaluatedState === input.lastState) return { send: false, reason: 'unchanged' };

  // From here the state genuinely changed (BR-018-21's condition is met); the
  // remaining checks are BR-018-25/26/27's independent reasons an otherwise
  // due email is still withheld.
  if (input.muted) return { send: false, reason: 'muted' };
  if (!input.consented) return { send: false, reason: 'not_consented' };
  if (isInCooldown(input.lastSentAt, input.now, input.cooldownHours)) {
    return { send: false, reason: 'cooldown' };
  }
  if (isWithinQuietHours(input.now, input.quietHours)) {
    return { send: false, reason: 'quiet_hours' };
  }
  return { send: true, reason: 'state_changed' };
}

/**
 * BR-018-22/DL-018-05 — a fixed window after the last send, regardless of how
 * many further state changes happen inside it. `lastSentAt` comes from
 * `OpportunityNotificationLog.lastSentAt`, not from this rule's own history
 * of state changes, which is the mechanism (not a side effect) behind
 * BR-018-23's accepted cost: a genuine second crossing the same afternoon is
 * suppressed exactly as a false one would be, because the clock started on
 * the *send*, not on the state.
 */
function isInCooldown(lastSentAt: Date | null, now: Date, cooldownHours: number): boolean {
  if (lastSentAt === null) return false;
  const elapsedMs = now.getTime() - lastSentAt.getTime();
  return elapsedMs < cooldownHours * 60 * 60 * 1000;
}

/**
 * BR-018-27 — a configurable do-not-disturb band, in São Paulo wall-clock
 * time. `window === null` means no quiet window at all (the config default);
 * it does not mean "always quiet" — the registry's own validation rejects
 * `start === end` for exactly that ambiguity (`src/config/registry.ts`).
 *
 * The window is half-open, `[start, end)`: the instant equal to `end` is
 * outside it, the same way a cadence boundary is treated elsewhere in this
 * codebase (`isQuoteStale`'s strict `>`). `start > end` wraps past midnight
 * (e.g. `22:00`–`07:00`), which is the common case for a quiet window and is
 * why this is not simply `start <= now && now < end`.
 *
 * `Intl.DateTimeFormat` with `hourCycle: 'h23'` reads the wall-clock hour
 * rather than a fixed UTC offset — Brazil has no DST since 2019, but São
 * Paulo's offset has changed by legislative fiat before and plain arithmetic
 * on the UTC instant would silently drift if it ever does again.
 */
export function isWithinQuietHours(now: Date, window: QuietHoursWindow | null): boolean {
  if (window === null) return false;
  const current = saoPauloHHMM(now);
  const { start, end } = window;
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}

/**
 * `hourCycle: 'h23'` rather than the default `hour12` inference — some
 * locale/hour12 combinations render midnight as `24:00`, which would compare
 * as greater than every other time of day instead of the smallest. `en-CA`
 * with `h23` formats straight to `HH:MM`, so no `formatToParts` assembly (and
 * no fallback for a part Intl is contractually guaranteed to produce) is
 * needed.
 */
function saoPauloHHMM(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

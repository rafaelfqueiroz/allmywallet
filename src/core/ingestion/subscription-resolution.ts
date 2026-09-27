import type { BusinessDate } from '@/core/shared/clock';
import type { Quantity } from '@/core/shared/money';

/**
 * SPEC-005 BR-005-20d (#144) — an **exercised subscription** resolved at
 * commit as one `subscription` on the main asset.
 *
 * B3 never states the link: it records the exercise as a price-less
 * `Direitos de Subscrição - Exercido` debit on the *right* ticker (`XPML12`)
 * and, weeks or months later, an unrelated-looking price-less `Atualização`
 * credit on the *main* ticker (`XPML11`) — two different catalog rows with
 * nothing in either extract naming the other. This resolver pairs the two by
 * what they share: the same B3 issuer root, the same institution, the same
 * quantity, and the credit falling on or after the exercise within a
 * configured window — and only when each is the *other's* one and only
 * match (BR-005-20d: "each is the other's only match").
 *
 * Pure (AR-01): which rows exist, what state the ledger holds them in, and
 * what the main position held before the credit come from `commit-batch.ts`.
 */

export type SubscriptionEvidenceRole = 'exercise' | 'credit';

/**
 * What the ledger makes of the row today:
 *
 * - `open` — this commit may write it: a row of this batch, or a stored copy
 *   an earlier import left `unclassified`;
 * - `applied` — already what this pairing would write (the exercise
 *   `superseded`, the credit an active `subscription` of this quantity);
 * - `locked` — a person decided (edited, entered by hand, or classified as
 *   something else). BR-005-20d: never touched, so the pair stays as it is.
 */
export type SubscriptionEvidenceState = 'open' | 'applied' | 'locked';

export interface SubscriptionEvidence {
  readonly id: string;
  readonly role: SubscriptionEvidenceRole;
  /** B3's code on the row — the right ticker for an exercise, the main code for a credit. */
  readonly assetCode: string;
  readonly tradeDate: BusinessDate;
  /** The exercise's own quantity, or what the credit **added** (its statement, already resolved to a delta by the caller — BR-005-20e's own reading). */
  readonly quantity: Quantity;
  readonly state: SubscriptionEvidenceState;
  /**
   * `role: 'credit'` only — the main asset's position replayed immediately
   * before this row's date, or `null` where it does not replay. BR-005-20d
   * (D8) refuses a pair where this equals `quantity`: the `Atualização` may
   * be a balance statement (DL-007-10), not an acquisition.
   */
  readonly balanceBefore?: Quantity | null | undefined;
}

/** What a resolved pair writes: the credit becomes this `subscription`, the exercise is superseded. */
export interface SubscriptionPairPlan {
  readonly exerciseId: string;
  readonly creditId: string;
  /** The main asset's ledger code — never the right ticker. */
  readonly assetCode: string;
  /** DL-005-22 (D6): the subscription is dated the credit, not the exercise. */
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
}

export interface ResolvedSubscriptionPair {
  readonly status: 'resolved';
  readonly plan: SubscriptionPairPlan;
}

/** Both rows already hold exactly what this pairing would write — D7: never repriced. */
export interface AppliedSubscriptionPair {
  readonly status: 'applied';
  readonly exerciseId: string;
  readonly creditId: string;
}

export type SubscriptionPairResolution = ResolvedSubscriptionPair | AppliedSubscriptionPair;

export type SubscriptionUnresolvedReason =
  /** More than one candidate on the other side, or the match is not mutual. */
  | 'ambiguous'
  /** A same-issuer, same-quantity candidate exists but outside the configured window, or before the exercise. */
  | 'outside_window'
  /** BR-005-20d (D8): the credit restates the balance the position already held. */
  | 'balance_statement'
  /** A row of the pair was edited, entered by hand, or classified as something else. */
  | 'user_modified';

export interface ResolveSubscriptionsInput {
  /** Every exercise/credit row of one issuer at one institution, from the batch and the ledger. */
  readonly evidence: readonly SubscriptionEvidence[];
  /** `import.subscription_credit_window_days` (SPEC-002): no default here. */
  readonly windowDays: number;
}

export interface ResolveSubscriptionsResult {
  readonly pairs: readonly SubscriptionPairResolution[];
  /** Every evidence id this pass could not pair, and why — diagnostic only; BR-005-19 already puts the row in Needs attention regardless. */
  readonly unresolved: ReadonlyMap<string, SubscriptionUnresolvedReason>;
}

function dayNumber(date: BusinessDate): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

/**
 * SPEC-005 BR-005-20d — pairs every exercise in `input.evidence` with its
 * credit, or says why it could not. Never partial: a pair with any
 * ambiguity, a window miss, a balance statement or a locked row on either
 * side writes nothing — the rows stay exactly as they are, for a later
 * import once the evidence is unambiguous (BR-005-17).
 */
export function resolveSubscriptions(input: ResolveSubscriptionsInput): ResolveSubscriptionsResult {
  const unresolved = new Map<string, SubscriptionUnresolvedReason>();
  const pairs: SubscriptionPairResolution[] = [];

  if (!Number.isInteger(input.windowDays) || input.windowDays < 0) {
    for (const item of input.evidence) unresolved.set(item.id, 'outside_window');
    return { pairs, unresolved };
  }

  const exercises = input.evidence.filter((item) => item.role === 'exercise');
  const credits = input.evidence.filter((item) => item.role === 'credit');

  const sameShape = (exercise: SubscriptionEvidence, credit: SubscriptionEvidence): boolean =>
    exercise.assetCode !== credit.assetCode && exercise.quantity.equals(credit.quantity);
  const withinWindow = (exercise: SubscriptionEvidence, credit: SubscriptionEvidence): boolean => {
    const days = dayNumber(credit.tradeDate) - dayNumber(exercise.tradeDate);
    return days >= 0 && days <= input.windowDays;
  };
  const isMatch = (exercise: SubscriptionEvidence, credit: SubscriptionEvidence): boolean =>
    sameShape(exercise, credit) && withinWindow(exercise, credit);

  for (const exercise of exercises) {
    const shapeMatches = credits.filter((credit) => sameShape(exercise, credit));
    if (shapeMatches.length === 0) continue; // No matching evidence at all — stays unclassified, no diagnostic needed.

    const windowMatches = shapeMatches.filter((credit) => withinWindow(exercise, credit));
    if (windowMatches.length === 0) {
      unresolved.set(exercise.id, 'outside_window');
      for (const c of shapeMatches) unresolved.set(c.id, 'outside_window');
      continue;
    }

    const [credit, ...extraCredits] = windowMatches;
    if (extraCredits.length > 0) {
      unresolved.set(exercise.id, 'ambiguous');
      for (const c of windowMatches) unresolved.set(c.id, 'ambiguous');
      continue;
    }
    const creditRow = credit as SubscriptionEvidence;

    const candidateExercises = exercises.filter((candidate) => isMatch(candidate, creditRow));
    const [, ...extraExercises] = candidateExercises;
    if (extraExercises.length > 0) {
      for (const e of candidateExercises) unresolved.set(e.id, 'ambiguous');
      unresolved.set(creditRow.id, 'ambiguous');
      continue;
    }

    if (exercise.state === 'locked' || creditRow.state === 'locked') {
      unresolved.set(exercise.id, 'user_modified');
      unresolved.set(creditRow.id, 'user_modified');
      continue;
    }

    const balanceBefore = creditRow.balanceBefore ?? null;
    if (balanceBefore !== null && balanceBefore.equals(creditRow.quantity)) {
      unresolved.set(creditRow.id, 'balance_statement');
      continue;
    }

    if (exercise.state === 'applied' || creditRow.state === 'applied') {
      pairs.push({ status: 'applied', exerciseId: exercise.id, creditId: creditRow.id });
      continue;
    }

    pairs.push({
      status: 'resolved',
      plan: {
        exerciseId: exercise.id,
        creditId: creditRow.id,
        assetCode: creditRow.assetCode,
        tradeDate: creditRow.tradeDate,
        quantity: creditRow.quantity,
      },
    });
  }

  return { pairs, unresolved };
}

import type { BusinessDate } from '@/core/shared/clock';
import type { Quantity } from '@/core/shared/money';
import type { Transaction, TransactionType } from '@/core/ledger/transaction';

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

/**
 * SPEC-005 BR-005-20d (#157) — what a *hand-classified* credit already
 * decided about cost, so a pair whose credit is `locked` can still tell
 * whether the cost question has an answer: `costed` (a unit price above
 * zero on a type that adds shares) or `zero_cost` (the same type at a unit
 * price of zero — a bonificação attributing no value is BR-007-05's own
 * reading of a quantity B3 states without one).
 */
export type SubscriptionCreditHandClassification = 'costed' | 'zero_cost';

/**
 * SPEC-006 BR-006-05 / SPEC-007's own acquisition types — the transaction
 * types that add shares to a position. `adjustment` only counts when its own
 * quantity is positive (`deriveSubscriptionHandClassification`): a negative
 * adjustment is a withdrawal, not an acquisition (`applyAdjustment`).
 */
const ADDS_SHARES_TRANSACTION_TYPES: ReadonlySet<TransactionType> = new Set([
  'buy',
  'subscription',
  'bonificacao',
  'transfer_in',
  'adjustment',
]);

/**
 * SPEC-005 BR-005-20d (#157) — the one place a locked credit's own
 * transaction is read for what it already decided about cost, so every
 * caller (commit, the close-request backfill, the read-time offer) agrees
 * on the same reading. `null` covers everything BR-005-20d has no view on: a
 * status other than `active` (#157 review F6 — a `superseded` or
 * `unclassified` row adds nothing to any replay, whatever its type or
 * price), a type that does not add shares, or a negative `adjustment`.
 */
export function deriveSubscriptionHandClassification(
  transaction: Transaction,
): SubscriptionCreditHandClassification | null {
  if (transaction.status !== 'active') return null;
  if (!ADDS_SHARES_TRANSACTION_TYPES.has(transaction.type)) return null;
  if (transaction.type === 'adjustment' && !transaction.quantity.isPositive()) return null;
  return transaction.unitPrice.isPositive() ? 'costed' : 'zero_cost';
}

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
  /**
   * `role: 'credit'` and `state: 'locked'` only (#157) — what the user's own
   * classification already decided about cost, from
   * `deriveSubscriptionHandClassification`. Absent or `null` for anything
   * else: an `open`/`applied` credit's cost question is not this field's to
   * answer, and a locked credit of a type that does not add shares, or that
   * removes them, has no reading here either.
   */
  readonly handClassification?: SubscriptionCreditHandClassification | null | undefined;
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

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — the credit is `locked` and its own
 * hand classification already carries a cost (`costed`): the cost question
 * is answered, so the exercise clears on its own. No credit write — the
 * user's classification is never overwritten (BR-005-20/20b) — only the
 * exercise supersedes.
 */
export interface EvidenceOnlySubscriptionPair {
  readonly status: 'evidence_only';
  readonly exerciseId: string;
  readonly creditId: string;
}

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — the credit is `locked` at
 * `zero_cost`: a paid subscription entered as a zero-cost bonificação is
 * plausible but not certain (a genuine bonificação can carry no value), so
 * nothing is written. `plan` is the same re-type a `resolved` pair would
 * write, offered rather than applied — **Resolve as subscription** and
 * **Keep my classification** are the two actions built from it.
 */
export interface OfferedSubscriptionPair {
  readonly status: 'offer';
  readonly plan: SubscriptionPairPlan;
}

export type SubscriptionPairResolution =
  | ResolvedSubscriptionPair
  | AppliedSubscriptionPair
  | EvidenceOnlySubscriptionPair
  | OfferedSubscriptionPair;

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
 * import once the evidence is unambiguous (BR-005-17). The one exception
 * (#157, DL-005-25) is a **locked credit whose own classification already
 * decides the cost question** — see the `locked` branch below.
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

    // SPEC-005 BR-005-20d (#157): an exercise the user classified by hand is
    // never touched, whatever the credit's own state — unchanged from before
    // #157, and taking precedence over every branch below.
    if (exercise.state === 'locked') {
      unresolved.set(exercise.id, 'user_modified');
      unresolved.set(creditRow.id, 'user_modified');
      continue;
    }

    if (creditRow.state === 'locked') {
      // A credit locked at commit and an exercise `applied` through the
      // ordinary BR-005-20d path (superseded with no user flag) — reachable,
      // for instance, when the credit is reclassified again after a
      // *resolved* pair already applied. Note this is **not** the state
      // #157's own two actions leave: `editTransactions` flags the exercise
      // user-modified too (the default), so after **Resolve as
      // subscription** or **Keep my classification** the exercise itself
      // reads `locked`, and a later import takes the `exercise.state ===
      // 'locked'` branch above instead — still a no-op (BR-005-17), just via
      // that branch rather than this one (#157 review F5).
      if (exercise.state === 'applied') {
        pairs.push({ status: 'applied', exerciseId: exercise.id, creditId: creditRow.id });
        continue;
      }

      // D8 still applies first: a locked credit that merely restates the
      // balance is not evidence of an acquisition either.
      const balanceBefore = creditRow.balanceBefore ?? null;
      if (balanceBefore !== null && balanceBefore.equals(creditRow.quantity)) {
        unresolved.set(creditRow.id, 'balance_statement');
        continue;
      }

      const handClassification = creditRow.handClassification ?? null;
      if (handClassification === 'costed') {
        pairs.push({ status: 'evidence_only', exerciseId: exercise.id, creditId: creditRow.id });
        continue;
      }
      if (handClassification === 'zero_cost') {
        pairs.push({
          status: 'offer',
          plan: {
            exerciseId: exercise.id,
            creditId: creditRow.id,
            assetCode: creditRow.assetCode,
            tradeDate: creditRow.tradeDate,
            quantity: creditRow.quantity,
          },
        });
        continue;
      }
      // Locked as some other type entirely (a sale, a transfer out, …) — the
      // classification answers no cost question at all.
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

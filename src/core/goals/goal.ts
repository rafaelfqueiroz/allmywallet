import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { WalletGoalId, type UserId, type WalletId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { GoalDependencies } from '@/core/goals/dependencies';
import { GoalErrorCode, goalError } from '@/core/goals/errors';

/**
 * SPEC-019 — a measured goal attached to one wallet.
 *
 * This promotes SPEC-010 BR-010-02, where a wallet's goal was "descriptive in
 * v1; not used in any calculation". From M7 the descriptive text is the goal's
 * **name** and the number beside it is measured — which is why the two live in
 * separate columns rather than one field doing both jobs (DL-019-06: a
 * decorative "goal" and a calculated "goal" on the same screen is a usability
 * trap, not a migration convenience).
 *
 * **There is no target date, and there is no date field below** (BR-019-04,
 * DL-019-01). That is the decision the whole module is shaped by: with an
 * amount alone the burn-up answers *how far have I come* and is structurally
 * incapable of answering *am I on track*. A date would buy a pace line and
 * cost a projection, a second empty state and an "on track" verdict this
 * product has decided not to make. Adding one later remains possible; adding
 * one here would change every chart's meaning.
 */

export const GOAL_KINDS = ['growth', 'earnings'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** BR-019-05 — growth measured at cost, or at market. Two different questions. */
export const GROWTH_BASES = ['invested', 'current_value'] as const;
export type GrowthBasis = (typeof GROWTH_BASES)[number];

/** BR-019-06 — an earnings goal names the period its amount applies to. */
export const EARNINGS_PERIODS = ['monthly', 'yearly'] as const;
export type EarningsPeriod = (typeof EARNINGS_PERIODS)[number];

export interface WalletGoal {
  readonly id: WalletGoalId;
  readonly userId: UserId;
  /** BR-019-01: exactly one wallet. Portfolio-scope goals are out of scope (DL-019-07). */
  readonly walletId: WalletId;
  /** SPEC-010 BR-010-02's text, promoted to the goal's name. */
  readonly name: string;
  readonly kind: GoalKind;
  /** BR-019-07 / AR-06: money, strictly positive. */
  readonly amount: Money;
  /** BR-019-05 — set on a growth goal, `null` on an earnings goal. */
  readonly basis: GrowthBasis | null;
  /** BR-019-06 — set on an earnings goal, `null` on a growth goal. */
  readonly period: EarningsPeriod | null;
  /**
   * BR-019-24/26 / DL-019-05 — **the record of an event, not a current
   * status.** Set once, on the transition, and never cleared or moved. A goal
   * that later dips back below its amount keeps this marker and this date:
   * the goal *was* reached, and rewriting that because the market moved would
   * make the marker mean "currently above", which is a different claim.
   *
   * AR-29 — the **date it was reached**, read off the progress that reached
   * it, never the instant the product looked. See the column's own note in
   * `src/db/schema/goals.ts`.
   */
  readonly achievedOn: BusinessDate | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** BR-019-01/02 — one wallet, and a wallet may hold several goals of either kind. */
export interface CreateGoalInput {
  readonly walletId: WalletId;
  readonly name: string;
  readonly kind: GoalKind;
  readonly amount: Money;
  readonly basis?: GrowthBasis | null | undefined;
  readonly period?: EarningsPeriod | null | undefined;
}

export async function createGoal(
  deps: GoalDependencies,
  userId: UserId,
  input: CreateGoalInput,
): Promise<Result<WalletGoal, DomainError<GoalErrorCode>>> {
  const name = input.name.trim();
  if (name.length === 0) return err(goalError(GoalErrorCode.INVALID_NAME));

  // BR-019-07: strictly positive. Zero is not a goal and a negative one has no
  // burn-up to draw; both are refused here rather than left to the column's
  // CHECK, so the caller gets a code it can render instead of a driver error.
  if (!input.amount.isPositive()) {
    return err(goalError(GoalErrorCode.INVALID_AMOUNT, { amount: input.amount.toString() }));
  }

  const shape = validateShape(input.kind, input.basis ?? null, input.period ?? null);
  if (!shape.ok) return shape;

  const now = deps.clock.now();
  const goal: WalletGoal = {
    id: WalletGoalId.generate(),
    userId,
    walletId: input.walletId,
    name,
    kind: input.kind,
    amount: input.amount,
    basis: shape.value.basis,
    period: shape.value.period,
    achievedOn: null,
    createdAt: now,
    updatedAt: now,
  };

  await deps.goals.insert(goal);
  return ok(goal);
}

/**
 * BR-019-03 — the kind is fixed at creation, and so are the two fields the
 * kind selects. Everything else is editable.
 *
 * BR-019-27: **editing the amount changes nothing else.** No recomputation is
 * triggered here and `achievedOn` is carried through untouched — raising a
 * goal a user has already reached moves the goal line and leaves both the
 * historical series and the achieved marker exactly where they were (AC-16).
 * That falls out of spreading `existing`; it is asserted in the tests because
 * a future edit to this function could quietly take it away.
 */
export interface UpdateGoalInput {
  readonly goalId: WalletGoalId;
  readonly name?: string | undefined;
  readonly amount?: Money | undefined;
  /** Accepted only so an attempted change is **refused**, never silently dropped. */
  readonly kind?: GoalKind | undefined;
  readonly basis?: GrowthBasis | undefined;
  readonly period?: EarningsPeriod | undefined;
}

export async function updateGoal(
  deps: GoalDependencies,
  userId: UserId,
  input: UpdateGoalInput,
): Promise<Result<WalletGoal, DomainError<GoalErrorCode>>> {
  const existing = await deps.goals.findById(input.goalId);
  if (existing === null || existing.userId !== userId) {
    return err(goalError(GoalErrorCode.GOAL_NOT_FOUND, { goalId: input.goalId }));
  }

  if (input.kind !== undefined && input.kind !== existing.kind) {
    return err(
      goalError(GoalErrorCode.GOAL_KIND_IMMUTABLE, { from: existing.kind, to: input.kind }),
    );
  }

  const immutable = refuseShapeChange(existing, input);
  if (immutable !== null) return err(immutable);

  let name = existing.name;
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed.length === 0) return err(goalError(GoalErrorCode.INVALID_NAME));
    name = trimmed;
  }

  let amount = existing.amount;
  if (input.amount !== undefined) {
    if (!input.amount.isPositive()) {
      return err(goalError(GoalErrorCode.INVALID_AMOUNT, { amount: input.amount.toString() }));
    }
    amount = input.amount;
  }

  const updated: WalletGoal = { ...existing, name, amount, updatedAt: deps.clock.now() };
  await deps.goals.update(updated);
  return ok(updated);
}

/**
 * BR-019-05/06 — the kind decides which of the two fields exists, and the
 * other must be absent. The same rule the `wallet_goals` CHECK constraint
 * states, held here too so the caller gets a code rather than a driver error
 * (the pattern SPEC-010 uses for the sum invariant).
 */
function validateShape(
  kind: GoalKind,
  basis: GrowthBasis | null,
  period: EarningsPeriod | null,
): Result<
  { basis: GrowthBasis | null; period: EarningsPeriod | null },
  DomainError<GoalErrorCode>
> {
  if (kind === 'growth') {
    if (basis === null) return err(goalError(GoalErrorCode.GROWTH_GOAL_REQUIRES_BASIS));
    if (period !== null) {
      return err(goalError(GoalErrorCode.GOAL_PERIOD_NOT_APPLICABLE, { kind, period }));
    }
    return ok({ basis, period: null });
  }

  if (period === null) return err(goalError(GoalErrorCode.EARNINGS_GOAL_REQUIRES_PERIOD));
  if (basis !== null) {
    return err(goalError(GoalErrorCode.GOAL_BASIS_NOT_APPLICABLE, { kind, basis }));
  }
  return ok({ basis: null, period });
}

/**
 * BR-019-03 — a basis change on a growth goal and a period change on an
 * earnings goal are both kind changes wearing a smaller name: the basis *is*
 * what a growth goal measures, and switching it re-bases every point on the
 * chart against an amount the user set for the other question.
 *
 * Passing the value it already has is a no-op, not an error — a form that
 * round-trips every field would otherwise be unable to save a rename.
 */
function refuseShapeChange(
  existing: WalletGoal,
  input: UpdateGoalInput,
): DomainError<GoalErrorCode> | null {
  if (existing.kind === 'growth') {
    if (input.period !== undefined) {
      return goalError(GoalErrorCode.GOAL_PERIOD_NOT_APPLICABLE, {
        kind: existing.kind,
        period: input.period,
      });
    }
    if (input.basis !== undefined && input.basis !== existing.basis) {
      return goalError(GoalErrorCode.GOAL_BASIS_IMMUTABLE, {
        from: existing.basis,
        to: input.basis,
      });
    }
    return null;
  }

  if (input.basis !== undefined) {
    return goalError(GoalErrorCode.GOAL_BASIS_NOT_APPLICABLE, {
      kind: existing.kind,
      basis: input.basis,
    });
  }
  if (input.period !== undefined && input.period !== existing.period) {
    return goalError(GoalErrorCode.GOAL_PERIOD_IMMUTABLE, {
      from: existing.period,
      to: input.period,
    });
  }
  return null;
}

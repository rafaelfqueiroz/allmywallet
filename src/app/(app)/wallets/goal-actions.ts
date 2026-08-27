'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { normalizeDecimalInput } from '@/lib/decimal-input';
import { err, isErr, ok } from '@/core/shared/result';
import { IDLE, INVALID_INPUT, failure, type ActionState } from '@/lib/action-state';
import {
  EARNINGS_PERIODS,
  GOAL_KINDS,
  GROWTH_BASES,
  createGoal,
  updateGoal,
} from '@/core/goals/goal';
import { GoalErrorCode, goalError } from '@/core/goals/errors';
import { withGoalDeps } from '@/app/(app)/wallets/goals-composition';
import { requireUserId } from '@/lib/session';

/**
 * SPEC-019 — the goals form's server actions, in the exact shape of
 * `src/app/(app)/wallets/actions.ts`: AR-32 validates with Zod at the
 * boundary (DV-07), resolves the session, and calls exactly one use case.
 * AR-34/AR-35: nothing here decides anything — `createGoal`/`updateGoal`
 * (`core/goals/goal.ts`) do, and every action returns `ActionState` so a
 * domain refusal reaches the form rather than a page that silently
 * re-renders unchanged (see that file's own comment on why #63 made `void`
 * the wrong return type for a wallet action).
 */

/**
 * `normalizeDecimalInput`'s own contract: a pt-BR "1.234,56" or a plain
 * "1234.56" both become the plain decimal string `Money.fromString` expects.
 * **Never `Number(...)`/`parseFloat`** — see `src/app/(app)/transactions/actions.ts`,
 * whose `decimal`/`optionalDecimal` this mirrors, for why that boundary is the
 * one AR-06 exists to guard.
 */
const decimal = z
  .string()
  .transform((value) => normalizeDecimalInput(value))
  .refine((value): value is string => value !== null, 'not a decimal literal');

/** An empty or absent field is "not supplied", never "zero" — `updateGoal`'s `amount` is optional. */
const optionalDecimal = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value.trim() === '') return undefined;
    const normalized = normalizeDecimalInput(value);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a decimal literal' });
      return z.NEVER;
    }
    return normalized;
  });

const CreateGoalSchema = z.object({
  walletId: z.string(),
  name: z.string().min(1),
  kind: z.enum(GOAL_KINDS),
  amount: decimal,
  basis: z.enum(GROWTH_BASES).optional(),
  period: z.enum(EARNINGS_PERIODS).optional(),
});

export async function createGoalAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = CreateGoalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const input = parsed.data;
  const walletId = WalletId.of(input.walletId);

  const result = await withGoalDeps(userId, (deps) =>
    createGoal(deps, userId, {
      walletId,
      name: input.name,
      kind: input.kind,
      amount: Money.fromString(input.amount),
      basis: input.basis ?? null,
      period: input.period ?? null,
    }),
  );
  if (isErr(result)) return failure(result.error);
  revalidatePath(`/wallets/${walletId}`);
  revalidatePath(`/wallets/${walletId}/goals`);
  return IDLE;
}

/**
 * BR-019-03: `kind`, `basis` and `period` are accepted here **only so an
 * attempted change is refused by `updateGoal` itself**, never filtered out
 * before it reaches the use case — a caller that sends `kind: 'earnings'` for
 * a growth goal believes it is changing something, and silently dropping the
 * field would leave it convinced the change landed.
 */
const UpdateGoalSchema = z.object({
  goalId: z.string(),
  walletId: z.string(),
  name: z.string().min(1).optional(),
  amount: optionalDecimal,
  kind: z.enum(GOAL_KINDS).optional(),
  basis: z.enum(GROWTH_BASES).optional(),
  period: z.enum(EARNINGS_PERIODS).optional(),
});

export async function updateGoalAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = UpdateGoalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const input = parsed.data;
  const walletId = WalletId.of(input.walletId);
  const goalId = WalletGoalId.of(input.goalId);

  const result = await withGoalDeps(userId, (deps) =>
    updateGoal(deps, userId, {
      goalId,
      name: input.name,
      amount: input.amount === undefined ? undefined : Money.fromString(input.amount),
      kind: input.kind,
      basis: input.basis,
      period: input.period,
    }),
  );
  if (isErr(result)) return failure(result.error);
  revalidatePath(`/wallets/${walletId}`);
  revalidatePath(`/wallets/${walletId}/goals`);
  return IDLE;
}

const DeleteGoalSchema = z.object({ goalId: z.string(), walletId: z.string() });

export async function deleteGoalAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = DeleteGoalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const walletId = WalletId.of(parsed.data.walletId);
  const goalId = WalletGoalId.of(parsed.data.goalId);

  /**
   * BR-019-08/AC-17: a goal's deletion is a plain row removal — no cascade to
   * `transactions` or `wallet_allocation_events` reaches from here, and none
   * should (see `wallet_goals`'s own comment in `src/db/schema/goals.ts`).
   * There is deliberately no `deleteGoal` use case in `core/goals` for that
   * reason: `wallet_goals`'s `tenant_isolation` RLS policy already scopes
   * `findById`/`delete` to this tenant's own rows, so the only thing left to
   * check before deleting is that the row exists at all.
   */
  const result = await withGoalDeps(userId, async (deps) => {
    const existing = await deps.goals.findById(goalId);
    if (existing === null) return err(goalError(GoalErrorCode.GOAL_NOT_FOUND, { goalId }));
    await deps.goals.delete(goalId);
    return ok(undefined);
  });
  if (isErr(result)) return failure(result.error);
  revalidatePath(`/wallets/${walletId}`);
  revalidatePath(`/wallets/${walletId}/goals`);
  return IDLE;
}

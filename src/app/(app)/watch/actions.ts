'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { normalizeDecimalInput } from '@/lib/decimal-input';
import { err, isErr, ok } from '@/core/shared/result';
import { IDLE, INVALID_INPUT, failure, type ActionState } from '@/lib/action-state';
import { createRule, updateRule } from '@/core/opportunity/rule';
import {
  OPPORTUNITY_STATES,
  type OpportunityBound,
  type OpportunityState,
} from '@/core/opportunity/ports';
import { OpportunityErrorCode, opportunityError } from '@/core/opportunity/errors';
import { withWatchDeps } from '@/app/(app)/watch/composition';
import { requireUserId } from '@/lib/session';

/**
 * SPEC-018 — the watch screen's server actions, in the shape of
 * `src/app/(app)/wallets/actions.ts`: AR-32 validates with Zod at the
 * boundary, resolves the session, and calls exactly one use case each.
 *
 * `createRule`/`updateRule` (`core/opportunity/rule.ts`) do everything a
 * business rule needs to decide — eligibility (BR-018-01/02), bound ordering
 * (BR-018-08), the money floor (BR-018-10). Nothing here re-derives any of
 * that (AR-35); this module only turns form fields into the shapes those two
 * use cases already expect, exactly as `goal-actions.ts` does for
 * `createGoal`/`updateGoal`.
 */

/**
 * A native `<select>` submits an empty string for its placeholder option,
 * never omits the field — so `z.enum(...).optional()` alone would reject "no
 * state chosen for this bound" as an invalid enum member rather than treating
 * it as absent. Preprocessing `''` to `undefined` before the enum check is
 * what lets `parseBound` below tell "no bound" from "a bound with no state",
 * the one combination BR-018-06 refuses.
 */
const optionalState = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.enum(OPPORTUNITY_STATES).optional(),
);

const RuleFormSchema = z.object({
  assetId: z.string().min(1),
  lowerPrice: z.string().optional(),
  lowerState: optionalState,
  upperPrice: z.string().optional(),
  upperState: optionalState,
  defaultState: z.enum(OPPORTUNITY_STATES),
});

/**
 * BR-018-05/06/10 — an empty price field means "this bound is not set", never
 * "zero". A price with no chosen state (DL-018-02 requires one) or a price
 * that is not a decimal literal is refused rather than silently dropped —
 * `'invalid'` is a distinct return from `null` for exactly that reason: the
 * caller must tell the two apart to know whether to reject the whole
 * submission (AR-06: `normalizeDecimalInput`, never `Number(...)`/`parseFloat`,
 * so a threshold is never a JS float even in transit).
 */
function parseBound(
  price: string | undefined,
  state: OpportunityState | undefined,
): OpportunityBound | null | 'invalid' {
  const trimmed = (price ?? '').trim();
  if (trimmed === '') return null;
  if (state === undefined) return 'invalid';
  const normalized = normalizeDecimalInput(trimmed);
  if (normalized === null) return 'invalid';
  return { price: Money.fromString(normalized), state };
}

export async function createRuleAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = RuleFormSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;

  const lower = parseBound(parsed.data.lowerPrice, parsed.data.lowerState);
  const upper = parseBound(parsed.data.upperPrice, parsed.data.upperState);
  if (lower === 'invalid' || upper === 'invalid') return INVALID_INPUT;

  const result = await withWatchDeps(userId, (deps) =>
    createRule(deps, userId, {
      assetId: AssetId.of(parsed.data.assetId),
      lower,
      upper,
      defaultState: parsed.data.defaultState,
    }),
  );
  if (isErr(result)) return failure(result.error);
  revalidatePath('/watch');
  return IDLE;
}

/**
 * The edit form always renders every current field, so "leave unchanged" is
 * simply resubmitting the same value — `lower`/`upper`/`defaultState` are
 * therefore always sent explicitly here, never `undefined`.
 * `updateRule`'s tri-state (`undefined` leaves, `null` clears, a value sets —
 * see its own doc comment in `core/opportunity/rule.ts`) exists for a partial
 * PATCH-style caller, which this form is not.
 */
export async function updateRuleAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = RuleFormSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;

  const lower = parseBound(parsed.data.lowerPrice, parsed.data.lowerState);
  const upper = parseBound(parsed.data.upperPrice, parsed.data.upperState);
  if (lower === 'invalid' || upper === 'invalid') return INVALID_INPUT;

  const result = await withWatchDeps(userId, (deps) =>
    updateRule(deps, userId, {
      assetId: AssetId.of(parsed.data.assetId),
      lower,
      upper,
      defaultState: parsed.data.defaultState,
    }),
  );
  if (isErr(result)) return failure(result.error);
  revalidatePath('/watch');
  return IDLE;
}

const SetMutedSchema = z.object({ assetId: z.string(), muted: z.enum(['true', 'false']) });

/** BR-018-26 — the per-asset mute, independent of `updateRuleAction`'s bounds editing so muting never risks resubmitting a stale threshold. */
export async function setRuleMutedAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = SetMutedSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;

  const result = await withWatchDeps(userId, (deps) =>
    updateRule(deps, userId, {
      assetId: AssetId.of(parsed.data.assetId),
      muted: parsed.data.muted === 'true',
    }),
  );
  if (isErr(result)) return failure(result.error);
  revalidatePath('/watch');
  return IDLE;
}

const AssetIdSchema = z.object({ assetId: z.string() });

/**
 * A real, user-initiated delete (BR-018-03's own distinction — a sale
 * deactivates a rule, it never deletes one). No dedicated `core/opportunity`
 * use case exists for this, in the exact shape `goal-actions.ts#deleteGoalAction`
 * gives for the same absence: `opportunity_rules`' RLS policy already scopes
 * `findByAsset`/`delete` to this tenant's own rows, so the only thing left to
 * check before deleting is that the row exists at all.
 */
export async function deleteRuleAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = AssetIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const assetId = AssetId.of(parsed.data.assetId);

  const result = await withWatchDeps(userId, async (deps) => {
    const existing = await deps.rules.findByAsset(assetId);
    if (existing === null || existing.userId !== userId) {
      return err(opportunityError(OpportunityErrorCode.RULE_NOT_FOUND, { assetId }));
    }
    await deps.rules.delete(existing.id);
    return ok(undefined);
  });
  if (isErr(result)) return failure(result.error);
  revalidatePath('/watch');
  return IDLE;
}

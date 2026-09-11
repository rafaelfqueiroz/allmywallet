import type { AssetClass } from '@/core/quotes/ports';
import type { AssetId, UserId } from '@/core/shared/ids';
import { OpportunityRuleId } from '@/core/shared/ids';
import type { Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import { OpportunityErrorCode, opportunityError } from '@/core/opportunity/errors';
import type { DomainError } from '@/core/shared/domain-error';
import type { OpportunityBound, OpportunityRule, OpportunityState } from '@/core/opportunity/ports';

/**
 * SPEC-018 BR-018-01..10 — creating and editing a rule, and BR-018-03's
 * activation, which is recomputed rather than hooked into the ledger.
 */

/**
 * BR-018-02 — the five classes with an observable market price. CDB, LCI and
 * LCA are the catalog's other three classes and are refused server-side
 * below, not merely hidden by a UI that a direct server-action call would
 * bypass.
 */
export const WATCHABLE_ASSET_CLASSES: readonly AssetClass[] = [
  'stock',
  'fii',
  'bdr',
  'etf',
  'tesouro_direto',
];

/**
 * BR-018-01/02 — both eligibility conditions in one place, so `createRule`
 * and any future caller (a UI asking "does this asset offer a rule form?")
 * apply the identical test.
 *
 * `quantity` is checked for non-zero here rather than positivity, matching
 * BR-018-01's own wording ("non-zero position") — this product does not model
 * short positions, but the rule is stated the way the spec states it rather
 * than assuming a narrower one it happens to be equivalent to today.
 */
export function canCarryRule(assetClass: AssetClass, quantity: Quantity): boolean {
  return WATCHABLE_ASSET_CLASSES.includes(assetClass) && !quantity.isZero();
}

/**
 * BR-018-03 — recomputed from current holdings wherever rules are read or
 * evaluated, rather than hooked into the transaction-write path. A pure
 * function so the ledger never has to know this feature exists: any caller
 * that can list a user's rules and their currently held asset ids can call
 * this and get the exact set of ids to flip, in either direction.
 */
export function reconcileActivation(
  rules: readonly OpportunityRule[],
  heldAssetIds: ReadonlySet<AssetId>,
): {
  readonly activate: readonly OpportunityRuleId[];
  readonly deactivate: readonly OpportunityRuleId[];
} {
  const activate: OpportunityRuleId[] = [];
  const deactivate: OpportunityRuleId[] = [];
  for (const rule of rules) {
    const held = heldAssetIds.has(rule.assetId);
    if (held && !rule.active) activate.push(rule.id);
    else if (!held && rule.active) deactivate.push(rule.id);
  }
  return { activate, deactivate };
}

export interface CreateRuleInput {
  readonly assetId: AssetId;
  readonly lower?: OpportunityBound | null | undefined;
  readonly upper?: OpportunityBound | null | undefined;
  /** BR-018-07 — defaults to `hold` when omitted. */
  readonly defaultState?: OpportunityState | undefined;
}

export async function createRule(
  deps: OpportunityDependencies,
  userId: UserId,
  input: CreateRuleInput,
): Promise<Result<OpportunityRule, DomainError<OpportunityErrorCode>>> {
  const lower = input.lower ?? null;
  const upper = input.upper ?? null;
  const defaultState = input.defaultState ?? 'hold';

  const shape = validateBounds(lower, upper);
  if (!shape.ok) return shape;

  // BR-018-01/02 — eligibility is re-checked here, server-side, against the
  // ledger-derived holdings, regardless of what a form up the call stack
  // already showed. This is what makes CDB/LCI/LCA and unheld assets refused
  // rather than merely hidden.
  const held = await deps.heldAssets.listHeld();
  const holding = held.find((row) => row.assetId === input.assetId);
  if (holding === undefined || holding.quantity.isZero()) {
    return err(opportunityError(OpportunityErrorCode.ASSET_NOT_HELD, { assetId: input.assetId }));
  }
  if (!WATCHABLE_ASSET_CLASSES.includes(holding.assetClass)) {
    return err(
      opportunityError(OpportunityErrorCode.ASSET_CLASS_NOT_WATCHABLE, {
        assetId: input.assetId,
        assetClass: holding.assetClass,
      }),
    );
  }

  const existing = await deps.rules.findByAsset(input.assetId);
  if (existing !== null) {
    return err(
      opportunityError(OpportunityErrorCode.RULE_ALREADY_EXISTS, { assetId: input.assetId }),
    );
  }

  const rule: OpportunityRule = {
    id: OpportunityRuleId.generate(),
    userId,
    assetId: input.assetId,
    lower,
    upper,
    defaultState,
    lastState: null,
    lastEvaluatedAt: null,
    // BR-018-01 already proved the position is non-zero, above.
    active: true,
    muted: false,
  };

  await deps.rules.insert(rule);
  return ok(rule);
}

/**
 * BR-018-05/07/26 — bounds, the default state and the mute flag are the
 * editable surface. The asset a rule watches is not: changing it is
 * indistinguishable from deleting one rule and creating another, and this
 * module offers both of those already.
 *
 * Each bound field is tri-state: `undefined` leaves it exactly as it is,
 * `null` clears it, and an `OpportunityBound` replaces it — the same
 * distinction a PATCH body needs to be able to remove a bound rather than
 * merely leaving it unset in the request.
 *
 * Keyed by `assetId`, not by the rule's own id. `OpportunityRuleRepository`
 * has no `findById` — BR-018-20's watch screen and every editing surface
 * address a rule by the asset it watches ("the rule on PETR4"), which is
 * exactly what `findByAsset` answers, and there is at most one rule per
 * asset to find (`RULE_ALREADY_EXISTS` above is what keeps that true). Adding
 * a lookup-by-id port method here would be a second way to reach the same
 * row for a caller this codebase does not have.
 */
export interface UpdateRuleInput {
  readonly assetId: AssetId;
  readonly lower?: OpportunityBound | null | undefined;
  readonly upper?: OpportunityBound | null | undefined;
  readonly defaultState?: OpportunityState | undefined;
  readonly muted?: boolean | undefined;
}

export async function updateRule(
  deps: OpportunityDependencies,
  userId: UserId,
  input: UpdateRuleInput,
): Promise<Result<OpportunityRule, DomainError<OpportunityErrorCode>>> {
  const existing = await deps.rules.findByAsset(input.assetId);
  if (existing === null || existing.userId !== userId) {
    return err(opportunityError(OpportunityErrorCode.RULE_NOT_FOUND, { assetId: input.assetId }));
  }

  const lower = input.lower === undefined ? existing.lower : input.lower;
  const upper = input.upper === undefined ? existing.upper : input.upper;

  const shape = validateBounds(lower, upper);
  if (!shape.ok) return shape;

  const updated: OpportunityRule = {
    ...existing,
    lower,
    upper,
    defaultState: input.defaultState ?? existing.defaultState,
    muted: input.muted ?? existing.muted,
  };

  await deps.rules.update(updated);
  return ok(updated);
}

/**
 * BR-018-05/08/10 — the invariants every stored `OpportunityRule` must hold,
 * checked identically at creation and at every edit.
 *
 * A bound's `state` needs no check of its own: `OpportunityBound` requires
 * one to exist at all (DL-018-02), so there is no way to construct a bound
 * without a state for this function to reject — the type system is the
 * enforcement, not a branch here.
 */
function validateBounds(
  lower: OpportunityBound | null,
  upper: OpportunityBound | null,
): Result<true, DomainError<OpportunityErrorCode>> {
  if (lower === null && upper === null) {
    return err(opportunityError(OpportunityErrorCode.NO_BOUNDS_SET));
  }
  if (lower !== null && !lower.price.isPositive()) {
    return err(
      opportunityError(OpportunityErrorCode.INVALID_THRESHOLD, {
        bound: 'lower',
        price: lower.price.toString(),
      }),
    );
  }
  if (upper !== null && !upper.price.isPositive()) {
    return err(
      opportunityError(OpportunityErrorCode.INVALID_THRESHOLD, {
        bound: 'upper',
        price: upper.price.toString(),
      }),
    );
  }
  if (lower !== null && upper !== null && lower.price.comparedTo(upper.price) >= 0) {
    return err(
      opportunityError(OpportunityErrorCode.LOWER_NOT_BELOW_UPPER, {
        lower: lower.price.toString(),
        upper: upper.price.toString(),
      }),
    );
  }
  return ok(true);
}

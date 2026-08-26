import { SystemClock, type BusinessDate, type Clock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import type { GoalDependencies } from '@/core/goals/dependencies';
import type { WalletHolding, WalletValuation, WalletValuationPort } from '@/core/goals/ports';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleWalletGoalRepository } from '@/adapters/db/wallet-goal-repository';
import { LogGoalNotificationAdapter } from '@/adapters/notifications/log-goal-notification-adapter';
import { db } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * SPEC-019 — the composition root for `/wallets/[walletId]/goals` (AR-02): the
 * one place that wires `core/goals`' ports to their adapters, in the shape of
 * `src/app/(app)/wallets/composition.ts`.
 */
const clock = new SystemClock();

/**
 * `createGoal`/`updateGoal` (`core/goals/goal.ts`) and the plain repository
 * delete in `goal-actions.ts#deleteGoalAction` never call `deps.valuation` —
 * pricing only matters when *reading* a goal's progress, never when writing
 * the goal itself. So the write-path composition below wires a pricer that
 * exists solely to satisfy `GoalDependencies`' shape and is never expected to
 * run.
 *
 * The **read** path (`goals-data.ts#loadGoalsView`) cannot reuse a
 * generically-constructed pricer at all: `WalletValuationPort` needs a
 * `ValuationContext` sized to one wallet's own asset history and loaded
 * exactly once for the whole render (see that file's own comment on why a
 * context load per call is the mistake to avoid). Building that here, in a
 * composition root with no wallet in scope yet, would mean loading it before
 * knowing which assets or date range it needs to cover. `loadGoalsView`
 * builds the real adapter itself and passes it in through `overrides` below,
 * which is the one deliberate deviation from "composition wires every port":
 * the seam is real, but the data it needs is only available to the caller.
 */
class UnusedWalletValuationPort implements WalletValuationPort {
  async valueOn(
    _holdings: readonly WalletHolding[],
    _date: BusinessDate,
  ): Promise<Result<WalletValuation, DomainError>> {
    throw new Error(
      'SPEC-019: WalletValuationPort.valueOn called with no adapter wired. ' +
        'createGoal/updateGoal/deleteGoalAction never read progress, so the default ' +
        'write-path composition (buildGoalDeps in goals-composition.ts) supplies no pricer. ' +
        'A call here means a progress-reading path ran through withGoalDeps instead of ' +
        'goals-data.ts#loadGoalsView, which builds the real adapter against a preloaded ' +
        'ValuationContext.',
    );
  }
}

export function buildGoalDeps(
  tx: Tx,
  userId: UserId,
  overrides: { readonly valuation?: WalletValuationPort; readonly clock?: Clock } = {},
): GoalDependencies {
  return {
    goals: new DrizzleWalletGoalRepository(tx, userId),
    valuation: overrides.valuation ?? new UnusedWalletValuationPort(),
    notifications: new LogGoalNotificationAdapter(),
    // SPEC-004's own repository, not a goals-local copy — see
    // `core/goals/dependencies.ts`'s own comment on why a second consent store
    // is the one thing LGPD compliance cannot survive.
    consents: new DrizzleConsentRepository(tx, userId),
    clock: overrides.clock ?? clock,
  };
}

export async function withGoalDeps<T>(
  userId: UserId,
  fn: (deps: GoalDependencies) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(buildGoalDeps(tx, userId)), db);
}

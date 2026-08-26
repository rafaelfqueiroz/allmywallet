import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { GoalErrorCode } from '@/core/goals/errors';
import {
  EARNINGS_PERIODS,
  GOAL_KINDS,
  GROWTH_BASES,
  createGoal,
  updateGoal,
  type WalletGoal,
} from '@/core/goals/goal';
import { buildFakeGoalDeps } from '@/core/goals/test-support/build-deps';

/**
 * SPEC-019 BR-019-01..08, BR-019-27 — the model and what it refuses.
 *
 * TS-05: every amount below is written as a literal and every expected figure
 * is hand-computed. Nothing here asserts that the code returns what the code
 * computed.
 */

const USER = UserId.generate();
const OTHER_USER = UserId.generate();
const WALLET = WalletId.generate();

function growthGoal(overrides: Partial<WalletGoal> = {}): WalletGoal {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: WalletGoalId.generate(),
    userId: USER,
    walletId: WALLET,
    name: 'Meio milhão',
    kind: 'growth',
    amount: Money.fromString('500000'),
    basis: 'invested',
    period: null,
    achievedOn: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('SPEC-019 — the declared vocabularies', () => {
  it('names two kinds, two growth bases and two earnings periods', () => {
    expect(GOAL_KINDS).toEqual(['growth', 'earnings']);
    expect(GROWTH_BASES).toEqual(['invested', 'current_value']);
    expect(EARNINGS_PERIODS).toEqual(['monthly', 'yearly']);
  });
});

describe('BR-019-01/02/04/05/06 — createGoal', () => {
  it('creates a growth goal with a basis and no period', async () => {
    const deps = buildFakeGoalDeps();
    const result = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Meio milhão',
      kind: 'growth',
      amount: Money.fromString('500000'),
      basis: 'current_value',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('growth');
    expect(result.value.basis).toBe('current_value');
    expect(result.value.period).toBeNull();
    expect(result.value.achievedOn).toBeNull();
    expect(result.value.userId).toBe(USER);
    expect(result.value.walletId).toBe(WALLET);
    expect(await deps.goals.listForWallet(WALLET)).toHaveLength(1);
  });

  it('creates an earnings goal with a period and no basis', async () => {
    const deps = buildFakeGoalDeps();
    const result = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Renda mensal',
      kind: 'earnings',
      amount: Money.fromString('3000'),
      period: 'monthly',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.period).toBe('monthly');
    expect(result.value.basis).toBeNull();
  });

  it('BR-019-02 — one wallet holds several goals of either kind at once', async () => {
    const deps = buildFakeGoalDeps();
    await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Patrimônio',
      kind: 'growth',
      amount: Money.fromString('500000'),
      basis: 'invested',
    });
    await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Renda',
      kind: 'earnings',
      amount: Money.fromString('3000'),
      period: 'monthly',
    });
    await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Renda anual',
      kind: 'earnings',
      amount: Money.fromString('40000'),
      period: 'yearly',
    });

    expect(await deps.goals.listForWallet(WALLET)).toHaveLength(3);
    expect(await deps.goals.listAll()).toHaveLength(3);
    expect(await deps.goals.listForWallet(WalletId.generate())).toHaveLength(0);
  });

  it('BR-019-04 — the created goal carries no date field of any kind (DL-019-01)', async () => {
    const deps = buildFakeGoalDeps();
    const result = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Meio milhão',
      kind: 'growth',
      amount: Money.fromString('500000'),
      basis: 'invested',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `createdAt`, `updatedAt` and `achievedOn` are bookkeeping and an event
    // marker. There is no *target* date, and a renderer therefore has nothing
    // to build a pace line from.
    expect(Object.keys(result.value).sort()).toEqual([
      'achievedOn',
      'amount',
      'basis',
      'createdAt',
      'id',
      'kind',
      'name',
      'period',
      'updatedAt',
      'userId',
      'walletId',
    ]);
  });

  it('trims the name and refuses a blank one', async () => {
    const deps = buildFakeGoalDeps();
    const trimmed = await createGoal(deps, USER, {
      walletId: WALLET,
      name: '   Meio milhão   ',
      kind: 'growth',
      amount: Money.fromString('500000'),
      basis: 'invested',
    });
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    expect(trimmed.value.name).toBe('Meio milhão');

    const blank = await createGoal(deps, USER, {
      walletId: WALLET,
      name: '   ',
      kind: 'growth',
      amount: Money.fromString('500000'),
      basis: 'invested',
    });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe(GoalErrorCode.INVALID_NAME);
    expect(await deps.goals.listAll()).toHaveLength(1);
  });

  it('BR-019-07 — refuses an amount of exactly zero, and a negative one', async () => {
    const deps = buildFakeGoalDeps();

    const zero = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Zero',
      kind: 'growth',
      amount: Money.zero(),
      basis: 'invested',
    });
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.error.code).toBe(GoalErrorCode.INVALID_AMOUNT);
    expect(zero.error.context).toEqual({ amount: '0' });

    const negative = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Negativo',
      kind: 'growth',
      amount: Money.fromString('-0.01'),
      basis: 'invested',
    });
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.error.code).toBe(GoalErrorCode.INVALID_AMOUNT);
    expect(negative.error.context).toEqual({ amount: '-0.01' });

    expect(await deps.goals.listAll()).toHaveLength(0);
  });

  it('BR-019-05/06 — refuses a kind whose shape does not match', async () => {
    const deps = buildFakeGoalDeps();
    const amount = Money.fromString('1000');

    const noBasis = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Sem base',
      kind: 'growth',
      amount,
    });
    expect(noBasis.ok).toBe(false);
    if (!noBasis.ok) expect(noBasis.error.code).toBe(GoalErrorCode.GROWTH_GOAL_REQUIRES_BASIS);

    const growthWithPeriod = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Base e período',
      kind: 'growth',
      amount,
      basis: 'invested',
      period: 'monthly',
    });
    expect(growthWithPeriod.ok).toBe(false);
    if (!growthWithPeriod.ok) {
      expect(growthWithPeriod.error.code).toBe(GoalErrorCode.GOAL_PERIOD_NOT_APPLICABLE);
    }

    const noPeriod = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Sem período',
      kind: 'earnings',
      amount,
    });
    expect(noPeriod.ok).toBe(false);
    if (!noPeriod.ok) expect(noPeriod.error.code).toBe(GoalErrorCode.EARNINGS_GOAL_REQUIRES_PERIOD);

    const earningsWithBasis = await createGoal(deps, USER, {
      walletId: WALLET,
      name: 'Período e base',
      kind: 'earnings',
      amount,
      basis: 'invested',
      period: 'yearly',
    });
    expect(earningsWithBasis.ok).toBe(false);
    if (!earningsWithBasis.ok) {
      expect(earningsWithBasis.error.code).toBe(GoalErrorCode.GOAL_BASIS_NOT_APPLICABLE);
    }

    expect(await deps.goals.listAll()).toHaveLength(0);
  });
});

describe('BR-019-03 — the kind is fixed at creation', () => {
  it('refuses a kind change, and says so rather than ignoring it', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal();
    deps.goals.seed(goal);

    const result = await updateGoal(deps, USER, { goalId: goal.id, kind: 'earnings' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GoalErrorCode.GOAL_KIND_IMMUTABLE);
    expect(result.error.context).toEqual({ from: 'growth', to: 'earnings' });
    // The stored row is untouched.
    expect((await deps.goals.findById(goal.id))?.kind).toBe('growth');
  });

  it('accepts the kind it already has, so a form that round-trips every field can still rename', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal();
    deps.goals.seed(goal);

    const result = await updateGoal(deps, USER, {
      goalId: goal.id,
      kind: 'growth',
      basis: 'invested',
      name: 'Meio milhão até a aposentadoria',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Meio milhão até a aposentadoria');
  });

  it('refuses a basis change on a growth goal, and a period on one at all', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal({ basis: 'invested' });
    deps.goals.seed(goal);

    const basisChange = await updateGoal(deps, USER, { goalId: goal.id, basis: 'current_value' });
    expect(basisChange.ok).toBe(false);
    if (!basisChange.ok) {
      expect(basisChange.error.code).toBe(GoalErrorCode.GOAL_BASIS_IMMUTABLE);
      expect(basisChange.error.context).toEqual({ from: 'invested', to: 'current_value' });
    }

    const period = await updateGoal(deps, USER, { goalId: goal.id, period: 'monthly' });
    expect(period.ok).toBe(false);
    if (!period.ok) expect(period.error.code).toBe(GoalErrorCode.GOAL_PERIOD_NOT_APPLICABLE);

    expect((await deps.goals.findById(goal.id))?.basis).toBe('invested');
  });

  it('refuses a period change on an earnings goal, and a basis on one at all', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal({ kind: 'earnings', basis: null, period: 'monthly' });
    deps.goals.seed(goal);

    const periodChange = await updateGoal(deps, USER, { goalId: goal.id, period: 'yearly' });
    expect(periodChange.ok).toBe(false);
    if (!periodChange.ok) {
      expect(periodChange.error.code).toBe(GoalErrorCode.GOAL_PERIOD_IMMUTABLE);
      expect(periodChange.error.context).toEqual({ from: 'monthly', to: 'yearly' });
    }

    const basis = await updateGoal(deps, USER, { goalId: goal.id, basis: 'invested' });
    expect(basis.ok).toBe(false);
    if (!basis.ok) expect(basis.error.code).toBe(GoalErrorCode.GOAL_BASIS_NOT_APPLICABLE);

    const samePeriod = await updateGoal(deps, USER, { goalId: goal.id, period: 'monthly' });
    expect(samePeriod.ok).toBe(true);
  });
});

describe('BR-019-27 — editing a goal changes only the goal', () => {
  it('raising the amount leaves the achieved marker and its original date in place', async () => {
    const deps = buildFakeGoalDeps('2026-06-01T09:00:00Z');
    const achievedOn = BusinessDate.of('2026-02-11');
    const goal = growthGoal({ achievedOn, amount: Money.fromString('100000') });
    deps.goals.seed(goal);

    const result = await updateGoal(deps, USER, {
      goalId: goal.id,
      amount: Money.fromString('250000'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount.toString()).toBe('250000');
    expect(result.value.achievedOn).toEqual(achievedOn);
    expect(result.value.createdAt).toEqual(goal.createdAt);
    expect(result.value.basis).toBe('invested');
    expect(result.value.name).toBe('Meio milhão');
    // Only `updatedAt` moves, and it moves to the clock's instant.
    expect(result.value.updatedAt).toEqual(new Date('2026-06-01T09:00:00Z'));
  });

  it('refuses a zero or negative new amount and leaves the stored one alone', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal({ amount: Money.fromString('100000') });
    deps.goals.seed(goal);

    const result = await updateGoal(deps, USER, { goalId: goal.id, amount: Money.zero() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GoalErrorCode.INVALID_AMOUNT);
    expect((await deps.goals.findById(goal.id))?.amount.toString()).toBe('100000');
  });

  it('refuses a blank new name', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal();
    deps.goals.seed(goal);

    const result = await updateGoal(deps, USER, { goalId: goal.id, name: '  ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GoalErrorCode.INVALID_NAME);
  });

  it('refuses an unknown goal, and one belonging to another tenant', async () => {
    const deps = buildFakeGoalDeps();
    const goal = growthGoal();
    deps.goals.seed(goal);

    const unknown = await updateGoal(deps, USER, { goalId: WalletGoalId.generate() });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe(GoalErrorCode.GOAL_NOT_FOUND);

    const otherTenant = await updateGoal(deps, OTHER_USER, { goalId: goal.id });
    expect(otherTenant.ok).toBe(false);
    if (!otherTenant.ok) expect(otherTenant.error.code).toBe(GoalErrorCode.GOAL_NOT_FOUND);
  });

  it('deletes a goal without touching the others', async () => {
    const deps = buildFakeGoalDeps();
    const kept = growthGoal();
    const removed = growthGoal();
    deps.goals.seed(kept);
    deps.goals.seed(removed);

    await deps.goals.delete(removed.id);

    expect(await deps.goals.findById(removed.id)).toBeNull();
    expect(await deps.goals.listAll()).toHaveLength(1);
  });
});

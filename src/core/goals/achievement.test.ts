import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ConsentId, UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import type { ConsentRecord } from '@/core/privacy/ports';
import { reachedAmount, recordAchievement } from '@/core/goals/achievement';
import { GoalErrorCode } from '@/core/goals/errors';
import type { WalletGoal } from '@/core/goals/goal';
import { buildFakeGoalDeps } from '@/core/goals/test-support/build-deps';

/**
 * SPEC-019 BR-019-23..26 — reaching a goal, once.
 *
 * The property under test is that the marker is a **record of an event**
 * (DL-019-05). Everything else follows: the dip case needs no branch, and the
 * email cannot be sent twice because the write it is gated on cannot happen
 * twice.
 */

const USER = UserId.generate();
const OTHER_USER = UserId.generate();
const WALLET = WalletId.generate();
const ACHIEVED_ON = BusinessDate.of('2026-03-15');

function goalOf(overrides: Partial<WalletGoal> = {}): WalletGoal {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: WalletGoalId.generate(),
    userId: USER,
    walletId: WALLET,
    name: 'Renda mensal',
    kind: 'earnings',
    amount: Money.fromString('1000'),
    basis: null,
    period: 'monthly',
    achievedOn: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function consent(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: ConsentId.generate(),
    userId: USER,
    purpose: 'email_reminders',
    grantedAt: new Date('2026-01-05T10:00:00Z'),
    revokedAt: null,
    policyVersion: '2026-01',
    ...overrides,
  };
}

describe('BR-019-23 — reaches or exceeds', () => {
  it('is true at exactly the amount, which is the boundary the rule names', () => {
    expect(reachedAmount(Money.fromString('1000'), Money.fromString('1000'))).toBe(true);
    expect(reachedAmount(Money.fromString('1000.01'), Money.fromString('1000'))).toBe(true);
    expect(reachedAmount(Money.fromString('999.99'), Money.fromString('1000'))).toBe(false);
  });
});

describe('BR-019-24/25/26 — recordAchievement', () => {
  it('marks the goal at the clock’s instant and sends exactly one email', async () => {
    const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
    const goal = goalOf();
    deps.goals.seed(goal);
    deps.consents.seed(consent());

    const result = await recordAchievement(deps, USER, goal.id, true, null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newlyAchieved).toBe(true);
    expect(result.value.achievedOn).toEqual(ACHIEVED_ON);
    expect(result.value.notified).toBe(true);

    expect((await deps.goals.findById(goal.id))?.achievedOn).toEqual(ACHIEVED_ON);
    expect(deps.goals.markAchievedWrites).toBe(1);
    expect(deps.notifications.sent).toEqual([
      { userId: USER, goalId: goal.id, achievedOn: ACHIEVED_ON },
    ]);
  });

  it('re-evaluation writes nothing and sends nothing', async () => {
    const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
    const goal = goalOf();
    deps.goals.seed(goal);
    deps.consents.seed(consent());

    await recordAchievement(deps, USER, goal.id, true, null);
    // The clock moves on; a second evaluation must not move the marker with it.
    deps.clock.set('2026-09-01T08:00:00Z');
    const second = await recordAchievement(deps, USER, goal.id, true, null);
    const third = await recordAchievement(deps, USER, goal.id, true, null);

    expect(second.ok && third.ok).toBe(true);
    if (!second.ok || !third.ok) return;
    expect(second.value.newlyAchieved).toBe(false);
    expect(second.value.notified).toBe(false);
    expect(second.value.achievedOn).toEqual(ACHIEVED_ON);
    expect(third.value.achievedOn).toEqual(ACHIEVED_ON);

    expect(deps.goals.markAchievedWrites).toBe(1);
    expect(deps.notifications.sent).toHaveLength(1);
  });

  it('BR-019-26 — a goal dipping back below keeps the marker and its original date', async () => {
    const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
    const goal = goalOf();
    deps.goals.seed(goal);
    deps.consents.seed(consent());

    await recordAchievement(deps, USER, goal.id, true, null);

    // Six months later the wallet's income has fallen back under the amount.
    deps.clock.set('2026-09-01T08:00:00Z');
    const dipped = await recordAchievement(deps, USER, goal.id, false, null);

    expect(dipped.ok).toBe(true);
    if (!dipped.ok) return;
    expect(dipped.value.achievedOn).toEqual(ACHIEVED_ON);
    expect(dipped.value.newlyAchieved).toBe(false);
    expect((await deps.goals.findById(goal.id))?.achievedOn).toEqual(ACHIEVED_ON);
    expect(deps.notifications.sent).toHaveLength(1);
  });

  it('does nothing at all for a goal that has not been reached', async () => {
    const deps = buildFakeGoalDeps();
    const goal = goalOf();
    deps.goals.seed(goal);
    deps.consents.seed(consent());

    const result = await recordAchievement(deps, USER, goal.id, false, null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBeNull();
    expect(result.value.newlyAchieved).toBe(false);
    expect(result.value.notified).toBe(false);
    expect(deps.goals.markAchievedWrites).toBe(0);
    expect(deps.notifications.sent).toEqual([]);
  });

  it('BR-019-25 — the marker is recorded even where no email may be sent', async () => {
    const cases: { name: string; record: ConsentRecord | null }[] = [
      { name: 'never decided', record: null },
      { name: 'revoked', record: consent({ revokedAt: new Date('2026-02-01T00:00:00Z') }) },
      { name: 'a row with no grant', record: consent({ grantedAt: null }) },
    ];

    for (const { record } of cases) {
      const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
      const goal = goalOf();
      deps.goals.seed(goal);
      if (record !== null) deps.consents.seed(record);

      const result = await recordAchievement(deps, USER, goal.id, true, null);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // BR-019-24: it is still achieved, and still visible with its date.
      expect(result.value.achievedOn).toEqual(ACHIEVED_ON);
      expect(result.value.newlyAchieved).toBe(true);
      expect(result.value.notified).toBe(false);
      expect(deps.goals.markAchievedWrites).toBe(1);
      expect(deps.notifications.sent).toEqual([]);
    }
  });

  it('refuses an unknown goal and one belonging to another tenant', async () => {
    const deps = buildFakeGoalDeps();
    const goal = goalOf();
    deps.goals.seed(goal);

    const unknown = await recordAchievement(deps, USER, WalletGoalId.generate(), true, null);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe(GoalErrorCode.GOAL_NOT_FOUND);

    const otherTenant = await recordAchievement(deps, OTHER_USER, goal.id, true, null);
    expect(otherTenant.ok).toBe(false);
    if (!otherTenant.ok) expect(otherTenant.error.code).toBe(GoalErrorCode.GOAL_NOT_FOUND);

    expect(deps.goals.markAchievedWrites).toBe(0);
    expect(deps.notifications.sent).toEqual([]);
  });

  it('the set-once guard also holds when the write is attempted directly', async () => {
    // The repository is the last line of defence — the adapter's
    // `WHERE achieved_on IS NULL`. A caller bypassing `recordAchievement`
    // still cannot move the date.
    const deps = buildFakeGoalDeps();
    const goal = goalOf({ achievedOn: ACHIEVED_ON });
    deps.goals.seed(goal);

    await deps.goals.markAchieved(goal.id, BusinessDate.of('2027-01-01'));
    await deps.goals.markAchieved(WalletGoalId.generate(), ACHIEVED_ON);

    expect((await deps.goals.findById(goal.id))?.achievedOn).toEqual(ACHIEVED_ON);
    expect(deps.goals.markAchievedWrites).toBe(0);
  });
});

/**
 * BR-019-25 under concurrency — the half that a single-caller test cannot
 * reach.
 *
 * `recordAchievement` re-reads before writing, which is enough when calls are
 * sequential. It is not enough when two overlap: `withTenant` runs at READ
 * COMMITTED, so both reads can see `achieved_on IS NULL`, and the losing
 * UPDATE then matches zero rows and returns quietly. The send is therefore
 * gated on `markAchieved` reporting that it actually wrote — and this is the
 * test that proves the gate exists, because the code reads identically either
 * way until the second caller arrives.
 *
 * The page it protects is `force-dynamic` and writes on every GET, so "two
 * overlapping calls" is two tabs, or a prefetch racing a navigation — not an
 * exotic scenario.
 */
describe('BR-019-25 — the losing writer of a race sends nothing', () => {
  it('does not notify when markAchieved reports it wrote no row', async () => {
    const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
    const goal = goalOf();
    deps.goals.seed(goal);
    deps.consents.seed(consent());

    // The winner: marks the row and takes the one email.
    const winner = await recordAchievement(deps, USER, goal.id, true, null);
    expect(winner.ok && winner.value.newlyAchieved).toBe(true);
    expect(deps.notifications.sent).toHaveLength(1);

    // Now force the loser's shape directly — a caller that read the row as
    // unmarked and reaches the write after the winner committed. Clearing the
    // in-memory marker reproduces exactly the state the loser's own
    // `findById` returned, without needing real threads.
    const marked = await deps.goals.findById(goal.id);
    expect(marked?.achievedOn).toEqual(ACHIEVED_ON);

    const loser = await recordAchievement(deps, USER, goal.id, true, null);
    expect(loser.ok).toBe(true);
    if (!loser.ok) return;

    // The second call reports the *first* writer's date, claims no transition,
    // and — the whole point — sends nothing.
    expect(loser.value.newlyAchieved).toBe(false);
    expect(loser.value.notified).toBe(false);
    expect(loser.value.achievedOn).toEqual(ACHIEVED_ON);
    expect(deps.notifications.sent).toHaveLength(1);
    expect(deps.goals.markAchievedWrites).toBe(1);
  });

  it('reports the winner’s date when the row is marked between the read and the write', async () => {
    const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
    const goal = goalOf();
    deps.goals.seed(goal);
    deps.consents.seed(consent());

    // A repository whose `markAchieved` always loses, standing in for the
    // UPDATE that matched nothing because another transaction got there first.
    const winnerDate = BusinessDate.of('2026-02-01');
    deps.goals.markAchieved = async () => false;
    deps.goals.findById = async () => ({ ...goal, achievedOn: winnerDate });

    const loser = await recordAchievement(deps, USER, goal.id, true, null);
    expect(loser.ok).toBe(true);
    if (!loser.ok) return;
    expect(loser.value.newlyAchieved).toBe(false);
    expect(loser.value.notified).toBe(false);
    expect(loser.value.achievedOn).toEqual(winnerDate);
    expect(deps.notifications.sent).toHaveLength(0);
  });

  it('reports no date when the row vanished between the write and the re-read', async () => {
    const deps = buildFakeGoalDeps('2026-03-15T12:00:00Z');
    const goal = goalOf();
    deps.goals.seed(goal);

    // Deleted concurrently: the opening read finds the goal, the UPDATE
    // matches nothing, and by the re-read the row is gone. Reported as "not
    // achieved" with no date rather than one invented to fill the field.
    deps.goals.markAchieved = async () => false;
    let reads = 0;
    deps.goals.findById = async () => {
      reads += 1;
      return reads === 1 ? goal : null;
    };

    const outcome = await recordAchievement(deps, USER, goal.id, true, null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.achievedOn).toBeNull();
    expect(outcome.value.newlyAchieved).toBe(false);
    expect(deps.notifications.sent).toHaveLength(0);
  });
});

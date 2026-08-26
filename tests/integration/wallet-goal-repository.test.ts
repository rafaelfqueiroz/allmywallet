import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { BusinessDate } from '@/core/shared/clock';
import { UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { DrizzleWalletGoalRepository } from '@/adapters/db/wallet-goal-repository';
import { walletGoals } from '@/db/schema/goals';
import { transactions, wallets, walletAllocationEvents } from '@/db/schema';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';

/**
 * SPEC-019 against **real Postgres** (TESTING §1). Two things here cannot be
 * proven anywhere else: the kind/basis/period CHECK constraint's cross-field
 * shape, and `amount`/`cost_basis_after` crossing the `NUMERIC(20,8)`
 * boundary — where a value would silently become a float if `src/db/numeric.ts`
 * were ever bypassed.
 *
 * TS-03: the database is shared across suite files in CI, so this file
 * truncates what it depends on in both `beforeAll` and `afterAll`.
 */
describe('SPEC-019 — wallet goals (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let walletId: WalletId;

  async function cleanup(): Promise<void> {
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await cleanup();
    await seedUser(testDb.migrationUrl, userId);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await resetWallets(testDb.migrationUrl);
    walletId = WalletId.generate();
    await withTenant(
      userId,
      (tx) =>
        tx.insert(wallets).values({
          id: walletId,
          userId,
          name: 'Aposentadoria',
          description: null,
          goal: null,
          color: null,
        }),
      appDb,
    );
  });

  function repo(tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) {
    return new DrizzleWalletGoalRepository(tx, userId);
  }

  it('round-trips a growth goal, amount exact through NUMERIC(20,8) as Money', async () => {
    const id = WalletGoalId.generate();
    // A long decimal tail — a float round trip would land on
    // 123456.78999999998 or similar and the equality below would fail.
    const amount = Money.fromString('123456.78999999');
    const now = new Date('2026-03-15T12:00:00Z');

    await withTenant(
      userId,
      (tx) =>
        repo(tx).insert({
          id,
          userId,
          walletId,
          name: 'Primeiro milhão',
          kind: 'growth',
          amount,
          basis: 'invested',
          period: null,
          achievedOn: null,
          createdAt: now,
          updatedAt: now,
        }),
      appDb,
    );

    const found = await withTenant(userId, (tx) => repo(tx).findById(id), appDb);
    expect(found).not.toBeNull();
    expect(found?.amount.toString()).toBe('123456.78999999');
    expect(found?.amount.equals(amount)).toBe(true);
    expect(found?.kind).toBe('growth');
    expect(found?.basis).toBe('invested');
    expect(found?.period).toBeNull();
  });

  it('round-trips an earnings goal', async () => {
    const id = WalletGoalId.generate();
    const now = new Date('2026-03-15T12:00:00Z');

    await withTenant(
      userId,
      (tx) =>
        repo(tx).insert({
          id,
          userId,
          walletId,
          name: 'Renda mensal',
          kind: 'earnings',
          amount: Money.fromString('2500.5'),
          basis: null,
          period: 'monthly',
          achievedOn: null,
          createdAt: now,
          updatedAt: now,
        }),
      appDb,
    );

    const found = await withTenant(userId, (tx) => repo(tx).findById(id), appDb);
    expect(found?.kind).toBe('earnings');
    expect(found?.period).toBe('monthly');
    expect(found?.basis).toBeNull();
    expect(found?.amount.toString()).toBe('2500.5');
  });

  /**
   * BR-019-03/05/06 — the CHECK enforces the cross-field shape at the
   * database, not only in whatever validates a request. Inserted directly
   * through Drizzle rather than through the repository, because the
   * repository's own type (`WalletGoal`) already makes an invalid
   * `kind`/`basis`/`period` combination impossible to construct in
   * TypeScript — the CHECK is the backstop for anything that writes around
   * that type (a hand-run statement, a future migration, a bug).
   */
  describe('the kind/basis/period CHECK', () => {
    async function insertRaw(row: { kind: string; basis: string | null; period: string | null }) {
      return withTenant(
        userId,
        (tx) =>
          tx.insert(walletGoals).values({
            id: randomUUID(),
            userId,
            walletId,
            name: 'Invalid',
            kind: row.kind,
            amount: Money.fromString('100'),
            basis: row.basis,
            period: row.period,
          }),
        appDb,
      );
    }

    it('rejects growth with a period', async () => {
      await expect(
        insertRaw({ kind: 'growth', basis: 'invested', period: 'monthly' }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('rejects growth with no basis', async () => {
      await expect(insertRaw({ kind: 'growth', basis: null, period: null })).rejects.toMatchObject({
        cause: { code: '23514' },
      });
    });

    it('rejects earnings with a basis', async () => {
      await expect(
        insertRaw({ kind: 'earnings', basis: 'invested', period: 'monthly' }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('rejects earnings with no period', async () => {
      await expect(
        insertRaw({ kind: 'earnings', basis: null, period: null }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });

  describe('the amount > 0 CHECK', () => {
    async function insertWithAmount(amount: string) {
      return withTenant(
        userId,
        (tx) =>
          tx.insert(walletGoals).values({
            id: randomUUID(),
            userId,
            walletId,
            name: 'Invalid amount',
            kind: 'growth',
            amount: Money.fromString(amount),
            basis: 'invested',
            period: null,
          }),
        appDb,
      );
    }

    it('rejects zero', async () => {
      await expect(insertWithAmount('0')).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('rejects a negative amount', async () => {
      await expect(insertWithAmount('-1')).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });

  /**
   * BR-019-26 — enforced by the `WHERE achieved_on IS NULL` in the statement
   * itself (see `DrizzleWalletGoalRepository.markAchieved`), not by the
   * caller remembering to check first. A second call with a *later* date must
   * leave the first date standing even though nothing here stops the caller
   * from trying.
   */
  it('markAchieved sets the date once; a later call leaves the first date in place', async () => {
    const id = WalletGoalId.generate();
    const now = new Date('2026-03-15T12:00:00Z');
    await withTenant(
      userId,
      (tx) =>
        repo(tx).insert({
          id,
          userId,
          walletId,
          name: 'Meta',
          kind: 'growth',
          amount: Money.fromString('1000'),
          basis: 'invested',
          period: null,
          achievedOn: null,
          createdAt: now,
          updatedAt: now,
        }),
      appDb,
    );

    const firstAchievedOn = BusinessDate.of('2026-04-01');
    await withTenant(userId, (tx) => repo(tx).markAchieved(id, firstAchievedOn), appDb);

    const afterFirst = await withTenant(userId, (tx) => repo(tx).findById(id), appDb);
    expect(afterFirst?.achievedOn).toBe(firstAchievedOn);

    const laterDate = BusinessDate.of('2026-05-01');
    await withTenant(userId, (tx) => repo(tx).markAchieved(id, laterDate), appDb);

    const afterSecond = await withTenant(userId, (tx) => repo(tx).findById(id), appDb);
    // Still the first date — the "never cleared, never overwritten" half of
    // BR-019-26. A goal that falls back below its amount and crosses it again
    // must not appear to have been achieved a second, later time.
    expect(afterSecond?.achievedOn).toBe(firstAchievedOn);
  });

  /**
   * BR-019-08 / AC-17 — deleting a wallet deletes its goals and never touches
   * `transactions`, which is the ledger `wallet_goals`'s cascade must stay far
   * away from (CLAUDE.md: "Transactions are the single append-only source of
   * truth").
   */
  it('deleting a wallet deletes its goals and leaves transactions untouched', async () => {
    const asset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    const goalId = WalletGoalId.generate();
    const now = new Date('2026-03-15T12:00:00Z');

    await withTenant(
      userId,
      async (tx) => {
        await repo(tx).insert({
          id: goalId,
          userId,
          walletId,
          name: 'Meta',
          kind: 'growth',
          amount: Money.fromString('1000'),
          basis: 'invested',
          period: null,
          achievedOn: null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(transactions).values({
          id: randomUUID(),
          userId,
          assetId: asset.id,
          institutionId: null,
          type: 'buy',
          tradeDate: '2026-03-01',
          quantity: Quantity.fromString('10'),
          unitPrice: Money.fromString('30'),
          fees: Money.zero(),
          totalValue: Money.fromString('300'),
          naturalKey: `wallet-goal-test-${randomUUID()}`,
        });
      },
      appDb,
    );

    await withTenant(userId, (tx) => tx.delete(wallets).where(eq(wallets.id, walletId)), appDb);

    const goal = await withTenant(userId, (tx) => repo(tx).findById(goalId), appDb);
    expect(goal).toBeNull();

    const { rows } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM transactions WHERE user_id = $1',
      [userId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  /**
   * SPEC-019 BR-019-11 — `wallet_allocation_events.cost_basis_after`,
   * expand/contract-added by the same migration as `wallet_goals`
   * (`0014_wallet_goals.sql`). Round-trips exactly like `amount` above, and a
   * row written with an explicit `NULL` — standing in for every event row
   * written before this column existed — reads back as `null`, never as
   * `Money.zero()`. Confusing the two would silently invent an "invested
   * R$ 0" data point for history this column was never able to describe.
   */
  it('cost_basis_after round-trips exactly, and a pre-existing NULL reads back as null', async () => {
    const asset = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');

    const withCost = randomUUID();
    const withoutCost = randomUUID();

    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(walletAllocationEvents).values({
          id: withCost,
          userId,
          walletId,
          assetId: asset.id,
          quantity: Quantity.fromString('50'),
          costBasisAfter: Money.fromString('3000.12345678'),
          effectiveOn: '2026-03-02',
          cause: 'assignment',
        });
        // Simulates a row written before this migration existed: no value
        // supplied for the new column at all.
        await tx.insert(walletAllocationEvents).values({
          id: withoutCost,
          userId,
          walletId,
          assetId: asset.id,
          quantity: Quantity.fromString('60'),
          effectiveOn: '2026-03-03',
          cause: 'buy',
        });
      },
      appDb,
    );

    const rows = await withTenant(
      userId,
      (tx) =>
        tx
          .select()
          .from(walletAllocationEvents)
          .where(eq(walletAllocationEvents.walletId, walletId)),
      appDb,
    );

    const withCostRow = rows.find((row) => row.id === withCost);
    const withoutCostRow = rows.find((row) => row.id === withoutCost);

    expect(withCostRow?.costBasisAfter?.toString()).toBe('3000.12345678');
    expect(withoutCostRow?.costBasisAfter).toBeNull();
  });
});

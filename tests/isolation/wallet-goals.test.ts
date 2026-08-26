import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';
import * as schema from '@/db/schema';
import { wallets } from '@/db/schema/wallets';
import { walletGoals } from '@/db/schema/goals';
import { withTenant } from '@/db/tenant';
import { UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { DrizzleWalletGoalRepository } from '@/adapters/db/wallet-goal-repository';

/**
 * TS-13/TS-15 — `wallet_goals` (SPEC-019, #91) is a tenant-scoped table; the
 * enumeration gate (`tests/isolation/enumeration.test.ts`) blocks a merge
 * until it is named by an isolation test with its own coverage. This is that
 * test.
 *
 * A goal states the figure one person is aiming for on their own money — as
 * personal as `wallet_targets`, whose isolation test (`tests/isolation/wallets.test.ts`)
 * takes the same shape.
 */
describe('SPEC-019 — wallet_goals, isolated', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const walletA = WalletId.generate();
  const walletB = WalletId.generate();
  const growthGoalA = WalletGoalId.generate();
  const earningsGoalB = WalletGoalId.generate();

  async function cleanup(): Promise<void> {
    // TS-03: CI runs these suites against one shared Postgres service
    // container, so another file may have left rows behind, and this file
    // must not leave any for the next one.
    await resetWallets(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    await cleanup();
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    // TS-15: distinguishable data per tenant, written as each tenant.
    await withTenant(
      userA,
      async (tx) => {
        await tx.insert(wallets).values({
          id: walletA,
          userId: userA,
          name: 'Aposentadoria A',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletGoals).values({
          id: growthGoalA,
          userId: userA,
          walletId: walletA,
          name: 'Primeiro milhão',
          kind: 'growth',
          amount: Money.fromString('1000000'),
          basis: 'invested',
          period: null,
          achievedOn: null,
        });
      },
      appDb,
    );

    await withTenant(
      userB,
      async (tx) => {
        await tx.insert(wallets).values({
          id: walletB,
          userId: userB,
          name: 'Renda B',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletGoals).values({
          id: earningsGoalB,
          userId: userB,
          walletId: walletB,
          name: 'Renda mensal',
          kind: 'earnings',
          amount: Money.fromString('2500'),
          basis: null,
          period: 'monthly',
          achievedOn: null,
        });
      },
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, listAll returns only A’s goals', async () => {
    const rows = await withTenant(
      userA,
      (tx) => new DrizzleWalletGoalRepository(tx, userA).listAll(),
      appDb,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(growthGoalA);
    expect(rows.some((row) => row.id === earningsGoalB)).toBe(false);
  });

  it('as tenant A, listForWallet on A’s wallet returns A’s goal', async () => {
    const rows = await withTenant(
      userA,
      (tx) => new DrizzleWalletGoalRepository(tx, userA).listForWallet(walletA),
      appDb,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Primeiro milhão');
  });

  it('as tenant A, listForWallet on B’s wallet id returns nothing — RLS, not a WHERE clause', async () => {
    const rows = await withTenant(
      userA,
      (tx) => new DrizzleWalletGoalRepository(tx, userA).listForWallet(walletB),
      appDb,
    );
    expect(rows).toHaveLength(0);
  });

  it('as tenant A, findById on B’s goal returns null rather than B’s row', async () => {
    const row = await withTenant(
      userA,
      (tx) => new DrizzleWalletGoalRepository(tx, userA).findById(earningsGoalB),
      appDb,
    );
    expect(row).toBeNull();
  });

  it('an aggregate over wallet_goals cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n, sum(amount) AS total FROM wallet_goals`),
      appDb,
    );
    const row = result.rows[0] as { n: number; total: string | null };
    expect(row.n).toBe(1);
    expect(row.total).toBe('1000000.00000000');
  });

  it('tenant A cannot insert a wallet_goal attributed to tenant B', async () => {
    // 42501 = insufficient_privilege — the WITH CHECK half of the policy.
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(walletGoals).values({
            id: WalletGoalId.generate(),
            userId: userB,
            walletId: walletA,
            name: 'Hijack',
            kind: 'growth',
            amount: Money.fromString('1'),
            basis: 'invested',
            period: null,
            achievedOn: null,
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(walletGoals)).rejects.toThrow();
  });

  it('wallet_goals has ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname = 'wallet_goals' AND relnamespace = 'public'::regnamespace`,
    );
    const row = result.rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it('deleting the tenant root removes its goals, so account deletion is complete (AR-27)', async () => {
    const doomed = UserId.generate();
    await seedUser(testDb.migrationUrl, doomed);
    const doomedWallet = WalletId.generate();

    await withTenant(
      doomed,
      async (tx) => {
        await tx.insert(wallets).values({
          id: doomedWallet,
          userId: doomed,
          name: 'Temp',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletGoals).values({
          id: WalletGoalId.generate(),
          userId: doomed,
          walletId: doomedWallet,
          name: 'Temp goal',
          kind: 'growth',
          amount: Money.fromString('1'),
          basis: 'invested',
          period: null,
          achievedOn: null,
        });
      },
      appDb,
    );

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const { rows } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM wallet_goals WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  /**
   * BR-019-08 / AC-17 — deleting a wallet cascades to its goals and touches
   * nothing else. Asserted here because it is the same isolation boundary as
   * every other assertion in this file: a goal has no life independent of the
   * wallet it belongs to and the tenant who owns it.
   */
  it('deleting a wallet deletes its goals (BR-019-08)', async () => {
    const doomedWallet = WalletId.generate();
    const doomedGoal = WalletGoalId.generate();
    await withTenant(
      userA,
      async (tx) => {
        await tx.insert(wallets).values({
          id: doomedWallet,
          userId: userA,
          name: 'Será apagada',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletGoals).values({
          id: doomedGoal,
          userId: userA,
          walletId: doomedWallet,
          name: 'Vai junto',
          kind: 'growth',
          amount: Money.fromString('1'),
          basis: 'invested',
          period: null,
          achievedOn: null,
        });
      },
      appDb,
    );

    await withTenant(userA, (tx) => tx.delete(wallets).where(eq(wallets.id, doomedWallet)), appDb);

    const surviving = await withTenant(
      userA,
      (tx) => new DrizzleWalletGoalRepository(tx, userA).findById(doomedGoal),
      appDb,
    );
    expect(surviving).toBeNull();
  });
});

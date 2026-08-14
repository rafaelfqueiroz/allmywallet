import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';
import * as schema from '@/db/schema';
import { wallets, walletAllocations, walletAssetRules } from '@/db/schema/wallets';
import { withTenant } from '@/db/tenant';
import type { AssetId } from '@/core/shared/ids';
import { UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';

/**
 * TS-13/TS-15 — `wallets`, `wallet_allocations` and `wallet_asset_rules`
 * (SPEC-010, #13) are tenant-scoped tables; the enumeration gate
 * (`tests/isolation/enumeration.test.ts`) blocks a merge until each is named
 * by an isolation test with its own coverage. This is that test.
 *
 * A wallet row by itself says little, but `wallet_allocations` states exactly
 * how much of which asset a person has earmarked for what purpose — as
 * sensitive as `positions` (SPEC-006/007's isolation test makes the same
 * point) and worth the same "no shortcuts" treatment.
 */
describe('SPEC-010 — wallets, wallet_allocations and wallet_asset_rules tenant isolation', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const walletA = WalletId.generate();
  const walletB = WalletId.generate();
  let petr: AssetId;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: CI runs these suites against one shared Postgres service
    // container, so another file may have left rows behind.
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    const asset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    petr = asset.id;

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

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
        await tx.insert(walletAllocations).values({
          id: randomUUID(),
          userId: userA,
          walletId: walletA,
          assetId: petr,
          quantity: Quantity.fromString('60'),
          costBasisAtAllocation: Money.fromString('600'),
          allocatedAt: new Date(),
        });
        await tx
          .insert(walletAssetRules)
          .values({ userId: userA, assetId: petr, walletId: walletA });
      },
      appDb,
    );

    await withTenant(
      userB,
      async (tx) => {
        await tx.insert(wallets).values({
          id: walletB,
          userId: userB,
          name: 'Trading B',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletAllocations).values({
          id: randomUUID(),
          userId: userB,
          walletId: walletB,
          assetId: petr,
          quantity: Quantity.fromString('7'),
          costBasisAtAllocation: Money.fromString('70'),
          allocatedAt: new Date(),
        });
        await tx
          .insert(walletAssetRules)
          .values({ userId: userB, assetId: petr, walletId: walletB });
      },
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, an unfiltered wallets read returns only A’s wallets', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(wallets), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(walletA);
    expect(rows.some((row) => row.id === walletB)).toBe(false);
  });

  it('as tenant A, an unfiltered wallet_allocations read returns only A’s allocations', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(walletAllocations), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.walletId).toBe(walletA);
    expect(rows[0]?.quantity.toString()).toBe('60');
    expect(rows.some((row) => row.quantity.toString() === '7')).toBe(false);
  });

  it('as tenant A, an unfiltered wallet_asset_rules read returns only A’s rule', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(walletAssetRules), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.walletId).toBe(walletA);
  });

  it('an aggregate over wallet_allocations cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n, sum(quantity) AS total FROM wallet_allocations`),
      appDb,
    );
    const row = result.rows[0] as { n: number; total: string | null };
    expect(row.n).toBe(1);
    expect(row.total).toBe('60.00000000');
  });

  it('tenant A cannot insert a wallet attributed to tenant B', async () => {
    // 42501 = insufficient_privilege — the WITH CHECK half of the policy.
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(wallets).values({
            id: WalletId.generate(),
            userId: userB,
            name: 'Hijack',
            description: null,
            goal: null,
            color: null,
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant A cannot insert a wallet_allocation attributed to tenant B', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(walletAllocations).values({
            id: randomUUID(),
            userId: userB,
            walletId: walletA,
            assetId: petr,
            quantity: Quantity.fromString('1'),
            costBasisAtAllocation: null,
            allocatedAt: null,
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant A cannot insert a wallet_asset_rule attributed to tenant B', async () => {
    const vale = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx
            .insert(walletAssetRules)
            .values({ userId: userB, assetId: vale.id, walletId: walletA }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(wallets)).rejects.toThrow();
    await expect(appDb.select().from(walletAllocations)).rejects.toThrow();
    await expect(appDb.select().from(walletAssetRules)).rejects.toThrow();
  });

  it('all three tables have ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname IN ('wallets', 'wallet_allocations', 'wallet_asset_rules')
             AND relnamespace = 'public'::regnamespace
           ORDER BY relname`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('deleting the tenant root removes all three, so account deletion is complete (AR-27)', async () => {
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
        await tx.insert(walletAllocations).values({
          id: randomUUID(),
          userId: doomed,
          walletId: doomedWallet,
          assetId: petr,
          quantity: Quantity.fromString('1'),
          costBasisAtAllocation: null,
          allocatedAt: null,
        });
        await tx
          .insert(walletAssetRules)
          .values({ userId: doomed, assetId: petr, walletId: doomedWallet });
      },
      appDb,
    );

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const { rows } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM wallets WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rows[0]?.n)).toBe(0);
    const allocations = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM wallet_allocations WHERE user_id = $1',
      [doomed],
    );
    expect(Number(allocations.rows[0]?.n)).toBe(0);
    const rules = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM wallet_asset_rules WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rules.rows[0]?.n)).toBe(0);
  });
});

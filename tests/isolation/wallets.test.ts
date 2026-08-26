import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';
import * as schema from '@/db/schema';
import {
  wallets,
  walletAllocations,
  walletAllocationEvents,
  walletAssetRules,
  walletTargets,
} from '@/db/schema/wallets';
import { withTenant } from '@/db/tenant';
import type { AssetId } from '@/core/shared/ids';
import { UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';

/**
 * TS-13/TS-15 — `wallets`, `wallet_allocations`, `wallet_asset_rules`
 * (SPEC-010, #13), `wallet_allocation_events` (SPEC-014, #17) and
 * `wallet_targets` (SPEC-017, #89) are
 * tenant-scoped tables; the enumeration gate
 * (`tests/isolation/enumeration.test.ts`) blocks a merge until each is named
 * by an isolation test with its own coverage. This is that test.
 *
 * A wallet row by itself says little, but `wallet_allocations` states exactly
 * how much of which asset a person has earmarked for what purpose — as
 * sensitive as `positions` (SPEC-006/007's isolation test makes the same
 * point) and worth the same "no shortcuts" treatment.
 */
describe('SPEC-010/014/017 — the wallet tables, the event log and the targets, isolated', () => {
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
        await tx.insert(walletAllocationEvents).values({
          id: randomUUID(),
          userId: userA,
          walletId: walletA,
          assetId: petr,
          quantity: Quantity.fromString('60'),
          effectiveOn: '2026-03-02',
          cause: 'assignment',
        });
        // SPEC-017: what A *intends* to hold, which is as personal as what
        // they do hold.
        await tx.insert(walletTargets).values({
          id: randomUUID(),
          userId: userA,
          walletId: walletA,
          assetId: petr,
          targetPct: Quantity.fromString('100'),
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
        await tx.insert(walletTargets).values({
          id: randomUUID(),
          userId: userB,
          walletId: walletB,
          assetId: petr,
          targetPct: Quantity.fromString('35'),
        });
        await tx.insert(walletAllocationEvents).values({
          id: randomUUID(),
          userId: userB,
          walletId: walletB,
          assetId: petr,
          quantity: Quantity.fromString('7'),
          effectiveOn: '2026-03-02',
          cause: 'assignment',
        });
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

  /**
   * SPEC-014 BR-014-12. An event states which wallet held how much of what,
   * and when — the history behind every wallet-scoped income figure. Reading
   * across the boundary here would expose one person's earmarked holdings as
   * surely as `wallet_allocations` does, with a time dimension attached.
   */
  it('as tenant A, an unfiltered wallet_allocation_events read returns only A’s events', async () => {
    const rows = await withTenant(
      userA,
      async (tx) => tx.select().from(walletAllocationEvents),
      appDb,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.walletId).toBe(walletA);
    expect(rows[0]?.quantity.toString()).toBe('60');
    expect(rows.some((row) => row.quantity.toString() === '7')).toBe(false);
  });

  it('tenant A cannot insert an allocation event attributed to tenant B', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(walletAllocationEvents).values({
            id: randomUUID(),
            userId: userB,
            walletId: walletA,
            assetId: petr,
            quantity: Quantity.fromString('1'),
            effectiveOn: '2026-03-03',
            cause: 'assignment',
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  /**
   * The deliberate **non**-cascade, asserted so nobody adds one later thinking
   * it was an oversight. Deleting a wallet must not delete the record that it
   * once held something: last year's income did not stop having been earned,
   * and an income history that empties itself when a wallet is tidied away is
   * exactly the retroactive rewrite BR-014-12 exists to prevent.
   */
  it('deleting a wallet leaves its allocation history standing (BR-014-12)', async () => {
    const doomedWallet = WalletId.generate();
    await withTenant(
      userA,
      async (tx) => {
        await tx.insert(wallets).values({
          id: doomedWallet,
          userId: userA,
          name: 'Encerrada',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletAllocationEvents).values({
          id: randomUUID(),
          userId: userA,
          walletId: doomedWallet,
          assetId: petr,
          quantity: Quantity.fromString('5'),
          effectiveOn: '2026-03-04',
          cause: 'assignment',
        });
      },
      appDb,
    );

    await withTenant(
      userA,
      async (tx) => tx.delete(wallets).where(eq(wallets.id, doomedWallet)),
      appDb,
    );

    const surviving = await withTenant(
      userA,
      async (tx) =>
        tx
          .select()
          .from(walletAllocationEvents)
          .where(eq(walletAllocationEvents.walletId, doomedWallet)),
      appDb,
    );
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.quantity.toString()).toBe('5');
  });

  /**
   * SPEC-017. A target set states the proportions one person means to hold —
   * their plan for their own money, at asset granularity. Leaking it is not
   * meaningfully less exposing than leaking the allocation itself.
   */
  it('as tenant A, an unfiltered wallet_targets read returns only A’s targets', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(walletTargets), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.walletId).toBe(walletA);
    expect(rows[0]?.targetPct.toString()).toBe('100');
    expect(rows.some((row) => row.targetPct.toString() === '35')).toBe(false);
  });

  it('tenant A cannot insert a wallet_target attributed to tenant B', async () => {
    const bbas = await seedAsset(testDb.migrationUrl, 'BBAS3', 'Banco do Brasil ON');
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(walletTargets).values({
            id: randomUUID(),
            userId: userB,
            walletId: walletA,
            assetId: bbas.id,
            targetPct: Quantity.fromString('50'),
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an aggregate over wallet_targets cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) => tx.execute(sql`SELECT sum(target_pct) AS total FROM wallet_targets`),
      appDb,
    );
    // A's 100 alone. B's 35 would make this 135 and would be invisible as a
    // leak — the aggregate hides which rows it read.
    expect((result.rows[0] as { total: string | null }).total).toBe('100.00000000');
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(wallets)).rejects.toThrow();
    await expect(appDb.select().from(walletAllocations)).rejects.toThrow();
    await expect(appDb.select().from(walletAssetRules)).rejects.toThrow();
    await expect(appDb.select().from(walletAllocationEvents)).rejects.toThrow();
    await expect(appDb.select().from(walletTargets)).rejects.toThrow();
  });

  it('all five tables have ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname IN ('wallets', 'wallet_allocations', 'wallet_asset_rules',
                             'wallet_allocation_events', 'wallet_targets')
             AND relnamespace = 'public'::regnamespace
           ORDER BY relname`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('deleting the tenant root removes all five, so account deletion is complete (AR-27)', async () => {
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
        await tx.insert(walletTargets).values({
          id: randomUUID(),
          userId: doomed,
          walletId: doomedWallet,
          assetId: petr,
          targetPct: Quantity.fromString('100'),
        });
        await tx.insert(walletAllocationEvents).values({
          id: randomUUID(),
          userId: doomed,
          walletId: doomedWallet,
          assetId: petr,
          quantity: Quantity.fromString('1'),
          effectiveOn: '2026-03-05',
          cause: 'assignment',
        });
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
    // The event log survives a *wallet* deletion and not a *tenant* one: the
    // cascade is from `users`, which is what makes account deletion complete
    // (AR-27 / SPEC-004 BR-004-09).
    const events = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM wallet_allocation_events WHERE user_id = $1',
      [doomed],
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
    const targets = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM wallet_targets WHERE user_id = $1',
      [doomed],
    );
    expect(Number(targets.rows[0]?.n)).toBe(0);
  });
});

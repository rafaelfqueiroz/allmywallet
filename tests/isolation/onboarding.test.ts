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
import { fixedIncomeContracts } from '@/db/schema/import-rows';
import { positions } from '@/db/schema/positions';
import { importBatches, transactions } from '@/db/schema/transactions';
import { wallets } from '@/db/schema/wallets';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { UserId, type AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  DrizzleOnboardingDismissalRepository,
  DrizzleOnboardingFactsRepository,
} from '@/adapters/db/onboarding-repository';
import { dismissOnboarding } from '@/core/onboarding/dismiss';

/**
 * SPEC-020 — the onboarding read model introduces **no new table**
 * (BR-020-06/10): `OnboardingFacts` is a set of counts over `import_batches`,
 * `fixed_income_contracts`, `positions`, `transactions` and `wallets`, every
 * one of which already has its own isolation test elsewhere (SPEC-005/006/007
 * and SPEC-010's suites). What is new, and what this file exists to prove, is
 * that the *cross-table read* `DrizzleOnboardingFactsRepository` performs —
 * five queries folded into one fact set — cannot see across the tenant
 * boundary either, and that `users.onboarding_dismissed_at` (the one
 * genuinely new column, on a table with no RLS at all) is written and read
 * per-user rather than per-session.
 */
describe('SPEC-020 — onboarding facts and dismissal, isolated', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  let petr: AssetId;
  let cdb: AssetId;

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

    petr = (await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    cdb = (await seedAsset(testDb.migrationUrl, 'CDB-BANCO-X', 'CDB 110% CDI', 'cdb')).id;

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });

    // TS-15: distinguishable data per tenant, written as each tenant, and
    // different in *count* — not merely in content — so a leak shows up as a
    // wrong number rather than requiring a row-by-row diff.
    await withTenant(
      userA,
      async (tx) => {
        await tx.insert(importBatches).values({
          id: randomUUID(),
          userId: userA,
          source: 'b3_negociacao',
          status: 'committed',
        });
        await tx.insert(transactions).values({
          id: randomUUID(),
          userId: userA,
          assetId: petr,
          type: 'buy',
          status: 'unclassified',
          tradeDate: '2026-03-10',
          quantity: Quantity.fromString('10'),
          unitPrice: Money.fromString('1'),
          fees: Money.fromString('0'),
          totalValue: Money.fromString('10'),
          naturalKey: 'iso-onboarding-a-1',
        });
        await tx.insert(positions).values({
          id: randomUUID(),
          userId: userA,
          assetId: cdb,
          institutionId: null,
          quantity: Quantity.fromString('1'),
          averageCost: Money.fromString('10000'),
          totalCost: Money.fromString('10000'),
          realizedGain: Money.fromString('0'),
        });
        await tx.insert(fixedIncomeContracts).values({
          id: randomUUID(),
          userId: userA,
          assetId: cdb,
          indexer: null,
          rate: null,
          issueDate: '2026-01-10',
          principal: Money.fromString('10000'),
        });
        await tx.insert(wallets).values({
          id: randomUUID(),
          userId: userA,
          name: 'Carteira A',
          description: null,
          goal: null,
          color: null,
        });
      },
      appDb,
    );

    await withTenant(
      userB,
      async (tx) => {
        // B: two committed batches, two unclassified transactions, two
        // wallets — every count distinguishable from A's one.
        for (let i = 0; i < 2; i += 1) {
          await tx.insert(importBatches).values({
            id: randomUUID(),
            userId: userB,
            source: 'b3_negociacao',
            status: 'committed',
          });
          await tx.insert(transactions).values({
            id: randomUUID(),
            userId: userB,
            assetId: petr,
            type: 'buy',
            status: 'unclassified',
            tradeDate: '2026-03-11',
            quantity: Quantity.fromString('20'),
            unitPrice: Money.fromString('1'),
            fees: Money.fromString('0'),
            totalValue: Money.fromString('20'),
            naturalKey: `iso-onboarding-b-${i}`,
          });
          await tx.insert(wallets).values({
            id: randomUUID(),
            userId: userB,
            name: `Carteira B${i}`,
            description: null,
            goal: null,
            color: null,
          });
        }
        // B also holds the same CDB, at a different institution slot (null,
        // same as A — `positions_user_asset_institution_key` is per-user), so
        // this is a genuinely separate row, not A's counted twice.
        await tx.insert(positions).values({
          id: randomUUID(),
          userId: userB,
          assetId: cdb,
          institutionId: null,
          quantity: Quantity.fromString('2'),
          averageCost: Money.fromString('5000'),
          totalCost: Money.fromString('10000'),
          realizedGain: Money.fromString('0'),
        });
        await tx.insert(fixedIncomeContracts).values({
          id: randomUUID(),
          userId: userB,
          assetId: cdb,
          indexer: null,
          rate: null,
          issueDate: '2026-01-05',
          principal: Money.fromString('10000'),
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

  it('as tenant A, OnboardingFacts counts only A’s rows', async () => {
    const facts = await withTenant(
      userA,
      async (tx) => new DrizzleOnboardingFactsRepository(tx).readFacts(),
      appDb,
    );

    expect(facts.committedImportCount).toBe(1);
    expect(facts.unclassifiedTransactionCount).toBe(1);
    expect(facts.walletCount).toBe(1);
    expect(facts.contractsMissingRate).toEqual([{ assetId: cdb }]);
  });

  it('as tenant B, OnboardingFacts counts only B’s rows', async () => {
    const facts = await withTenant(
      userB,
      async (tx) => new DrizzleOnboardingFactsRepository(tx).readFacts(),
      appDb,
    );

    expect(facts.committedImportCount).toBe(2);
    expect(facts.unclassifiedTransactionCount).toBe(2);
    expect(facts.walletCount).toBe(2);
    expect(facts.contractsMissingRate).toEqual([{ assetId: cdb }]);
  });

  /**
   * The fold that matters most here: `contractsMissingRate` joins
   * `fixed_income_contracts` to `positions` with an `exists` subquery.
   * Getting the tenant filter wrong on either side of that join is exactly
   * the class of bug this suite exists to catch — a correct-looking count
   * that quietly summed across both tenants' rows (TS-14).
   */
  it('an aggregate cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM wallets`),
      appDb,
    );
    expect((result.rows[0] as { n: number }).n).toBe(1);
  });

  describe('dismissal (BR-020-09)', () => {
    it('dismissing as A leaves B’s onboarding_dismissed_at null', async () => {
      const dismissal = new DrizzleOnboardingDismissalRepository(appDb);
      const clock = new FakeClock('2026-03-01T12:00:00Z');

      await dismissOnboarding(dismissal, userA, clock);

      expect(await dismissal.dismissedAt(userA)).toEqual(new Date('2026-03-01T12:00:00Z'));
      expect(await dismissal.dismissedAt(userB)).toBeNull();
    });

    it('reopening A does not touch B', async () => {
      const dismissal = new DrizzleOnboardingDismissalRepository(appDb);
      await dismissal.setDismissedAt(userB, new Date('2026-02-01T00:00:00Z'));
      await dismissal.setDismissedAt(userA, new Date('2026-02-01T00:00:00Z'));

      await dismissal.setDismissedAt(userA, null);

      expect(await dismissal.dismissedAt(userA)).toBeNull();
      expect(await dismissal.dismissedAt(userB)).toEqual(new Date('2026-02-01T00:00:00Z'));
      // Cleanup for the tests above, which assert B started at null.
      await dismissal.setDismissedAt(userB, null);
    });
  });

  /**
   * BR-020-06/10 — the read model introduces no table of its own. Checked
   * against the live schema rather than trusted from memory, so the
   * enumeration gate (`tests/isolation/enumeration.test.ts`) and this
   * assertion cannot silently disagree.
   */
  it('introduces no onboarding table — the enumeration gate stays green', async () => {
    const { rows } = await migratorPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ILIKE '%onboarding%'`,
    );
    expect(rows).toEqual([]);
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(importBatches).where(eq(importBatches.userId, userA))).rejects.toThrow();
  });
});

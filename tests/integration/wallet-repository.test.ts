import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  DrizzlePositionQueryRepository,
  DrizzleWalletAllocationRepository,
  DrizzleWalletAssetRuleRepository,
  DrizzleWalletRepository,
} from '@/adapters/db/wallet-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { allocateToWallet, computeUnassigned } from '@/core/wallets/allocate';
import { createWallet } from '@/core/wallets/create-wallet';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedAsset } from '../support/ledger-fixtures';
import { seedUser } from '../support/users';

/**
 * SPEC-010 against **real Postgres** (TESTING §1) — the sum invariant
 * (BR-010-05) is exactly the kind of thing a mock would mock away, since it
 * lives in row locking behaviour, not in application logic alone.
 *
 * TS-03: the database is shared across suite files in CI, so this file
 * truncates what it depends on in `beforeAll`.
 */
describe('SPEC-010 — wallet allocation (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-15T12:00:00Z');
  let itsa4: AssetId;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
    itsa4 = (await seedAsset(testDb.migrationUrl, 'ITSA4', 'Itaúsa PN')).id;

    // A handful of connections — enough for genuinely concurrent transactions.
    appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await testDb.stop();
  });

  // TS-03: each test claims the whole 100-share position for itself, so a
  // wallet or allocation left behind by a previous test in this same file
  // would silently change how much room the next test's assertions expect.
  beforeEach(async () => {
    await resetWallets(testDb.migrationUrl);
  });

  /** Seeds a position row directly (bypassing the ledger — not this spec's concern). */
  async function seedPosition(quantity: string, averageCost: string): Promise<void> {
    await withTenant(
      userId,
      async (tx) => {
        const repo = new DrizzlePositionRepository(tx, userId);
        await repo.replaceAll([
          {
            assetId: itsa4,
            institutionId: null,
            state: {
              quantity: Quantity.fromString(quantity),
              totalCost: Money.fromString(averageCost).times(Quantity.fromString(quantity)),
              averageCost: Money.fromString(averageCost),
              realizedGain: Money.zero(),
            },
          },
        ]);
      },
      appDb,
    );
  }

  // Every use-case call below runs its own `withTenant`, each constructing
  // fresh Drizzle repositories bound to that call's transaction — mirroring
  // exactly how a server action would wire the composition root per request.
  function buildDeps(
    tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0],
  ): WalletDependencies {
    return {
      wallets: new DrizzleWalletRepository(tx, userId),
      allocations: new DrizzleWalletAllocationRepository(tx, userId),
      assetRules: new DrizzleWalletAssetRuleRepository(tx, userId),
      positionQuery: new DrizzlePositionQueryRepository(tx),
      clock,
    };
  }

  it('AC — allocating more than the held quantity is refused at write time', async () => {
    await seedPosition('100', '10');

    const walletId = await withTenant(
      userId,
      async (tx) => {
        const created = await createWallet(buildDeps(tx), userId, { name: 'Trading' });
        if (!created.ok) throw new Error('setup failed');
        return created.value.id;
      },
      appDb,
    );

    const first = await withTenant(
      userId,
      (tx) =>
        allocateToWallet(buildDeps(tx), userId, {
          walletId,
          assetId: itsa4,
          quantity: Quantity.fromString('60'),
        }),
      appDb,
    );
    expect(first.ok).toBe(true);

    const secondWalletId = await withTenant(
      userId,
      async (tx) => {
        const created = await createWallet(buildDeps(tx), userId, { name: 'Overflow' });
        if (!created.ok) throw new Error('setup failed');
        return created.value.id;
      },
      appDb,
    );

    const second = await withTenant(
      userId,
      (tx) =>
        allocateToWallet(buildDeps(tx), userId, {
          walletId: secondWalletId,
          assetId: itsa4,
          quantity: Quantity.fromString('41'),
        }),
      appDb,
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('ALLOCATION_EXCEEDS_HOLDINGS');
  });

  it('AC — the invariant holds under CONCURRENT allocation writes', async () => {
    await seedPosition('100', '10');

    // Ten wallets, each racing to claim 20 of a 100-share position — five
    // times more demand than exists. If the lock in
    // `DrizzleWalletAllocationRepository.lockForAsset` did not serialise
    // these, more than 100 could be jointly accepted (each individual
    // request of 20 fits comfortably under 100 read in isolation).
    const walletIds = await withTenant(
      userId,
      async (tx) => {
        const deps = buildDeps(tx);
        const ids: WalletId[] = [];
        for (let i = 0; i < 10; i += 1) {
          const created = await createWallet(deps, userId, { name: `Racer ${i}` });
          if (!created.ok) throw new Error('setup failed');
          ids.push(created.value.id);
        }
        return ids;
      },
      appDb,
    );

    const results = await Promise.all(
      walletIds.map((walletId) =>
        withTenant(
          userId,
          (tx) =>
            allocateToWallet(buildDeps(tx), userId, {
              walletId,
              assetId: itsa4,
              quantity: Quantity.fromString('20'),
            }),
          appDb,
        ),
      ),
    );

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    // Exactly 5 of the 10 requests for 20 fit inside 100.
    expect(succeeded).toBe(5);
    expect(failed).toBe(5);
    for (const result of results) {
      if (!result.ok) expect(result.error.code).toBe('ALLOCATION_EXCEEDS_HOLDINGS');
    }

    // THE invariant itself, read back from the database with no application
    // logic involved — a raw SUM, the thing BR-010-05 actually promises.
    const total = await withTenant(
      userId,
      async (tx) => {
        const rows = await new DrizzleWalletAllocationRepository(tx, userId).listForAsset(itsa4);
        return rows.reduce((sum, row) => sum.plus(row.quantity), Quantity.zero());
      },
      appDb,
    );
    expect(total.comparedTo(Quantity.fromString('100'))).toBeLessThanOrEqual(0);
    expect(total.toString()).toBe('100');
  }, 60_000);

  it('AC — Unassigned plus every wallet sums to the portfolio', async () => {
    await seedPosition('50', '20');

    const walletId = await withTenant(
      userId,
      async (tx) => {
        const created = await createWallet(buildDeps(tx), userId, { name: 'Aposentadoria' });
        if (!created.ok) throw new Error('setup failed');
        return created.value.id;
      },
      appDb,
    );

    await withTenant(
      userId,
      (tx) =>
        allocateToWallet(buildDeps(tx), userId, {
          walletId,
          assetId: itsa4,
          quantity: Quantity.fromString('30'),
        }),
      appDb,
    );

    const { allocatedTotal, unassignedTotal } = await withTenant(
      userId,
      async (tx) => {
        const deps = buildDeps(tx);
        const allocated = await deps.allocations.listForAsset(itsa4);
        const unassigned = await computeUnassigned(deps, userId);
        return {
          allocatedTotal: allocated.reduce((sum, row) => sum.plus(row.quantity), Quantity.zero()),
          unassignedTotal: unassigned.reduce((sum, row) => sum.plus(row.quantity), Quantity.zero()),
        };
      },
      appDb,
    );

    expect(allocatedTotal.plus(unassignedTotal).toString()).toBe('50');
  });
});

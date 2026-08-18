import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { createTransaction } from '@/core/ledger/create-transaction';
import { rebuildAll, rebuildForTenant } from '@/ops/rebuild-positions';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedAsset } from '../support/ledger-fixtures';
import { seedUser } from '../support/users';

/**
 * SPEC-007 BR-007-14 / DM-4 — the repair command, end to end against real
 * Postgres.
 *
 * `rebuild.test.ts` proves the *arithmetic* of a rebuild with fakes, and
 * `transaction-repository.test.ts` proves rebuild-equals-incremental through
 * the NUMERIC round trip. Neither proves the thing this file exists for: that
 * an operator can actually run it, that it is scoped to one tenant when asked,
 * and that `--dry-run` writes nothing. The command was the missing half of
 * BR-007-14 for a whole milestone precisely because "the use case works" and
 * "someone can run it" are different claims.
 */
describe('SPEC-007 — pnpm positions:rebuild (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const alice = UserId.generate();
  const bob = UserId.generate();
  const clock = new FakeClock('2026-06-30T12:00:00Z');
  let petr4: AssetId;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, alice);
    await seedUser(testDb.migrationUrl, bob);
    petr4 = (await seedAsset(testDb.migrationUrl, 'PETR4', 'Petróleo Brasileiro PN')).id;

    appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    try {
      await pool.query('TRUNCATE positions, transactions RESTART IDENTITY CASCADE');
    } finally {
      await pool.end();
    }
  });

  async function seedBuy(userId: UserId, quantity: string, price: string) {
    return withTenant(
      userId,
      async (tx) => {
        const result = await createTransaction(
          {
            transactions: new DrizzleTransactionRepository(tx, userId),
            positions: new DrizzlePositionRepository(tx, userId),
            clock,
          },
          userId,
          {
            assetId: petr4,
            institutionId: null,
            type: 'buy',
            tradeDate: BusinessDate.of('2026-01-05'),
            quantity: Quantity.fromString(quantity),
            unitPrice: Money.fromString(price),
            fees: Money.zero(),
          },
        );
        expect(result.ok).toBe(true);
      },
      appDb,
    );
  }

  /** Corrupts the cache the way a since-fixed calculation bug would have. */
  async function planStaleAverage(userId: UserId): Promise<void> {
    const pool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    try {
      await pool.query(
        `UPDATE positions SET total_cost = '9999.00000000', average_cost = '99.99000000'
         WHERE user_id = $1`,
        [userId],
      );
    } finally {
      await pool.end();
    }
  }

  async function storedAverage(userId: UserId): Promise<string | undefined> {
    return withTenant(
      userId,
      async (tx) => {
        const rows = await new DrizzlePositionRepository(tx, userId).list();
        return rows[0]?.state.averageCost.toString();
      },
      appDb,
    );
  }

  it('reports the drift and repairs it', async () => {
    await seedBuy(alice, '100', '10.00');
    await planStaleAverage(alice);

    const outcome = await rebuildForTenant(alice, { dryRun: false }, appDb);

    expect(outcome.written).toBe(true);
    expect(outcome.drift).toHaveLength(1);
    expect(outcome.drift[0]?.kind).toBe('changed');
    // The *stored* form, eight places — what NUMERIC(20,8) holds, which is
    // what `verifyPositions` compares (see `asStored`).
    expect(outcome.drift[0]?.cached?.averageCost).toBe('99.99000000');
    expect(outcome.drift[0]?.rebuilt?.averageCost).toBe('10.00000000');
    expect(await storedAverage(alice)).toBe('10');
  });

  it('--dry-run reports the same drift and changes nothing', async () => {
    await seedBuy(alice, '100', '10.00');
    await planStaleAverage(alice);

    const outcome = await rebuildForTenant(alice, { dryRun: true }, appDb);

    expect(outcome.written).toBe(false);
    expect(outcome.drift).toHaveLength(1);
    // The assertion that makes `--dry-run` safe to run against production.
    expect(await storedAverage(alice)).toBe('99.99');
  });

  it('reports nothing to do when the cache already agrees', async () => {
    await seedBuy(alice, '100', '10.00');

    const outcome = await rebuildForTenant(alice, { dryRun: false }, appDb);

    expect(outcome.checked).toBe(1);
    expect(outcome.drift).toEqual([]);
  });

  /**
   * AR-11, stated as a test rather than as a comment: the command runs inside
   * `withTenant`, so RLS is what scopes it. A rebuild that reached across
   * tenants would be the most damaging possible version of this bug — one
   * user's replay overwriting another's cache.
   */
  it('rebuilds one tenant without touching another', async () => {
    await seedBuy(alice, '100', '10.00');
    await seedBuy(bob, '50', '20.00');
    await planStaleAverage(bob);

    const outcome = await rebuildForTenant(alice, { dryRun: false }, appDb);

    expect(outcome.checked).toBe(1);
    expect(outcome.drift).toEqual([]);
    // Bob's planted corruption survives, because Alice's rebuild never saw it.
    expect(await storedAverage(bob)).toBe('99.99');
  });

  it('--all covers every active tenant', async () => {
    await seedBuy(alice, '100', '10.00');
    await seedBuy(bob, '50', '20.00');
    await planStaleAverage(alice);
    await planStaleAverage(bob);

    const outcomes = await rebuildAll({ all: true }, appDb);

    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(await storedAverage(alice)).toBe('10');
    expect(await storedAverage(bob)).toBe('20');
  });

  /**
   * A ledger that cannot be replayed must not half-overwrite the cache: the
   * surviving mixture would be neither the old figures nor the new ones, and
   * nothing would say so.
   */
  it('refuses, writing nothing, when the ledger cannot be replayed', async () => {
    await seedBuy(alice, '100', '10.00');
    await planStaleAverage(alice);

    // A sale of more than was ever held, inserted straight into the table so
    // it bypasses BR-006-15 — which is exactly the state a historical bug
    // could have left behind, and the state this command exists to meet.
    const pool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    try {
      await pool.query(
        `INSERT INTO transactions
           (id, user_id, asset_id, institution_id, type, status, trade_date,
            quantity, unit_price, fees, total_value, natural_key, occurrence, is_manual)
         VALUES (gen_random_uuid(), $1, $2, NULL, 'sell', 'active', '2026-02-05',
            '500', '10.00000000', '0', '5000.00000000', 'impossible-sell', 1, true)`,
        [alice, petr4],
      );
    } finally {
      await pool.end();
    }

    await expect(rebuildForTenant(alice, { dryRun: false }, appDb)).rejects.toThrow(
      /cannot be replayed/,
    );
    expect(await storedAverage(alice)).toBe('99.99');
  });
});

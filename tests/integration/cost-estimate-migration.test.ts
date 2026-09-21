import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migration `0028_spec007_cost_estimate.sql` — SPEC-007 BR-007-06 (amended
 * 2026-09-21) / SPEC-005 BR-005-20d: `transactions.cost_is_estimate`,
 * `transactions.estimate_close_date` and `positions.cost_estimated`.
 *
 * TESTING §1: the CHECK pairing and the previous application version's
 * continued ability to write both tables with the new columns omitted are
 * verified against real Postgres rather than a schema mock.
 */
describe('migration 0028 — cost estimate columns (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let assetId: string;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 5 });
    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    assetId = randomUUID();
    await migratorPool.query(
      `INSERT INTO assets (id, code, name, class) VALUES ($1, 'PETR4', 'Petrobras PN', 'stock')`,
      [assetId],
    );
  });

  it('applied cleanly: the three columns and the CHECK constraint exist', async () => {
    const columns = await migratorPool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE (table_name = 'transactions' AND column_name IN ('cost_is_estimate', 'estimate_close_date'))
           OR (table_name = 'positions' AND column_name = 'cost_estimated')
        ORDER BY table_name, column_name`,
    );

    expect(columns.rows).toEqual([
      {
        table_name: 'positions',
        column_name: 'cost_estimated',
        is_nullable: 'NO',
        column_default: 'false',
      },
      {
        table_name: 'transactions',
        column_name: 'cost_is_estimate',
        is_nullable: 'NO',
        column_default: 'false',
      },
      {
        table_name: 'transactions',
        column_name: 'estimate_close_date',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);

    const constraint = await migratorPool.query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = 'transactions_estimate_close_date_check'`,
    );
    expect(constraint.rows).toEqual([{ convalidated: true }]);
  });

  it('rejects an estimate_close_date on a row that does not carry cost_is_estimate', async () => {
    await expectConstraintFailure(
      withTenant(
        userId,
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO transactions
              (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
               total_value, natural_key, occurrence, cost_is_estimate, estimate_close_date)
            VALUES
              (${randomUUID()}, ${userId}, ${assetId}, 'buy', '2026-09-18', '10',
               '12.34', '0', '123.4', ${`estimate-${randomUUID()}`}, 1, false, '2026-10-01')
          `);
        },
        appDb,
      ),
      'transactions_estimate_close_date_check',
    );
  });

  it('accepts an estimate_close_date paired with cost_is_estimate true', async () => {
    const id = randomUUID();
    await withTenant(
      userId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO transactions
            (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
             total_value, natural_key, occurrence, cost_is_estimate, estimate_close_date)
          VALUES
            (${id}, ${userId}, ${assetId}, 'buy', '2026-09-18', '10',
             '12.34', '0', '123.4', ${`estimate-${id}`}, 1, true, '2026-10-01')
        `);
      },
      appDb,
    );

    const result = await migratorPool.query<{
      cost_is_estimate: boolean;
      estimate_close_date: string;
    }>(
      `SELECT cost_is_estimate, estimate_close_date::text AS estimate_close_date
         FROM transactions WHERE id = $1`,
      [id],
    );
    expect(result.rows).toEqual([{ cost_is_estimate: true, estimate_close_date: '2026-10-01' }]);
  });

  it('keeps a previous-version write valid: omitting all three new columns defaults them', async () => {
    const transactionId = randomUUID();
    await withTenant(
      userId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO transactions
            (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
             total_value, natural_key, occurrence)
          VALUES
            (${transactionId}, ${userId}, ${assetId}, 'buy', '2026-09-18', '10',
             '12.34', '0', '123.4', ${`previous-image-${transactionId}`}, 1)
        `);
      },
      appDb,
    );

    const transactionRow = await migratorPool.query<{
      cost_is_estimate: boolean;
      estimate_close_date: string | null;
    }>(`SELECT cost_is_estimate, estimate_close_date FROM transactions WHERE id = $1`, [
      transactionId,
    ]);
    expect(transactionRow.rows).toEqual([{ cost_is_estimate: false, estimate_close_date: null }]);

    const positionId = randomUUID();
    await withTenant(
      userId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO positions
            (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
          VALUES
            (${positionId}, ${userId}, ${assetId}, '10', '12.34', '123.4', '0')
        `);
      },
      appDb,
    );

    const positionRow = await migratorPool.query<{ cost_estimated: boolean }>(
      `SELECT cost_estimated FROM positions WHERE id = $1`,
      [positionId],
    );
    expect(positionRow.rows).toEqual([{ cost_estimated: false }]);
  });

  async function expectConstraintFailure(
    operation: Promise<void>,
    constraintName: string,
  ): Promise<void> {
    let error: unknown;
    try {
      await operation;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error).cause as (Error & { constraint?: string }) | undefined;
    expect(cause?.constraint ?? cause?.message ?? (error as Error).message).toContain(
      constraintName,
    );
  }
});

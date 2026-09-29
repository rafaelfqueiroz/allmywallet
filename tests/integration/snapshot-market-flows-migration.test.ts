import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { dailyValuationSnapshots } from '@/db/schema/valuation';
import { withTenant } from '@/db/tenant';
import { Money } from '@/core/shared/money';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migration `0032_snapshot_market_flows.sql` (#183) — SPEC-013 BR-013-08 /
 * SPEC-012 BR-012-01: `daily_valuation_snapshots.market_flows`.
 *
 * AR-69 is what this pins. The column is nullable with no default so the
 * previous application image — which `start.sh` rolls back to on a failed
 * health check, and which does not know the column — keeps writing snapshots;
 * the backfill sets existing rows to `net_contributions`, the documented
 * meaning of NULL; and the table's RLS is untouched by the change.
 */
describe('migration 0032 — snapshot market_flows (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();

  const migration = async () =>
    migratorPool.query(
      await readFile(
        join(process.cwd(), 'src/db/migrations/0032_snapshot_market_flows.sql'),
        'utf8',
      ),
    );

  const insertLegacyRow = async (user: string, date: string, net: string) =>
    migratorPool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       VALUES ($1, $2, '1000', $3, '0', '{}'::jsonb)`,
      [user, date, net],
    );

  const flows = async () =>
    (
      await migratorPool.query<{
        user_id: string;
        date: string;
        net: string;
        market: string | null;
      }>(
        `SELECT user_id, date::text AS date, net_contributions::text AS net, market_flows::text AS market
           FROM daily_valuation_snapshots ORDER BY user_id, date`,
      )
    ).rows;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 2 });
    appPool = new Pool({ connectionString: database.appUrl, max: 2 });
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
    await seedUser(database.migrationUrl, userA);
    await seedUser(database.migrationUrl, userB);
  });

  it('applied cleanly: numeric(20,8), nullable, no default', async () => {
    const { rows } = await migratorPool.query(
      `SELECT data_type, numeric_precision, numeric_scale, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'daily_valuation_snapshots' AND column_name = 'market_flows'`,
    );
    expect(rows).toEqual([
      {
        data_type: 'numeric',
        numeric_precision: 20,
        numeric_scale: 8,
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
  });

  it('backfills every existing row from net_contributions, across tenants, negatives included', async () => {
    // The state the migration finds in a deployed database: the column absent.
    await migratorPool.query('ALTER TABLE daily_valuation_snapshots DROP COLUMN market_flows');
    await insertLegacyRow(userA, '2026-03-19', '24415.12345678');
    await insertLegacyRow(userA, '2026-03-20', '-50.5');
    await insertLegacyRow(userB, '2026-03-20', '0');

    await migration();

    expect(await flows()).toEqual(
      [
        { user_id: userA, date: '2026-03-19', net: '24415.12345678', market: '24415.12345678' },
        { user_id: userA, date: '2026-03-20', net: '-50.50000000', market: '-50.50000000' },
        { user_id: userB, date: '2026-03-20', net: '0.00000000', market: '0.00000000' },
      ].sort((a, b) => (a.user_id + a.date < b.user_id + b.date ? -1 : 1)),
    );
  });

  it('leaves the rolled-back image able to write: an INSERT that omits the column succeeds and stays NULL', async () => {
    // The app role, under RLS, with the previous image's INSERT shape — no
    // `market_flows` — exactly as it connects.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userA]);
      await client.query(
        `INSERT INTO daily_valuation_snapshots
           (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class, has_estimates)
         VALUES ($1, '2026-03-20', '1000', '900', '0', '{}'::jsonb, false)`,
        [userA],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await flows()).toEqual([
      { user_id: userA, date: '2026-03-20', net: '900.00000000', market: null },
    ]);
  });

  it('the tenant_isolation policy is untouched: still FORCEd, USING and WITH CHECK, and a cross-tenant write fails', async () => {
    const table = await migratorPool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'daily_valuation_snapshots'`,
    );
    expect(table.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const policies = await migratorPool.query<{
      policyname: string;
      cmd: string;
      qual: string;
      with_check: string;
    }>(
      `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'daily_valuation_snapshots'`,
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]?.policyname).toBe('tenant_isolation');
    expect(policies.rows[0]?.cmd).toBe('ALL');
    expect(policies.rows[0]?.qual).toContain('app.user_id');
    expect(policies.rows[0]?.with_check).toContain('app.user_id');

    // WITH CHECK, exercised: tenant B cannot write market_flows onto A's row.
    await expect(
      withTenant(
        userB,
        async (tx) =>
          tx.insert(dailyValuationSnapshots).values({
            userId: userA,
            date: '2026-03-20',
            totalValue: Money.fromString('1'),
            netContributions: Money.fromString('1'),
            marketFlows: Money.fromString('1'),
            earningsToDate: Money.zero(),
            byAssetClass: {},
          }),
        appDb,
      ),
    ).rejects.toThrow();
  });

  it('adds no NOT NULL and no default (AR-69): the migration text changes nothing else', async () => {
    const sqlText = await readFile(
      join(process.cwd(), 'src/db/migrations/0032_snapshot_market_flows.sql'),
      'utf8',
    );
    const statements = sqlText
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "daily_valuation_snapshots" ADD COLUMN "market_flows" numeric(20, 8);',
      'UPDATE "daily_valuation_snapshots" SET "market_flows" = "net_contributions";',
    ]);
  });
});

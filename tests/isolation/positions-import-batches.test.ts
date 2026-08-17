import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset, seedImportBatch, seedInstitution } from '../support/ledger-fixtures';
import * as schema from '@/db/schema';
import { positions } from '@/db/schema/positions';
import { importBatches } from '@/db/schema/transactions';
import { withTenant } from '@/db/tenant';
import { ImportBatchId, PositionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';

/**
 * TS-13/TS-15 — `positions` and `import_batches` are tenant-scoped tables
 * introduced by SPEC-006/007, and the enumeration gate blocks a merge until
 * each is named by an isolation test. This is that test.
 *
 * `positions` deserves the attention more than most tables here. It is a
 * *derived* cache — every figure in it is rebuildable from the ledger — which
 * makes it tempting to treat as less sensitive than the transactions it came
 * from. It is not: a row of it states exactly how much of what a person owns
 * and what they paid, which is the single most sensitive fact the product
 * holds. A leak here needs no join to be damaging.
 */
describe('SPEC-006/007 — positions and import_batches tenant isolation', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const batchA = ImportBatchId.generate();
  const batchB = ImportBatchId.generate();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: CI runs these suites against one shared Postgres service
    // container, so another file may have left rows behind.
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    const petr = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    const vale = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');
    const institution = await seedInstitution(testDb.migrationUrl, 'Corretora Teste');

    await seedImportBatch(testDb.migrationUrl, userA, batchA);
    await seedImportBatch(testDb.migrationUrl, userB, batchB);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    // TS-15: distinguishable data per tenant, written as each tenant.
    await withTenant(
      userA,
      async (tx) =>
        tx.insert(positions).values({
          id: PositionId.generate(),
          userId: userA,
          assetId: petr.id,
          institutionId: institution,
          quantity: Quantity.fromString('100'),
          averageCost: Money.fromString('25.5'),
          totalCost: Money.fromString('2550'),
          realizedGain: Money.zero(),
        }),
      appDb,
    );

    await withTenant(
      userB,
      async (tx) =>
        tx.insert(positions).values({
          id: PositionId.generate(),
          userId: userB,
          assetId: vale.id,
          institutionId: institution,
          quantity: Quantity.fromString('7'),
          averageCost: Money.fromString('61.2'),
          totalCost: Money.fromString('428.4'),
          realizedGain: Money.zero(),
        }),
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, an unfiltered position read returns only A’s holdings', async () => {
    // No WHERE user_id anywhere. The policy is what constrains this, which is
    // the entire point — a forgotten predicate must return nothing rather than
    // everything (PRD risk R6).
    const rows = await withTenant(userA, async (tx) => tx.select().from(positions), appDb);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userA);
    expect(rows[0]?.quantity.toString()).toBe('100');
    // B holds VALE3 at a distinguishable quantity; none of it may appear.
    expect(rows.some((row) => row.quantity.toString() === '7')).toBe(false);
  });

  it('as tenant A, an unfiltered import_batches read returns only A’s batches', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(importBatches), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(batchA);
    expect(rows.some((row) => row.id === batchB)).toBe(false);
  });

  it('an aggregate over positions cannot see across the boundary (TS-14)', async () => {
    // TS-14: leaks happen in aggregates and exports, above where a repository
    // test looks. A SUM that silently includes another tenant produces a
    // plausible number, which is worse than an error.
    const result = await withTenant(
      userA,
      async (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n, sum(quantity) AS total FROM positions`),
      appDb,
    );
    const row = result.rows[0] as { n: number; total: string | null };
    expect(row.n).toBe(1);
    expect(row.total).toBe('100.00000000');
  });

  it('tenant A cannot insert a position attributed to tenant B', async () => {
    // The WITH CHECK half. Without it, a read-side test still passes while A
    // quietly writes rows belonging to B. 42501 = insufficient_privilege.
    const petr = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(positions).values({
            id: PositionId.generate(),
            userId: userB,
            assetId: petr.id,
            quantity: Quantity.fromString('1'),
            averageCost: Money.fromString('1'),
            totalCost: Money.fromString('1'),
            realizedGain: Money.zero(),
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant A cannot insert an import batch attributed to tenant B', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(importBatches).values({
            id: ImportBatchId.generate(),
            userId: userB,
            source: 'b3_negociacao',
            status: 'pending',
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('#63 — a failed batch’s failure_code never crosses the tenant boundary', async () => {
    // BR-005-05: `failure_code` is a new, additive column on an already
    // tenant-scoped table (#63) — this pins it under the same policy as
    // every other column on `import_batches`, rather than assuming the
    // existing coverage above generalises to a column that did not exist
    // when it was written.
    await migratorPool.query(
      "UPDATE import_batches SET status = 'failed', failure_code = $2 WHERE id = $1",
      [batchA, 'INGESTION_MALFORMED_CELL'],
    );

    const asA = await withTenant(userA, async (tx) => tx.select().from(importBatches), appDb);
    expect(asA).toHaveLength(1);
    expect(asA[0]?.failureCode).toBe('INGESTION_MALFORMED_CELL');

    const asB = await withTenant(userB, async (tx) => tx.select().from(importBatches), appDb);
    expect(asB.some((row) => row.failureCode === 'INGESTION_MALFORMED_CELL')).toBe(false);
    expect(asB.some((row) => row.id === batchA)).toBe(false);

    // Restore batchA to the state the tests above assume, so ordering never
    // matters between files sharing this database (TS-03).
    await migratorPool.query(
      "UPDATE import_batches SET status = 'committed', failure_code = NULL WHERE id = $1",
      [batchA],
    );
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    // `app.user_id` is never set, so `current_setting(...)::uuid` raises rather
    // than matching. Failing closed is the property being asserted.
    await expect(appDb.select().from(positions)).rejects.toThrow();
    await expect(appDb.select().from(importBatches)).rejects.toThrow();
  });

  it('both tables have ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname IN ('positions', 'import_batches')
             AND relnamespace = 'public'::regnamespace
           ORDER BY relname`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // FORCE matters as much as ENABLE: migrations run as the owner, and an
      // owner bypasses its own policies without it.
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('deleting the tenant root removes both, so account deletion is complete', async () => {
    // AR-27: the ON DELETE CASCADE is load-bearing for SPEC-004. Asserting it
    // here means the deletion story is verified against the real schema rather
    // than assumed from the column definition.
    const doomed = UserId.generate();
    await seedUser(testDb.migrationUrl, doomed);
    const doomedBatch = ImportBatchId.generate();
    await seedImportBatch(testDb.migrationUrl, doomed, doomedBatch);

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const { rows } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM import_batches WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { FakeClock } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { domainError } from '@/core/shared/domain-error';
import { err, ok } from '@/core/shared/result';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import { withTenantResult, type Tx } from '@/db/tenant';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-010 BR-010-05 / SPEC-006 BR-006-15: expected domain refusals are
 * returned values, but their preceding writes are still atomic at the real
 * Postgres transaction boundary.
 */
describe('withTenantResult (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-09-30T12:00:00-03:00');

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl, max: 2 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  beforeEach(async () => {
    // TS-03: protect this file from every predecessor in the shared database.
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
  });

  afterAll(async () => {
    // TS-03: protect every successor in the shared database too.
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  async function insertPending(batchId: ImportBatchId, tx: Tx): Promise<void> {
    await new DrizzleImportBatchRepository(tx, userId).insert({
      id: batchId,
      userId,
      source: 'b3_movimentacao',
      status: 'pending',
      uploadedAt: clock.now(),
      committedAt: null,
      rowCounts: null,
      reconciliation: null,
      failureCode: null,
    });
  }

  async function stored(batchId: ImportBatchId): Promise<boolean> {
    const { rowCount } = await migratorPool.query('SELECT 1 FROM import_batches WHERE id = $1', [
      batchId,
    ]);
    return rowCount === 1;
  }

  it('commits a successful Result', async () => {
    const batchId = ImportBatchId.generate();
    const success = ok(batchId);

    const returned = await withTenantResult(
      userId,
      async (tx) => {
        await insertPending(batchId, tx);
        return success;
      },
      appDb,
    );

    expect(returned).toBe(success);
    expect(await stored(batchId)).toBe(true);
  });

  it('rolls back a write and returns the identical expected refusal value', async () => {
    const batchId = ImportBatchId.generate();
    const refusal = err(
      domainError('ALLOCATION_EXCEEDS_HOLDINGS', { held: '10', requested: '11' }),
    );

    const returned = await withTenantResult(
      userId,
      async (tx) => {
        await insertPending(batchId, tx);
        return refusal;
      },
      appDb,
    );

    expect(returned).toBe(refusal);
    expect(await stored(batchId)).toBe(false);
  });

  it('rolls back and propagates a genuine thrown fault unchanged', async () => {
    const batchId = ImportBatchId.generate();
    const fault = new Error('database-side fault');

    await expect(
      withTenantResult(
        userId,
        async (tx) => {
          await insertPending(batchId, tx);
          throw fault;
        },
        appDb,
      ),
    ).rejects.toBe(fault);

    expect(await stored(batchId)).toBe(false);
  });
});

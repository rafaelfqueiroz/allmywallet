import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDatabase, checkQuoteSync, checkWorkerLiveness } from '@/lib/health';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * AR-50/AR-33: "reports database reachability, worker liveness and last
 * successful quote sync." TS-01's "cannot test against a mock" applies here —
 * these are genuine connectivity/timing probes against Postgres, not domain
 * logic.
 *
 * SPEC-008 (#11) has since merged, so `latest_quotes` is now in this migration
 * set and `checkQuoteSync` is tested against the real contract it was written
 * against (`latest_quotes.updated_at`) rather than against its absence. The
 * "schema is behind the running code" branch stays in the implementation as a
 * deliberate degradation path, but it can no longer be reached from a migrated
 * database, which is the only kind this suite builds.
 */
describe('health probes (SPEC-016 AR-50)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    // TS-03: order-agnostic against a reused database. `latest_quotes` and
    // `assets` are included because the quote-sync probe reads them and one of
    // the tests below seeds them — without this, "has never synced" would pass
    // or fail depending on which test ran first.
    await migratorPool.query('TRUNCATE worker_heartbeats');
    await migratorPool.query('TRUNCATE latest_quotes, assets CASCADE');
  });

  describe('checkDatabase', () => {
    it('reports ok against a reachable database', async () => {
      expect(await checkDatabase(appPool)).toEqual({ status: 'ok' });
    });

    it('reports down, not a thrown error, against an unreachable database', async () => {
      const deadPool = new Pool({
        connectionString: 'postgresql://allmywallet_app:allmywallet@127.0.0.1:1/allmywallet',
        connectionTimeoutMillis: 500,
        max: 1,
      });
      try {
        const result = await checkDatabase(deadPool);
        expect(result.status).toBe('down');
        expect(result.detail).toBeTruthy();
      } finally {
        await deadPool.end().catch(() => undefined);
      }
    });
  });

  describe('checkWorkerLiveness', () => {
    it('reports unknown when no heartbeat has ever been recorded', async () => {
      expect(await checkWorkerLiveness(appPool, 120)).toEqual({
        status: 'unknown',
        detail: 'no heartbeat recorded yet',
      });
    });

    it('reports ok for a fresh heartbeat', async () => {
      await migratorPool.query(
        `INSERT INTO worker_heartbeats (id, updated_at) VALUES ('worker', now())`,
      );
      expect(await checkWorkerLiveness(appPool, 120)).toEqual({ status: 'ok' });
    });

    it('reports down for a heartbeat older than the configured threshold', async () => {
      await migratorPool.query(
        `INSERT INTO worker_heartbeats (id, updated_at) VALUES ('worker', now() - interval '10 minutes')`,
      );
      const result = await checkWorkerLiveness(appPool, 120);
      expect(result.status).toBe('down');
      expect(result.detail).toContain('old');
    });
  });

  describe('checkQuoteSync', () => {
    it('reports unknown, not down, when latest_quotes exists but has never synced', async () => {
      const result = await checkQuoteSync(appPool);
      expect(result.status).toBe('unknown');
      expect(result.lastSuccessfulSyncAt).toBeNull();
      expect(result.detail).toContain('no rows yet');
    });

    it('reports the most recent sync across assets once quotes exist', async () => {
      // Two assets synced at different times: AR-50 asks for the *last*
      // successful sync, so the newer timestamp is the answer — a probe that
      // returned the older one would report the system as stale while it was
      // in fact healthy.
      await migratorPool.query(
        `INSERT INTO assets (id, code, name, class) VALUES
           (gen_random_uuid(), 'PETR4', 'Petrobras', 'stock'),
           (gen_random_uuid(), 'VALE3', 'Vale', 'stock')`,
      );
      await migratorPool.query(
        `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source, updated_at)
         SELECT id, 10, now(), now(), 'test',
                CASE WHEN code = 'PETR4' THEN now() - interval '2 hours' ELSE now() END
           FROM assets WHERE code IN ('PETR4', 'VALE3')`,
      );

      const result = await checkQuoteSync(appPool);
      expect(result.status).toBe('ok');
      expect(result.lastSuccessfulSyncAt).not.toBeNull();
      const age = Date.now() - new Date(result.lastSuccessfulSyncAt as string).getTime();
      expect(age).toBeLessThan(60_000);
    });
  });
});

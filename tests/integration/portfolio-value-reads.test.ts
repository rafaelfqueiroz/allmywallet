import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { UserId } from '@/core/shared/ids';
import { withReportPort } from '@/app/(app)/reports/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-013 BR-013-02/13 — the two reads the Portfolio Value report needs
 * beyond SPEC-011's shared set, against real Postgres.
 *
 * Both are the kind of query that is easy to write plausibly and wrong:
 * `findSnapshotBefore` must return the row *strictly before* the range (an
 * inclusive comparison silently discards the first day's movement), and
 * `lastImportAt` must ignore batches that were staged and abandoned.
 *
 * TS-03: the shared CI database is cleaned in both `beforeAll` and `afterAll`.
 */
describe('SPEC-013 report reads (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();

  async function cleanUp(): Promise<void> {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await cleanUp();
    await seedUser(database.migrationUrl, userId);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    await cleanUp();
    await database.stop();
  });

  beforeEach(async () => {
    await migratorPool.query('TRUNCATE daily_valuation_snapshots, import_batches CASCADE');
  });

  async function seedSnapshot(date: string, totalValue: string, contributions: string) {
    await migratorPool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       VALUES ($1, $2, $3, $4, 0, '{}'::jsonb)`,
      [userId, date, totalValue, contributions],
    );
  }

  async function seedBatch(status: string, committedAt: string | null) {
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at)
       VALUES (gen_random_uuid(), $1, 'b3_movimentacao', $2, now(), $3)`,
      [userId, status, committedAt],
    );
  }

  describe('findSnapshotBefore', () => {
    it('returns the row strictly before the date, not the one on it', async () => {
      // The off-by-one that matters: growth "during March" is measured from
      // February's close. Returning 2026-03-01 here would discard the first
      // day's movement and still look plausible.
      await seedSnapshot('2026-02-27', '90000', '88000');
      await seedSnapshot('2026-02-28', '100000', '95000');
      await seedSnapshot('2026-03-01', '101000', '95000');

      const opening = await withReportPort(userId, (port) =>
        port.findSnapshotBefore(BusinessDate.of('2026-03-01')),
      );

      expect(opening?.date).toBe('2026-02-28');
      expect(opening?.totalValue.toDecimal().toFixed(2)).toBe('100000.00');
      expect(opening?.netContributions.toDecimal().toFixed(2)).toBe('95000.00');
    });

    it('returns null when the range starts at the first snapshot there is', async () => {
      await seedSnapshot('2026-03-01', '1000', '1000');
      const opening = await withReportPort(userId, (port) =>
        port.findSnapshotBefore(BusinessDate.of('2026-03-01')),
      );
      expect(opening).toBe(null);
    });
  });

  describe('lastImportAt (BR-013-13 / SPEC-005 BR-005-27)', () => {
    it('reports the most recent committed batch', async () => {
      await seedBatch('committed', '2026-03-10T14:00:00Z');
      await seedBatch('committed', '2026-03-15T14:00:00Z');

      const at = await withReportPort(userId, (port) => port.lastImportAt());
      expect(at).toBe('2026-03-15');
    });

    /**
     * A staged-but-abandoned upload changed nothing about the portfolio.
     * Reporting it would tell the user their figures are fresher than they
     * are — the one thing this date exists to prevent.
     */
    it('ignores a batch that was never committed', async () => {
      await seedBatch('committed', '2026-03-10T14:00:00Z');
      await seedBatch('pending', null);

      const at = await withReportPort(userId, (port) => port.lastImportAt());
      expect(at).toBe('2026-03-10');
    });

    it('reports null before the first import rather than a fabricated date', async () => {
      expect(await withReportPort(userId, (port) => port.lastImportAt())).toBe(null);
    });

    /**
     * AR-29: the timestamp is converted to a São Paulo business date, not to
     * UTC's. 2026-03-15T02:00Z is still 14 March in São Paulo, and a report
     * claiming an import happened a day later than it did would be wrong in
     * exactly the direction that hides staleness.
     */
    it('converts the timestamp in São Paulo, not in UTC', async () => {
      await seedBatch('committed', '2026-03-15T02:00:00Z');
      const at = await withReportPort(userId, (port) => port.lastImportAt());
      expect(at).toBe('2026-03-14');
    });
  });
});

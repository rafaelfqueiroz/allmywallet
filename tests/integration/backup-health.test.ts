import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aggregateStatus, checkBackup, readFailedBackup } from '@/lib/health';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-021 BR-021-20 — "a failed backup appears in /api/health … until the
 * next success". The probe reads `backup_runs`, which `dist/ops.js
 * backup-record` writes for scripts/personal/backup.sh.
 */
describe('backup health (SPEC-021 BR-021-20)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;

  async function record(status: 'succeeded' | 'failed', finishedAt: string, detail?: string) {
    await migratorPool.query(
      `INSERT INTO backup_runs (id, status, file_name, detail, finished_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [
        status,
        status === 'succeeded' ? 'allmywallet-x.dump.age' : null,
        detail ?? null,
        finishedAt,
      ],
    );
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl });
  }, 180_000);

  // TS-03: truncated before each test and after the file, so the shared CI
  // database never hands another suite a failed backup.
  beforeEach(async () => {
    await migratorPool.query('TRUNCATE backup_runs');
  });

  afterAll(async () => {
    await migratorPool.query('TRUNCATE backup_runs');
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('is unknown where no backup has ever run — development and hosted', async () => {
    expect((await checkBackup(appPool)).status).toBe('unknown');
  });

  it('reports a failure as degraded, naming the reason and the last success', async () => {
    await record('succeeded', '2026-09-10T10:00:00Z');
    await record('failed', '2026-09-11T10:00:00Z', 'BACKUP_DIR does not exist');

    const health = await checkBackup(appPool);

    expect(health.status).toBe('degraded');
    expect(health.detail).toContain('BACKUP_DIR does not exist');
    expect(health.lastSuccessfulBackupAt).toBe('2026-09-10T10:00:00.000Z');
    // Degraded, never down: a failed backup must not make start.sh roll back a healthy image.
    expect(aggregateStatus([{ status: 'ok' }, health])).toBe('degraded');
  });

  it('keeps reporting the failure across repeated failures, until a success clears it', async () => {
    await record('failed', '2026-09-11T10:00:00Z', 'first');
    await record('failed', '2026-09-12T10:00:00Z', 'second');
    expect((await checkBackup(appPool)).status).toBe('degraded');

    // The in-app notice reads the same state.
    expect(await readFailedBackup(appPool)).toEqual({
      failedAt: new Date('2026-09-12T10:00:00Z'),
      reason: 'second',
      lastSuccessAt: null,
    });

    await record('succeeded', '2026-09-13T10:00:00Z');
    expect(await readFailedBackup(appPool)).toBeNull();
    const health = await checkBackup(appPool);
    expect(health.status).toBe('ok');
    expect(health.lastSuccessfulBackupAt).toBe('2026-09-13T10:00:00.000Z');
  });
});

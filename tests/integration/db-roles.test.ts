import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * TS-18 / SPEC-003 AC "the application's database role cannot bypass RLS —
 * asserted directly against the role's attributes." DL-003-02: a
 * `BYPASSRLS` role (or the table owner) makes every other RLS control
 * decorative, so this is checked directly against `pg_roles`, not inferred
 * from behaviour.
 */
describe('allmywallet_app role attributes (SPEC-003 BR-003-03, TS-18)', () => {
  let testDb: TestDatabase;
  let migratorPool: Pool;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    migratorPool = new Pool({ connectionString: testDb.migrationUrl });
  }, 180_000);

  afterAll(async () => {
    await migratorPool.end();
    await testDb.stop();
  });

  it('allmywallet_app cannot bypass row-level security', async () => {
    const { rows } = await migratorPool.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'allmywallet_app'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('allmywallet_app is not a superuser', async () => {
    const { rows } = await migratorPool.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = 'allmywallet_app'`,
    );
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('allmywallet_app does not own any table in the public schema', async () => {
    const { rows } = await migratorPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_tables
       WHERE schemaname = 'public' AND tableowner = 'allmywallet_app'`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('allmywallet_migrator owns every table in the public schema (the other half of DL-003-02)', async () => {
    const { rows } = await migratorPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_tables
       WHERE schemaname = 'public' AND tableowner != 'allmywallet_migrator'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});

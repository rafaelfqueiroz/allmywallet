import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-020 BR-020-06/09/10 — "no onboarding progress table exists;
 * completion is reproduced entirely by query." AC: "`users.onboarding_
 * dismissed_at` is the only onboarding column added."
 *
 * Verified against the live schema rather than trusted from the migration
 * alone — the same reasoning `tests/isolation/enumeration.test.ts` gives for
 * enumerating from `pg_class`: a maintained list goes stale silently, a
 * database query does not.
 */
describe('SPEC-020 — no onboarding progress table (schema)', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  it('no table in the schema has "onboarding" in its name', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ILIKE '%onboarding%'`,
    );
    expect(rows).toEqual([]);
  });

  /**
   * BR-020-09 — "the single persisted field is `users.onboarding_
   * dismissed_at`, nullable." Pinned against the exact column set rather than
   * only checking the new one exists, so an accidental second onboarding
   * column added to `users` later fails this test rather than going
   * unnoticed (BR-020-10).
   */
  it('users carries exactly the columns SPEC-001/004 declared, plus onboarding_dismissed_at', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
        ORDER BY ordinal_position`,
    );
    const columns = rows.map((row) => row.column_name);

    expect(columns).toEqual([
      'id',
      'google_subject_id',
      'email',
      'name',
      'image_url',
      'created_at',
      'updated_at',
      'deleted_at',
      'onboarding_dismissed_at',
    ]);
  });

  it('migration 0016 contains no CREATE TABLE', () => {
    const sql = readFileSync(
      join(process.cwd(), 'src/db/migrations/0016_users_onboarding_dismissed_at.sql'),
      'utf8',
    );
    expect(sql.toUpperCase()).not.toContain('CREATE TABLE');
    expect(sql.toUpperCase()).toContain('ALTER TABLE');
  });
});

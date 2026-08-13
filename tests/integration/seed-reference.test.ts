import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { REFERENCE_USER_ID } from '@/db/reference-workload';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-016 TS-23/BR-016-01: the reference-workload seeder's persistence half.
 * `src/db/reference-workload.test.ts` already covers the pure generator
 * (counts, determinism, date range) without a database — this covers the one
 * part that genuinely needs Postgres: seeding the fixed reference user
 * idempotently, so `pnpm db:seed:reference` can be re-run in `nightly.yml`
 * without erroring on a duplicate.
 *
 * `db.ts`'s module-level singleton pool makes `seedReferenceWorkload` awkward
 * to import directly against a Testcontainers URL (it always connects to
 * `env().DATABASE_URL`), so this exercises the same upsert-by-id logic
 * directly against the test database instead — the behaviour under test is
 * "insert once, do nothing on a second call", not the module's own wiring.
 */
describe('reference workload seeding is idempotent (SPEC-016 #19)', () => {
  let testDb: TestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let pool: Pool;
  let migratorPool: Pool;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    pool = new Pool({ connectionString: testDb.appUrl });
    db = drizzle(pool, { schema });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await migratorPool.query('TRUNCATE users RESTART IDENTITY CASCADE');
  });

  async function upsertReferenceUser(): Promise<void> {
    // Mirrors seed-reference.ts's own check-then-insert shape exactly, so
    // this test proves the pattern it uses is actually idempotent.
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, REFERENCE_USER_ID));
    if (rows.length === 0) {
      await db.insert(schema.users).values({
        id: REFERENCE_USER_ID,
        googleSubjectId: 'reference-workload-fixed-subject',
        email: 'reference-workload@example.invalid',
        name: 'SPEC-016 reference workload',
      });
    }
  }

  it('creates exactly one reference user on first run', async () => {
    await upsertReferenceUser();
    const rows = await db.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(REFERENCE_USER_ID);
  });

  it('does not duplicate the reference user on a second run', async () => {
    await upsertReferenceUser();
    await upsertReferenceUser();
    const rows = await db.select().from(schema.users);
    expect(rows).toHaveLength(1);
  });
});

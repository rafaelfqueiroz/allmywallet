import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { DrizzleUserRepository } from '@/adapters/db/user-repository';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-001 BR-001-04 against real Postgres — `provision-tenant.test.ts`
 * proves the use case delegates correctly against a fake; this proves the
 * `ON CONFLICT (google_subject_id) DO UPDATE` the fake's semantics are
 * modelled on is actually what Postgres does, including under real
 * concurrency (TESTING §1: NUMERIC round-tripping and RLS aren't the only
 * things a mock would mock away — a unique-constraint race is a real
 * database behaviour too).
 */
describe('DrizzleUserRepository (SPEC-001 BR-001-04)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: DrizzleUserRepository;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    pool = new Pool({ connectionString: testDb.appUrl });
    db = drizzle(pool, { schema });
    repository = new DrizzleUserRepository(db);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await testDb.stop();
  });

  it('a retried callback for the same Google account never creates a second row', async () => {
    const input = {
      googleSubjectId: `sub-${crypto.randomUUID()}`,
      email: 'first@example.com',
      name: 'First',
      imageUrl: null,
    };
    const first = await repository.upsertByGoogleSubject(input);
    const second = await repository.upsertByGoogleSubject(input);
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query(
      'SELECT count(*)::text AS count FROM users WHERE google_subject_id = $1',
      [input.googleSubjectId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('two concurrent upserts for the same brand-new subject still resolve to one row', async () => {
    // The race the comment in src/auth.ts describes: two concurrent
    // callbacks for a subject that has never signed in before. Without the
    // database-level ON CONFLICT, a JS-level check-then-insert could create
    // two rows here.
    const googleSubjectId = `sub-race-${crypto.randomUUID()}`;
    const input = { googleSubjectId, email: 'race@example.com', name: 'Race', imageUrl: null };

    const [a, b] = await Promise.all([
      repository.upsertByGoogleSubject(input),
      repository.upsertByGoogleSubject(input),
    ]);
    expect(a.id).toBe(b.id);

    const { rows } = await pool.query(
      'SELECT count(*)::text AS count FROM users WHERE google_subject_id = $1',
      [googleSubjectId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('an email change at Google preserves the same tenant (DL-001-02)', async () => {
    const googleSubjectId = `sub-${crypto.randomUUID()}`;
    const first = await repository.upsertByGoogleSubject({
      googleSubjectId,
      email: 'old@example.com',
      name: 'Name',
      imageUrl: null,
    });
    const changed = await repository.upsertByGoogleSubject({
      googleSubjectId,
      email: 'new@example.com',
      name: 'Name',
      imageUrl: null,
    });
    expect(changed.id).toBe(first.id);
    expect(changed.email).toBe('new@example.com');
  });

  it('findById returns null for an id that does not exist', async () => {
    expect(await repository.findById(UserId.generate())).toBeNull();
  });
});
